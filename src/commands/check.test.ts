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

function crossSpec(body: string): string {
  return `---\nrun: demo\nhost: claude\nmodel: sonnet\nphases:\n  verify: { host: openai, model: o3 }\n---\n\n# Demo\n\n${body}\n`;
}

const COMPLETE_BODY =
  "## Design\n\nDo the thing.\n\n" +
  "## Out of scope\n\nNONE\n\n" +
  "## Notes\n\nNONE\n";

const COMPLETE = crossSpec(COMPLETE_BODY);

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

  test("same-binding-verify warns when build and verify share host and model", () => {
    const parsed = parseRunspec(spec(COMPLETE_BODY), "runspec.md");
    const findings = checkRunspec(parsed);

    expect(findings).toContainEqual({
      level: "warn",
      rule: "same-binding-verify",
      message:
        "verify shares build's host and model; prefer a verifier at least as capable on a different vendor (invariant 9)",
    });
  });

  test("same-binding-verify does not warn when verify uses a different binding", () => {
    const parsed = parseRunspec(crossSpec(COMPLETE_BODY), "runspec.md");
    const findings = checkRunspec(parsed);

    expect(findings.every((f) => f.rule !== "same-binding-verify")).toBe(true);
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
