import { adapterFor } from "../hosts/index.ts";
import { type Runspec } from "../runspec.ts";
import type { Plan, ReleaseUnit, ReviewLayer } from "../plan.ts";
import type { ProbeResult } from "../trace.ts";
import { createWorktree, git, worktreePath } from "../worktree.ts";
import { manifestRecord, phaseSkillIn, type PhaseOutcome } from "./invoke.ts";
import { outputPath, phase } from "./phases.ts";
import { appendManifest, readArtifact, writeArtifact, type Run } from "./store.ts";

interface LayerResult {
  layer: ReviewLayer;
  summary: string;
  commit?: string;
  /** Files the layer wrote that its declared set did not include. */
  strayFiles: string[];
  error?: string;
}

interface CheckpointResult {
  unit: string;
  command: string;
  ok: boolean;
  output: string;
}

/** Runs a unit's checkpoint in the worktree, so G6 shows evidence and not a claim. */
async function runCheckpoint(workdir: string, unit: ReleaseUnit): Promise<CheckpointResult> {
  const proc = Bun.spawn(["sh", "-c", unit.checkpoint], {
    cwd: workdir,
    stdout: "pipe",
    stderr: "pipe",
  });

  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);

  const output = `${stdout}${stderr}`.trim().split("\n").slice(-25).join("\n");
  return { unit: unit.id, command: unit.checkpoint, ok: exitCode === 0, output };
}

/**
 * Commits a layer and reports which files it wrote outside its declared set.
 *
 * Detection rather than prevention. design.md §15.1 wants this as a `PreToolUse`
 * hook that refuses the write before it happens; checking the commit afterwards is
 * the same rule one rung lower on the enforcement ladder, and it is where the rule
 * can live until the hook exists. The gap is worth naming: a layer that widened its
 * own footprint is reported at G6, not stopped at the keystroke.
 */
async function commitLayer(workdir: string, layer: ReviewLayer): Promise<{ commit?: string; strayFiles: string[] }> {
  await git(workdir, ["add", "-A"]);

  const staged = (await git(workdir, ["diff", "--cached", "--name-only"])).stdout;
  const touched = staged.split("\n").filter((line) => line.trim());
  if (touched.length === 0) return { strayFiles: [] };

  const declared = new Set(layer.files);
  const strayFiles = touched.filter((file) => !declared.has(file));

  await git(workdir, ["commit", "--quiet", "-m", layer.title]);
  const commit = (await git(workdir, ["rev-parse", "--short", "HEAD"])).stdout;

  return { commit, strayFiles };
}

function layerPayload(
  unit: ReleaseUnit,
  layer: ReviewLayer,
  shape: string,
  probe: ProbeResult
): string {
  const deviations = [
    ...(probe.deviations ?? []),
    ...probe.traces.flatMap((trace) => trace.deviations ?? []),
  ];

  const sections = [
    `# This layer\n\n${layer.title}\n\nkind: ${layer.kind}\ninert: ${layer.inert}\nfiles you may write:\n${layer.files.map((f) => `- ${f}`).join("\n")}\n`,
    `# The unit this layer belongs to\n\n${unit.goal}\n\nIts checkpoint is \`${unit.checkpoint}\`.\n`,
    `# The approved shape\n\n${shape}\n`,
  ];

  if (deviations.length > 0) {
    const listed = deviations
      .map((d) => `- ${d.kind}: ${d.detail}${d.file ? ` (${d.file})` : ""}`)
      .join("\n");
    sections.push(`# What the probe ran into building this\n\n${listed}\n`);
  }

  return sections.join("\n");
}

/**
 * Builds every review layer, in order, into one worktree.
 *
 * One invocation per layer rather than one per phase: a builder given the whole plan
 * has no fence, and the layer boundary is the thing the reviewer approved at G3.
 * Layers land as commits on one branch in dependency order, which is the stack.
 *
 * A layer that fails halts the unit rather than the run — the branch keeps whatever
 * landed before it, and `build.md` says where it stopped.
 */
