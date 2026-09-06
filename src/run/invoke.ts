import { adapterFor } from "../hosts/index.ts";
import type { HostRequest, PhaseSkill } from "../hosts/types.ts";
import {
  DEFAULT_ADAPTER,
  installedSkillPath,
  phaseSkillName,
  skillRelDir,
  skillRootFor,
} from "../skills.ts";
import { researchInput, sha256, section, type Runspec } from "../runspec.ts";
import type { ResolvedConfig, RoleBinding } from "../config.ts";
import type { HostResult } from "../hosts/types.ts";
import { validatePlan } from "../plan.ts";
import { recordDeviations } from "../ledger.ts";
import { allDeviations, validateTrace, withLayers, type ProbeResult } from "../trace.ts";
import { createWorktree, removeWorktree, worktreePath } from "../worktree.ts";
import { outputPath, phase, phaseForArtifact, type PhaseDef } from "./phases.ts";
import {
  appendManifest,
  readApprovals,
  readArtifact,
  writeArtifact,
  type ArtifactRef,
  type ManifestRecord,
  type PhaseId,
  type Run,
} from "./store.ts";

export interface PhaseInput {
  /** Heading the payload block carries, so the phase can tell its inputs apart. */
  label: string;
  content: string;
  /** Set when the input is a run artifact, for the manifest's `inputs`. */
  ref?: ArtifactRef;
}

export interface PhaseOutcome {
  ok: boolean;
  output?: ArtifactRef;
  error?: string;
  attempts: number;
}

export interface InvocationRecord {
  def: PhaseDef;
  binding: RoleBinding;
  skill: PhaseSkill;
  promptSha: string;
  inputs: ArtifactRef[];
  outputs: ArtifactRef[];
  result: HostResult;
  attempt: number;
  notes: string[];
}

/**
 * Builds the manifest record for one invocation.
 *
 * Shared because Build invokes once per review layer rather than once per phase, and
 * invariant 7 wants every one of those in the manifest on the same terms — same
 * fields, same treatment of failures, same cost attribution.
 */
export function manifestRecord(record: InvocationRecord): ManifestRecord {
  const { def, binding, result } = record;

  return {
    ts: new Date().toISOString(),
    phase: def.id,
    role: def.role,
    host: binding.host,
    model: binding.model,
    ...(binding.effort ? { effort: binding.effort } : {}),
    skill: record.skill.name,
    prompt_sha: record.promptSha,
    inputs: record.inputs,
    outputs: record.outputs,
    duration_s: Math.round(result.duration_s * 10) / 10,
    exit_code: result.exit_code,
    attempt: record.attempt,
    ...(result.usage ? { usage: result.usage } : {}),
    ...(result.cost_usd === undefined ? {} : { cost_usd: result.cost_usd }),
    ...(result.permission_denials ? { permission_denials: result.permission_denials } : {}),
    notes: record.notes,
  };
}

/** Reads one of the run's artifacts as a phase input, hashed for the manifest. */
async function artifactInput(run: Run, path: string, label: string): Promise<PhaseInput> {
  const content = await readArtifact(run, path);
  if (content === null) throw new Error(`Missing input ${path} — run the phase that produces it first`);
  return { label, content, ref: { path, sha: sha256(content) } };
}

function specInput(spec: Runspec, name: string, label: string): PhaseInput[] {
  const content = section(spec, name);
  return content ? [{ label, content }] : [];
}

/**
 * What each phase is given.
 *
 * This function is where design.md §8's input column is enforced. Research's case is
 * load-bearing: it returns the assumptions section alone, and no branch of this
 * function can add to it.
 */
