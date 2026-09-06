import { evaluate, failedClause, parsePredicate, type Scope } from "../gates.ts";
import { planMetrics, type Plan } from "../plan.ts";
import { probeMetrics, type ProbeResult } from "../trace.ts";
import { outputPath, phaseForGate } from "./phases.ts";
import { readArtifact, type GateId, type Run } from "./store.ts";

export interface AutoPass {
  passed: boolean;
  /** The predicate that was asked. Recorded on the approval when it passed. */
  predicate: string;
  /** Why it did not pass. Absent when it did. */
  reason?: string;
}

/**
 * What a gate's predicate is evaluated against, read off the artifact the gate covers.
 *
 * A gate the pipeline has no measurements for gets none, which makes its predicate
 * unevaluable rather than vacuously true — the safe direction.
 */
async function scopeFor(run: Run, gate: GateId): Promise<Scope | null> {
  const def = phaseForGate(gate);
  if (!def) return null;

  const stored = await readArtifact(run, outputPath(def, run.meta.repo));
  if (stored === null) return null;

  if (gate === "G3") return planMetrics(JSON.parse(stored) as Plan);
  if (gate === "G4") return probeMetrics(JSON.parse(stored) as ProbeResult);
  return null;
}

/**
 * Whether a pre-authorization clears `gate` (design.md §12.4).
 *
 * Null when the gate carries no predicate — it blocks the way it always has. Every
 * other outcome is a decision this function made, so the caller can say why.
 *
 * Fails closed without exception. A malformed artifact, an unbound variable, a gate
 * with nothing to measure: all of them are reasons a human should look, never reasons
 * to open. The evaluator makes no model call and reads nothing but the artifact on
 * disk (invariants 1 and 2), which is the whole point — a gate cleared by a predicate
 * is cleared by something that cannot be persuaded.
 */
export async function autoPass(run: Run, gate: GateId): Promise<AutoPass | null> {
  const predicate = run.meta.config.gates[gate]?.auto_pass_if;
  if (!predicate) return null;

  try {
    const scope = await scopeFor(run, gate);
    if (!scope) {
      return { passed: false, predicate, reason: `nothing to measure at ${gate}` };
    }

    // G4's floor is not configurable (design.md §12.4). A trace nobody ran and a
    // deviation nobody classified are exactly the cases a predicate must not clear,
    // so they are checked before the predicate rather than left to it to remember.
    if (gate === "G4") {
      if (scope["trace.source"] !== "runtime") {
        return {
          passed: false,
          predicate,
          reason: `G4 needs runtime traces, but the weakest is ${scope["trace.source"]}`,
        };
      }
      if (scope["structural_deviations"] !== 0) {
        return {
          passed: false,
          predicate,
          reason: `G4 needs zero structural deviations, but there are ${scope["structural_deviations"]}`,
        };
      }
    }

    const clauses = parsePredicate(predicate);
    if (evaluate(clauses, scope)) return { passed: true, predicate };

    return { passed: false, predicate, reason: failedClause(clauses, scope) ?? predicate };
  } catch (error) {
    return { passed: false, predicate, reason: (error as Error).message };
  }
}
