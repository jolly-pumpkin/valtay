import type { GateId, PhaseId } from "./store.ts";

export interface PhaseDef {
  id: PhaseId;
  title: string;
  /** Output artifact, relative to the run directory. */
  output: string;
  format: "markdown" | "json";
  /** Whether the phase gets a worktree and may write source. */
  write: boolean;
  worktree?: "keep";
  /** The gate that follows, if any. Only verify has one. */
  gate?: GateId;
  summary: string;
}

export const PHASES: readonly PhaseDef[] = [
  {
    id: "plan",
    title: "Plan",
    output: "plan.json",
    format: "json",
    write: false,
    summary: "release units and review layers, cut from the design",
  },
  {
    id: "build",
    title: "Build",
    output: "build.md",
    format: "markdown",
    write: true,
    worktree: "keep",
    summary: "working code, per review layer",
  },
  {
    id: "verify",
    title: "Verify",
    output: "verify.json",
    format: "json",
    write: false,
    gate: "verify",
    summary: "check build against runspec — drift stops the run",
  },
];

export function phase(id: PhaseId): PhaseDef {
  const found = PHASES.find((p) => p.id === id);
  if (!found) throw new Error(`Unknown phase: ${id}`);
  return found;
}

export function nextPhase(id: PhaseId): PhaseDef | null {
  return PHASES[PHASES.findIndex((p) => p.id === id) + 1] ?? null;
}

export function gates(): GateId[] {
  return PHASES.flatMap((p) => (p.gate ? [p.gate] : []));
}

export function phaseForGate(gate: GateId): PhaseDef | null {
  return PHASES.find((p) => p.gate === gate) ?? null;
}
