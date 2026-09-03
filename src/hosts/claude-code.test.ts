import { test, expect, describe } from "bun:test";
import { claudeArgs } from "./claude-code.ts";
import { stripFence } from "./types.ts";
import type { HostRequest } from "./types.ts";

const request = (overrides: Partial<HostRequest> = {}): HostRequest => ({
  binding: { host: "claude-code", model: "opus", effort: "high", timeout_ms: 600_000 },
  host: { bin: "claude", adapter: "claude-code" },
  prompt: "# Role: researcher",
  input: "payload",
  workdir: "/repo",
  write: false,
  timeout_ms: 600_000,
  ...overrides,
});

describe("claudeArgs", () => {
  test("a read-only phase denies the write tools and never asks", () => {
    const args = claudeArgs(request());

    expect(args).toContain("-p");
    expect(args.join(" ")).toContain("--output-format json");
    expect(args.join(" ")).toContain("--permission-mode dontAsk");
    expect(args.join(" ")).toContain("--disallowed-tools Edit Write NotebookEdit");
  });

  test("a write phase gets a shell, via an allowlist rather than a blanket skip", () => {
    const args = claudeArgs(request({ write: true }));

    // `bypassPermissions` maps to --dangerously-skip-permissions, which refuses to
    // run as root and so fails outright in a container. This works everywhere and
    // is a fence rather than the absence of one.
    expect(args.join(" ")).toContain("--permission-mode acceptEdits");
    expect(args.join(" ")).toContain("--allowed-tools Bash Read Write Edit");
    expect(args).not.toContain("--disallowed-tools");
    expect(args).not.toContain("bypassPermissions");
  });

  test("the model and effort come from the binding", () => {
    expect(claudeArgs(request()).join(" ")).toContain("--model opus --effort high");

    const noEffort = claudeArgs(
      request({ binding: { host: "claude-code", model: "sonnet", timeout_ms: 1 } })
    );
    expect(noEffort).not.toContain("--effort");
  });

  test("the payload is never an argument", () => {
    // `--disallowed-tools <tools...>` and `--add-dir <directories...>` are variadic
    // and swallow a trailing positional prompt, which the CLI then reports as
    // "Input must be provided either through stdin or as a prompt argument".
    // The payload goes on stdin instead, which also lifts the argv length ceiling.
    const args = claudeArgs(request({ input: "SENTINEL", readDirs: ["/runs/demo"] }));

    expect(args).not.toContain("SENTINEL");
    expect(args.at(-1)).toBe("/runs/demo");
  });

  test("the role prompt is appended rather than replacing the host's own", () => {
    const args = claudeArgs(request());
    const index = args.indexOf("--append-system-prompt");

    expect(index).toBeGreaterThan(-1);
    expect(args[index + 1]).toBe("# Role: researcher");
    expect(args).not.toContain("--system-prompt");
  });
});

describe("stripFence", () => {
  test("unwraps a fence around the whole artifact", () => {
    expect(stripFence("```markdown\n## Findings\n\nbody\n```")).toBe("## Findings\n\nbody");
    expect(stripFence("~~~\nplain\n~~~")).toBe("plain");
  });

  test("leaves fences that are part of the artifact alone", () => {
    const doc = "## Findings\n\n```ts\nconst x = 1;\n```\n\nmore";
    expect(stripFence(doc)).toBe(doc);
  });

  test("trims without otherwise touching unfenced output", () => {
    expect(stripFence("  body  ")).toBe("body");
  });
});
