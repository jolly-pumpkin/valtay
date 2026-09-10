import { resolve } from "path";
import { findRepoRoot } from "../detect.ts";
import { PHASES } from "../run/phases.ts";
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
  repo?: string;
  run?: string;
}

export async function selectRun(options: RunSelector): Promise<Run> {
  const start = resolve(options.repo ?? ".");
  const repoRoot = await findRepoRoot(start);
  if (!repoRoot) throw new Error(`No git repository at or above ${start}`);
  return findRun(repoRoot, options.run);
}

async function phaseLines(run: Run, state: RunState): Promise<string[]> {
  const lines: string[] = [];

  for (const def of PHASES) {
    const produced = (await hashArtifact(run, def.output)) !== null;

    let note: string;
    if (!def.gate) {
      note = produced ? "done" : "pending";
    } else {
      const decision = await latestDecision(run, def.gate);
      if (!decision) {
        note = produced ? `${def.gate} awaiting approval` : "pending";
      } else if (decision.decision === "reject") {
        note = `${def.gate} rejected`;
      } else {
        const stale = await staleArtifacts(run, decision);
        note = stale.length > 0
          ? `${def.gate} approval VOID (${stale.join(", ")} edited)`
          : `${def.gate} approved`;
      }
    }

    const marker = state.phase === def.id ? ">" : " ";
    lines.push(`${marker} ${def.title.padEnd(8)} ${def.output.padEnd(14)} ${note}`);
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

  const frozen = await hashArtifact(run, "runspec.md");
  if (frozen !== run.meta.runspec.sha) {
    header.push("  warn    the frozen runspec.md no longer matches its recorded hash");
  }

  return [...header, "", ...(await phaseLines(run, state))];
}
