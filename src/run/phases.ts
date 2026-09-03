import { resolve } from "path";
import { existsSync } from "fs";
import type { Role } from "../config.ts";
import type { GateId, PhaseId } from "./store.ts";

export interface PhaseDef {
  id: PhaseId;
  /** Phase number as design.md §8 tables it. */
  n: string;
  title: string;
  role: Role;
  /** Output artifact, relative to the run directory. `{ext}` is the repo's language. */
  output: string;
  format: "markdown" | "json";
  /** Instruction budget. A phase that wants more must be split (design.md §8). */
  budget: number;
  /** Whether the phase gets a worktree and may write source. */
  write: boolean;
  /**
   * What happens to that worktree afterwards. `discard` is the probe's revert — it
   * is what makes the probe a falsifier rather than a draft, and it is why probe
   * re-entry costs one probe rather than a rollback.
   */
  worktree?: "discard" | "keep";
  /** The gate that follows, if any. */
  gate?: GateId;
  /**
   * The heading the artifact must open with.
   *
   * Phase prompts ask for the bare artifact and models mostly comply, but a working
   * note ahead of it ("Confirmed X. Now writing findings.") is common enough to be
   * worth catching mechanically rather than asking harder. Anything before this
   * heading is dropped; an artifact missing it entirely fails validation and the
   * phase retries with the reason attached (design.md §15, moving a rule down the
   * enforcement ladder from Advisory to Mechanical).
   */
  leading?: string;
  summary: string;
}

/**
 * The pipeline as currently built — design.md §8 minus Assess, Invariants,
 * Conformance, Integration and Retro, which a single-developer single-repo run
 * cannot exercise. Their gates (G5) are absent rather than auto-passed, so nothing
 * records an approval nobody gave.
 */
export const PHASES: readonly PhaseDef[] = [
  {
    id: "research",
    n: "1",
    title: "Research",
    role: "researcher",
    output: "research.md",
    format: "markdown",
    budget: 25,
    write: false,
    leading: "## Findings",
    summary: "facts about the codebase, from the assumptions section alone",
  },
  {
    id: "reconcile",
    n: "2",
    title: "Reconcile",
    role: "designer",
    output: "design.md",
    format: "markdown",
    budget: 30,
    write: false,
    gate: "G1",
    leading: "## End state",
    summary: "the delta between the design and what the code actually does",
  },
  {
    id: "shape",
    n: "3",
    title: "Shape",
    role: "shaper",
    output: "shape.{ext}",
    format: "markdown",
    budget: 30,
    write: false,
    gate: "G2",
    summary: "type and function declarations you hand-edit",
  },
  {
    id: "plan",
    n: "4",
    title: "Plan",
    role: "planner",
    output: "plan.json",
    format: "json",
    budget: 40,
    write: false,
    gate: "G3",
    summary: "release units and review layers",
  },
  {
    id: "probe",
    n: "5",
    title: "Probe",
    role: "prober",
    // One structured document rather than design.md §8's `probe.md` plus
    // `trace/*.json`: the phase writes nothing itself, so the orchestrator stays the
    // only thing that owns an artifact path. `valtay trace` renders it.
    output: "probe.json",
    format: "json",
    budget: 40,
    write: true,
    worktree: "discard",
    gate: "G4",
    summary: "implement, trace, revert — the code is discarded, the trace is kept",
  },
  {
    id: "build",
    n: "7",
    title: "Build",
    role: "builder",
    output: "build.md",
    format: "markdown",
    budget: 35,
    write: true,
    worktree: "keep",
    gate: "G6",
    summary: "working code, per review layer",
  },
] as const;

export function phase(id: PhaseId): PhaseDef {
  const found = PHASES.find((p) => p.id === id);
  if (!found) throw new Error(`Unknown phase: ${id}`);
  return found;
}

/** The phase after `id`, or null when `id` is the last one. */
export function nextPhase(id: PhaseId): PhaseDef | null {
  return PHASES[PHASES.findIndex((p) => p.id === id) + 1] ?? null;
}

/** Gates that exist in the built pipeline, in order. */
export function gates(): GateId[] {
  return PHASES.flatMap((p) => (p.gate ? [p.gate] : []));
}

/** The phase a gate follows. */
export function phaseForGate(gate: GateId): PhaseDef | null {
  return PHASES.find((p) => p.gate === gate) ?? null;
}

const EXT_BY_MARKER: ReadonlyArray<readonly [string, string]> = [
  ["tsconfig.json", "ts"],
  ["package.json", "ts"],
  ["go.mod", "go"],
  ["Cargo.toml", "rs"],
  ["pyproject.toml", "py"],
];

/**
 * Extension for `shape.<ext>`. Shape is code, not prose (design.md §8.4), so it has
 * to land in a file the project's own tooling can parse.
 */
export function shapeExt(repoRoot: string): string {
  const found = EXT_BY_MARKER.find(([marker]) => existsSync(resolve(repoRoot, marker)));
  return found?.[1] ?? "txt";
}

/** A phase's output path with `{ext}` resolved against the repo. */
export function outputPath(def: PhaseDef, repoRoot: string): string {
  return def.output.replace("{ext}", shapeExt(repoRoot));
}

/**
 * The phase that produces `name`, which may be the artifact's path (`design.md`) or
 * its bare stem (`design`).
 *
 * This is what makes `valtay reject g4 --to design` mean something precise. Naming
 * which artifact was wrong is the same discipline the probe's `fix_lives_in` applies
 * (design.md §12.3), with the reviewer as the authority — so the target has to
 * resolve to exactly one phase or be refused.
 */
export function phaseForArtifact(name: string, repoRoot: string): PhaseDef | null {
  const wanted = name.trim().toLowerCase().replace(/\.[^.]+$/, "");

  return (
    PHASES.find((p) => outputPath(p, repoRoot).replace(/\.[^.]+$/, "").toLowerCase() === wanted) ??
    null
  );
}

/** Artifact stems a rejection may name, for error messages and help text. */
export function artifactNames(repoRoot: string): string[] {
  return PHASES.map((p) => outputPath(p, repoRoot));
}
