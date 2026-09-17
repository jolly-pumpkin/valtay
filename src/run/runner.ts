import { resolve } from "path";
import { mkdir } from "node:fs/promises";
import { mkdirSync, writeFileSync } from "node:fs";
import { readRunspec, designSection, sha256, type Runspec } from "../runspec.ts";
import { resolveConfig, bindingFor } from "../config.ts";
import { createWorktree, removeWorktree, worktreePath, git } from "../worktree.ts";
import {
  createRun,
  loadRun,
  readState,
  runDir,
  writeState,
  readArtifact,
  writeArtifact,
  readLedger,
  writeLedger,
  appendInvocation,
  type Run,
  type LayerReport,
  type BuildLedger,
  type InvocationRecord,
} from "./store.ts";
import { pathExists } from "../detect.ts";
import { advance } from "./orchestrator.ts";
import { providerFor, dispatchNotes, type Provider, type DispatchResult } from "./provider.ts";
import { formatEvent } from "./progress.ts";
import { parsePlanUnits, topoSortWaves, parseReport, type PlanUnit } from "./plan-parser.ts";
import { buildPhasePrompt, buildSubagentPrompt, type PromptContext } from "./prompts.ts";
import { importGraph, waveConflicts, formatConflicts } from "./fileset.ts";

/**
 * Run a setup command in the given directory.
 * Uses `sh -c` with a 10-minute timeout. Captures combined stdout+stderr,
 * keeps only the last 200 lines.
 */
export async function runSetup(cwd: string, cmd: string): Promise<{ ok: boolean; output: string }> {
  const proc = Bun.spawn(["sh", "-c", cmd], {
    cwd,
    stdout: "pipe",
    stderr: "pipe",
  });

  const timeout = setTimeout(() => proc.kill(), 10 * 60 * 1000);
  const [stdout, stderr] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  const exitCode = await proc.exited;
  clearTimeout(timeout);

  const combined = (stdout + stderr).split("\n");
  const output = combined.slice(-200).join("\n").trimEnd();

  return { ok: exitCode === 0, output };
}

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

/**
 * Run checkpoint commands for units that have them. Writes checkpoint.md
 * to the run directory. Returns the path to checkpoint.md if any checkpoints
 * were run, undefined otherwise.
 */
async function runCheckpoints(
  units: PlanUnit[],
  cwd: string,
  runDirPath: string,
): Promise<string | undefined> {
  const unitsWithCheckpoints = units.filter((u) => u.checkpoint);
  if (unitsWithCheckpoints.length === 0) return undefined;

  const sections: string[] = [];

  for (const unit of unitsWithCheckpoints) {
    const start = Date.now();
    const proc = Bun.spawn(["sh", "-c", unit.checkpoint!], {
      cwd,
      stdout: "pipe",
      stderr: "pipe",
    });

    const timeout = setTimeout(() => proc.kill(), 10 * 60 * 1000);
    const [stdout, stderr] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
    ]);
    const exitCode = await proc.exited;
    clearTimeout(timeout);
    const elapsed = ((Date.now() - start) / 1000).toFixed(1);

    const combined = (stdout + stderr).split("\n");
    const last200 = combined.slice(-200).join("\n").trimEnd();

    sections.push(`## ${unit.id} — \`${unit.checkpoint}\` — exit ${exitCode} — ${elapsed}s\n\`\`\`\n${last200}\n\`\`\``);
  }

  const checkpointPath = resolve(runDirPath, "checkpoint.md");
  await Bun.write(checkpointPath, sections.join("\n\n") + "\n");
  return checkpointPath;
}

/** Clean up unit worktrees and branches after build completes. Keep integration branch. */
async function cleanupWorktrees(
  repoRoot: string,
  wtPaths: string[],
  runName: string,
  units: PlanUnit[],
): Promise<void> {
  for (const wtPath of wtPaths) {
    try { await removeWorktree(repoRoot, wtPath); } catch { /* best effort */ }
  }
  for (const unit of units) {
    const branch = `valtay/${runName}-${unit.id}`;
    await git(repoRoot, ["branch", "-D", branch]); // best effort
  }
}

