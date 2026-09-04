import { test, expect, describe } from "bun:test";
import { codexArgs, codexPayload, parseCodexStream } from "./codex.ts";
import type { HostRequest } from "./types.ts";

const request = (overrides: Partial<HostRequest> = {}): HostRequest => ({
  binding: { host: "codex", model: "gpt-5.6-luna", effort: "high", timeout_ms: 600_000 },
  host: { bin: "codex", adapter: "codex" },
  skill: { name: "valtay-research", path: "/repo/.codex/skills/valtay-research/SKILL.md" },
  input: "payload",
  workdir: "/repo",
  write: false,
  timeout_ms: 600_000,
  ...overrides,
});

const OUT = "/repo/.valtay-codex-1.txt";

describe("codexArgs", () => {
  test("a read-only phase runs under the sandbox that refuses every write", () => {
    // Verified against codex-cli 0.153.3 with `codex sandbox`: under `read-only` a
    // write inside the working root fails with "Read-only file system", while reads
    // outside it still succeed.
    const args = codexArgs(request(), OUT);

    expect(args[0]).toBe("exec");
    expect(args.join(" ")).toContain("--sandbox read-only");
    expect(args.join(" ")).toContain("--json");
  });

  test("a write phase is fenced to its working root, never handed full access", () => {
    // `danger-full-access` and `--dangerously-bypass-approvals-and-sandbox` are the
    // codex analogue of claude's `bypassPermissions`: the absence of a fence.
    // `workspace-write` confines writes to the worktree, which is the fence Valtay
    // already relies on.
    const args = codexArgs(request({ write: true }), OUT);

    expect(args.join(" ")).toContain("--sandbox workspace-write");
    expect(args).not.toContain("danger-full-access");
    expect(args).not.toContain("--dangerously-bypass-approvals-and-sandbox");
  });

  test("the model and effort come from the binding", () => {
    // `model_reasoning_effort` is a real config field, not a guess: `--strict-config`
    // accepts it and rejects a typo of it.
    expect(codexArgs(request(), OUT).join(" ")).toContain("--model gpt-5.6-luna");
    expect(codexArgs(request(), OUT).join(" ")).toContain("-c model_reasoning_effort=high");

    const noEffort = codexArgs(
      request({ binding: { host: "codex", model: "gpt-5.6-sol", timeout_ms: 1 } }),
      OUT
    );
    expect(noEffort.join(" ")).not.toContain("model_reasoning_effort");
  });

  test("the payload is never an argument", () => {
    // Same reason as claude-code: it lifts the argv length ceiling, which matters
    // once a phase's inputs are several artifacts long. `-` is what makes codex read
    // the prompt from stdin.
    const args = codexArgs(request({ input: "SENTINEL" }), OUT);

    expect(args).not.toContain("SENTINEL");
    expect(args.at(-1)).toBe("-");
  });

  test("the run directory is not handed to --add-dir", () => {
    // `--add-dir` grants *write* access, and reads outside the working root already
    // succeed under both sandboxes. Passing it would let a write phase write into the
    // run's own artifacts to buy nothing.
    const args = codexArgs(request({ readDirs: ["/runs/demo"], write: true }), OUT);

    expect(args).not.toContain("--add-dir");
    expect(args).not.toContain("/runs/demo");
  });

  test("the last-message file never lands in the working directory", () => {
    // For a read-only phase the workdir is the user's own checkout; for a write phase
    // it is the worktree whose file set Build inspects, where a stray file is exactly
    // what the fence looks for. `--sandbox` governs the model's shell commands, not
    // the CLI's own output file, so the temp directory works under both modes.
    const args = codexArgs(request({ workdir: "/repo" }), "/tmp/valtay-codex-1.txt");
    const out = args[args.indexOf("--output-last-message") + 1]!;

    expect(out.startsWith("/repo")).toBe(false);
  });

  test("the final message is written to a file rather than scraped from the banner", () => {
    // `codex exec` prints a human-readable transcript to stdout, so the artifact
    // cannot be stdout. codex does not write this file at all when a turn fails,
    // which makes its absence a reliable failure signal.
    expect(codexArgs(request(), OUT).join(" ")).toContain(`--output-last-message ${OUT}`);
  });
});

describe("codexPayload", () => {
  test("the phase's instructions are inlined, because codex cannot be given a name", () => {
    // design.md §7.4 wants an adapter to deliver a name. Verified against 0.153.3:
    // a leading `/valtay-research` reaches the model as literal text, a name that
    // does not exist raises nothing, and codex's own skill loading is a lexical
    // relevance ranking. A phase picked by similarity is what the orchestrator
    // exists to prevent, so the body is inlined and the manifest records it.
    const payload = codexPayload("# Research\n\nDo the thing.", "# Assumptions\n\n- A-1 ...");

    expect(payload).toContain("<skill>");
    expect(payload).toContain("Do the thing.");
    expect(payload).toContain("- A-1 ...");
    expect(payload.indexOf("<skill>")).toBeLessThan(payload.indexOf("- A-1 ..."));
  });

  test("a slash line is not what carries the phase", () => {
    // The inverse of the claude-code adapter's contract, and deliberately so.
    expect(codexPayload("body", "input").startsWith("/valtay-")).toBe(false);
  });
});

describe("parseCodexStream", () => {
  const line = (o: unknown) => `${JSON.stringify(o)}\n`;

  test("the last agent message is the artifact", () => {
    const stdout =
      line({ type: "thread.started", thread_id: "t" }) +
      line({ type: "item.completed", item: { type: "reasoning", text: "thinking" } }) +
      line({ type: "item.completed", item: { type: "agent_message", text: "first" } }) +
      line({ type: "item.completed", item: { type: "agent_message", text: "## Findings" } }) +
      line({ type: "turn.completed", usage: { input_tokens: 10, output_tokens: 4 } });

    const parsed = parseCodexStream(stdout);

    expect(parsed.message).toBe("## Findings");
    expect(parsed.usage).toEqual({ input_tokens: 10, output_tokens: 4 });
    expect(parsed.error).toBeUndefined();
  });

  test("a failed turn carries codex's own text, never a paraphrase", () => {
    const stdout =
      line({ type: "turn.started" }) +
      line({ type: "turn.failed", error: { message: "model returned 429" } });

    expect(parseCodexStream(stdout).error).toBe("model returned 429");
  });

  test("a truncated stream is not a parse failure", () => {
    // A killed process leaves a partial line. That is a timeout, which the caller
    // already reports from the signal — it must not be reported as bad JSON on top.
    const stdout =
      line({ type: "item.completed", item: { type: "agent_message", text: "body" } }) +
      '{"type":"turn.comp';

    const parsed = parseCodexStream(stdout);

    expect(parsed.message).toBe("body");
    expect(parsed.error).toBeUndefined();
  });

  test("usage is absent rather than zero when codex does not report it", () => {
    expect(parseCodexStream(line({ type: "turn.completed" })).usage).toBeUndefined();
    expect(parseCodexStream("").message).toBeUndefined();
  });

  test("a stream with nothing in it yields no error string, not an empty one", () => {
    // `runPhase` treats `result.error` as a failure only when it is nullish, so an
    // empty string would read as success and store an empty artifact. Everything
    // downstream of the parser has to preserve undefined rather than "".
    const parsed = parseCodexStream(line({ type: "turn.started" }));

    expect(parsed.error).toBeUndefined();
    expect("error" in parsed).toBe(false);
  });
});