export async function inputsFor(run: Run, spec: Runspec, def: PhaseDef): Promise<PhaseInput[]> {
  const repo = run.meta.repo;
  const design = () => artifactInput(run, "design.md", "The approved design delta");
  const shape = () => artifactInput(run, outputPath(phase("shape"), repo), "The approved shape");

  switch (def.id) {
    case "research":
      return [{ label: "Assumptions to verify", content: researchInput(spec) }];

    case "reconcile":
      return [
        ...specInput(spec, "intent", "Intent"),
        ...specInput(spec, "tickets", "Tickets"),
        ...specInput(spec, "gaps", "Gaps"),
        ...specInput(spec, "out of scope", "Out of scope"),
        await artifactInput(run, "research.md", "Research findings"),
      ];

    case "shape":
      return [...specInput(spec, "intent", "Intent"), await design()];

    case "plan":
      return [await design(), await shape(), ...specInput(spec, "out of scope", "Out of scope")];

    case "probe":
      return [await artifactInput(run, "plan.json", "The approved plan"), await shape()];

    case "build":
      // Build invokes once per review layer, so it assembles a payload per layer in
      // `build.ts` rather than one for the phase. Reaching here means the
      // orchestrator stopped routing it there.
      throw new Error("Build assembles its own per-layer inputs — call runBuild");
  }
}

export function renderPayload(inputs: PhaseInput[]): string {
  return inputs.map((input) => `# ${input.label}\n\n${input.content.trim()}\n`).join("\n");
}

/**
 * Drops anything a phase emitted ahead of its artifact's opening heading.
 *
 * Exported for its test: this is the mechanical half of the `leading` rule, and the
 * validator below is the half that fails a phase whose heading is missing entirely.
 */
export function trimPreamble(output: string, leading?: string): string {
  if (!leading) return output;

  const index = output.indexOf(`\n${leading}`);
  return index === -1 ? output : output.slice(index + 1);
}

/**
 * The outermost JSON object in `output`, or `output` unchanged.
 *
 * The JSON counterpart of `trimPreamble`, and needed for the same reason: a phase
 * asked for a bare object will sometimes wrap it in a sentence. Scans for a balanced
 * pair rather than taking the last `}`, so a trailing remark after the object does
 * not drag unparseable text back in. String contents are skipped, since a brace
 * inside a `detail` field would otherwise unbalance the count.
 */
export function extractJson(output: string): string {
  const start = output.indexOf("{");
  if (start === -1) return output;

  let depth = 0;
  let inString = false;
  let escaped = false;

  for (let i = start; i < output.length; i++) {
    const char = output[i]!;

    if (escaped) escaped = false;
    else if (char === "\\") escaped = true;
    else if (char === '"') inString = !inString;
    else if (!inString && char === "{") depth++;
    else if (!inString && char === "}" && --depth === 0) return output.slice(start, i + 1);
  }

  return output;
}

export interface Validation {
  /** Why the artifact is unusable. Fed back to the phase on the retry. */
  error?: string;
  /** The artifact as it should be stored, when validation normalized it. */
  normalized?: string;
}

/**
 * Checks a phase's output, and normalizes it where the stored form should differ
 * from what the host emitted.
 *
 * JSON artifacts are re-serialized indented. A model emits `plan.json` on one line,
 * and a one-line plan is unreadable at G3 — which design.md §12.1 requires be
 * answerable from a phone. Reformatting on the way in is cheaper than asking the
 * planner to indent and more reliable than hoping it does.
 */
function validate(run: Run, def: PhaseDef, output: string): Validation {
  if (output.trim().length === 0) return { error: "the output was empty" };

  if (def.leading && !output.startsWith(def.leading)) {
    return { error: `the artifact must begin with "${def.leading}"` };
  }

  if (def.format !== "json") return {};

  let parsed: unknown;
  try {
    parsed = JSON.parse(extractJson(output));
  } catch (err) {
    return { error: `the output is not valid JSON: ${err instanceof Error ? err.message : String(err)}` };
  }

  if (def.id === "plan") {
    const problems = validatePlan(parsed, run.meta.config);
    if (problems.length > 0) return { error: problems.join("; ") };
  }

  if (def.id === "probe") {
    const problems = probeProblems(parsed, run.meta.config);
    if (problems.length > 0) return { error: problems.join("; ") };
    parsed = withProbeLayers(parsed as ProbeResult, run.meta.config.layers);
  }

  return { normalized: JSON.stringify(parsed, null, 2) };
}