export async function runBuild(run: Run, _spec: Runspec): Promise<PhaseOutcome> {
  const def = phase("build");
  const binding = run.meta.config.roles[def.role];
  const host = run.meta.config.hosts[binding.host];
  if (!host) throw new Error(`Role ${def.role} is bound to unknown host ${binding.host}`);

  const planText = await readArtifact(run, "plan.json");
  const probeText = await readArtifact(run, "probe.json");
  if (!planText || !probeText) throw new Error("Build needs an approved plan.json and probe.json");

  const plan = JSON.parse(planText) as Plan;
  const probe = JSON.parse(probeText) as ProbeResult;
  const shape = (await readArtifact(run, outputPath(phase("shape"), run.meta.repo))) ?? "";

  const workdir = worktreePath(run.meta.run, "build");
  const branch = `valtay/${run.meta.run}/build`;

  // The commit the branch forks from. `main` is not it — the run may start from any
  // branch, and pointing a reviewer at `main..HEAD` showed them every commit since
  // the last merge rather than the two the build actually made.
  const base = (await git(run.meta.repo, ["rev-parse", "HEAD"])).stdout;
  await createWorktree(run.meta.repo, workdir, branch);

  // Checked once for the whole phase rather than per layer: the worktree does not
  // change under it, and a builder that cannot load its skill would otherwise burn one
  // invocation per layer discovering the same setup mistake.
  const found = await phaseSkillIn(workdir, def.id);
  if (!found.ok) return { ok: false, error: found.error, attempts: 0 };

  const results: LayerResult[] = [];
  const checkpoints: CheckpointResult[] = [];
  let halted: string | undefined;

  for (const unit of plan.release_units) {
    for (const layer of unit.layers) {
      const result = await adapterFor(host.adapter).run({
        binding,
        host,
        skill: found.skill,
        input: layerPayload(unit, layer, shape, probe),
        workdir,
        readDirs: [run.dir],
        write: true,
        timeout_ms: binding.timeout_ms,
      });

      const failure = result.error ?? (result.output.trim() ? undefined : "the builder said nothing");
      const committed = failure ? { strayFiles: [] } : await commitLayer(workdir, layer);

      await appendManifest(
        run,
        manifestRecord({
          def,
          binding,
          skill: found.skill,
          promptSha: found.sha,
          inputs: [],
          outputs: [],
          result,
          attempt: 1,
          notes: [
            `layer ${layer.id}`,
            ...(failure ? [failure] : []),
            ...(committed.strayFiles.length > 0
              ? [`wrote outside its declared file set: ${committed.strayFiles.join(", ")}`]
              : []),
          ],
        })
      );

      results.push({ layer, summary: result.output.trim(), ...committed, ...(failure ? { error: failure } : {}) });

      if (failure) {
        halted = `${layer.id} failed: ${failure}`;
        break;
      }
    }

    if (halted) break;
    checkpoints.push(await runCheckpoint(workdir, unit));
  }

  const report = renderBuildReport({ branch, workdir, base, results, checkpoints, ...(halted ? { halted } : {}) });
  const ref = await writeArtifact(run, def.output, report);
  return halted
    ? { ok: false, error: halted, attempts: 1 }
    : { ok: true, output: ref, attempts: 1 };
}

export interface BuildReport {
  branch: string;
  workdir: string;
  /** The commit the branch forks from, so the review range is the build's own work. */
  base: string;
  results: LayerResult[];
  checkpoints: CheckpointResult[];
  halted?: string;
}

/** What G6 reads before opening the diff. */
export function renderBuildReport(report: BuildReport): string {
  const { branch, workdir, base, results, checkpoints, halted } = report;

  const lines = [
    "## Built",
    "",
    `Branch \`${branch}\` in ${workdir}`,
    "",
  ];

  for (const result of results) {
    const commit = result.commit ? ` — ${result.commit}` : " — nothing committed";
    lines.push(`### ${result.layer.id} ${result.layer.title}${commit}`, "");
    lines.push(`\`${result.layer.kind}\`${result.layer.inert ? ", inert" : ""}`, "");

    if (result.summary) lines.push(result.summary, "");
    if (result.error) lines.push(`**Failed:** ${result.error}`, "");

    // Surfaced at G6 rather than swallowed: a layer that widened its own footprint
    // is exactly what the ownership partition in the plan was cut to prevent.
    if (result.strayFiles.length > 0) {
      lines.push(
        `**Wrote outside its declared file set:** ${result.strayFiles.join(", ")}`,
        ""
      );
    }
  }

  lines.push("## Checkpoints", "");
  if (checkpoints.length === 0) {
    lines.push("None ran.", "");
  }
  for (const checkpoint of checkpoints) {
    lines.push(`### ${checkpoint.unit} — \`${checkpoint.command}\` ${checkpoint.ok ? "passed" : "FAILED"}`, "");
    lines.push("```", checkpoint.output, "```", "");
  }

  if (halted) lines.push("## Halted", "", halted, "");

  lines.push(
    "## Review",
    "",
    `\`git -C ${workdir} log --patch ${base.slice(0, 12)}..HEAD\``
  );
  return lines.join("\n");
}
