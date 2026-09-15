import { resolve } from "path";
import type { PhaseId } from "./store.ts";

export interface PromptContext {
  runName: string;
  runDir: string;      // absolute path to .valtay/runs/<name>
  repoRoot: string;    // absolute path to repo
  runspecPath: string;  // path to runspec.md in the run dir
  baseCommit?: string;           // pre-build HEAD for verify diffs
  integrationBranch?: string;    // runner-owned branch name
  checkpointPath?: string;       // absolute path to checkpoint.md when checkpoints were run
}

const ASSETS_DIR = resolve(import.meta.dir, "../../assets");

/**
 * Strip YAML frontmatter delimited by `---\n` fences.
 * If the content does not start with `---\n`, return it unchanged.
 */
export function stripFrontmatter(raw: string): string {
  if (!raw.startsWith("---\n")) return raw;
  const close = raw.indexOf("\n---\n", 4);
  if (close === -1) return raw;
  return raw.slice(close + 5).trimStart();
}

/**
 * Read a template file relative to the assets directory and strip its frontmatter.
 */
export async function loadTemplate(relPath: string): Promise<string> {
  const full = resolve(ASSETS_DIR, relPath);
  const raw = await Bun.file(full).text();
  return stripFrontmatter(raw);
}

const PHASE_TEMPLATES: Record<string, string> = {
  plan: "phases/plan/SKILL.md",
  verify: "phases/verify/SKILL.md",
};

/**
 * Build the full prompt for a phase (plan or verify).
 * Throws for "build" — the runner handles build dispatch itself.
 */
export async function buildPhasePrompt(phase: PhaseId, ctx: PromptContext): Promise<string> {
  if (phase === "build") {
    throw new Error("Runner handles build dispatch itself — do not call buildPhasePrompt for build");
  }

  const templatePath = PHASE_TEMPLATES[phase];
  if (!templatePath) {
    throw new Error(`No template for phase "${phase}"`);
  }

  const body = await loadTemplate(templatePath);

  const header = [
    `You are running phase "${phase}" of Valtay run "${ctx.runName}".`,
    "",
    `Run directory: ${ctx.runDir}`,
    `Repo root: ${ctx.repoRoot}`,
    `Runspec: ${ctx.runspecPath}`,
  ];
  if (ctx.baseCommit) header.push(`Base commit: ${ctx.baseCommit}`);
  if (ctx.integrationBranch) header.push(`Integration branch: ${ctx.integrationBranch}`);
  if (ctx.checkpointPath) header.push(`Checkpoint results: ${ctx.checkpointPath}`);

  return `${header.join("\n")}

---

${body}`;
}

/**
 * Build the full prompt for a build subagent working on a specific unit.
 */
export async function buildSubagentPrompt(unitId: string, ctx: PromptContext): Promise<string> {
  const body = await loadTemplate("phases/build/SUBAGENT.md");

  return `You are a build subagent for unit ${unitId} in Valtay run "${ctx.runName}".

Run directory: ${ctx.runDir}
Repo root: ${ctx.repoRoot}
Runspec: ${ctx.runspecPath}
Brief: ${ctx.runDir}/briefs/${unitId}.md

Read your brief and the runspec's ## Design section, then follow the instructions below.

---

${body}`;
}
