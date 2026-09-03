import { advance, artifactsForGate } from "../run/orchestrator.ts";
import {
  artifactNames,
  gates,
  outputPath,
  phaseForArtifact,
  phaseForGate,
  PHASES,
} from "../run/phases.ts";
import { appendApproval, readState, writeState, type GateId } from "../run/store.ts";
import { selectRun, type RunSelector } from "./status.ts";

export interface GateOptions extends RunSelector {
  gate: string;
}

export interface RejectOptions extends GateOptions {
  /** Which artifact was wrong. The run re-enters at the phase that produced it. */
  to: string;
  reason: string;
}

function parseGate(value: string): GateId {
  const gate = value.trim().toUpperCase() as GateId;
  if (!gates().includes(gate)) {
    throw new Error(`No gate ${value} in this pipeline. Gates: ${gates().join(", ")}`);
  }
  return gate;
}

/**
 * Records an approval over every artifact the gate covers, then carries the run on.
 *
 * The approval is bound to artifact hashes rather than to a phase name, so it says
 * "I approved *this* content" and stops meaning anything the moment the content
 * changes (design.md §12.3).
 */
export async function runApprove(options: GateOptions): Promise<string[]> {
  const run = await selectRun(options);
  const gate = parseGate(options.gate);

  const artifacts = await artifactsForGate(run, gate);
  const def = phaseForGate(gate)!;
  const own = outputPath(def, run.meta.repo);
  if (!artifacts.some((a) => a.path === own)) {
    throw new Error(`${gate} has nothing to approve — ${def.title} has not written ${own} yet`);
  }

  await appendApproval(run, {
    ts: new Date().toISOString(),
    gate,
    decision: "approve",
    artifacts,
  });

  return [
    `${gate} approved over ${artifacts.length} artifact(s): ${artifacts.map((a) => a.path).join(", ")}`,
    "",
    ...(await advance(run)),
  ];
}

/**
 * Records a typed rejection and re-enters the phase that owns the named artifact.
 *
 * `--to` is the point. Saying which artifact was wrong is what turns a rejection
 * into control flow rather than a complaint: the run re-enters there, and the reason
 * is handed to that phase on its next invocation.
 */
export async function runReject(options: RejectOptions): Promise<string[]> {
  const run = await selectRun(options);
  const gate = parseGate(options.gate);

  const target = phaseForArtifact(options.to, run.meta.repo);
  if (!target) {
    throw new Error(
      `Cannot re-enter at "${options.to}". Name an artifact: ${artifactNames(run.meta.repo).join(", ")}`
    );
  }

  if (!options.reason.trim()) {
    throw new Error("A rejection needs a reason — it is the phase's only correction.");
  }

  await appendApproval(run, {
    ts: new Date().toISOString(),
    gate,
    decision: "reject",
    to: options.to,
    reason: options.reason,
    artifacts: await artifactsForGate(run, gate),
  });

  const state = await readState(run);
  // Re-entering upstream drops the phases after it back off the completed list, so
  // their gates are asked again rather than riding on approvals given for artifacts
  // that were produced from a design since rejected.
  const reentered = PHASES.slice(PHASES.findIndex((p) => p.id === target.id)).map((p) => p.id);

  await writeState(run, {
    ...state,
    phase: target.id,
    status: "pending",
    gate: undefined,
    rerun: true,
    completed: state.completed.filter((id) => !reentered.includes(id)),
    note: `${gate} rejected to ${target.title}`,
  });

  return [
    `${gate} rejected — re-entering at ${target.n} ${target.title}`,
    `  reason  ${options.reason}`,
    "",
    ...(await advance(run)),
  ];
}
