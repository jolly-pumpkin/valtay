import skillMd from "../assets/skills/valtay-compose/SKILL.md" with { type: "file" };
import formatMd from "../assets/skills/valtay-compose/reference/format.md" with { type: "file" };
import exampleMd from "../assets/skills/valtay-compose/reference/example.md" with { type: "file" };

/** The Claude skill valtay installs at the project level to help author run specs. */
export const SKILL_NAME = "valtay-compose";

/** Where the skill lands, relative to the init root. */
export const SKILL_REL_DIR = `.claude/skills/${SKILL_NAME}`;

export interface SkillAsset {
  /** Destination path, relative to the installed skill directory. */
  rel: string;
  /** Absolute path to the shipped asset. */
  source: string;
}

/**
 * The skill's files, as an explicit manifest rather than a directory scan: the
 * `type: "file"` imports resolve to real paths when running from source and to
 * embedded files under `bun build --compile`, neither of which is enumerable.
 */
export const SKILL_FILES: readonly SkillAsset[] = [
  { rel: "SKILL.md", source: skillMd },
  { rel: "reference/format.md", source: formatMd },
  { rel: "reference/example.md", source: exampleMd },
];
