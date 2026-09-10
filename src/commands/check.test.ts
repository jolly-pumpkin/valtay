import { test, expect, describe, beforeEach, afterEach } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve, join } from "node:path";
import { checkRunspec, formatFindings, runCheck } from "./check.ts";
import { parseRunspec } from "../runspec.ts";

let root: string;

function spec(body: string): string {
  return `---\nrun: demo\nhost: claude\nmodel: sonnet\n---\n\n# Demo\n\n${body}\n`;
}

const COMPLETE = spec(
  "## Design\n\nDo the thing.\n\n" +
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

  test("a missing design section is a warn finding", () => {
    const parsed = parseRunspec(spec("## Notes\n\nsome notes\n"), "runspec.md");
    const findings = checkRunspec(parsed);

    expect(findings).toContainEqual({
      level: "warn",
      rule: "missing-design",
      message: '"## Design" section is missing',
    });
  });

  test("a TODO left in a section is a has-todo finding", () => {
    const parsed = parseRunspec(spec("## Design\n\nTODO: fill in\n"), "runspec.md");
    const findings = checkRunspec(parsed);

    expect(findings.some((f) => f.rule === "has-todo")).toBe(true);
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
      { level: "warn", rule: "missing-design", message: '"## Design" section is missing' },
    ]).join("\n");

    expect(lines).toContain("warn");
    expect(lines).toContain("[missing-design]");
  });
});

describe("runCheck", () => {
  test("is a pure read: never writes .valtay/ state", async () => {
    const path = resolve(root, "runspec.md");
    await writeFile(path, spec("## Notes\n\nsome notes\n"));

    const lines = await runCheck({ spec: path });
    expect(lines.join("\n")).toContain("missing-design");

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
