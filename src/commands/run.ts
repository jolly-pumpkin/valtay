import { resolve, dirname, basename } from "path";
import { findRepoRoot } from "../detect.ts";
import { readRunspec, designSection, type Runspec } from "../runspec.ts";
import { run, type RunResult } from "../run/runner.ts";

export interface RunCommandOptions {
  spec: string;
  run?: string;
  repo?: string;
}

async function resolveRepoRoot(spec: Runspec, override?: string): Promise<string> {
  const declared = override ?? spec.frontmatter["repo"];
  const start =
    typeof declared === "string" && declared.trim()
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

export async function runCommand(options: RunCommandOptions): Promise<string[]> {
  const specPath = resolve(options.spec);
  const spec = await readRunspec(specPath);
  designSection(spec); // throws if missing

  const repoRoot = await resolveRepoRoot(spec, options.repo);
  const runName = resolveRunName(spec, options.run);

  const result = await run({ spec, repoRoot, runName });
  return formatRunResult(runName, result);
}

export function formatRunResult(runName: string, result: RunResult): string[] {
  const lines: string[] = [];

  switch (result.outcome) {
    case "complete":
      lines.push(`Run "${runName}" complete. Verify: clean.`);
      break;

    case "drift":
      lines.push(`Run "${runName}" finished with drift.`);
      lines.push(`  ${result.findings.length} finding(s):`);
      for (const f of result.findings) {
        lines.push(`  [${f.severity}] ${f.what} — ${f.file}`);
      }
      lines.push("");
      lines.push("`valtay approve verify` to accept, or fix and re-run.");
      break;

    case "contested":
      lines.push(`Run "${runName}" halted: ${result.layers.length} layer(s) contested.`);
      for (const l of result.layers) {
        lines.push(`  ${l.unit}/${l.layer}: ${l.reason ?? "(no reason)"}`);
      }
      lines.push("");
      lines.push("`valtay accept <unit> <layer>` or `valtay override <unit> <layer>` to resolve.");
      break;

    case "blocked":
      lines.push(`Run "${runName}" halted: ${result.layers.length} layer(s) blocked.`);
      for (const l of result.layers) {
        lines.push(`  ${l.unit}/${l.layer}: ${l.reason ?? "(no reason)"}`);
      }
      break;

    case "failed":
      lines.push(`Run "${runName}" failed at ${result.phase}: ${result.reason}`);
      break;
  }

  return lines;
}
