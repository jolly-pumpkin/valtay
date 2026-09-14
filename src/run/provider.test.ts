import { test, expect, describe } from "bun:test";
import { providerFor, buildClaudeArgs, buildCodexArgs } from "./provider.ts";
import type { DispatchOpts } from "./provider.ts";

const baseOpts: DispatchOpts = { cwd: "/tmp", model: "sonnet" };

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
  test("builds basic args", () => {
    const args = buildClaudeArgs("do the thing", baseOpts);
    expect(args).toEqual(["claude", "-p", "do the thing", "--model", "sonnet"]);
  });

  test("includes effort when provided", () => {
    const args = buildClaudeArgs("do the thing", { ...baseOpts, effort: "high" });
    expect(args).toEqual(["claude", "-p", "do the thing", "--model", "sonnet", "--effort", "high"]);
  });
});

describe("buildCodexArgs", () => {
  test("builds basic args", () => {
    const args = buildCodexArgs("do the thing", baseOpts);
    expect(args).toEqual(["codex", "-q", "do the thing", "--model", "sonnet"]);
  });
});
