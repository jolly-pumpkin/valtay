import { test, expect, describe } from "bun:test";
import { formatEvent } from "./progress.ts";

function toolUseEvent(blocks: Array<{ name: string; input?: Record<string, unknown> }>): string {
  return JSON.stringify({
    type: "assistant",
    message: {
      content: blocks.map((b) => ({ type: "tool_use", name: b.name, input: b.input ?? {} })),
    },
  });
}

describe("formatEvent", () => {
  test("returns formatted string for a single tool_use block", () => {
    const line = toolUseEvent([{ name: "Read", input: { file_path: "src/run/store.ts" } }]);
    expect(formatEvent(line, "plan")).toBe("  [plan] Read src/run/store.ts");
  });

  test("returns one line per tool_use block in a multi-tool message", () => {
    const line = toolUseEvent([
      { name: "Read", input: { file_path: "a.ts" } },
      { name: "Write", input: { file_path: "b.ts" } },
    ]);
    const result = formatEvent(line, "RU-1");
    expect(result).toBe("  [RU-1] Read a.ts\n  [RU-1] Write b.ts");
  });

  test("returns null for user events", () => {
    expect(formatEvent(JSON.stringify({ type: "user" }), "plan")).toBeNull();
  });

  test("returns null for system events", () => {
    expect(formatEvent(JSON.stringify({ type: "system" }), "plan")).toBeNull();
  });

  test("returns null for result events", () => {
    expect(formatEvent(JSON.stringify({ type: "result" }), "plan")).toBeNull();
  });

  test("returns null for assistant messages with only text content", () => {
    const line = JSON.stringify({
      type: "assistant",
      message: { content: [{ type: "text", text: "Hello" }] },
    });
    expect(formatEvent(line, "plan")).toBeNull();
  });

  test("returns null for non-JSON input", () => {
    expect(formatEvent("not json", "plan")).toBeNull();
  });

  test("relativizes file_path when it starts with cwd", () => {
    const cwd = process.cwd();
    const line = toolUseEvent([{ name: "Read", input: { file_path: `${cwd}/src/foo.ts` } }]);
    expect(formatEvent(line, "plan")).toBe("  [plan] Read src/foo.ts");
  });

  test("leaves file_path as-is when it does not start with cwd", () => {
    const line = toolUseEvent([{ name: "Edit", input: { file_path: "/other/path/foo.ts" } }]);
    expect(formatEvent(line, "verify")).toBe("  [verify] Edit /other/path/foo.ts");
  });

  test("relativizes NotebookEdit notebook_path", () => {
    const cwd = process.cwd();
    const line = toolUseEvent([{ name: "NotebookEdit", input: { notebook_path: `${cwd}/nb.ipynb` } }]);
    expect(formatEvent(line, "plan")).toBe("  [plan] NotebookEdit nb.ipynb");
  });

  test("truncates Bash command to 80 chars", () => {
    const longCmd = "a".repeat(100);
    const line = toolUseEvent([{ name: "Bash", input: { command: longCmd } }]);
    const result = formatEvent(line, "RU-2");
    expect(result).toBe(`  [RU-2] Bash ${"a".repeat(80)}...`);
  });

  test("Bash command within 80 chars is not truncated", () => {
    const line = toolUseEvent([{ name: "Bash", input: { command: "bun run test" } }]);
    expect(formatEvent(line, "RU-2")).toBe("  [RU-2] Bash bun run test");
  });

  test("shows pattern for Grep", () => {
    const line = toolUseEvent([{ name: "Grep", input: { pattern: "TODO" } }]);
    expect(formatEvent(line, "verify")).toBe("  [verify] Grep TODO");
  });

  test("shows pattern for Glob", () => {
    const line = toolUseEvent([{ name: "Glob", input: { pattern: "**/*.ts" } }]);
    expect(formatEvent(line, "plan")).toBe("  [plan] Glob **/*.ts");
  });

  test("unknown tool shows name only, no arg summary", () => {
    const line = toolUseEvent([{ name: "Agent", input: { prompt: "do stuff" } }]);
    expect(formatEvent(line, "plan")).toBe("  [plan] Agent");
  });
});