function probeProblems(parsed: unknown, config: ResolvedConfig): string[] {
  const result = parsed as ProbeResult;
  if (!Array.isArray(result?.traces) || result.traces.length === 0) {
    return ["the probe returned no traces — G4 has nothing to approve"];
  }

  const problems = result.traces.flatMap((trace, i) =>
    validateTrace(trace, config).map((problem) => `traces[${i}]: ${problem}`)
  );

  // Evidence, not assertion: without the checkpoint's own output there is nothing
  // separating a traced execution from a plausible guess about one.
  if (!result.checkpoint_output?.trim()) {
    problems.push("no checkpoint_output — paste what the unit's checkpoint command actually printed");
  }

  return problems;
}

/** Fills each node's layer from the config map, so the renderer can column it. */
function withProbeLayers(result: ProbeResult, layers: Record<string, string>): ProbeResult {
  return { ...result, traces: result.traces.map((trace) => withLayers(trace, layers)) };
}

/**
 * The reviewer's own words, when this phase is being re-entered because they
 * rejected its output.
 *
 * A rejection re-runs the phase with the correction appended — not the whole
 * conversation, just what was wrong. Only the most recent one is carried: an older
 * rejection of an artifact that has since been rewritten is stale advice.
 */
async function reviewerCorrection(run: Run, def: PhaseDef): Promise<string> {
  const rejection = (await readApprovals(run))
    .filter((a) => a.decision === "reject" && a.to && phaseForArtifact(a.to, run.meta.repo)?.id === def.id)
    .at(-1);

  if (!rejection?.reason) return "";
  return `# Correction from your reviewer\n\nThey rejected the previous ${outputPath(def, run.meta.repo)}:\n\n${rejection.reason}\n`;
}

export type SkillLookup =
  | { ok: true; skill: PhaseSkill; sha: string }
  | { ok: false; error: string };

/**
 * Finds the phase's skill where the host will look for it, before anything is spawned.
 *
 * A host that cannot find the skill does not say so. It answers the payload
 * conversationally, with none of the phase's rules and none of its output contract —
 * an invocation billed in full to discover a setup mistake. So the absence is checked
 * here instead, and the phase fails having made no model call at all.
 *
 * `workdir` is the repo for a read-only phase and the worktree for a write one, which
 * is why `.claude/skills/` has to be committed: a worktree carries tracked files only.
 *
 * The hash is of the file as found rather than of the shipped asset, so a hand-edited
 * phase skill is distinguishable in the manifest from the one Valtay ships.
 */
export async function phaseSkillIn(
  workdir: string,
  id: PhaseId,
  adapter: string = DEFAULT_ADAPTER
): Promise<SkillLookup> {
  const path = installedSkillPath(workdir, id, adapter);
  const file = Bun.file(path);

  if (!(await file.exists())) {
    const dir = skillRelDir(phaseSkillName(id), adapter);
    return {
      ok: false,
      error:
        `no ${dir}/SKILL.md in ${workdir} — ` +
        `run \`valtay init\` and commit ${skillRootFor(adapter)}/`,
    };
  }

  return { ok: true, skill: { name: phaseSkillName(id), path }, sha: sha256(await file.text()) };
}

/**
 * Runs one phase, with design.md §18's retry policy.
 *
 * A transport failure retries once on the same binding. A schema-invalid output
 * retries once with the validation error appended, because a model told exactly what
 * was wrong usually fixes it and a second blind attempt usually does not. Every
 * attempt is written to the manifest, failures included (invariant 7).
 */
