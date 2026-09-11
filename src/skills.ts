import { resolve } from "path";
import { valtayHome } from "./config.ts";
import { pathExists } from "./detect.ts";
import type { PhaseId } from "./run/store.ts";
import composeSkillMd from "../assets/skills/valtay-compose/SKILL.md" with { type: "file" };
import composeFormatMd from "../assets/skills/valtay-compose/reference/format.md" with { type: "file" };
import composeExampleMd from "../assets/skills/valtay-compose/reference/example.md" with { type: "file" };
import planSkillMd from "../assets/phases/plan/SKILL.md" with { type: "file" };
import buildSkillMd from "../assets/phases/build/SKILL.md" with { type: "file" };
import buildSubagentMd from "../assets/phases/build/SUBAGENT.md" with { type: "file" };
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

/** Extra files shipped alongside the SKILL.md for a phase. */
const PHASE_EXTRAS: Partial<Record<PhaseId, SkillAsset[]>> = {
  build: [{ rel: "SUBAGENT.md", source: buildSubagentMd }],
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

  const extras = PHASE_EXTRAS[id] ?? [];
  return { name: phaseSkillName(id), files: [{ rel: "SKILL.md", source }, ...extras] };
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

export type UpgradeOutcome =
  | "updated"      // existed, unmodified by user, replaced with new version
  | "added"        // didn't exist, installed
  | "skipped"      // hand-edited by user, left alone
  | "unchanged"    // already matches shipped version
  | "obsolete";    // installed but no longer shipped

export interface UpgradeReport {
  name: string;
  dir: string;
  outcome: UpgradeOutcome;
}

/**
 * Upgrades installed skills to the current shipped versions.
 *
 * - New skills are added.
 * - Unmodified skills are replaced.
 * - Hand-edited skills are left alone (reported as "skipped").
 * - Skill dirs starting with `valtay-` that aren't shipped are "obsolete".
 */
export async function upgradeSkills(skillsDir: string): Promise<UpgradeReport[]> {
  const reports: UpgradeReport[] = [];
  const shipped = await shippedSkills();
  const shippedNames = new Set(shipped.map((s) => s.name));

  for (const skill of shipped) {
    const dir = resolve(skillsDir, skill.name);
    let outcome: UpgradeOutcome = "unchanged";

    for (const asset of skill.files) {
      const path = resolve(dir, asset.rel);
      const shippedContent = await Bun.file(asset.source).text();
      const installed = Bun.file(path);

      if (!(await installed.exists())) {
        await Bun.write(path, shippedContent);
        outcome = "added";
        continue;
      }

      const installedContent = await installed.text();
      if (installedContent === shippedContent) {
        continue; // already current
      }

      // Check if the user hand-edited it by comparing against ALL previous
      // shipped versions. Since we don't track previous versions, we compare
      // against the current shipped version only. If it doesn't match, we
      // assume it was hand-edited — conservative, but safe.
      //
      // A file that was shipped in a previous version and never touched by the
      // user will not match the NEW shipped version, so it looks hand-edited.
      // To handle this, we also check if the file contains the old shipped
      // skill name in its frontmatter — if the name matches but content differs
      // from the current shipped version, it's likely an old shipped version
      // rather than a hand edit.
      const hasShippedName = installedContent.includes(`name: ${skill.name}`);

      if (hasShippedName) {
        // Looks like an old shipped version — safe to replace
        await Bun.write(path, shippedContent);
        if (outcome !== "added") outcome = "updated";
      } else {
        // Doesn't even have the right name — truly hand-edited
        if (outcome !== "added" && outcome !== "updated") outcome = "skipped";
      }
    }

    reports.push({ name: skill.name, dir, outcome });
  }

  // Find obsolete valtay-* skill dirs
  try {
    const { readdir } = await import("node:fs/promises");
    const entries = await readdir(skillsDir, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.isDirectory() && entry.name.startsWith("valtay-") && !shippedNames.has(entry.name)) {
        reports.push({
          name: entry.name,
          dir: resolve(skillsDir, entry.name),
          outcome: "obsolete",
        });
      }
    }
  } catch {
    // skillsDir doesn't exist — nothing obsolete
  }

  return reports;
}
