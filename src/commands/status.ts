import { resolve } from "path";
import { findRepoRoot } from "../detect.ts";
import { PHASES } from "../run/phases.ts";
import {
  findRun,
  hashArtifact,
  latestDecision,
  readInvocations,
  readState,
  staleArtifacts,
  type InvocationRecord,
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

  return [...header, "", ...(await phaseLines(run, state)), ...(await costTimeLines(run))];
}

function formatCostTimeSummary(invocations: InvocationRecord[]): string[] {
  if (invocations.length === 0) return [];

  const phaseOrder = ["plan", "build", "verify"] as const;
  const lines: string[] = [];
  let totalDuration = 0;
  let totalCost = 0;

  for (const phase of phaseOrder) {
    const calls = invocations.filter((inv) => inv.phase === phase);
    if (calls.length === 0) continue;

    const duration = calls.reduce((sum, c) => sum + c.duration_ms, 0);
    const cost = calls.reduce((sum, c) => sum + (c.usage?.cost_usd ?? 0), 0);
    const failed = calls.filter((c) => c.exit_code !== 0).length;

    totalDuration += duration;
    totalCost += cost;

    const durationStr = `${Math.round(duration / 1000)}s`;
    const costStr = `$${cost.toFixed(2)}`;
    const countStr = `${calls.length} ${calls.length === 1 ? "call" : "calls"}`;

    const extras: string[] = [];

    // Show unit breakdown for phases with units (build)
    const withUnits = calls.filter((c) => c.unit);
    if (withUnits.length > 0) {
      const unitCounts = new Map<string, number>();
      for (const c of withUnits) {
        unitCounts.set(c.unit!, (unitCounts.get(c.unit!) ?? 0) + 1);
      }
      const parts = [...unitCounts.entries()]
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([unit, count]) => (count > 1 ? `${unit} x${count}` : unit));
      extras.push(`(${parts.join(", ")})`);
    }

    if (failed > 0) {
      extras.push(`(${failed} failed)`);
    }

    const suffix = extras.length > 0 ? `   ${extras.join("   ")}` : "";
    lines.push(`  ${phase.padEnd(8)} ${durationStr.padStart(6)}   ${costStr.padStart(6)}   ${countStr}${suffix}`);
  }

  const totalDurationStr = `${Math.round(totalDuration / 1000)}s`;
  const totalCostStr = `$${totalCost.toFixed(2)}`;
  lines.push(`  ${"total".padEnd(8)} ${totalDurationStr.padStart(6)}   ${totalCostStr.padStart(6)}`);

  return ["", ...lines];
}

async function costTimeLines(run: Run): Promise<string[]> {
  const invocations = await readInvocations(run);
  return formatCostTimeSummary(invocations);
}
