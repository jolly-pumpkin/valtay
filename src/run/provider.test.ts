import { test, expect, describe } from "bun:test";
import { providerFor, buildClaudeArgs, buildCodexArgs, readOnlyRules, dispatchNotes, parseClaudeUsage, parseCodexUsage } from "./provider.ts";
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
  test("read-only phase uses dontAsk with a read-only allow list, never disallowed-tools", () => {
    const args = buildClaudeArgs(readOpts);
    expect(args).toContain("--permission-mode");
    expect(args[args.indexOf("--permission-mode") + 1]).toBe("dontAsk");
    expect(args).not.toContain("--disallowed-tools");
    const allowed = args.slice(args.indexOf("--allowed-tools") + 1); // variadic, last in argv
    expect(allowed).toContain("Read");
    expect(allowed).toContain("Bash(git diff *)");
    expect(allowed.some((r) => r.startsWith("Edit("))).toBe(false);
    expect(args).not.toContain("--add-dir");
  });

  test("read-only phase with an artifactDir may write there and nowhere else", () => {
    const args = buildClaudeArgs({ ...readOpts, artifactDir: "/repo/.valtay/runs/x" });
    expect(args[args.indexOf("--permission-mode") + 1]).toBe("dontAsk");
    expect(args[args.indexOf("--add-dir") + 1]).toBe("/repo/.valtay/runs/x");
    const allowed = args.slice(args.indexOf("--allowed-tools") + 1);
    expect(allowed).toContain("Edit(//repo/.valtay/runs/x/**)");
    expect(allowed).toContain("Write(//repo/.valtay/runs/x/**)");
    expect(allowed).not.toContain("Write"); // no unscoped Write
    expect(allowed).not.toContain("Bash");  // no unscoped Bash
  });

  test("readOnlyRules scopes the artifact dir with an absolute-path rule", () => {
    expect(readOnlyRules()).not.toContainEqual(expect.stringContaining("Edit("));
    expect(readOnlyRules("/a/b")).toContain("Edit(//a/b/**)");
  });

  test("write phase uses acceptEdits with allowed-tools", () => {
    const args = buildClaudeArgs(writeOpts);
    expect(args[args.indexOf("--permission-mode") + 1]).toBe("acceptEdits");
    expect(args).toContain("--allowed-tools");
    expect(args).not.toContain("--disallowed-tools");
    expect(args.slice(args.indexOf("--allowed-tools") + 1)).toEqual(
      ["Bash", "Read", "Write", "Edit", "NotebookEdit", "Glob", "Grep"],
    );
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

  test("read-only phase with an artifactDir adds it as a writable dir", () => {
    const args = buildCodexArgs({ ...readOpts, artifactDir: "/repo/.valtay/runs/x" });
    expect(args[args.indexOf("--add-dir") + 1]).toBe("/repo/.valtay/runs/x");
    expect(buildCodexArgs({ ...writeOpts, artifactDir: "/repo/.valtay/runs/x" })).not.toContain("--add-dir");
  });

  test("includes effort as config flag", () => {
    const args = buildCodexArgs({ ...readOpts, effort: "high" });
    expect(args).toContain("-c");
    expect(args[args.indexOf("-c") + 1]).toBe("model_reasoning_effort=high");
  });
});

describe("parseClaudeUsage", () => {
  test("parses a full claude JSON response", () => {
    const stdout = JSON.stringify({
      result: "some text",
      usage: { input_tokens: 1000, output_tokens: 500, cache_creation_input_tokens: 200, cache_read_input_tokens: 800 },
      total_cost_usd: 0.42,
      num_turns: 3,
      duration_ms: 12345,
      permission_denials: ["Write", "Edit"],
    });
    const usage = parseClaudeUsage(stdout);
    expect(usage).toEqual({
      input_tokens: 1000,
      output_tokens: 500,
      cache_creation_input_tokens: 200,
      cache_read_input_tokens: 800,
      cost_usd: 0.42,
      num_turns: 3,
      cli_duration_ms: 12345,
      permission_denials: 2,
    });
  });

  test("parses partial usage (no cost, no denials)", () => {
    const stdout = JSON.stringify({
      usage: { input_tokens: 100, output_tokens: 50 },
      num_turns: 1,
    });
    const usage = parseClaudeUsage(stdout);
    expect(usage).toBeDefined();
    expect(usage!.input_tokens).toBe(100);
    expect(usage!.output_tokens).toBe(50);
    expect(usage!.cost_usd).toBeUndefined();
    expect(usage!.permission_denials).toBeUndefined();
  });

  test("returns undefined for non-JSON", () => {
    expect(parseClaudeUsage("not json")).toBeUndefined();
  });

  test("returns undefined for JSON with no usage fields", () => {
    expect(parseClaudeUsage(JSON.stringify({ result: "hello" }))).toBeUndefined();
  });

  test("zero permission_denials from empty array", () => {
    const stdout = JSON.stringify({ permission_denials: [] });
    const usage = parseClaudeUsage(stdout);
    expect(usage).toBeDefined();
    expect(usage!.permission_denials).toBe(0);
  });
});

describe("parseCodexUsage", () => {
  test("parses JSONL with a turn.completed event", () => {
    const lines = [
      JSON.stringify({ type: "thread.started" }),
      JSON.stringify({ type: "turn.started" }),
      JSON.stringify({
        type: "turn.completed",
        usage: { input_tokens: 2000, output_tokens: 800, cached_input_tokens: 500, total_tokens: 3300 },
      }),
    ].join("\n");

    const usage = parseCodexUsage(lines);
    expect(usage).toEqual({
      input_tokens: 2000,
      output_tokens: 800,
      cache_read_input_tokens: 500,
    });
  });

  test("returns undefined when no turn.completed event", () => {
    const lines = [
      JSON.stringify({ type: "thread.started" }),
      JSON.stringify({ type: "turn.started" }),
    ].join("\n");
    expect(parseCodexUsage(lines)).toBeUndefined();
  });

  test("returns undefined for non-JSONL", () => {
    expect(parseCodexUsage("garbage")).toBeUndefined();
  });
});

describe("dispatchNotes", () => {
  test("records the session id on success and nothing else", () => {
    const notes = dispatchNotes({ ok: true, exitCode: 0, stderr: "", stdout: JSON.stringify({ session_id: "abc", result: "done" }) });
    expect(notes).toEqual(["session:abc"]);
  });

  test("on failure records the CLI's error subtype and result text", () => {
    const stdout = JSON.stringify({ session_id: "abc", is_error: true, subtype: "error_max_turns", result: "hit the turn limit" });
    const notes = dispatchNotes({ ok: false, exitCode: 1, stderr: "", stdout });
    expect(notes).toEqual(["session:abc", "exit 1: error_max_turns — hit the turn limit"]);
  });

  test("on failure without JSON falls back to the stderr tail", () => {
    const notes = dispatchNotes({ ok: false, exitCode: 2, stderr: "boom", stdout: "not json" });
    expect(notes).toEqual(["exit 2: boom"]);
  });
});