/** Write the fileset manifest for a unit. Returns the absolute path to the manifest. */
export async function writeFilesetManifest(
  runDir: string,
  unitId: string,
  files: string[],
  reportPath: string,
): Promise<string> {
  const dir = resolve(runDir, "filesets");
  await mkdir(dir, { recursive: true });
  const manifestPath = resolve(dir, `${unitId}.txt`);
  const content = [...files, reportPath].join("\n") + "\n";
  await Bun.write(manifestPath, content);
  return manifestPath;
}

/** Write .claude/settings.local.json into the worktree with the fileset hook config. */
export async function writeHookConfig(
  wtPath: string,
  assetsDir: string,
  _filesetPath: string,
): Promise<void> {
  const config = {
    hooks: {
      PreToolUse: [
        {
          matcher: "Edit|Write|NotebookEdit",
          hooks: [
            {
              type: "command",
              command: `bun ${resolve(assetsDir, "hooks/fileset.ts")}`,
            },
          ],
        },
      ],
    },
  };
  const configDir = resolve(wtPath, ".claude");
  await mkdir(configDir, { recursive: true });
  await Bun.write(
    resolve(configDir, "settings.local.json"),
    JSON.stringify(config, null, 2) + "\n",
  );
}

/** Write the git exclude file and return env vars to keep .claude/settings.local.json off the branch. */
export function hookExcludeEnv(runDir: string): Record<string, string> {
  const hooksDir = resolve(runDir, "hooks");
  mkdirSync(hooksDir, { recursive: true });
  const excludePath = resolve(hooksDir, "exclude");
  writeFileSync(excludePath, ".claude/settings.local.json\n");
  return {
    GIT_CONFIG_COUNT: "1",
    GIT_CONFIG_KEY_0: "core.excludesFile",
    GIT_CONFIG_VALUE_0: excludePath,
  };
}

