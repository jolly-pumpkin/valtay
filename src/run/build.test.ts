import { test, expect, describe, beforeEach, afterEach } from "bun:test";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve, join } from "node:path";
import { runStart } from "../commands/start.ts";
import { createReplayAdapter, type ReplayAdapter } from "../hosts/replay.ts";
import { registerAdapter } from "../hosts/index.ts";
import { git, worktreePath } from "../worktree.ts";
import { pathExists } from "../detect.ts";
import { runBuild } from "./build.ts";
import { readArtifact, readManifest, writeArtifact, type Run } from "./store.ts";
import { readRunspec } from "../runspec.ts";

let root: string;
let repo: string;
let restore: () => void;
const savedHome = process.env["VALTAY_HOME"];

const SPEC = `---
run: demo
---

# Demo

## Assumptions to verify

- **A-1** Verify something.
`;

const PLAN = {
  epic: "two-layers",
  release_units: [
    {
      id: "RU-1",
      goal: "the greeting works",
      checkpoint: "cat greeting.txt",
      layers: [
        {
          id: "L1",
          title: "feat: add greeting",
          kind: "semantic",
          inert: true,
          files: ["greeting.txt"],
          est_loc: { add: 1, del: 0 },
        },
        {
          id: "L2",
          title: "feat: wire the greeting up",
          kind: "semantic",
          inert: false,
          files: ["wire.txt"],
          est_loc: { add: 1, del: 0 },
        },
      ],
    },
  ],
  alternatives_considered: [{ shape: "one layer", rejected: "mixes inert with activating" }],
};

const PROBE = {
  traces: [
    {
      unit: "RU-1",
      source: "agent",
      entry: "greet",
      nodes: [{ id: "n1", symbol: "greet", file: "greeting.txt", line: 1, status: "new", children: [] }],
    },
  ],
  deviations: [{ kind: "ordering", detail: "the greeting had to land before the wiring" }],
  checkpoint_output: "hello",
};

/**
 * A replay adapter that also performs each layer's file writes, so the worktree
 * really changes and the commit and fence checks act on a real diff.
 */
function buildingAdapter(writes: Array<Record<string, string>>): ReplayAdapter {
  const adapter = createReplayAdapter("claude-code", writes.map((_, i) => `- built layer ${i + 1}`));
  const replay = adapter.run.bind(adapter);

  adapter.run = async (request) => {
    const files = writes[adapter.calls.length] ?? {};
    for (const [name, content] of Object.entries(files)) {
      await Bun.write(resolve(request.workdir, name), content);
    }
    return replay(request);
  };

  return adapter;
}

async function readyRun(): Promise<Run> {
  const path = resolve(repo, "runspec.md");
  await writeFile(path, SPEC);

  const run = await runStart({ spec: path });
  await writeArtifact(run, "plan.json", JSON.stringify(PLAN));
  await writeArtifact(run, "probe.json", JSON.stringify(PROBE));
  await writeArtifact(run, "shape.ts", "export function greet(): string;");
  return run;
}

const build = async (run: Run) => runBuild(run, await readRunspec(resolve(run.dir, "runspec.md")));

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "valtay-build-"));
  repo = resolve(root, "valtay");
  await mkdir(repo, { recursive: true });
  await writeFile(resolve(repo, "package.json"), "{}");
  await git(repo, ["init", "--quiet", "-b", "main"]);
  await git(repo, ["config", "user.email", "test@example.com"]);
  await git(repo, ["config", "user.name", "Test"]);
  await git(repo, ["add", "-A"]);
  await git(repo, ["commit", "--quiet", "-m", "init"]);

  process.env["VALTAY_HOME"] = resolve(root, "home");
  restore = () => {};
});

afterEach(async () => {
  restore();
  if (savedHome === undefined) delete process.env["VALTAY_HOME"];
  else process.env["VALTAY_HOME"] = savedHome;
  await rm(root, { recursive: true, force: true });
});

