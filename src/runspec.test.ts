import { test, expect, describe } from "bun:test";
import { parseRunspec, section, designSection } from "./runspec.ts";

const SPEC = `---
run: player-damage
host: claude
model: opus
effort: high
---

# Player takes damage when an enemy leaks

## Design

Enemies that leak should cost the player health.

\`\`\`typescript
interface Player {
  health: number;
  max_health: number;
}
\`\`\`

## Out of scope

- Death screen

## Notes

Probes are cheap here. Example of a fenced heading that is not a section:

\`\`\`markdown
## Design
this is sample text, not a section
\`\`\`
`;

const spec = parseRunspec(SPEC, "/tmp/runspec.md");

describe("frontmatter", () => {
  test("parses as YAML", () => {
    expect(spec.frontmatter["run"]).toBe("player-damage");
    expect(spec.frontmatter["host"]).toBe("claude");
    expect(spec.frontmatter["model"]).toBe("opus");
  });

  test("takes the title from the H1", () => {
    expect(spec.title).toBe("Player takes damage when an enemy leaks");
  });

  test("a spec with no frontmatter still parses", () => {
    const bare = parseRunspec("# Title\n\n## Design\n\nsomething\n", "/tmp/bare.md");
    expect(bare.frontmatter).toEqual({});
    expect(section(bare, "design")).toBe("something");
  });
});

describe("sections", () => {
  test("splits every body section", () => {
    expect(section(spec, "design")).toContain("Enemies that leak");
    expect(section(spec, "out of scope")).toBe("- Death screen");
    expect(section(spec, "nope")).toBeNull();
  });

  test("lookup is case-insensitive", () => {
    expect(section(spec, "OUT OF SCOPE")).toBe(section(spec, "out of scope"));
  });

  test("a heading inside a code fence is not a section boundary", () => {
    expect(section(spec, "design")).not.toContain("sample text");
    expect(section(spec, "notes")).toContain("this is sample text, not a section");
  });
});

describe("designSection", () => {
  test("returns the design section", () => {
    const design = designSection(spec);
    expect(design).toContain("Enemies that leak");
    expect(design).toContain("interface Player");
  });

  test("a spec with no design section throws", () => {
    const noDesign = parseRunspec("# T\n\n## Notes\n\nx\n", "/tmp/x.md");
    expect(() => designSection(noDesign)).toThrow(/Design/);
  });
});
