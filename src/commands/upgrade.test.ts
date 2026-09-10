import { test, expect, describe, beforeEach, afterEach } from "bun:test";
import { mkdtemp, mkdir, rm, writeFile, readFile, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve, join } from "node:path";
import { runUpgrade, formatUpgradeResult } from "./upgrade.ts";
import { installSkills, shippedSkills, phaseSkillName } from "../skills.ts";

let root: string;
let repo: string;

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "valtay-upgrade-"));
  repo = resolve(root, "myrepo");
  await mkdir(resolve(repo, ".git"), { recursive: true });
  await mkdir(resolve(repo, ".claude"), { recursive: true });
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

describe("upgrade", () => {
  test("reports unchanged when skills are already current", async () => {
    const skillsDir = resolve(repo, ".claude", "skills");
    await installSkills(skillsDir);

    const result = await runUpgrade({ path: repo });
    const unchanged = result.reports.filter((r) => r.outcome === "unchanged");

    expect(unchanged.length).toBe(result.reports.length);
  });

  test("adds new skills that were not previously installed", async () => {
    const skillsDir = resolve(repo, ".claude", "skills");
    // Install only compose, not phase skills
    const composeDir = resolve(skillsDir, "valtay-compose");
    await mkdir(composeDir, { recursive: true });
    const shipped = await shippedSkills();
    const compose = shipped.find((s) => s.name === "valtay-compose")!;
    for (const asset of compose.files) {
      await Bun.write(resolve(composeDir, asset.rel), Bun.file(asset.source));
    }

    const result = await runUpgrade({ path: repo });
    const added = result.reports.filter((r) => r.outcome === "added");

    // plan, build, verify should be added
    expect(added.length).toBe(3);
    expect(added.map((r) => r.name).sort()).toEqual([
      "valtay-build",
      "valtay-plan",
      "valtay-verify",
    ]);
  });

  test("updates skills with old shipped content", async () => {
    const skillsDir = resolve(repo, ".claude", "skills");
    await installSkills(skillsDir);

    // Simulate an old version by changing content but keeping the name
    const planPath = resolve(skillsDir, "valtay-plan", "SKILL.md");
    await writeFile(planPath, "---\nname: valtay-plan\ndescription: old version\n---\n\nOld content.\n");

    const result = await runUpgrade({ path: repo });
    const updated = result.reports.filter((r) => r.outcome === "updated");

    expect(updated.length).toBe(1);
    expect(updated[0]!.name).toBe("valtay-plan");

    // Should now have the current shipped content
    const content = await readFile(planPath, "utf-8");
    expect(content).toContain("# Role: planner");
  });

  test("skips hand-edited skills", async () => {
    const skillsDir = resolve(repo, ".claude", "skills");
    await installSkills(skillsDir);

    // Simulate a hand edit — content changed AND name removed
    const planPath = resolve(skillsDir, "valtay-plan", "SKILL.md");
    await writeFile(planPath, "# My custom plan skill\n\nCompletely hand-written.\n");

    const result = await runUpgrade({ path: repo });
    const skipped = result.reports.filter((r) => r.outcome === "skipped");

    expect(skipped.length).toBe(1);
    expect(skipped[0]!.name).toBe("valtay-plan");

    // Should NOT have overwritten
    const content = await readFile(planPath, "utf-8");
    expect(content).toContain("My custom plan skill");
  });

  test("removes obsolete valtay-* skill directories", async () => {
    const skillsDir = resolve(repo, ".claude", "skills");
    await installSkills(skillsDir);

    const obsoletePath = resolve(skillsDir, "valtay-research");
    await mkdir(obsoletePath, { recursive: true });
    await writeFile(resolve(obsoletePath, "SKILL.md"), "old");

    const result = await runUpgrade({ path: repo });

    expect(result.reports.some((r) => r.outcome === "obsolete" && r.name === "valtay-research")).toBe(true);
    expect(result.cleaned).toContain("valtay-research");
    expect(await exists(obsoletePath)).toBe(false);
  });
});

describe("formatUpgradeResult", () => {
  test("shows a summary of actions", async () => {
    const lines = formatUpgradeResult({
      root: "/tmp/repo",
      skillsDirs: ["/tmp/repo/.claude/skills"],
      reports: [
        { name: "valtay-plan", dir: "/tmp", outcome: "updated" },
        { name: "valtay-build", dir: "/tmp", outcome: "unchanged" },
        { name: "valtay-verify", dir: "/tmp", outcome: "added" },
        { name: "valtay-research", dir: "/tmp", outcome: "obsolete" },
      ],
      cleaned: ["valtay-research"],
    }).join("\n");

    expect(lines).toContain("added     valtay-verify");
    expect(lines).toContain("updated   valtay-plan");
    expect(lines).toContain("current   valtay-build");
    expect(lines).toContain("removed   valtay-research");
  });
});