describe("runBuild", () => {
  test("invokes once per review layer and commits each in order", async () => {
    const adapter = buildingAdapter([{ "greeting.txt": "hello\n" }, { "wire.txt": "wired\n" }]);
    restore = registerAdapter(adapter);

    const run = await readyRun();
    const outcome = await build(run);

    expect(outcome.ok).toBe(true);
    expect(adapter.calls).toHaveLength(2);

    // The layer boundary is what the reviewer approved at G3, so it is the unit of
    // work — one commit each, in dependency order, which is the stack.
    const log = (await git(worktreePath("demo", "build"), ["log", "--format=%s", "main..HEAD"])).stdout;
    expect(log.split("\n")).toEqual(["feat: wire the greeting up", "feat: add greeting"]);
  });

  test("gives each builder only its own layer's fence and file set", async () => {
    const adapter = buildingAdapter([{ "greeting.txt": "hello\n" }, { "wire.txt": "wired\n" }]);
    restore = registerAdapter(adapter);
    await build(await readyRun());

    const first = adapter.calls[0]!.input;
    expect(first).toContain("feat: add greeting");
    expect(first).toContain("greeting.txt");
    expect(first).toContain("inert: true");
    expect(first).not.toContain("wire.txt");

    // What the probe ran into is the cheapest information a builder gets.
    expect(first).toContain("the greeting had to land before the wiring");
  });

  test("keeps the worktree, because G6 reads the diff", async () => {
    restore = registerAdapter(buildingAdapter([{ "greeting.txt": "hello\n" }, { "wire.txt": "x\n" }]));
    await build(await readyRun());

    expect(await pathExists(worktreePath("demo", "build"))).toBe(true);
  });

  test("points the reviewer at the build's own commits, not at main", async () => {
    restore = registerAdapter(buildingAdapter([{ "greeting.txt": "hello\n" }, { "wire.txt": "x\n" }]));
    const run = await readyRun();

    const base = (await git(repo, ["rev-parse", "HEAD"])).stdout;
    await build(run);

    // A run can start from any branch, so `main..HEAD` is the wrong range — live, it
    // showed a reviewer 58 files instead of the 2 the build actually touched.
    const report = (await readArtifact(run, "build.md"))!;
    expect(report).toContain(`${base.slice(0, 12)}..HEAD`);
    expect(report).not.toContain("main..HEAD");
  });

  test("runs the unit's checkpoint and reports what it printed", async () => {
    restore = registerAdapter(buildingAdapter([{ "greeting.txt": "hello\n" }, { "wire.txt": "x\n" }]));
    const run = await readyRun();
    await build(run);

    const report = (await readArtifact(run, "build.md"))!;
    expect(report).toContain("`cat greeting.txt` passed");
    expect(report).toContain("hello");
  });

  test("reports a checkpoint that fails rather than claiming success", async () => {
    // Nothing writes greeting.txt, so `cat greeting.txt` cannot succeed.
    restore = registerAdapter(buildingAdapter([{ "other.txt": "x\n" }, { "wire.txt": "x\n" }]));
    const run = await readyRun();
    await build(run);

    expect(await readArtifact(run, "build.md")).toContain("FAILED");
  });
});

describe("the file-set fence", () => {
  test("reports a layer that wrote outside its declared set", async () => {
    restore = registerAdapter(
      buildingAdapter([{ "greeting.txt": "hello\n", "sneaky.txt": "not declared\n" }, { "wire.txt": "x\n" }])
    );

    const run = await readyRun();
    await build(run);

    // Detection, not prevention — design.md §15.1 wants a PreToolUse hook that
    // refuses the write. Until that exists the rule lives one rung lower, and the
    // widened footprint is surfaced at G6 rather than swallowed.
    const report = (await readArtifact(run, "build.md"))!;
    expect(report).toContain("**Wrote outside its declared file set:** sneaky.txt");

    expect((await readManifest(run))[0]!.notes.join(" ")).toContain("sneaky.txt");
  });

  test("says nothing when every layer stayed inside its set", async () => {
    restore = registerAdapter(buildingAdapter([{ "greeting.txt": "hello\n" }, { "wire.txt": "x\n" }]));
    const run = await readyRun();
    await build(run);

    expect(await readArtifact(run, "build.md")).not.toContain("outside its declared file set");
  });
});

describe("failure", () => {
  test("halts the unit, keeps what landed, and says where it stopped", async () => {
    const adapter = createReplayAdapter("claude-code", ["- built L1", { error: "the builder gave up" }]);
    const replay = adapter.run.bind(adapter);
    adapter.run = async (request) => {
      if (adapter.calls.length === 0) await Bun.write(resolve(request.workdir, "greeting.txt"), "hello\n");
      return replay(request);
    };
    restore = registerAdapter(adapter);

    const run = await readyRun();
    const outcome = await build(run);

    expect(outcome.ok).toBe(false);
    expect(outcome.error).toContain("L2 failed");

    const report = (await readArtifact(run, "build.md"))!;
    expect(report).toContain("## Halted");
    expect(report).toContain("feat: add greeting");

    // L1 is still on the branch — a halt does not throw away what worked.
    const log = (await git(worktreePath("demo", "build"), ["log", "--format=%s", "main..HEAD"])).stdout;
    expect(log).toBe("feat: add greeting");
  });

  test("records every layer invocation in the manifest, failures included", async () => {
    const adapter = createReplayAdapter("claude-code", ["- built L1", { error: "gave up" }]);
    restore = registerAdapter(adapter);

    const run = await readyRun();
    await build(run);

    const manifest = await readManifest(run);
    expect(manifest).toHaveLength(2);
    expect(manifest[0]!.notes).toContain("layer L1");
    expect(manifest[1]!.notes.join(" ")).toContain("gave up");
  });
});
