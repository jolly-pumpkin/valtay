import { test, expect, describe, beforeEach, afterEach } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve, join } from "node:path";
import { checkRunspec, formatFindings, runCheck } from "./check.ts";
import { parseRunspec } from "../runspec.ts";

let root: string;

function spec(body: string): string {
  return `---\nrun: demo\n---\n\n# Demo\n\n${body}\n`;
}

const COMPLETE = spec(
  "## Intent\n\nDo the thing.\n\n" +
    "## Tickets\n\nNONE\n\n" +
    "## Conflicts\n\nNONE\n\n" +
    "## Gaps\n\nNONE\n\n" +
    "## Assumptions to verify\n\n- **A-1** Verify something.\n\n" +
    "## Out of scope\n\nNONE\n\n" +
    "## Notes\n\nNONE\n"
);

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "valtay-check-"));
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

describe("checkRunspec", () => {
  test("a complete spec has no findings", () => {
    const parsed = parseRunspec(COMPLETE, "runspec.md");
    expect(checkRunspec(parsed)).toEqual([]);
  });

  test("an unresolved conflict is a warn finding, not a throw", () => {
    const parsed = parseRunspec(
      spec(
        "## Conflicts\n\n- **C-2** PRD and the ticket disagree.\n  → **UNRESOLVED** — needs a decision.\n\n" +
          "## Assumptions to verify\n\n- **A-1** Verify something.\n"
      ),
      "runspec.md"
    );

    const findings = checkRunspec(parsed);
    expect(findings).toContainEqual({
      level: "warn",
      rule: "unresolved-conflict",
      message: expect.stringContaining("C-2"),
    });
  });

  test("a missing section is an info finding", () => {
    const parsed = parseRunspec(spec("## Intent\n\nDo the thing.\n"), "runspec.md");
    const findings = checkRunspec(parsed);

    expect(findings.some((f) => f.rule === "incomplete-section" && f.level === "info")).toBe(true);
  });

  test("a TODO left in a section is an incomplete-section finding", () => {
    const parsed = parseRunspec(spec("## Notes\n\nTODO\n"), "runspec.md");
    const findings = checkRunspec(parsed);

    expect(findings.some((f) => f.rule === "incomplete-section")).toBe(true);
  });
});

describe("formatFindings", () => {
  test("reports no findings plainly", () => {
    const parsed = parseRunspec(COMPLETE, "runspec.md");
    const lines = formatFindings(parsed, []).join("\n");

    expect(lines).toContain('Check "Demo"');
    expect(lines).toContain("no findings");
  });

  test("lists each finding's level, rule, and message", () => {
    const parsed = parseRunspec(COMPLETE, "runspec.md");
    const lines = formatFindings(parsed, [
      { level: "warn", rule: "unresolved-conflict", message: "unresolved conflict: C-2" },
    ]).join("\n");

    expect(lines).toContain("warn");
    expect(lines).toContain("[unresolved-conflict]");
    expect(lines).toContain("C-2");
  });
});

describe("runCheck", () => {
  test("is a pure read: never blocks and never writes .valtay/ state", async () => {
    const path = resolve(root, "runspec.md");
    await writeFile(
      path,
      spec(
        "## Conflicts\n\n- **C-1** Unresolved.\n  → **UNRESOLVED**\n\n" +
          "## Assumptions to verify\n\n- **A-1** Verify something.\n"
      )
    );

    const lines = await runCheck({ spec: path });
    expect(lines.join("\n")).toContain("unresolved-conflict");

    // check.ts never creates run state alongside the spec it read.
    const entries = await Bun.$`ls ${root}`.text();
    expect(entries).not.toContain(".valtay");
  });

  test("lints a complete spec cleanly", async () => {
    const path = resolve(root, "runspec.md");
    await writeFile(path, COMPLETE);

    const lines = await runCheck({ spec: path });
    expect(lines.join("\n")).toContain("no findings");
  });
});
