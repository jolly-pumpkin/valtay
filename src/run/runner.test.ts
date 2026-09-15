import { test, expect, describe, beforeEach, afterEach } from "bun:test";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve, join } from "node:path";
import { parseRunspec } from "../runspec.ts";
import { readState, readInvocations, readLedger, type Run } from "./store.ts";
import { run, type RunResult } from "./runner.ts";
import type { Provider, DispatchOpts, DispatchResult } from "./provider.ts";

let root: string;
let repo: string;

const SPEC = `---
run: test-run
host: claude
model: sonnet
---

# Test

## Design

interface Foo { bar: string }
`;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "valtay-runner-"));
  repo = resolve(root, "myrepo");
  await mkdir(resolve(repo, ".git"), { recursive: true });
  // Init a real git repo so worktree operations and merges can work
  const proc = Bun.spawn(["git", "init"], { cwd: repo, stdout: "ignore", stderr: "ignore" });
  await proc.exited;
  // Initial commit so branches can be created
  await Bun.write(resolve(repo, "README.md"), "# test\n");
  const addProc = Bun.spawn(["git", "add", "."], { cwd: repo, stdout: "ignore", stderr: "ignore" });
  await addProc.exited;
  const commitProc = Bun.spawn(["git", "commit", "-m", "init", "--allow-empty"], {
    cwd: repo,
    stdout: "ignore",
    stderr: "ignore",
    env: { ...process.env, GIT_AUTHOR_NAME: "test", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "test", GIT_COMMITTER_EMAIL: "t@t" },
  });
  await commitProc.exited;
});

afterEach(async () => {
  // Clean up worktrees that may have been created
  const proc = Bun.spawn(["git", "worktree", "prune"], { cwd: repo, stdout: "ignore", stderr: "ignore" });
  await proc.exited;
  await rm(root, { recursive: true, force: true });
});

/**
 * Build a FakeProvider that writes predetermined artifacts when dispatched.
 * The `actions` map keys are prompt substrings to match; values are functions
 * that write the expected files.
 */
function fakeProviderFactory(actions: Map<string, (opts: DispatchOpts) => Promise<void>>) {
  return (_host: string): Provider => ({
    name: "fake",
    async dispatch(prompt: string, opts: DispatchOpts): Promise<DispatchResult> {
      for (const [key, action] of actions) {
        if (prompt.includes(key)) {
          await action(opts);
          return { ok: true, exitCode: 0, stdout: "", stderr: "" };
        }
      }
      return { ok: true, exitCode: 0, stdout: "", stderr: "" };
    },
  });
}

function spec() {
  return parseRunspec(SPEC, resolve(root, "runspec.md"));
}

