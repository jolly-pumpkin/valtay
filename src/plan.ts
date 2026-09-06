import type { ResolvedConfig } from "./config.ts";
import type { Scope } from "./gates.ts";

/**
 * One PR. 1..n per release unit; when n > 1 they form a stack.
 *
 * `kind` is single-valued on purpose: design.md §9.3 forbids a layer that mixes
 * mechanical and semantic change, and a field that cannot hold both is a cheaper
 * enforcement than a check that has to notice.
 */
export interface ReviewLayer {
  id: string;
  title: string;
  kind: "mechanical" | "semantic";
  /** True when the layer adds code nothing references yet, so it cannot change behaviour. */
  inert: boolean;
  files: string[];
  est_loc: { add: number; del: number };
  tickets?: string[];
  owners?: string[];
  trace_segment?: string;
}

/** Independently shippable and revertible. */
export interface ReleaseUnit {
  id: string;
  goal: string;
  /** The command that decides whether this unit works. The probe's oracle. */
  checkpoint: string;
  layers: ReviewLayer[];
  tickets?: string[];
  rollback?: string;
  flags?: string[];
}

export interface Plan {
  epic: string;
  stacking?: string;
  release_units: ReleaseUnit[];
  /** What makes G3 a choice among shapes rather than a rubber stamp (design.md §9.5). */
  alternatives_considered: Array<{ shape: string; rejected: string }>;
  release_plan?: unknown;
}

/**
 * What a G3 pre-authorization predicate measures (design.md §12.4).
 *
 * Run-total rather than per-unit, because gates operate on the whole run (§12.2) —
 * `layers` is deliberately the same number `validatePlan` checks against the run
 * budget, so a predicate and a budget cannot disagree about what they counted.
 *
 * `owners` and `flags` are optional and nothing populates them for a single developer
 * in one repo, so both read zero on a real plan today. That is the honest reading: no
 * declared owners means no multi-team layer, not an unanswerable question.
 */
export function planMetrics(plan: Plan): Scope {
  const units = plan.release_units ?? [];
  const layers = units.flatMap((unit) => unit.layers ?? []);
  const semantic = layers.filter((layer) => layer.kind === "semantic");

  return {
    layers: layers.length,
    multiteam_layers: layers.filter((layer) => (layer.owners ?? []).length > 1).length,
    // Total churn, the way a diffstat counts it. Zero when nothing is semantic.
    max_semantic_loc: Math.max(
      0,
      ...semantic.map((layer) => (layer.est_loc?.add ?? 0) + (layer.est_loc?.del ?? 0))
    ),
    new_flags: units.reduce((n, unit) => n + (unit.flags ?? []).length, 0),
  };
}

function isTable(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function layerProblems(layer: unknown, where: string): string[] {
  if (!isTable(layer)) return [`${where} is not an object`];

  const problems: string[] = [];
  const id = typeof layer["id"] === "string" ? layer["id"] : null;
  if (!id) problems.push(`${where} has no id`);

  const at = `layer ${id ?? where}`;
  if (typeof layer["title"] !== "string") problems.push(`${at} has no title`);

  if (layer["kind"] !== "mechanical" && layer["kind"] !== "semantic") {
    problems.push(`${at} has kind ${JSON.stringify(layer["kind"])} — expected mechanical or semantic`);
  }

  if (!Array.isArray(layer["files"]) || layer["files"].length === 0) {
    problems.push(`${at} declares no files — the build fence has nothing to enforce`);
  }

  if (typeof layer["inert"] !== "boolean") {
    problems.push(`${at} does not say whether it is inert`);
  }

  return problems;
}

/**
 * Everything wrong with a plan, as reviewer-readable lines. Empty means valid.
 *
 * Structural checks only. Whether the decomposition is *good* is G3's question and
 * the reviewer's to answer; this decides whether the artifact is well-formed enough
 * to be worth putting in front of them, and whether it fits the run budget the same
 * reviewer set (design.md §9.4 — N is capped by review capacity, not by compute).
 */
export function validatePlan(parsed: unknown, config: ResolvedConfig): string[] {
  if (!isTable(parsed)) return ["the plan is not a JSON object"];

  const problems: string[] = [];
  if (typeof parsed["epic"] !== "string") problems.push("no epic name");

  const units = parsed["release_units"];
  if (!Array.isArray(units) || units.length === 0) {
    problems.push("no release_units");
    return problems;
  }

  if (units.length > config.run.max_units) {
    problems.push(`${units.length} release units exceeds the run budget of ${config.run.max_units}`);
  }

  let layerCount = 0;
  units.forEach((unit, index) => {
    const where = `release_units[${index}]`;
    if (!isTable(unit)) {
      problems.push(`${where} is not an object`);
      return;
    }

    const id = typeof unit["id"] === "string" ? unit["id"] : null;
    if (!id) problems.push(`${where} has no id`);

    const at = `unit ${id ?? where}`;
    if (typeof unit["goal"] !== "string") problems.push(`${at} has no goal`);

    // Without a checkpoint the probe has no oracle and the unit cannot be verified.
    if (typeof unit["checkpoint"] !== "string" || !unit["checkpoint"].trim()) {
      problems.push(`${at} has no checkpoint command`);
    }

    const layers = unit["layers"];
    if (!Array.isArray(layers) || layers.length === 0) {
      problems.push(`${at} has no layers`);
      return;
    }

    layerCount += layers.length;
    layers.forEach((layer, i) => problems.push(...layerProblems(layer, `${at} layer[${i}]`)));
  });

  if (layerCount > config.run.max_layers) {
    problems.push(`${layerCount} review layers exceeds the run budget of ${config.run.max_layers}`);
  }

  const alternatives = parsed["alternatives_considered"];
  if (!Array.isArray(alternatives) || alternatives.length === 0) {
    problems.push("no alternatives_considered — G3 must be a choice among shapes, not a rubber stamp");
  }

  return problems;
}