export async function runPhase(run: Run, spec: Runspec, def: PhaseDef): Promise<PhaseOutcome> {
  const binding = run.meta.config.roles[def.role];
  const host = run.meta.config.hosts[binding.host];
  if (!host) throw new Error(`Role ${def.role} is bound to unknown host ${binding.host}`);

  const inputs = await inputsFor(run, spec, def);
  const output = outputPath(def, run.meta.repo);

  const payload = renderPayload(inputs) + (await reviewerCorrection(run, def));

  // A write phase works in a worktree and nowhere else — that is the fence, and it
  // is why a write phase can be given a shell without risking the checkout you are
  // sitting in.
  const workdir = def.write ? worktreePath(run.meta.run, def.id) : run.meta.repo;
  if (def.write) {
    await createWorktree(run.meta.repo, workdir, `valtay/${run.meta.run}/${def.id}`);
  }

  let correction = "";
  let lastError = "unknown failure";

  try {
    // Inside the try so a write phase's worktree is still cleaned up when the phase
    // never starts. Zero attempts is the honest count: nothing was invoked.
    const found = await phaseSkillIn(workdir, def.id, host.adapter);
    if (!found.ok) return { ok: false, error: found.error, attempts: 0 };

    const base: HostRequest = {
      binding,
      host,
      skill: found.skill,
      input: payload,
      workdir,
      readDirs: [run.dir],
      write: def.write,
      timeout_ms: binding.timeout_ms,
    };

    for (let attempt = 1; attempt <= 2; attempt++) {
      const request = correction ? { ...base, input: `${base.input}\n${correction}` } : base;
      const result = await adapterFor(host.adapter).run(request);
      const artifact = trimPreamble(result.output.trim(), def.leading);

      const checked = result.exit_code === 0 ? validate(run, def, artifact) : {};
      const failure = result.error ?? checked.error;
      const stored = checked.normalized ?? artifact;
      const ref = failure ? undefined : await writeArtifact(run, output, `${stored}\n`);

      await appendManifest(
        run,
        manifestRecord({
          def,
          binding,
          skill: found.skill,
          promptSha: found.sha,
          inputs: inputs.flatMap((i) => (i.ref ? [i.ref] : [])),
          outputs: ref ? [ref] : [],
          result,
          attempt,
          // The adapter's own degradations first, then the failure. A dropped
          // capability is worth recording on a successful attempt too, which is why
          // this is not gated on `failure`.
          notes: [...(result.notes ?? []), ...(failure ? [failure] : [])],
        })
      );

      if (!failure) {
        if (def.id === "probe") await recordProbeDeviations(run, stored);
        return { ok: true, output: ref, attempts: attempt };
      }

      lastError = failure;
      // Stated this bluntly because a politer version got answered conversationally:
      // the phase explained itself in prose instead of re-emitting the artifact.
      correction = checked.error
        ? `# Correction\n\nYour previous output was rejected: ${checked.error}\n\n` +
          "Send the corrected artifact again. Your entire reply must be the artifact " +
          "itself — no explanation, no apology, no commentary before or after it.\n"
        : "";
    }

    return { ok: false, error: lastError, attempts: 2 };
  } finally {
    // In a `finally` on purpose: a probe that failed still leaves a worktree, and a
    // worktree that outlives its phase is a fence nobody is behind.
    if (def.write && def.worktree === "discard") {
      await removeWorktree(run.meta.repo, workdir);
    }
  }
}

/**
 * Appends the probe's deviations to the project ledger.
 *
 * Nothing consumes the ledger yet. It is written from the first run because the
 * promotion rule needs three recurrences to fire, and a history that was never
 * recorded cannot be backfilled.
 */
async function recordProbeDeviations(run: Run, stored: string): Promise<void> {
  const result = JSON.parse(stored) as ProbeResult;
  await recordDeviations(run.meta.repo, run.meta.run, allDeviations(result));
}
