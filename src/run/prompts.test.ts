import { test, expect, describe } from "bun:test";
import {
  stripFrontmatter,
  loadTemplate,
  buildPhasePrompt,
  buildSubagentPrompt,
  type PromptContext,
} from "./prompts.ts";

const CTX: PromptContext = {
  runName: "test-run",
  runDir: "/fake/repo/.valtay/runs/test-run",
  repoRoot: "/fake/repo",
  runspecPath: "/fake/repo/.valtay/runs/test-run/runspec.md",
};

describe("stripFrontmatter", () => {
  test("removes YAML frontmatter correctly", () => {
    const raw = `---\nname: foo\ndescription: bar\n---\n\n# Body here\n`;
    const result = stripFrontmatter(raw);
    expect(result).toBe("# Body here\n");
  });

  test("returns content unchanged when no frontmatter", () => {
    const raw = "# No frontmatter\n\nJust content.";
    expect(stripFrontmatter(raw)).toBe(raw);
  });

  test("returns content unchanged when only opening fence", () => {
    const raw = "---\nname: foo\nno closing fence";
    expect(stripFrontmatter(raw)).toBe(raw);
  });
});

describe("loadTemplate", () => {
  test("loads plan skill template", async () => {
    const body = await loadTemplate("phases/plan/SKILL.md");
    expect(body.length).toBeGreaterThan(0);
    expect(body).toContain("# Role: planner");
    // frontmatter should be stripped
    expect(body).not.toContain("name: valtay-plan");
  });

  test("loads verify skill template", async () => {
    const body = await loadTemplate("phases/verify/SKILL.md");
    expect(body.length).toBeGreaterThan(0);
    expect(body).toContain("# Role: verifier");
    expect(body).not.toContain("name: valtay-verify");
  });

  test("loads subagent contract", async () => {
    const body = await loadTemplate("phases/build/SUBAGENT.md");
    expect(body.length).toBeGreaterThan(0);
    expect(body).toContain("# Role: build subagent");
  });
});

describe("buildPhasePrompt", () => {
  test("plan prompt includes context header and template body", async () => {
    const prompt = await buildPhasePrompt("plan", CTX);
    expect(prompt).toContain('phase "plan"');
    expect(prompt).toContain('Valtay run "test-run"');
    expect(prompt).toContain("Run directory: /fake/repo/.valtay/runs/test-run");
    expect(prompt).toContain("Repo root: /fake/repo");
    expect(prompt).toContain("Runspec: /fake/repo/.valtay/runs/test-run/runspec.md");
    expect(prompt).toContain("# Role: planner");
  });

  test("verify prompt includes context header and template body", async () => {
    const prompt = await buildPhasePrompt("verify", CTX);
    expect(prompt).toContain('phase "verify"');
    expect(prompt).toContain('Valtay run "test-run"');
    expect(prompt).toContain("# Role: verifier");
  });

  test("verify prompt includes checkpoint path when present", async () => {
    const ctxWithCheckpoint: PromptContext = {
      ...CTX,
      checkpointPath: "/fake/repo/.valtay/runs/test-run/checkpoint.md",
    };
    const prompt = await buildPhasePrompt("verify", ctxWithCheckpoint);
    expect(prompt).toContain("Checkpoint results: /fake/repo/.valtay/runs/test-run/checkpoint.md");
  });

  test("verify prompt omits checkpoint line when not present", async () => {
    const prompt = await buildPhasePrompt("verify", CTX);
    expect(prompt).not.toContain("Checkpoint results:");
  });

  test("build phase throws", async () => {
    await expect(buildPhasePrompt("build", CTX)).rejects.toThrow(
      /runner handles build dispatch/i
    );
  });
});

describe("buildSubagentPrompt", () => {
  test("includes unit id, brief path, and subagent contract", async () => {
    const prompt = await buildSubagentPrompt("RU-1", CTX);
    expect(prompt).toContain("unit RU-1");
    expect(prompt).toContain('Valtay run "test-run"');
    expect(prompt).toContain("Run directory: /fake/repo/.valtay/runs/test-run");
    expect(prompt).not.toContain("Repo root:");
    expect(prompt).toContain("Runspec: /fake/repo/.valtay/runs/test-run/runspec.md");
    expect(prompt).toContain("Brief: /fake/repo/.valtay/runs/test-run/briefs/RU-1.md");
    expect(prompt).toContain("Read your brief and the runspec's ## Design section");
    expect(prompt).toContain("# Role: build subagent");
  });
});
