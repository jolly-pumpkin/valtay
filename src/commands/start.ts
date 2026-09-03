import { resolve, dirname, basename } from "path";
import { findRepoRoot } from "../detect.ts";
import { resolveConfig } from "../config.ts";
import { readRunspec, unresolvedConflicts, section, ASSUMPTIONS, type Runspec } from "../runspec.ts";
import { createRun, type Run } from "../run/store.ts";

export interface StartOptions {
  /** Path to the run spec. */
  spec: string;
  /** Run name. Defaults to the spec's `run:` key, then the spec's directory name. */
  run?: string;
  /** Repo root. Defaults to the spec's `repo:` key, then the enclosing repo. */
  repo?: string;
}

/**
 * Everything that must be true before the first model call.
 *
 * Unresolved conflicts block (`docs/RUNSPEC.md`) because a run started on a
 * contradiction produces a plan for one of two incompatible things and there is no
 * gate that catches which. A missing assumptions section blocks because Research
 * would have no input at all.
 */
function preflight(spec: Runspec): void {
  const conflicts = unresolvedConflicts(spec);
  if (conflicts.length > 0) {
    const listed = conflicts.map((c) => `  ${c.split("\n")[0]}`).join("\n");
    throw new Error(
      `${spec.path}: ${conflicts.length} unresolved conflict(s) block this run:\n${listed}\n` +
        "Resolve them in the spec, or move them to out of scope."
    );
  }

  if (!section(spec, ASSUMPTIONS)) {
    throw new Error(`${spec.path}: no "## ${ASSUMPTIONS}" section — Research has no input.`);
  }
}

async function resolveRepoRoot(spec: Runspec, override?: string): Promise<string> {
  const declared = override ?? spec.frontmatter["repo"];
  const start = typeof declared === "string" && declared.trim()
    ? resolve(declared.replace(/^~(?=\/|$)/, process.env["HOME"] ?? "~"))
    : dirname(resolve(spec.path));

  const root = await findRepoRoot(start);
  if (!root) throw new Error(`No git repository at or above ${start}`);
  return root;
}

function resolveRunName(spec: Runspec, override?: string): string {
  const declared = override ?? spec.frontmatter["run"];
  if (typeof declared === "string" && declared.trim()) return declared.trim();
  return basename(dirname(resolve(spec.path)));
}

/**
 * Creates the run directory and freezes the binding.
 *
 * Config is resolved exactly once, here, and written into `run.json`; every later
 * phase reads it back rather than re-resolving, so editing `valtay.toml` mid-run
 * cannot silently change what a run in flight is doing (design.md §6.2).
 */
export async function runStart(options: StartOptions): Promise<Run> {
  const spec = await readRunspec(resolve(options.spec));
  preflight(spec);

  const repoRoot = await resolveRepoRoot(spec, options.repo);
  const config = await resolveConfig(repoRoot, spec);

  return createRun(repoRoot, resolveRunName(spec, options.run), spec, config);
}

export function formatStartResult(run: Run): string[] {
  const { meta } = run;
  return [
    `Started run "${meta.run}" on ${meta.repo}`,
    `  spec    ${meta.runspec.path} (${meta.runspec.sha.slice(0, 12)})`,
    `  dir     ${run.dir}`,
    `  trace   tier ${meta.config.trace.tier}`,
    `  hosts   ${Object.keys(meta.config.hosts).join(", ")}`,
    ...(meta.vendor_diversity
      ? []
      : ["  note    single host — nothing is graded cross-vendor (invariant 9)"]),
  ];
}
