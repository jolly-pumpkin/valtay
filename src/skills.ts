import { resolve } from "path";
import { valtayHome } from "./config.ts";
import { pathExists } from "./detect.ts";
import type { PhaseId } from "./run/store.ts";
import composeSkillMd from "../assets/skills/valtay-compose/SKILL.md" with { type: "file" };
import composeFormatMd from "../assets/skills/valtay-compose/reference/format.md" with { type: "file" };
import composeExampleMd from "../assets/skills/valtay-compose/reference/example.md" with { type: "file" };
import planSkillMd from "../assets/phases/plan/SKILL.md" with { type: "file" };
import buildSkillMd from "../assets/phases/build/SKILL.md" with { type: "file" };
import verifySkillMd from "../assets/phases/verify/SKILL.md" with { type: "file" };

export interface SkillAsset {
  rel: string;
  source: string;
}

export interface ShippedSkill {
  name: string;
  files: readonly SkillAsset[];
}

export const HOST_SKILL_ROOTS: Readonly<Record<string, string>> = {
  "claude-code": ".claude/skills",
  codex: ".codex/skills",
};

export const DEFAULT_ADAPTER = "claude-code";

export function skillRootFor(adapter: string): string {
  const root = HOST_SKILL_ROOTS[adapter];
  if (!root) {
    const known = Object.keys(HOST_SKILL_ROOTS).join(", ");
    throw new Error(`No skill root for adapter "${adapter}". Known: ${known}`);
  }
  return root;
}

export function skillRelDir(name: string, adapter: string = DEFAULT_ADAPTER): string {
  return `${skillRootFor(adapter)}/${name}`;
}

export const COMPOSE_SKILL: ShippedSkill = {
  name: "valtay-compose",
  files: [
    { rel: "SKILL.md", source: composeSkillMd },
    { rel: "reference/format.md", source: composeFormatMd },
    { rel: "reference/example.md", source: composeExampleMd },
  ],
};

export function phaseSkillName(id: PhaseId): string {
  return `valtay-${id}`;
}

const SHIPPED_PHASES: Record<PhaseId, string> = {
  plan: planSkillMd,
  build: buildSkillMd,
  verify: verifySkillMd,
};

export function skillOverridePath(id: PhaseId): string {
  return resolve(valtayHome(), "phases", id, "SKILL.md");
}

export async function loadSkill(id: PhaseId): Promise<ShippedSkill> {
  const override = skillOverridePath(id);
  const source = (await Bun.file(override).exists()) ? override : SHIPPED_PHASES[id];

  if (!source) {
    throw new Error(`No phase skill for "${id}" — write assets/phases/${id}/SKILL.md`);
  }

  return { name: phaseSkillName(id), files: [{ rel: "SKILL.md", source }] };
}

export async function shippedSkills(): Promise<ShippedSkill[]> {
  const phases = await Promise.all(
    (Object.keys(SHIPPED_PHASES) as PhaseId[]).map((id) => loadSkill(id))
  );
  return [COMPOSE_SKILL, ...phases];
}

export function installedSkillPath(
  root: string,
  id: PhaseId,
  adapter: string = DEFAULT_ADAPTER
): string {
  return resolve(root, skillRelDir(phaseSkillName(id), adapter), "SKILL.md");
}

export interface InstalledSkill {
  name: string;
  dir: string;
  outcome: "written" | "skipped";
}

export async function installSkills(
  skillsDir: string,
  force = false
): Promise<InstalledSkill[]> {
  const installed: InstalledSkill[] = [];

  for (const skill of await shippedSkills()) {
    const dir = resolve(skillsDir, skill.name);
    let wrote = false;

    for (const asset of skill.files) {
      const path = resolve(dir, asset.rel);
      if (!force && (await pathExists(path))) continue;
      await Bun.write(path, Bun.file(asset.source));
      wrote = true;
    }

    installed.push({ name: skill.name, dir, outcome: wrote ? "written" : "skipped" });
  }

  return installed;
}
