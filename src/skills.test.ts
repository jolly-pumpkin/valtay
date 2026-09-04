import { test, expect, describe } from "bun:test";
import {
  HOST_SKILL_ROOTS,
  installedSkillPath,
  phaseSkillName,
  skillRelDir,
  skillRootFor,
} from "./skills.ts";
import { HOST_BY_MARKER } from "./detect.ts";

describe("skill roots", () => {
  test("each host family looks somewhere different", () => {
    // Verified against the binaries: claude-code discovers `.claude/skills/`, and
    // codex-cli 0.153.3's loader reads `.codex/skills/<name>/SKILL.md`.
    expect(skillRootFor("claude-code")).toBe(".claude/skills");
    expect(skillRootFor("codex")).toBe(".codex/skills");
  });

  test("an unknown adapter throws rather than defaulting to .claude/", () => {
    // A silent fallback would hand the host a directory it never reads, and the
    // phase would answer the payload conversationally — the expensive, silent
    // failure the pre-flight check exists to prevent.
    expect(() => skillRootFor("gemini")).toThrow(/No skill root for adapter "gemini"/);
    expect(() => skillRootFor("gemini")).toThrow(/claude-code, codex/);
  });

  test("the skill path follows the adapter it will be loaded by", () => {
    const name = phaseSkillName("research");

    expect(skillRelDir(name, "codex")).toBe(".codex/skills/valtay-research");
    expect(installedSkillPath("/repo", "research", "codex")).toBe(
      "/repo/.codex/skills/valtay-research/SKILL.md"
    );
    expect(installedSkillPath("/repo", "research", "claude-code")).toBe(
      "/repo/.claude/skills/valtay-research/SKILL.md"
    );
  });

  test("callers that predate a second host still get claude-code", () => {
    // The default keeps every pre-existing call site meaning what it meant.
    expect(skillRelDir("valtay-research")).toBe(".claude/skills/valtay-research");
    expect(installedSkillPath("/repo", "research")).toBe(
      "/repo/.claude/skills/valtay-research/SKILL.md"
    );
  });

  test("every adapter a repo can be detected as has a skill root", () => {
    // `detect.ts` writes these adapter names into valtay.toml, so a name here with
    // no root is an init that produces a config no phase can run under.
    for (const host of Object.values(HOST_BY_MARKER)) {
      expect(HOST_SKILL_ROOTS[host.adapter]).toBeDefined();
    }
  });
});
