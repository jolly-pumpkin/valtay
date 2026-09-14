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
    expect(skillRootFor("claude")).toBe(".claude/skills");
    expect(skillRootFor("codex")).toBe(".codex/skills");
  });

  test("an unknown adapter throws rather than defaulting to .claude/", () => {
    // A silent fallback would hand the host a directory it never reads, and the
    // phase would answer the payload conversationally — the expensive, silent
    // failure the pre-flight check exists to prevent.
    expect(() => skillRootFor("gemini")).toThrow(/No skill root for adapter "gemini"/);
    expect(() => skillRootFor("gemini")).toThrow(/claude, codex/);
  });

  test("the skill path follows the adapter it will be loaded by", () => {
    const name = phaseSkillName("plan");

    expect(skillRelDir(name, "codex")).toBe(".codex/skills/valtay-plan");
    expect(installedSkillPath("/repo", "plan", "codex")).toBe(
      "/repo/.codex/skills/valtay-plan/SKILL.md"
    );
    expect(installedSkillPath("/repo", "plan", "claude")).toBe(
      "/repo/.claude/skills/valtay-plan/SKILL.md"
    );
  });

  test("callers that predate a second host still get claude", () => {
    expect(skillRelDir("valtay-plan")).toBe(".claude/skills/valtay-plan");
    expect(installedSkillPath("/repo", "plan")).toBe(
      "/repo/.claude/skills/valtay-plan/SKILL.md"
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
