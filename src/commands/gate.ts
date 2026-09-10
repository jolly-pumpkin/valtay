import { advance, gateArtifacts } from "../run/orchestrator.ts";
import { PHASES, phaseForGate } from "../run/phases.ts";
import { appendApproval, hashArtifact, readState, writeState, type GateId } from "../run/store.ts";
import { selectRun, type RunSelector } from "./status.ts";

export interface GateOptions extends RunSelector {
  gate: string;
}

export interface RejectOptions extends GateOptions {
  to: string;
  reason: string;
}

function parseGate(value: string): GateId {
  const gate = value.trim().toLowerCase();
  if (gate !== "verify") {
    throw new Error(`No gate "${value}". The only gate is "verify".`);
  }
  return gate as GateId;
}

export async function runApprove(options: GateOptions): Promise<string[]> {
  const run = await selectRun(options);
  const gate = parseGate(options.gate);

  const def = phaseForGate(gate)!;
  const sha = await hashArtifact(run, def.output);
  if (!sha) {
    throw new Error(`${gate} has nothing to approve — ${def.title} has not written ${def.output} yet`);
  }

  const artifacts = await gateArtifacts(run);

  await appendApproval(run, {
    ts: new Date().toISOString(),
    gate,
    decision: "approve",
    artifacts,
  });

  return [
    `verify approved (${artifacts.length} artifact(s))`,
    "",
    ...(await advance(run)),
  ];
}

export async function runReject(options: RejectOptions): Promise<string[]> {
  const run = await selectRun(options);
  const gate = parseGate(options.gate);

  const targetId = options.to.trim().toLowerCase();
  const target = PHASES.find((p) => p.id === targetId);
  if (!target) {
    throw new Error(
      `Cannot re-enter at "${options.to}". Valid phases: ${PHASES.map((p) => p.id).join(", ")}`
    );
  }

  if (!options.reason.trim()) {
    throw new Error("A rejection needs a reason.");
  }

  const artifacts = await gateArtifacts(run);

  await appendApproval(run, {
    ts: new Date().toISOString(),
    gate,
    decision: "reject",
    reason: options.reason,
    artifacts,
  });

  const state = await readState(run);
  const reentered = PHASES.slice(PHASES.findIndex((p) => p.id === target.id)).map((p) => p.id);

  await writeState(run, {
    ...state,
    phase: target.id,
    status: "pending",
    gate: undefined,
    rerun: true,
    completed: state.completed.filter((id) => !reentered.includes(id)),
    note: `verify rejected to ${target.title}`,
  });

  return [
    `verify rejected — re-entering at ${target.title}`,
    `  reason  ${options.reason}`,
  ];
}
