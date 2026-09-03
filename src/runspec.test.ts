import { test, expect, describe } from "bun:test";
import {
  parseRunspec,
  section,
  researchInput,
  unresolvedConflicts,
  incompleteSections,
  ASSUMPTIONS,
} from "./runspec.ts";

const SPEC = `---
run: player-damage
repo: ~/work/foundry
mode: attended
sources:
  tickets: [LIN-483, LIN-484]
roles:
  researcher: { host: claude, model: opus, effort: high }
---

# Player takes damage when an enemy leaks

## Intent

Enemies that leak should cost the player health.

## Tickets

**LIN-483 — wave-completion event in sim**

## Conflicts

- **C-1** LIN-484 puts health on \`Player\`; tech design §2 puts it on \`RunState\`.
  → **RESOLVED: Player.**
- **C-2** PRD §3 says health persists; LIN-485 implies a per-wave reset.
  → **UNRESOLVED** — needs a product decision.

## Gaps

- **G-1** LIN-486 has no design coverage. → in scope.

## Assumptions to verify

- **A-1** Verify whether \`sim\` emits events or mutates \`RunState\` directly.
- **A-2** Verify whether enemies are removed on leak or merely marked.

## Out of scope

- Death screen

## Notes

Probes are cheap here. Example of a fenced heading that is not a section:

\`\`\`markdown
## Intent
this is sample text, not a section
\`\`\`
`;

const spec = parseRunspec(SPEC, "/tmp/runspec.md");

describe("frontmatter", () => {
  test("parses as YAML", () => {
    expect(spec.frontmatter["run"]).toBe("player-damage");
    expect(spec.frontmatter["mode"]).toBe("attended");
    expect((spec.frontmatter["sources"] as any).tickets).toEqual(["LIN-483", "LIN-484"]);
    expect((spec.frontmatter["roles"] as any).researcher.model).toBe("opus");
  });

  test("takes the title from the H1", () => {
    expect(spec.title).toBe("Player takes damage when an enemy leaks");
  });

  test("a spec with no frontmatter still parses", () => {
    const bare = parseRunspec("# Title\n\n## Intent\n\nsomething\n", "/tmp/bare.md");
    expect(bare.frontmatter).toEqual({});
    expect(section(bare, "intent")).toBe("something");
  });
});

describe("sections", () => {
  test("splits every body section", () => {
    expect(section(spec, "intent")).toBe("Enemies that leak should cost the player health.");
    expect(section(spec, "out of scope")).toBe("- Death screen");
    expect(section(spec, "nope")).toBeNull();
  });

  test("lookup is case-insensitive", () => {
    expect(section(spec, "OUT OF SCOPE")).toBe(section(spec, "out of scope"));
  });

  test("a heading inside a code fence is not a section boundary", () => {
    // `## Intent` appears twice: once as a real heading, once inside a fence in Notes.
    expect(section(spec, "intent")).not.toContain("sample text");
    expect(section(spec, "notes")).toContain("this is sample text, not a section");
  });
});

describe("research blindness", () => {
  test("returns the assumptions section and nothing else", () => {
    const input = researchInput(spec);

    expect(input).toContain("A-1");
    expect(input).toContain("A-2");

    // The whole point of design.md §8.2: a researcher that has read the intent or
    // the tickets returns evidence *for* the design instead of facts about the code.
    for (const leak of ["Intent", "LIN-483", "C-1", "Death screen", "Probes are cheap"]) {
      expect(input).not.toContain(leak);
    }
  });

  test("a spec with no assumptions section is an error, not an empty prompt", () => {
    const blind = parseRunspec("# T\n\n## Intent\n\nx\n", "/tmp/x.md");
    expect(() => researchInput(blind)).toThrow(ASSUMPTIONS);
  });
});

describe("preflight signals", () => {
  test("finds only the conflicts still marked unresolved", () => {
    const open = unresolvedConflicts(spec);
    expect(open).toHaveLength(1);
    expect(open[0]).toContain("C-2");
  });

  test("no conflicts section means nothing blocks", () => {
    expect(unresolvedConflicts(parseRunspec("# T\n", "/tmp/x.md"))).toEqual([]);
  });

  test("reports sections that are missing or still scaffolded", () => {
    expect(incompleteSections(spec)).toEqual([]);

    const scaffold = parseRunspec(
      "# T\n\n## Intent\n\nTODO: what you want\n\n## Notes\n\nfine\n",
      "/tmp/x.md"
    );
    expect(incompleteSections(scaffold)).toContain("intent");
    expect(incompleteSections(scaffold)).toContain(ASSUMPTIONS);
    expect(incompleteSections(scaffold)).not.toContain("notes");
  });
});
