import { readRunspec, incompleteSections, unresolvedConflicts, type Runspec } from "../runspec.ts";

/**
 * `valtay check <spec>` — advisory lint over a run spec.
 *
 * Never blocks: unlike `preflight` (start.ts), findings here are reported, not
 * thrown. No `.valtay/` state, `writeState`, `appendJsonl`, or `Bun.write` appears
 * anywhere in this path — check reads the spec and prints, nothing else.
 */
export interface CheckOptions {
  /** Path to the run spec to lint. */
  spec: string;
}

/**
 * Advisory only — there is no "error" tier here. A finding never changes the
 * command's exit behavior; `warn` vs `info` is presentational grouping only.
 */
export type FindingLevel = "warn" | "info";

/** One lint finding against a parsed spec. */
export interface Finding {
  level: FindingLevel;
  /** Short machine-stable tag, e.g. "incomplete-section", "unresolved-conflict". */
  rule: string;
  /** Human-readable line, printed as-is. */
  message: string;
}

/**
 * Runs every lint rule over an already-parsed spec.
 *
 * Reuses `incompleteSections`/`unresolvedConflicts` rather than re-deriving their
 * logic — `check` reports what `preflight` would have blocked on, plus whatever
 * else lands here as rules are added (Q-1: the rule set beyond this is open).
 */
export function checkRunspec(spec: Runspec): Finding[] {
  const findings: Finding[] = [];

  for (const conflict of unresolvedConflicts(spec)) {
    findings.push({
      level: "warn",
      rule: "unresolved-conflict",
      message: `unresolved conflict: ${conflict.split("\n")[0]}`,
    });
  }

  for (const name of incompleteSections(spec)) {
    findings.push({
      level: "info",
      rule: "incomplete-section",
      message: `"## ${name}" is missing or still carries a TODO`,
    });
  }

  return findings;
}

/** Renders findings as printable lines, in the shape `status.ts`'s lines take. */
export function formatFindings(spec: Runspec, findings: Finding[]): string[] {
  const header = [`Check "${spec.title}"`, `  spec    ${spec.path}`];

  if (findings.length === 0) {
    return [...header, "", "  no findings"];
  }

  const lines = findings.map((f) => `  ${f.level.padEnd(4)}    [${f.rule}] ${f.message}`);
  return [...header, "", ...lines];
}

/**
 * Loads and lints a spec by path. Pure read: `readRunspec` only opens the file
 * named by `options.spec` — no run directory, no `.valtay/`, no run selection.
 *
 * Mirrors `runStatusLines`'s shape (parse -> pure check -> string[] for the CLI
 * layer to print) rather than introducing a new reporting convention.
 */
export async function runCheck(options: CheckOptions): Promise<string[]> {
  const spec = await readRunspec(options.spec);
  return formatFindings(spec, checkRunspec(spec));
}
