import { resolve } from "path";
import { findRepoRoot } from "../detect.ts";
import { PHASES, outputPath } from "../run/phases.ts";
import {
  findRun,
  hashArtifact,
  latestDecision,
  readState,
  staleArtifacts,
  type Run,
  type RunState,
} from "../run/store.ts";

export interface RunSelector {
  /** Repo to look under. Defaults to the enclosing repo of the working directory. */
  repo?: string;
  /** Run name. Optional when the repo has exactly one run. */
  run?: string;
}

/** Resolves the run a gate command should act on. */
export async function selectRun(options: RunSelector): Promise<Run> {
  const start = resolve(options.repo ?? ".");
  const repoRoot = await findRepoRoot(start);
  if (!repoRoot) throw new Error(`No git repository at or above ${start}`);
  return findRun(repoRoot, options.run);
}

/** One line per phase: number, title, artifact, and where it stands. */
async function phaseLines(run: Run, state: RunState): Promise<string[]> {
  const lines: string[] = [];

  for (const def of PHASES) {
    const output = outputPath(def, run.meta.repo);
    const produced = (await hashArtifact(run, output)) !== null;

    let note: string;
    if (!def.gate) {
      note = produced ? "done" : "pending";
    } else {
      const decision = await latestDecision(run, def.gate);
      if (!decision) {
        note = produced ? `${def.gate} awaiting approval` : "pending";
      } else if (decision.decision === "reject") {
        note = `${def.gate} rejected -> ${decision.to ?? "?"}`;
      } else {
        const stale = await staleArtifacts(run, decision);
        const cleared = decision.decision === "auto" ? "auto-passed" : "approved";
        note =
          stale.length > 0
            ? `${def.gate} approval VOID (${stale.join(", ")} edited)`
            : `${def.gate} ${cleared}`;
      }
    }

    const marker = state.phase === def.id ? ">" : " ";
    lines.push(`${marker} ${def.n.padEnd(2)} ${def.title.padEnd(10)} ${output.padEnd(14)} ${note}`);
  }

  return lines;
}

export async function runStatusLines(options: RunSelector): Promise<string[]> {
  const run = await selectRun(options);
  const state = await readState(run);

  const header = [
    `Run "${run.meta.run}" on ${run.meta.repo}`,
    `  dir     ${run.dir}`,
    `  state   ${state.status}${state.gate ? ` ${state.gate}` : ""}`,
    ...(state.note ? [`  note    ${state.note}`] : []),
  ];

  // A spec edited after `start` is a detected event, not a silent divergence
  // (design.md §8.1) — the frozen copy is what the run actually used.
  const frozen = await hashArtifact(run, "runspec.md");
  if (frozen !== run.meta.runspec.sha) {
    header.push("  warn    the frozen runspec.md no longer matches its recorded hash");
  }

  return [...header, "", ...(await phaseLines(run, state))];
}
