import { readRunspec, type Runspec } from "../runspec.ts";
import { runPhase } from "./invoke.ts";
import { PHASES, nextPhase, outputPath, phase, type PhaseDef } from "./phases.ts";
import {
  hashArtifact,
  isApproved,
  latestDecision,
  readState,
  writeState,
  type ArtifactRef,
  type GateId,
  type Run,
} from "./store.ts";

/**
 * Every artifact produced up to and including `def`.
 *
 * A gate approval is bound to this whole set, not just the phase's own output, so
 * that editing an upstream artifact voids the approval *and everything downstream*
 * as design.md §12.3 requires. Approving G3 while G1's design has changed underneath
 * would otherwise record consent nobody gave.
 */
export async function gateArtifacts(run: Run, def: PhaseDef): Promise<ArtifactRef[]> {
  const upTo = PHASES.slice(0, PHASES.findIndex((p) => p.id === def.id) + 1);

  const refs = await Promise.all(
    upTo.map(async (p) => {
      const path = outputPath(p, run.meta.repo);
      const sha = await hashArtifact(run, path);
      return sha === null ? null : { path, sha };
    })
  );

  return refs.filter((ref): ref is ArtifactRef => ref !== null);
}

/** The artifacts a gate covers, for `approve` and for display. */
export async function artifactsForGate(run: Run, gate: GateId): Promise<ArtifactRef[]> {
  const def = PHASES.find((p) => p.gate === gate);
  if (!def) throw new Error(`No gate ${gate} in this pipeline`);
  return gateArtifacts(run, def);
}

/**
 * Clears a halted run so the failed phase can be attempted again.
 *
 * A failed phase has already had design.md §18's retries; the run halts rather than
 * looping, because a third blind attempt at something broken is waste. Retrying is
 * therefore a deliberate act — you fixed the cause, in the harness or in the repo —
 * and never something `advance` decides on its own.
 */
export async function retry(run: Run): Promise<string[]> {
  const state = await readState(run);
  if (state.status !== "failed") return [`Run is ${state.status} — nothing to retry.`];

  await writeState(run, { ...state, status: "pending", rerun: true, note: undefined });
  return [`Retrying ${phase(state.phase).title}.`, ""];
}

/**
 * Runs phases until something needs a human.
 *
 * The orchestrator makes no model calls of its own (invariant 1) and holds no state
 * in memory between phases (invariant 2) — every decision here reads `state.json`
 * and the artifacts on disk, which is what makes "resume" and "run on another
 * machine" the same operation (design.md §18).
 */
export async function advance(run: Run, spec?: Runspec): Promise<string[]> {
  const runspec = spec ?? (await readRunspec(`${run.dir}/runspec.md`));
  const lines: string[] = [];

  for (;;) {
    const state = await readState(run);
    if (state.status === "complete" || state.status === "failed") {
      lines.push(`Run is ${state.status}.${state.note ? ` ${state.note}` : ""}`);
      if (state.status === "failed") lines.push("Fix the cause, then `valtay resume --retry`.");
      return lines;
    }

    const def = phase(state.phase);
    const output = outputPath(def, run.meta.repo);
    const produced = (await hashArtifact(run, output)) !== null;

    if (!produced || state.rerun) {
      lines.push(`${def.n} ${def.title} — ${def.summary}`);
      const outcome = await runPhase(run, runspec, def);

      if (!outcome.ok) {
        await writeState(run, {
          ...state,
          status: "failed",
          rerun: false,
          note: `${def.title} failed after ${outcome.attempts} attempt(s): ${outcome.error}`,
        });
        lines.push(`  FAILED after ${outcome.attempts} attempt(s): ${outcome.error}`);
        return lines;
      }

      lines.push(`  wrote ${output}`);
      await writeState(run, { ...state, rerun: false });
    }

    if (def.gate && !(await isApproved(run, def.gate))) {
      const decision = await latestDecision(run, def.gate);
      const note =
        decision?.decision === "reject"
          ? `${def.gate} was rejected to ${decision.to ?? "?"} — re-run that phase first`
          : undefined;

      await writeState(run, {
        ...state,
        status: "awaiting_gate",
        gate: def.gate,
        rerun: false,
        ...(note ? { note } : { note: undefined }),
      });

      lines.push(`  ${def.gate} — review, then \`valtay approve ${def.gate}\``);
      return lines;
    }

    const next = nextPhase(def.id);
    const completed = state.completed.includes(def.id)
      ? state.completed
      : [...state.completed, def.id];

    if (!next) {
      await writeState(run, { ...state, status: "complete", completed, rerun: false, gate: undefined });
      lines.push("Run complete.");
      return lines;
    }

    await writeState(run, {
      phase: next.id,
      status: "pending",
      completed,
      updated: state.updated,
      gate: undefined,
      rerun: false,
    });
  }
}
