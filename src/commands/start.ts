import { resolve, dirname, basename } from "path";
import { findRepoRoot, pathExists } from "../detect.ts";
import { resolveConfig } from "../config.ts";
import { readRunspec, designSection, type Runspec } from "../runspec.ts";
import { createRun, type Run } from "../run/store.ts";

export interface StartOptions {
  spec: string;
  run?: string;
  repo?: string;
}

function preflight(spec: Runspec): void {
  designSection(spec); // throws if missing
}

async function resolveRepoRoot(spec: Runspec, override?: string): Promise<string> {
  const declared = override ?? spec.frontmatter["repo"];
  const start = typeof declared === "string" && declared.trim()
    ? resolve(declared.replace(/^~(?=\/|$)/, process.env["HOME"] ?? "~"))
    : process.cwd();

  const root = await findRepoRoot(start);
  if (!root) throw new Error(`No git repository at or above ${start}`);
  return root;
}

function resolveRunName(spec: Runspec, override?: string): string {
  const declared = override ?? spec.frontmatter["run"];
  if (typeof declared === "string" && declared.trim()) return declared.trim();
  return basename(dirname(resolve(spec.path)));
}

async function resolveSpecPath(ref: string): Promise<string> {
  const asPath = resolve(ref);
  if (await pathExists(asPath)) return asPath;
  throw new Error(`No spec at "${ref}"`);
}

export async function runStart(options: StartOptions): Promise<Run> {
  const specPath = await resolveSpecPath(options.spec);
  const spec = await readRunspec(specPath);
  preflight(spec);

  const repoRoot = await resolveRepoRoot(spec, options.repo);
  const config = resolveConfig(spec);

  return createRun(repoRoot, resolveRunName(spec, options.run), spec, config);
}

export function formatStartResult(run: Run): string[] {
  return [
    `Started run "${run.meta.run}" on ${run.meta.repo}`,
    `  spec    ${run.meta.runspec.path} (${run.meta.runspec.sha.slice(0, 12)})`,
    `  dir     ${run.dir}`,
    "",
    "Next: `valtay run` to execute the pipeline, or invoke phases manually.",
  ];
}
