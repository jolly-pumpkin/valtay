import { test, expect, describe } from "bun:test";
import { providerFor, buildClaudeArgs, buildCodexArgs } from "./provider.ts";
import type { DispatchOpts } from "./provider.ts";

const readOpts: DispatchOpts = { cwd: "/tmp", model: "sonnet", write: false };
const writeOpts: DispatchOpts = { cwd: "/tmp", model: "sonnet", write: true };

describe("providerFor", () => {
  test("returns a claude provider", () => {
    const p = providerFor("claude");
    expect(p.name).toBe("claude");
    expect(typeof p.dispatch).toBe("function");
  });

  test("returns a codex provider", () => {
    const p = providerFor("codex");
    expect(p.name).toBe("codex");
    expect(typeof p.dispatch).toBe("function");
  });

  test("throws for an unknown host", () => {
    expect(() => providerFor("unknown")).toThrow(/Unknown host/);
  });
});

describe("buildClaudeArgs", () => {
  test("read-only phase uses dontAsk with disallowed-tools", () => {
    const args = buildClaudeArgs(readOpts);
    expect(args).toContain("--permission-mode");
    expect(args[args.indexOf("--permission-mode") + 1]).toBe("dontAsk");
    expect(args).toContain("--disallowed-tools");
    expect(args).not.toContain("--allowed-tools");
  });

  test("write phase uses acceptEdits with allowed-tools", () => {
    const args = buildClaudeArgs(writeOpts);
    expect(args[args.indexOf("--permission-mode") + 1]).toBe("acceptEdits");
    expect(args).toContain("--allowed-tools");
    expect(args).not.toContain("--disallowed-tools");
  });

  test("includes effort when provided", () => {
    const args = buildClaudeArgs({ ...readOpts, effort: "high" });
    expect(args).toContain("--effort");
    expect(args[args.indexOf("--effort") + 1]).toBe("high");
  });

  test("prompt is not in args (goes on stdin)", () => {
    const args = buildClaudeArgs(readOpts);
    // Should have -p flag but no prompt string following it
    expect(args).toContain("-p");
    // -p is immediately followed by --output-format, not a prompt string
    expect(args[args.indexOf("-p") + 1]).toBe("--output-format");
  });
});

describe("buildCodexArgs", () => {
  test("uses codex exec with read-only sandbox", () => {
    const args = buildCodexArgs(readOpts);
    expect(args[0]).toBe("codex");
    expect(args[1]).toBe("exec");
    expect(args).toContain("--sandbox");
    expect(args[args.indexOf("--sandbox") + 1]).toBe("read-only");
    expect(args.at(-1)).toBe("-"); // prompt on stdin
  });

  test("uses workspace-write sandbox for write phases", () => {
    const args = buildCodexArgs(writeOpts);
    expect(args[args.indexOf("--sandbox") + 1]).toBe("workspace-write");
  });

  test("includes effort as config flag", () => {
    const args = buildCodexArgs({ ...readOpts, effort: "high" });
    expect(args).toContain("-c");
    expect(args[args.indexOf("-c") + 1]).toBe("model_reasoning_effort=high");
  });
});
