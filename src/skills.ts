import { resolve } from "path";
import { valtayHome } from "./config.ts";
import { pathExists } from "./detect.ts";
import type { PhaseId } from "./run/store.ts";
import composeSkillMd from "../assets/skills/valtay-compose/SKILL.md" with { type: "file" };
import composeFormatMd from "../assets/skills/valtay-compose/reference/format.md" with { type: "file" };
import composeExampleMd from "../assets/skills/valtay-compose/reference/example.md" with { type: "file" };
import researchSkillMd from "../assets/phases/research/SKILL.md" with { type: "file" };
import reconcileSkillMd from "../assets/phases/reconcile/SKILL.md" with { type: "file" };
import shapeSkillMd from "../assets/phases/shape/SKILL.md" with { type: "file" };
import planSkillMd from "../assets/phases/plan/SKILL.md" with { type: "file" };
import probeSkillMd from "../assets/phases/probe/SKILL.md" with { type: "file" };
import buildSkillMd from "../assets/phases/build/SKILL.md" with { type: "file" };

export interface SkillAsset {
  /** Destination path, relative to the installed skill directory. */
  rel: string;
  /** Absolute path to the shipped asset. */
  source: string;
}

export interface ShippedSkill {
  /** Directory name, and the name the host loads it by. */
  name: string;
  /**
   * The skill's files, as an explicit manifest rather than a directory scan: the
   * `type: "file"` imports resolve to real paths when running from source and to
   * embedded files under `bun build --compile`, neither of which is enumerable.
   */
  files: readonly SkillAsset[];
}

/**
 * Where a host looks for an installed skill, relative to the root it was installed
 * into.
 *
 * One entry per host family, keyed by adapter name. The codex root is where the
 * binary itself looks — verified against codex-cli 0.153.3, whose skill loader reads
 * `.codex/skills/<name>/SKILL.md` (and `$CODEX_HOME/skills` for user-level ones).
 *
 * Installing there is worth doing even though the codex adapter also inlines the
 * body (see `hosts/codex.ts`): it keeps the pre-flight check in `run/invoke.ts`
 * honest, keeps `prompt_sha` a hash of the file the host would load, and puts the
 * phase where a human running codex by hand will find it.
 */
export const HOST_SKILL_ROOTS: Readonly<Record<string, string>> = {
  "claude-code": ".claude/skills",
  codex: ".codex/skills",
};

/** The default adapter for callers that predate a second host. */
export const DEFAULT_ADAPTER = "claude-code";

/**
 * The skill root for `adapter`.
 *
 * Throws rather than falling back: a host whose root we do not know would otherwise
 * be handed `.claude/skills`, find nothing there, and answer the payload
 * conversationally — the expensive, silent failure `phaseSkillIn` exists to prevent.
 */
export function skillRootFor(adapter: string): string {
  const root = HOST_SKILL_ROOTS[adapter];
  if (!root) {
    const known = Object.keys(HOST_SKILL_ROOTS).join(", ");
    throw new Error(`No skill root for adapter "${adapter}". Known: ${known}`);
  }
  return root;
}

/** Where a skill installs to, relative to the init root. */
export function skillRelDir(name: string, adapter: string = DEFAULT_ADAPTER): string {
  return `${skillRootFor(adapter)}/${name}`;
}

/** The skill valtay installs at the project level to help author run specs. */
export const COMPOSE_SKILL: ShippedSkill = {
  name: "valtay-compose",
  files: [
    { rel: "SKILL.md", source: composeSkillMd },
    { rel: "reference/format.md", source: composeFormatMd },
    { rel: "reference/example.md", source: composeExampleMd },
  ],
};

/** The name a phase's skill is loaded by — `/valtay-research`, and so on. */
export function phaseSkillName(id: PhaseId): string {
  return `valtay-${id}`;
}

/**
 * Phase skills, shipped as assets.
 *
 * A phase whose skill is not yet written is absent here rather than stubbed, so
 * reaching it fails loudly instead of invoking a model with nothing to go on.
 */
const SHIPPED_PHASES: Partial<Record<PhaseId, string>> = {
  research: researchSkillMd,
  reconcile: reconcileSkillMd,
  shape: shapeSkillMd,
  plan: planSkillMd,
  probe: probeSkillMd,
  build: buildSkillMd,
};

/**
 * Where a project-local override of a phase skill lives.
 *
 * The override is how a promoted ledger entry reaches a phase (design.md §16.2) — and
 * it is also why Valtay never writes there itself (invariant 8): a harness that edits
 * its own instructions based on its own performance has no fixed point.
 */
export function skillOverridePath(id: PhaseId): string {
  return resolve(valtayHome(), "phases", id, "SKILL.md");
}

/**
 * The source SKILL.md for `id`, preferring `~/.valtay/phases/<id>/SKILL.md`.
 *
 * A path rather than the text: the host reads the file itself through its own skill
 * system, so nothing between here and the model needs the content — only `valtay
 * init`, which copies it into place.
 */
export async function loadSkill(id: PhaseId): Promise<ShippedSkill> {
  const override = skillOverridePath(id);
  const source = (await Bun.file(override).exists()) ? override : SHIPPED_PHASES[id];

  if (!source) {
    throw new Error(`No phase skill for "${id}" — write assets/phases/${id}/SKILL.md`);
  }

  return { name: phaseSkillName(id), files: [{ rel: "SKILL.md", source }] };
}

/** Every skill `valtay init` installs, compose first. */
export async function shippedSkills(): Promise<ShippedSkill[]> {
  const phases = await Promise.all(
    (Object.keys(SHIPPED_PHASES) as PhaseId[]).map((id) => loadSkill(id))
  );
  return [COMPOSE_SKILL, ...phases];
}

/**
 * The SKILL.md a host will actually load for `id`, under `root`.
 *
 * `root` is the directory the host runs in — the repo for a read-only phase, the
 * worktree for a write one. Both must carry the installed skill, which is why the
 * skills directory has to be committed: a git worktree only gets tracked files.
 */
export function installedSkillPath(
  root: string,
  id: PhaseId,
  adapter: string = DEFAULT_ADAPTER
): string {
  return resolve(root, skillRelDir(phaseSkillName(id), adapter), "SKILL.md");
}

export interface InstalledSkill {
  name: string;
  /** Absolute directory the skill's files landed in. */
  dir: string;
  outcome: "written" | "skipped";
}

/**
 * Copies every shipped skill into `skillsDir` — `valtay-compose`, which a human loads
 * while authoring a run spec, and one per phase, which a host loads when the
 * orchestrator names it.
 *
 * Per-file skipping means a hand-edited SKILL.md survives a re-install while a newly
 * shipped reference file still lands. `force` overwrites regardless.
 */
export async function installSkills(
  skillsDir: string,
  force = false
): Promise<InstalledSkill[]> {
  const installed: InstalledSkill[] = [];

  for (const skill of await shippedSkills()) {
    const dir = resolve(skillsDir, skill.name);
    let wrote = false;

    // Sequential: the assets share parent directories, and Bun.write creates them.
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