describe("runner", () => {
  test("complete run: plan → build → verify (clean)", async () => {
    const actions = new Map<string, (opts: DispatchOpts) => Promise<void>>();

    // Plan phase: write plan.md and briefs/RU-1.md
    actions.set('phase "plan"', async () => {
      const runDir = resolve(repo, ".valtay", "runs", "test-run");
      await mkdir(resolve(runDir, "briefs"), { recursive: true });
      await Bun.write(
        resolve(runDir, "plan.md"),
        "# Plan: Test\n\n## RU-1 — Implement Foo\n\n**Checkpoint:** `bun test`\n\n### L1 — feat(foo): add Foo type\n- **Kind:** semantic\n- **Inert:** no\n- **Files:** `src/foo.ts`\n- **Est LOC:** +10 / -0\n\n## Alternatives considered\n\n- **Single file** — rejected because not modular\n",
      );
      await Bun.write(
        resolve(runDir, "briefs", "RU-1.md"),
        "# Brief: RU-1 — Implement Foo\n\n## Layers\n\n### L1 — feat(foo): add Foo type\n\n## Dependencies\n\nNone\n",
      );
    });

    // Build subagent: write report and commit a file in worktree
    actions.set("build subagent for unit RU-1", async (opts) => {
      const runDir = resolve(repo, ".valtay", "runs", "test-run");
      // Write a source file in the worktree
      await Bun.write(resolve(opts.cwd, "src", "foo.ts"), "export interface Foo { bar: string }\n");
      // Stage and commit
      const addProc = Bun.spawn(["git", "add", "-A"], { cwd: opts.cwd, stdout: "ignore", stderr: "ignore" });
      await addProc.exited;
      const commitProc = Bun.spawn(["git", "commit", "-m", "feat: add Foo type"], {
        cwd: opts.cwd,
        stdout: "ignore",
        stderr: "ignore",
        env: { ...process.env, GIT_AUTHOR_NAME: "test", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "test", GIT_COMMITTER_EMAIL: "t@t" },
      });
      await commitProc.exited;
      // Write report to run dir
      await Bun.write(
        resolve(runDir, "reports", "RU-1.md"),
        "# Report: RU-1\n\n## L1 — feat(foo): add Foo type\n- **Status:** done\n- **Files touched:** `src/foo.ts`\n",
      );
    });

    // Verify phase: write clean verify.json
    actions.set('phase "verify"', async () => {
      const runDir = resolve(repo, ".valtay", "runs", "test-run");
      await Bun.write(resolve(runDir, "verify.json"), JSON.stringify({ status: "clean", findings: [] }));
    });

    const result = await run({
      spec: spec(),
      repoRoot: repo,
      runName: "test-run",
      providerFactory: fakeProviderFactory(actions),
    });

    expect(result.outcome).toBe("complete");
  });

  test("drift: verify finds drift", async () => {
    const actions = new Map<string, (opts: DispatchOpts) => Promise<void>>();

    actions.set('phase "plan"', async () => {
      const runDir = resolve(repo, ".valtay", "runs", "test-run");
      await mkdir(resolve(runDir, "briefs"), { recursive: true });
      await Bun.write(resolve(runDir, "plan.md"), "# Plan\n\n## RU-1 — Test\n");
      await Bun.write(resolve(runDir, "briefs", "RU-1.md"), "# Brief\n\n## Dependencies\n\nNone\n");
    });

    actions.set("build subagent for unit RU-1", async (opts) => {
      const runDir = resolve(repo, ".valtay", "runs", "test-run");
      await Bun.write(resolve(opts.cwd, "src", "foo.ts"), "export const foo = 1;\n");
      const addProc = Bun.spawn(["git", "add", "-A"], { cwd: opts.cwd, stdout: "ignore", stderr: "ignore" });
      await addProc.exited;
      const commitProc = Bun.spawn(["git", "commit", "-m", "build"], {
        cwd: opts.cwd,
        stdout: "ignore",
        stderr: "ignore",
        env: { ...process.env, GIT_AUTHOR_NAME: "test", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "test", GIT_COMMITTER_EMAIL: "t@t" },
      });
      await commitProc.exited;
      await Bun.write(resolve(runDir, "reports", "RU-1.md"), "# Report: RU-1\n\n## L1 — test\n- **Status:** done\n- **Files touched:** `src/foo.ts`\n");
    });

    actions.set('phase "verify"', async () => {
      const runDir = resolve(repo, ".valtay", "runs", "test-run");
      await Bun.write(
        resolve(runDir, "verify.json"),
        JSON.stringify({
          status: "drift",
          findings: [{ what: "Foo interface", actual: "const foo", file: "src/foo.ts", severity: "drift" }],
        }),
      );
    });

    const result = await run({
      spec: spec(),
      repoRoot: repo,
      runName: "test-run",
      providerFactory: fakeProviderFactory(actions),
    });

    expect(result.outcome).toBe("drift");
    if (result.outcome === "drift") {
      expect(result.findings.length).toBe(1);
      expect(result.findings[0]!.severity).toBe("drift");
    }
  });

  test("contested: subagent contests a layer", async () => {
    const actions = new Map<string, (opts: DispatchOpts) => Promise<void>>();

    actions.set('phase "plan"', async () => {
      const runDir = resolve(repo, ".valtay", "runs", "test-run");
      await mkdir(resolve(runDir, "briefs"), { recursive: true });
      await Bun.write(resolve(runDir, "plan.md"), "# Plan\n\n## RU-1 — Test\n");
      await Bun.write(resolve(runDir, "briefs", "RU-1.md"), "# Brief\n\n## Dependencies\n\nNone\n");
    });

    actions.set("build subagent for unit RU-1", async () => {
      const runDir = resolve(repo, ".valtay", "runs", "test-run");
      await Bun.write(
        resolve(runDir, "reports", "RU-1.md"),
        "# Report: RU-1\n\n## L1 — test\n- **Status:** contested\n- **Reason:** This layer is unnecessary\n",
      );
    });

    const result = await run({
      spec: spec(),
      repoRoot: repo,
      runName: "test-run",
      providerFactory: fakeProviderFactory(actions),
    });

    expect(result.outcome).toBe("contested");
    if (result.outcome === "contested") {
      expect(result.layers.length).toBe(1);
      expect(result.layers[0]!.status).toBe("contested");
    }
  });

  test("failed: plan provider exits non-zero", async () => {
    const factory = (_host: string): Provider => ({
      name: "fake",
      async dispatch(): Promise<DispatchResult> {
        return { ok: false, exitCode: 1, stdout: "", stderr: "model error" };
      },
    });

    const result = await run({
      spec: spec(),
      repoRoot: repo,
      runName: "test-run",
      providerFactory: factory,
    });

    expect(result.outcome).toBe("failed");
    if (result.outcome === "failed") {
      expect(result.phase).toBe("plan");
      expect(result.reason).toContain("model error");
    }
  });

  test("records invocations for each dispatch", async () => {
    const actions = new Map<string, (opts: DispatchOpts) => Promise<void>>();

    actions.set('phase "plan"', async () => {
      const runDir = resolve(repo, ".valtay", "runs", "test-run");
      await mkdir(resolve(runDir, "briefs"), { recursive: true });
      await Bun.write(resolve(runDir, "plan.md"), "# Plan\n\n## RU-1 — Test\n");
      await Bun.write(
        resolve(runDir, "briefs", "RU-1.md"),
        "# Brief\n\n## Layers\n\n### L1\n- **Files:** `src/foo.ts`\n\n## Dependencies\n\nNone\n",
      );
    });

    actions.set("build subagent for unit RU-1", async (opts) => {
      const runDir = resolve(repo, ".valtay", "runs", "test-run");
      await Bun.write(resolve(opts.cwd, "src", "foo.ts"), "export const foo = 1;\n");
      const addProc = Bun.spawn(["git", "add", "-A"], { cwd: opts.cwd, stdout: "ignore", stderr: "ignore" });
      await addProc.exited;
      const commitProc = Bun.spawn(["git", "commit", "-m", "build"], {
        cwd: opts.cwd, stdout: "ignore", stderr: "ignore",
        env: { ...process.env, GIT_AUTHOR_NAME: "test", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "test", GIT_COMMITTER_EMAIL: "t@t" },
      });
      await commitProc.exited;
      await Bun.write(resolve(runDir, "reports", "RU-1.md"), "# Report: RU-1\n\n## L1\n- **Status:** done\n- **Files touched:** `src/foo.ts`\n");
    });

    actions.set('phase "verify"', async () => {
      const runDir = resolve(repo, ".valtay", "runs", "test-run");
      await Bun.write(resolve(runDir, "verify.json"), JSON.stringify({ status: "clean", findings: [] }));
    });

    await run({
      spec: spec(),
      repoRoot: repo,
      runName: "test-run",
      providerFactory: fakeProviderFactory(actions),
    });

    const { loadRun } = await import("./store.ts");
    const theRun = await loadRun(resolve(repo, ".valtay", "runs", "test-run"));
    const invocations = await readInvocations(theRun);

    expect(invocations).toHaveLength(3); // plan, build RU-1, verify
    expect(invocations[0]!.phase).toBe("plan");
    expect(invocations[0]!.host).toBe("claude");
    expect(invocations[0]!.model).toBe("sonnet");
    expect(invocations[0]!.exit_code).toBe(0);
    expect(invocations[0]!.duration_ms).toBeGreaterThanOrEqual(0);
    expect(invocations[0]!.prompt_sha).toBeTruthy();

    expect(invocations[1]!.phase).toBe("build");
    expect(invocations[1]!.unit).toBe("RU-1");

    expect(invocations[2]!.phase).toBe("verify");
  });

  test("failed dispatch still records invocation", async () => {
    const factory = (_host: string): Provider => ({
      name: "fake",
      async dispatch(): Promise<DispatchResult> {
        return { ok: false, exitCode: 1, stdout: "", stderr: "boom" };
      },
    });

    await run({
      spec: spec(),
      repoRoot: repo,
      runName: "test-run",
      providerFactory: factory,
    });

    const { loadRun } = await import("./store.ts");
    const theRun = await loadRun(resolve(repo, ".valtay", "runs", "test-run"));
    const invocations = await readInvocations(theRun);

    expect(invocations).toHaveLength(1);
    expect(invocations[0]!.exit_code).toBe(1);
  });

  test("detects fence violations when unit touches files outside its declared set", async () => {
    const actions = new Map<string, (opts: DispatchOpts) => Promise<void>>();

    actions.set('phase "plan"', async () => {
      const runDir = resolve(repo, ".valtay", "runs", "test-run");
      await mkdir(resolve(runDir, "briefs"), { recursive: true });
      await Bun.write(resolve(runDir, "plan.md"), "# Plan\n\n## RU-1 — Test\n");
      // Brief declares only src/foo.ts
      await Bun.write(
        resolve(runDir, "briefs", "RU-1.md"),
        "# Brief\n\n## Layers\n\n### L1\n- **Files:** `src/foo.ts`\n\n## Dependencies\n\nNone\n",
      );
    });

    actions.set("build subagent for unit RU-1", async (opts) => {
      const runDir = resolve(repo, ".valtay", "runs", "test-run");
      // Touch src/foo.ts (declared) AND src/extra.ts (NOT declared — fence violation)
      await mkdir(resolve(opts.cwd, "src"), { recursive: true });
      await Bun.write(resolve(opts.cwd, "src", "foo.ts"), "export const foo = 1;\n");
      await Bun.write(resolve(opts.cwd, "src", "extra.ts"), "export const extra = 2;\n");
      const addProc = Bun.spawn(["git", "add", "-A"], { cwd: opts.cwd, stdout: "ignore", stderr: "ignore" });
      await addProc.exited;
      const commitProc = Bun.spawn(["git", "commit", "-m", "build"], {
        cwd: opts.cwd, stdout: "ignore", stderr: "ignore",
        env: { ...process.env, GIT_AUTHOR_NAME: "test", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "test", GIT_COMMITTER_EMAIL: "t@t" },
      });
      await commitProc.exited;
      await Bun.write(resolve(runDir, "reports", "RU-1.md"), "# Report: RU-1\n\n## L1\n- **Status:** done\n- **Files touched:** `src/foo.ts`, `src/extra.ts`\n");
    });

    actions.set('phase "verify"', async () => {
      const runDir = resolve(repo, ".valtay", "runs", "test-run");
      await Bun.write(resolve(runDir, "verify.json"), JSON.stringify({ status: "clean", findings: [] }));
    });

    await run({
      spec: spec(),
      repoRoot: repo,
      runName: "test-run",
      providerFactory: fakeProviderFactory(actions),
    });

    const { loadRun } = await import("./store.ts");
    const theRun = await loadRun(resolve(repo, ".valtay", "runs", "test-run"));
    const ledger = await readLedger(theRun);

    expect(ledger).not.toBeNull();
    const ru1 = ledger!.units.find((u) => u.unit === "RU-1");
    expect(ru1).toBeDefined();
    expect(ru1!.fenceViolations).toContain("src/extra.ts");
    expect(ru1!.fenceViolations).not.toContain("src/foo.ts");
  });
});