export async function run(opts: RunnerOpts): Promise<RunResult> {
  const { spec, repoRoot, runName } = opts;
  const factory = opts.providerFactory ?? providerFor;
  const config = resolveConfig(spec, repoRoot);

  // Re-entrant: load existing run or create a new one
  const dir = runDir(repoRoot, runName);
  let theRun: Run;
  if (await pathExists(resolve(dir, "run.json"))) {
    theRun = await loadRun(dir);
  } else {
    theRun = await createRun(repoRoot, runName, spec, config);
  }

  const ctx: PromptContext = {
    runName,
    runDir: theRun.dir,
    repoRoot,
    runspecPath: resolve(theRun.dir, "runspec.md"),
  };

  let state = await readState(theRun);

  // Create logs directory for streaming event logs
  const logsDir = resolve(theRun.dir, "logs");
  await mkdir(logsDir, { recursive: true });

  // ── Plan ────────────────────────────────────────────────
  if (state.phase === "plan" && state.status !== "complete") {
    // If rerun, re-dispatch even if artifact exists
    if (state.rerun) {
      await writeState(theRun, { ...state, rerun: undefined });
    }

    const planBinding = bindingFor(config, "plan");
    const planProvider = factory(planBinding.host);
    const planPrompt = await buildPhasePrompt("plan", ctx);

    const planStart = Date.now();
    const planResult = await planProvider.dispatch(planPrompt, {
      cwd: repoRoot,
      model: planBinding.model,
      effort: planBinding.effort,
      write: false,
      artifactDir: theRun.dir,
      logPath: resolve(logsDir, "plan.jsonl"),
      onEvent: (line) => {
        const formatted = formatEvent(line, "plan");
        if (formatted) console.log(formatted);
      },
    });

    await appendInvocation(theRun, {
      ts: new Date().toISOString(),
      phase: "plan",
      attempt: 1,
      host: planBinding.host,
      model: planBinding.model,
      effort: planBinding.effort,
      prompt_sha: sha256(planPrompt),
      exit_code: planResult.exitCode,
      duration_ms: Date.now() - planStart,
      usage: planResult.usage,
      notes: dispatchNotes(planResult),
    });

    if (!planResult.ok) {
      return { outcome: "failed", phase: "plan", reason: `Provider exited ${planResult.exitCode}: ${planResult.stderr}` };
    }

    await advance(theRun);
    state = await readState(theRun);

    if (state.phase !== "build") {
      return { outcome: "failed", phase: "plan", reason: "Plan did not produce plan.md or briefs/" };
    }
  }

  // ── Build ───────────────────────────────────────────────
  state = await readState(theRun);
  if (state.phase === "build" && state.status !== "complete") {
    const units = await parsePlanUnits(theRun);
    if (units.length === 0) {
      return { outcome: "failed", phase: "build", reason: "No briefs found in briefs/" };
    }

    const buildBinding = bindingFor(config, "build");
    const buildProvider = factory(buildBinding.host);
    await mkdir(resolve(theRun.dir, "reports"), { recursive: true });
    const assetsDir = resolve(import.meta.dir, "../../assets");

    // Record base commit and create runner-owned integration branch
    const integrationBranch = `valtay/${runName}`;
    let baseCommit = theRun.meta.baseCommit;
    if (!baseCommit) {
      const headResult = await git(repoRoot, ["rev-parse", "HEAD"]);
      baseCommit = headResult.ok ? headResult.stdout : "unknown";
      theRun.meta.baseCommit = baseCommit;
      theRun.meta.integrationBranch = integrationBranch;
      await Bun.write(
        resolve(theRun.dir, "run.json"),
        `${JSON.stringify(theRun.meta, null, 2)}\n`,
      );
    }

    // Create integration branch worktree
    const integrationWtPath = worktreePath(runName, "integration");
    // Reuse on re-entry: the branch already carries earlier waves' merges.
    await createWorktree(repoRoot, integrationWtPath, integrationBranch, "HEAD", { reuse: true });

    // Update context with base commit info for verify prompt
    ctx.baseCommit = baseCommit;
    ctx.integrationBranch = integrationBranch;

    // Track all unit worktrees for cleanup
    const unitWorktreePaths: string[] = [];

    // Build loop: dispatch waves, check advance, retry if blocked layers remain
    for (;;) {
      const existingLedger = await readLedger(theRun);
      const doneUnits = new Set(
        existingLedger?.units
          .filter((u) => u.layers.every((l) => l.status === "done"))
          .map((u) => u.unit) ?? []
      );
      const pendingUnits = units.filter((u) => !doneUnits.has(u.id));

      if (pendingUnits.length === 0) break;

      if (existingLedger) {
        for (const entry of existingLedger.units) {
          for (const layer of entry.layers) {
            if (layer.status === "blocked") {
              layer.status = "pending";
              layer.reason = undefined;
            }
          }
        }
        await writeLedger(theRun, existingLedger);
      }

      const waves = topoSortWaves(pendingUnits);
      const ledger: BuildLedger = existingLedger ?? { units: [], updated: "" };

      let waveIdx = 0;
      for (const wave of waves) {
        // Check for file-set conflicts before dispatching
        const allWaveFiles = wave.units.flatMap((u) => u.files);
        const graph = await importGraph(integrationWtPath, allWaveFiles);
        const conflicts = waveConflicts(wave, graph);
        if (conflicts.length > 0) {
          const messages = formatConflicts(conflicts);
          const reason = messages.join("\n");
          await writeState(theRun, { ...state, status: "failed", note: reason });
          await cleanupWorktrees(repoRoot, unitWorktreePaths, runName, units);
          return { outcome: "failed", phase: "build", reason };
        }

        // Snapshot checkout integrity before wave dispatch
        const preWaveStatus = await git(repoRoot, ["status", "--porcelain"]);

        // Create worktrees serially from integration branch (avoid git lock contention)
        const worktrees: Array<{ unit: typeof wave.units[number]; branch: string; wtPath: string }> = [];
        for (const unit of wave.units) {
          const branch = `valtay/${runName}-${unit.id}`;
          const wtPath = worktreePath(runName, unit.id);
          await createWorktree(repoRoot, wtPath, branch, integrationBranch);
          worktrees.push({ unit, branch, wtPath });
          unitWorktreePaths.push(wtPath);
        }

        // Run setup command in each worktree if configured
        const setupBlockedUnits = new Map<string, string>();
        if (config.setup) {
          for (const { unit, wtPath } of worktrees) {
            const setupStart = Date.now();
            const setupResult = await runSetup(wtPath, config.setup);
            const setupDuration = Date.now() - setupStart;
            const exitCode = setupResult.ok ? 0 : 1;

            await appendInvocation(theRun, {
              ts: new Date().toISOString(),
              phase: "build",
              unit: unit.id,
              attempt: 1,
              host: "local",
              model: "sh",
              prompt_sha: sha256(config.setup),
              exit_code: exitCode,
              duration_ms: setupDuration,
              notes: [`setup: ${config.setup} exit ${exitCode} ${(setupDuration / 1000).toFixed(1)}s`],
            });

            if (!setupResult.ok) {
              setupBlockedUnits.set(unit.id, setupResult.output);
            }
          }
        }

        // Dispatch in parallel
        const waveResults = await Promise.all(
          worktrees.map(async ({ unit, branch, wtPath }) => {
            // If setup failed for this unit, block all layers and skip dispatch
            if (setupBlockedUnits.has(unit.id)) {
              const tail = setupBlockedUnits.get(unit.id)!;
              const reportContent = await readArtifact(theRun, `reports/${unit.id}.md`);
              const layers: LayerReport[] = reportContent
                ? parseReport(unit.id, reportContent).map((l) => ({
                    ...l,
                    status: "blocked" as const,
                    reason: `setup failed: ${tail}`,
                  }))
                : [{ unit: unit.id, layer: "L1", status: "blocked" as const, reason: `setup failed: ${tail}` }];
              return { unit: unit.id, layers, branch, files: unit.files };
            }

            const prompt = await buildSubagentPrompt(unit.id, ctx);
            const reportPath = resolve(theRun.dir, `reports/${unit.id}.md`);
            const filesetPath = await writeFilesetManifest(theRun.dir, unit.id, unit.files, reportPath);
            await writeHookConfig(wtPath, assetsDir, filesetPath);
            const excludeEnv = hookExcludeEnv(theRun.dir);

            const buildStart = Date.now();
            const result = await buildProvider.dispatch(prompt, {
              cwd: wtPath,
              model: buildBinding.model,
              effort: buildBinding.effort,
              write: true,
              env: {
                VALTAY_FILESET: filesetPath,
                ...excludeEnv,
              },
              logPath: resolve(logsDir, `build-${unit.id}.jsonl`),
              onEvent: (line) => {
                const formatted = formatEvent(line, unit.id);
                if (formatted) console.log(formatted);
              },
            });

            await appendInvocation(theRun, {
              ts: new Date().toISOString(),
              phase: "build",
              unit: unit.id,
              attempt: 1,
              host: buildBinding.host,
              model: buildBinding.model,
              effort: buildBinding.effort,
              prompt_sha: sha256(prompt),
              exit_code: result.exitCode,
              duration_ms: Date.now() - buildStart,
              usage: result.usage,
              notes: dispatchNotes(result),
            });

            const reportContent = await readArtifact(theRun, `reports/${unit.id}.md`);
            const layers: LayerReport[] = reportContent
              ? parseReport(unit.id, reportContent)
              : [{ unit: unit.id, layer: "L1", status: result.ok ? "done" : "blocked", reason: result.ok ? undefined : result.stderr }];

            return { unit: unit.id, layers, branch, files: unit.files };
          }),
        );

        // Fence detection and merge unit branches into integration worktree
        for (const result of waveResults) {
          // Detect fence violations before merge
          let fenceViolations: string[] = [];
          if (result.files.length > 0) {
            const diffResult = await git(integrationWtPath, [
              "diff", "--name-only", `${integrationBranch}...${result.branch}`,
            ]);
            if (diffResult.ok && diffResult.stdout) {
              const touchedFiles = diffResult.stdout.split("\n").filter((f) => f.trim());
              const allowedSet = new Set(result.files);
              fenceViolations = touchedFiles.filter(
                (f) => !allowedSet.has(f) && f !== ".claude/settings.local.json",
              );
            }
          }
          if (fenceViolations.length > 0) {
            console.log(`fence: ${result.unit}: ${fenceViolations.join(", ")}`);
            for (const layer of result.layers) {
              layer.status = "blocked";
              layer.reason = `fence violations: ${fenceViolations.join(", ")}`;
            }
          }

          const hasDone = result.layers.some((l) => l.status === "done");
          if (hasDone) {
            const mergeResult = await git(integrationWtPath, [
              "merge", "--no-ff", "-m", `valtay: merge ${result.unit}`, result.branch,
            ]);
            if (!mergeResult.ok) {
              // Abort the failed merge so the worktree is clean for the next wave
              await git(integrationWtPath, ["merge", "--abort"]);
              for (const layer of result.layers) {
                if (layer.status === "done") {
                  layer.status = "blocked";
                  layer.reason = `Merge failed: ${mergeResult.stderr}`;
                }
              }
            }
          }

          // Update ledger with fence violations
          const existing = ledger.units.findIndex((u) => u.unit === result.unit);
          const entry = { unit: result.unit, layers: result.layers, branch: result.branch, fenceViolations };
          if (existing >= 0) {
            ledger.units[existing] = entry;
          } else {
            ledger.units.push(entry);
          }
        }
        // Checkout integrity check after wave dispatch + merge
        const postWaveStatus = await git(repoRoot, ["status", "--porcelain"]);
        if (preWaveStatus.stdout !== postWaveStatus.stdout) {
          const diff = `checkout changed during wave ${waveIdx}`;
          for (const result of waveResults) {
            const entry = ledger.units.find((u) => u.unit === result.unit);
            if (entry) {
              entry.fenceViolations = [...(entry.fenceViolations ?? []), diff];
            }
          }

          const preLines = (preWaveStatus.stdout ?? "").split("\n").filter(Boolean);
          const postLines = (postWaveStatus.stdout ?? "").split("\n").filter(Boolean);
          const integrityDiff = postLines.filter((l) => !preLines.includes(l)).slice(0, 5);
          const notes = [`checkout changed during wave ${waveIdx}: ${integrityDiff.join(", ")}`];

          await appendInvocation(theRun, {
            ts: new Date().toISOString(),
            phase: "build",
            unit: `wave-${waveIdx}`,
            attempt: 1,
            host: "runner",
            model: "integrity-check",
            prompt_sha: "",
            exit_code: 0,
            duration_ms: 0,
            notes,
          });
        }

        await writeLedger(theRun, ledger);
        waveIdx++;
      }

      // Write build summary
      const allLayers = ledger.units.flatMap((u) => u.layers);
      const doneCount = allLayers.filter((l) => l.status === "done").length;
      const contestedCount = allLayers.filter((l) => l.status === "contested").length;
      const blockedCount = allLayers.filter((l) => l.status === "blocked").length;

      await writeArtifact(theRun, "build.md", [
        `# Build Summary`,
        "",
        `- ${ledger.units.length} unit(s), ${allLayers.length} layer(s)`,
        `- ${doneCount} done, ${contestedCount} contested, ${blockedCount} blocked`,
      ].join("\n") + "\n");

      await advance(theRun);
      state = await readState(theRun);

      const contestedLayers = allLayers.filter((l) => l.status === "contested");
      if (contestedLayers.length > 0) {
        await cleanupWorktrees(repoRoot, unitWorktreePaths, runName, units);
        return { outcome: "contested", layers: contestedLayers };
      }

      if (state.status === "failed") {
        const blockedLayers = allLayers.filter((l) => l.status === "blocked");
        await cleanupWorktrees(repoRoot, unitWorktreePaths, runName, units);
        return { outcome: "blocked", layers: blockedLayers };
      }

      if (state.phase === "build" && state.status === "pending" && state.rerun) {
        await writeState(theRun, { ...state, rerun: undefined });
        continue;
      }

      break;
    }

    // Clean up unit worktrees and branches (keep integration branch)
    await cleanupWorktrees(repoRoot, unitWorktreePaths, runName, units);

    state = await readState(theRun);
    if (state.phase !== "verify") {
      return { outcome: "failed", phase: "build", reason: `Unexpected state after build: ${state.phase}/${state.status}` };
    }
  } // end build phase guard

  // ── Verify ──────────────────────────────────────────────
  state = await readState(theRun);
  if (state.phase === "verify" && state.status === "pending") {
    if (state.rerun) {
      await writeState(theRun, { ...state, rerun: undefined });
    }

    // Ensure context has base commit info (may be resuming from a previous run)
    if (!ctx.baseCommit && theRun.meta.baseCommit) {
      ctx.baseCommit = theRun.meta.baseCommit;
      ctx.integrationBranch = theRun.meta.integrationBranch;
    }

    // Verify runs against the integration worktree where the built code lives
    const verifyCwd = theRun.meta.integrationBranch
      ? worktreePath(runName, "integration")
      : repoRoot;

    // Run setup in integration worktree before checkpoints
    if (config.setup) {
      const setupStart = Date.now();
      const setupResult = await runSetup(verifyCwd, config.setup);
      const setupDuration = Date.now() - setupStart;
      const exitCode = setupResult.ok ? 0 : 1;

      await appendInvocation(theRun, {
        ts: new Date().toISOString(),
        phase: "build",
        unit: "integration",
        attempt: 1,
        host: "local",
        model: "sh",
        prompt_sha: sha256(config.setup),
        exit_code: exitCode,
        duration_ms: setupDuration,
        notes: [`setup: ${config.setup} exit ${exitCode} ${(setupDuration / 1000).toFixed(1)}s`],
      });
    }

    // Run checkpoints before verify dispatch
    const units = await parsePlanUnits(theRun);
    const checkpointPath = await runCheckpoints(units, verifyCwd, theRun.dir);
    if (checkpointPath) {
      ctx.checkpointPath = checkpointPath;
    }

    const verifyBinding = bindingFor(config, "verify");
    const verifyProvider = factory(verifyBinding.host);
    const verifyPrompt = await buildPhasePrompt("verify", ctx);

    const verifyStart = Date.now();
    const verifyResult = await verifyProvider.dispatch(verifyPrompt, {
      cwd: verifyCwd,
      model: verifyBinding.model,
      effort: verifyBinding.effort,
      write: false,
      artifactDir: theRun.dir,
      logPath: resolve(logsDir, "verify.jsonl"),
      onEvent: (line) => {
        const formatted = formatEvent(line, "verify");
        if (formatted) console.log(formatted);
      },
    });

    await appendInvocation(theRun, {
      ts: new Date().toISOString(),
      phase: "verify",
      attempt: 1,
      host: verifyBinding.host,
      model: verifyBinding.model,
      effort: verifyBinding.effort,
      prompt_sha: sha256(verifyPrompt),
      exit_code: verifyResult.exitCode,
      duration_ms: Date.now() - verifyStart,
      usage: verifyResult.usage,
      notes: dispatchNotes(verifyResult),
    });

    if (!verifyResult.ok) {
      return { outcome: "failed", phase: "verify", reason: `Provider exited ${verifyResult.exitCode}: ${verifyResult.stderr}` };
    }

    await advance(theRun);
    state = await readState(theRun);
  }

  if (state.status === "complete") {
    const rejPath = resolve(theRun.dir, "rejection.md");
    if (await Bun.file(rejPath).exists()) {
      const { unlink } = await import("node:fs/promises");
      await unlink(rejPath);
    }
    return { outcome: "complete" };
  }

  if (state.phase === "verify" && state.status === "awaiting_gate") {
    const raw = await readArtifact(theRun, "verify.json");
    if (raw) {
      try {
        const parsed = JSON.parse(raw) as { findings?: VerifyFinding[] };
        const findings = parsed.findings ?? [];
        console.log(`verify parked — ${findings.length} finding(s). Use valtay approve/reject to continue.`);
        return { outcome: "drift", findings };
      } catch {
        return { outcome: "failed", phase: "verify", reason: "verify.json is not valid JSON" };
      }
    }
  }

  if (state.phase === "verify" && state.status === "failed") {
    console.log(`verify failed. Use valtay reject to re-enter.`);
    return { outcome: "failed", phase: "verify", reason: "verify previously failed" };
  }

  return { outcome: "failed", phase: "verify", reason: `Unexpected state after verify: ${state.phase}/${state.status}` };
}
