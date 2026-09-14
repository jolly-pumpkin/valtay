import { resolve } from "path";
import { mkdir } from "node:fs/promises";
import { readRunspec, designSection, type Runspec } from "../runspec.ts";
import { resolveConfig, bindingFor } from "../config.ts";
import { createWorktree, removeWorktree, worktreePath, git } from "../worktree.ts";
import {
  createRun,
  readState,
  writeState,
  readArtifact,
  writeArtifact,
  readLedger,
  writeLedger,
  type Run,
  type LayerReport,
  type BuildLedger,
} from "./store.ts";
import { advance } from "./orchestrator.ts";
import { providerFor, type Provider } from "./provider.ts";
import { parsePlanUnits, topoSortWaves, parseReport } from "./plan-parser.ts";
import { buildPhasePrompt, buildSubagentPrompt, type PromptContext } from "./prompts.ts";

export interface VerifyFinding {
  what: string;
  actual: string;
  file: string;
  severity: "drift" | "minor";
}

export type RunResult =
  | { outcome: "complete" }
  | { outcome: "drift"; findings: VerifyFinding[] }
  | { outcome: "contested"; layers: LayerReport[] }
  | { outcome: "blocked"; layers: LayerReport[] }
  | { outcome: "failed"; phase: string; reason: string };

export interface RunnerOpts {
  spec: Runspec;
  repoRoot: string;
  runName: string;
  /** Override provider factory (for testing). */
  providerFactory?: (host: string) => Provider;
}

export async function run(opts: RunnerOpts): Promise<RunResult> {
  const { spec, repoRoot, runName } = opts;
  const factory = opts.providerFactory ?? providerFor;
  const config = resolveConfig(spec);
  const theRun = await createRun(repoRoot, runName, spec, config);

  const ctx: PromptContext = {
    runName,
    runDir: theRun.dir,
    repoRoot,
    runspecPath: resolve(theRun.dir, "runspec.md"),
  };

  // ── Plan ────────────────────────────────────────────────
  const planBinding = bindingFor(config, "plan");
  const planProvider = factory(planBinding.host);
  const planPrompt = await buildPhasePrompt("plan", ctx);

  const planResult = await planProvider.dispatch(planPrompt, {
    cwd: repoRoot,
    model: planBinding.model,
    effort: planBinding.effort,
  });

  if (!planResult.ok) {
    return { outcome: "failed", phase: "plan", reason: `Provider exited ${planResult.exitCode}: ${planResult.stderr}` };
  }

  await advance(theRun);
  let state = await readState(theRun);

  if (state.phase !== "build") {
    return { outcome: "failed", phase: "plan", reason: "Plan did not produce plan.md or briefs/" };
  }

  // ── Build ───────────────────────────────────────────────
  const units = await parsePlanUnits(theRun);
  if (units.length === 0) {
    return { outcome: "failed", phase: "build", reason: "No briefs found in briefs/" };
  }

  const waves = topoSortWaves(units);
  const buildBinding = bindingFor(config, "build");
  const buildProvider = factory(buildBinding.host);

  const ledger: BuildLedger = { units: [], updated: "" };
  await mkdir(resolve(theRun.dir, "reports"), { recursive: true });

  for (const wave of waves) {
    const waveResults = await Promise.all(
      wave.units.map(async (unit) => {
        const branch = `valtay/${runName}-${unit.id}`;
        const wtPath = worktreePath(runName, unit.id);
        await createWorktree(repoRoot, wtPath, branch);

        const prompt = await buildSubagentPrompt(unit.id, ctx);
        const result = await buildProvider.dispatch(prompt, {
          cwd: wtPath,
          model: buildBinding.model,
          effort: buildBinding.effort,
        });

        // Read the report the subagent wrote
        const reportContent = await readArtifact(theRun, `reports/${unit.id}.md`);
        const layers: LayerReport[] = reportContent
          ? parseReport(unit.id, reportContent)
          : [{ unit: unit.id, layer: "L1", status: result.ok ? "done" : "blocked", reason: result.ok ? undefined : result.stderr }];

        return { unit: unit.id, layers, branch };
      }),
    );

    // Merge worktree branches in unit order
    for (const result of waveResults) {
      const hasDone = result.layers.some((l) => l.status === "done");
      if (hasDone) {
        const mergeResult = await git(repoRoot, ["merge", "--no-ff", "-m", `valtay: merge ${result.unit}`, result.branch]);
        if (!mergeResult.ok) {
          // Mark all layers as blocked on merge failure
          for (const layer of result.layers) {
            if (layer.status === "done") {
              layer.status = "blocked";
              layer.reason = `Merge failed: ${mergeResult.stderr}`;
            }
          }
        }
      }
    }

    // Update ledger with this wave's results
    for (const result of waveResults) {
      ledger.units.push({ unit: result.unit, layers: result.layers, branch: result.branch });
    }
    await writeLedger(theRun, ledger);
  }

  // Write build summary
  const allLayers = ledger.units.flatMap((u) => u.layers);
  const doneCount = allLayers.filter((l) => l.status === "done").length;
  const contestedLayers = allLayers.filter((l) => l.status === "contested");
  const blockedLayers = allLayers.filter((l) => l.status === "blocked");

  const summaryLines = [
    `# Build Summary`,
    "",
    `- ${ledger.units.length} unit(s), ${allLayers.length} layer(s)`,
    `- ${doneCount} done, ${contestedLayers.length} contested, ${blockedLayers.length} blocked`,
  ];
  await writeArtifact(theRun, "build.md", summaryLines.join("\n") + "\n");

  await advance(theRun);
  state = await readState(theRun);

  if (contestedLayers.length > 0) {
    return { outcome: "contested", layers: contestedLayers };
  }
  if (blockedLayers.length > 0 && state.status === "failed") {
    return { outcome: "blocked", layers: blockedLayers };
  }
  if (state.phase !== "verify") {
    return { outcome: "failed", phase: "build", reason: `Unexpected state after build: ${state.phase}/${state.status}` };
  }

  // ── Verify ──────────────────────────────────────────────
  const verifyBinding = bindingFor(config, "verify");
  const verifyProvider = factory(verifyBinding.host);
  const verifyPrompt = await buildPhasePrompt("verify", ctx);

  const verifyResult = await verifyProvider.dispatch(verifyPrompt, {
    cwd: repoRoot,
    model: verifyBinding.model,
    effort: verifyBinding.effort,
  });

  if (!verifyResult.ok) {
    return { outcome: "failed", phase: "verify", reason: `Provider exited ${verifyResult.exitCode}: ${verifyResult.stderr}` };
  }

  await advance(theRun);
  state = await readState(theRun);

  if (state.status === "complete") {
    return { outcome: "complete" };
  }

  if (state.status === "awaiting_gate") {
    const raw = await readArtifact(theRun, "verify.json");
    if (raw) {
      try {
        const parsed = JSON.parse(raw) as { findings?: VerifyFinding[] };
        return { outcome: "drift", findings: parsed.findings ?? [] };
      } catch {
        return { outcome: "failed", phase: "verify", reason: "verify.json is not valid JSON" };
      }
    }
  }

  return { outcome: "failed", phase: "verify", reason: `Unexpected state after verify: ${state.phase}/${state.status}` };
}
