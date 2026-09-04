import { test, expect, describe, beforeEach, afterEach } from "bun:test";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve, join } from "node:path";
import { runStart } from "../commands/start.ts";
import { createReplayAdapter, type ReplayAdapter } from "../hosts/replay.ts";
import { registerAdapter } from "../hosts/index.ts";
import { git, worktreePath } from "../worktree.ts";
import { pathExists } from "../detect.ts";
import { readLedger } from "../ledger.ts";
import { installSkills, phaseSkillName } from "../skills.ts";
import { sha256 } from "../runspec.ts";
import { advance, gateArtifacts, retry } from "./orchestrator.ts";
import { phase } from "./phases.ts";
import {
  appendApproval,
  readArtifact,
  readManifest,
  readState,
  writeArtifact,
  writeState,
  type Run,
} from "./store.ts";

let root: string;
let repo: string;
let restore: () => void;
const savedHome = process.env["VALTAY_HOME"];

const SPEC = `---
run: demo
---

# Demo

## Intent

Make the store append rather than overwrite.

## Tickets

**V-1 — append-only manifest**

## Out of scope

- Anything to do with the renderer

## Assumptions to verify

- **A-1** Verify whether the store appends or overwrites.
`;

const RESEARCH = "## Findings\n\n### A-1\n\n**Verdict:** confirmed. It appends (src/run/store.ts:12).";
const DESIGN = "## End state\n\nIt appends.\n\n## Deltas\n\nD-1 nothing disagrees.";
const SHAPE = "// NEW — the lint entry point\nexport function checkSpec(path: string): string[];";

const PLAN = JSON.stringify({
  epic: "append-only-manifest",
  stacking: "none",
  release_units: [
    {
      id: "RU-1",
      goal: "the manifest appends",
      checkpoint: "bun test",
      layers: [
        {
          id: "L1",
          title: "feat(store): append-only manifest",
          kind: "semantic",
          inert: false,
          files: ["src/run/store.ts"],
          est_loc: { add: 40, del: 2 },
        },
      ],
    },
  ],
  alternatives_considered: [{ shape: "one layer per function", rejected: "fragmentation, no review gain" }],
});

const PROBE = JSON.stringify({
  traces: [
    {
      unit: "RU-1",
      source: "agent",
      entry: "appendManifest",
      nodes: [
        {
          id: "n1",
          symbol: "appendManifest",
          file: "src/run/store.ts",
          line: 12,
          status: "changed",
          note: "appends rather than overwriting",
          children: ["n2"],
        },
        {
          id: "n2",
          symbol: "appendJsonl",
          file: "src/run/store.ts",
          line: 40,
          status: "new",
          children: [],
        },
      ],
    },
  ],
  deviations: [
    {
      kind: "signature",
      detail: "appendJsonl needed the run dir, which the plan did not pass",
      file: "src/run/store.ts",
      severity: "local",
      fix_lives_in: "plan.json",
    },
  ],
  checkpoint_output: "bun test v1.3.11\n 24 pass\n 0 fail",
});

const BUILD = "- Added appendJsonl and switched appendManifest to it.";

async function start(responses: Parameters<typeof createReplayAdapter>[1]): Promise<{
  run: Run;
  adapter: ReplayAdapter;
}> {
  const adapter = createReplayAdapter("claude-code", responses);
  restore = registerAdapter(adapter);

  const path = resolve(repo, "runspec.md");
  await writeFile(path, SPEC);
  return { run: await runStart({ spec: path, repo }), adapter };
}

/** Records the standing approval a gate needs, over everything it covers. */
async function approve(run: Run, gate: "G1" | "G2" | "G3" | "G4" | "G6"): Promise<void> {
  const def = [...["reconcile", "shape", "plan", "probe", "build"]]
    .map((id) => phase(id as never))
    .find((p) => p.gate === gate)!;

  await appendApproval(run, {
    ts: new Date().toISOString(),
    gate,
    decision: "approve",
    artifacts: await gateArtifacts(run, def),
  });
}

/** A real repo, not a `.git` stub — the probe's worktree needs git to work. */
async function initRepo(dir: string): Promise<void> {
  await mkdir(dir, { recursive: true });
  // Makes `shape.{ext}` resolve to TypeScript, as it does in the real repo.
  await writeFile(resolve(dir, "package.json"), "{}");

  // A phase is a skill the host loads from the directory it runs in, so a repo with
  // none is a repo no phase can start in. Committed, not just written: Probe and
  // Build run in a worktree, which carries tracked files only.
  await installSkills(resolve(dir, ".claude", "skills"));

  await git(dir, ["init", "--quiet", "-b", "main"]);
  await git(dir, ["config", "user.email", "test@example.com"]);
  await git(dir, ["config", "user.name", "Test"]);
  await git(dir, ["add", "-A"]);
  await git(dir, ["commit", "--quiet", "-m", "init"]);
}

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "valtay-orch-"));
  repo = resolve(root, "valtay");
  await initRepo(repo);
  process.env["VALTAY_HOME"] = resolve(root, "home");
  restore = () => {};
});

afterEach(async () => {
  restore();
  if (savedHome === undefined) delete process.env["VALTAY_HOME"];
  else process.env["VALTAY_HOME"] = savedHome;
  await rm(root, { recursive: true, force: true });
});

describe("advance", () => {
  test("runs phases until a gate needs a human", async () => {
    const { run, adapter } = await start([RESEARCH, DESIGN]);
    const lines = (await advance(run)).join("\n");

    // Research has no gate, so the run carries straight on into Reconcile and stops
    // at G1 — two invocations, one stop.
    expect(adapter.calls).toHaveLength(2);
    expect(await readArtifact(run, "research.md")).toContain("Verdict");
    expect(await readArtifact(run, "design.md")).toContain("End state");
    expect(lines).toContain("valtay approve G1");

    const state = await readState(run);
    expect(state).toMatchObject({ phase: "reconcile", status: "awaiting_gate", gate: "G1" });
    expect(state.completed).toEqual(["research"]);
  });

  test("Research is given the assumptions and nothing else", async () => {
    const { run, adapter } = await start([RESEARCH, DESIGN]);
    await advance(run);

    const payload = adapter.calls[0]?.input ?? "";
    expect(payload).toContain("A-1");

    // The section boundary is the fence (design.md §8.2) — assert it survives all
    // the way to what the host is actually handed, not just at the extractor.
    for (const leak of ["Make the store append", "V-1", "renderer"]) {
      expect(payload).not.toContain(leak);
    }
  });

  test("each phase is handed its own skill, where the host will look for it", async () => {
    const { run, adapter } = await start([RESEARCH, DESIGN]);
    await advance(run);

    expect(adapter.calls.map((c) => c.skill.name)).toEqual(["valtay-research", "valtay-reconcile"]);

    // The path has to sit inside the directory the host runs in — that is the whole
    // mechanism, since Claude Code resolves `/valtay-research` against `<cwd>/.claude/skills/`.
    for (const call of adapter.calls) {
      expect(call.skill.path).toBe(
        resolve(call.workdir, ".claude", "skills", call.skill.name, "SKILL.md")
      );
    }
  });

  test("the manifest records the skill, hashed as the host found it", async () => {
    const { run } = await start([RESEARCH, DESIGN]);
    await advance(run);

    const installed = resolve(repo, ".claude", "skills", phaseSkillName("research"), "SKILL.md");
    const record = (await readManifest(run)).find((r) => r.phase === "research");

    expect(record?.skill).toBe("valtay-research");
    expect(record?.prompt_sha).toBe(sha256(await Bun.file(installed).text()));
  });

  test("a phase whose skill is not installed fails without invoking the host", async () => {
    const { run, adapter } = await start([RESEARCH, DESIGN]);
    await rm(resolve(repo, ".claude", "skills", phaseSkillName("research")), {
      recursive: true,
      force: true,
    });

    const lines = (await advance(run)).join("\n");

    // The point of the preflight: a host that cannot find the skill does not say so,
    // it answers conversationally. Discovering that costs a full invocation, so the
    // absence is caught before anything is spawned.
    expect(adapter.calls).toHaveLength(0);
    expect(lines).toContain("FAILED after 0 attempt(s)");
    expect(lines).toContain(".claude/skills/valtay-research/SKILL.md");
    expect(lines).toContain("valtay init");
    expect(await readState(run)).toMatchObject({ phase: "research", status: "failed" });
  });

  test("Reconcile is given the request and the research, but not the assumptions", async () => {
    const { run, adapter } = await start([RESEARCH, DESIGN]);
    await advance(run);

    const payload = adapter.calls[1]?.input ?? "";
    expect(payload).toContain("Make the store append");
    expect(payload).toContain("V-1");
    expect(payload).toContain("Verdict");
    expect(payload).toContain("Anything to do with the renderer");
  });

  test("an approved gate lets the run carry on to the next one", async () => {
    const { run } = await start([RESEARCH, DESIGN, SHAPE, PLAN]);
    await advance(run);
    await approve(run, "G1");
    await advance(run);

    // G1 cleared, so Reconcile is behind us and Shape has run and stopped at G2.
    const state = await readState(run);
    expect(state.completed).toEqual(["research", "reconcile"]);
    expect(state).toMatchObject({ phase: "shape", status: "awaiting_gate", gate: "G2" });
    expect(await readArtifact(run, "shape.ts")).toContain("checkSpec");
  });

  test("clears every gate in order and completes", async () => {
    const { run } = await start([RESEARCH, DESIGN, SHAPE, PLAN, PROBE, BUILD]);

    for (const gate of ["G1", "G2", "G3", "G4", "G6"] as const) {
      await advance(run);
      expect((await readState(run)).gate).toBe(gate);
      await approve(run, gate);
    }

    expect((await advance(run)).join("\n")).toContain("Run complete.");
    expect(await readState(run)).toMatchObject({ status: "complete" });
    expect((await readState(run)).completed).toEqual([
      "research",
      "reconcile",
      "shape",
      "plan",
      "probe",
      "build",
    ]);
  });

  test("resuming does not re-run a phase whose artifact is already on disk", async () => {
    const { run, adapter } = await start([RESEARCH, DESIGN]);
    await advance(run);
    expect(adapter.calls).toHaveLength(2);

    await advance(run);
    expect(adapter.calls).toHaveLength(2);
  });

  test("`rerun` re-enters a phase whose output was rejected", async () => {
    const { run, adapter } = await start([RESEARCH, DESIGN, "## End state\n\nsecond attempt"]);
    await advance(run);

    await writeState(run, {
      ...(await readState(run)),
      phase: "reconcile",
      status: "pending",
      rerun: true,
    });
    await advance(run);

    expect(adapter.calls).toHaveLength(3);
    expect(await readArtifact(run, "design.md")).toContain("second attempt");
    expect((await readState(run)).rerun).toBe(false);
  });
});

describe("failure handling", () => {
  test("a transport failure retries once, then halts the run", async () => {
    const { run } = await start([{ error: "connection reset" }, { error: "connection reset" }]);
    const lines = (await advance(run)).join("\n");

    expect(lines).toContain("FAILED after 2 attempt(s)");
    expect((await readState(run)).status).toBe("failed");

    // Invariant 7: both failures are in the manifest, not just the last.
    const manifest = await readManifest(run);
    expect(manifest).toHaveLength(2);
    expect(manifest.map((r) => r.attempt)).toEqual([1, 2]);
    expect(manifest[0]!.notes).toEqual(["connection reset"]);
  });

  test("a retry that succeeds carries on, and both attempts are recorded", async () => {
    const { run } = await start([{ error: "timeout" }, RESEARCH, DESIGN]);
    await advance(run);

    expect((await readState(run)).gate).toBe("G1");
    expect((await readManifest(run)).map((r) => r.exit_code)).toEqual([1, 0, 0]);
  });

  test("a halted run says how to pick it back up, and does not loop on its own", async () => {
    const { run, adapter } = await start([{ error: "boom" }, { error: "boom" }, RESEARCH, DESIGN]);
    await advance(run);
    expect(adapter.calls).toHaveLength(2);

    // A third blind attempt at something broken is waste, so advance refuses.
    expect((await advance(run)).join("\n")).toContain("valtay resume --retry");
    expect(adapter.calls).toHaveLength(2);

    // Retrying is a deliberate act, taken after the cause is fixed.
    await retry(run);
    await advance(run);
    expect(adapter.calls).toHaveLength(4);
    expect((await readState(run)).gate).toBe("G1");
  });

  test("retry on a healthy run does nothing", async () => {
    const { run } = await start([RESEARCH, DESIGN]);
    await advance(run);
    expect((await retry(run)).join("")).toContain("nothing to retry");
  });

  test("an empty artifact is a failure, not an empty file", async () => {
    const { run } = await start(["", "   "]);
    await advance(run);

    expect((await readState(run)).status).toBe("failed");
    expect(await readArtifact(run, "research.md")).toBeNull();
  });
});

describe("the leading-heading fence", () => {
  test("a working note ahead of the artifact is dropped", async () => {
    // Observed on the first live run: the prompt says "no preamble" and the model
    // wrote one anyway. Advisory rules fail; this one is mechanical now.
    const { run } = await start([`Checked the store first. Now writing findings.\n\n${RESEARCH}`, DESIGN]);
    await advance(run);

    const artifact = await readArtifact(run, "research.md");
    expect(artifact).toStartWith("## Findings");
    expect(artifact).not.toContain("Now writing findings");
  });

  test("an artifact missing its heading retries with the reason, then fails", async () => {
    const { run } = await start(["I could not determine anything.", "Still nothing."]);
    await advance(run);

    expect((await readState(run)).status).toBe("failed");

    const manifest = await readManifest(run);
    expect(manifest).toHaveLength(2);
    expect(manifest[0]!.notes[0]).toContain('must begin with "## Findings"');
  });

  test("the retry is told what was wrong", async () => {
    const { run, adapter } = await start(["no heading here", RESEARCH, DESIGN]);
    await advance(run);

    expect(adapter.calls[1]!.input).toContain("# Correction");
    expect(adapter.calls[1]!.input).toContain('must begin with "## Findings"');
    expect(await readArtifact(run, "research.md")).toStartWith("## Findings");
  });
});

describe("JSON artifacts", () => {
  test("are stored indented, whatever the host emitted", async () => {
    // Observed on the first live run: the planner emitted plan.json on one line,
    // and a one-line plan cannot be reviewed at G3 — let alone from a phone.
    const { run } = await start([RESEARCH, DESIGN, SHAPE, PLAN]);
    expect(PLAN).not.toContain("\n");

    await advance(run);
    await approve(run, "G1");
    await advance(run);
    await approve(run, "G2");
    await advance(run);

    const stored = (await readArtifact(run, "plan.json"))!;
    expect(stored).toContain('\n  "epic": "append-only-manifest"');
    expect(JSON.parse(stored)).toEqual(JSON.parse(PLAN));
  });

  test("a plan that breaks the run budget is rejected, not stored", async () => {
    const overBudget = JSON.stringify({
      ...JSON.parse(PLAN),
      release_units: Array.from({ length: 6 }, (_, i) => ({
        ...JSON.parse(PLAN).release_units[0],
        id: `RU-${i}`,
      })),
    });

    const { run } = await start([RESEARCH, DESIGN, SHAPE, overBudget, overBudget]);
    await advance(run);
    await approve(run, "G1");
    await advance(run);
    await approve(run, "G2");
    await advance(run);

    expect((await readState(run)).status).toBe("failed");
    expect(await readArtifact(run, "plan.json")).toBeNull();
    expect((await readManifest(run)).at(-1)!.notes.join(" ")).toContain("exceeds the run budget");
  });
});

describe("the probe", () => {
  /** Advances through G1-G3 so the next `advance` runs the probe. */
  async function toProbe(responses: Array<string | { error: string }>): Promise<Run> {
    const { run } = await start(responses);
    for (const gate of ["G1", "G2", "G3"] as const) {
      await advance(run);
      await approve(run, gate);
    }
    return run;
  }

  test("works in a worktree and discards it, whatever the outcome", async () => {
    const run = await toProbe([RESEARCH, DESIGN, SHAPE, PLAN, PROBE]);
    const wt = worktreePath(run.meta.run, "probe");

    await advance(run);

    // The revert is the discard (design.md §10.1). What survives is the trace.
    expect(await pathExists(wt)).toBe(false);
    expect((await readState(run)).gate).toBe("G4");
    expect(await readArtifact(run, "probe.json")).toContain("appendManifest");
  });

  test("hands the prober the worktree, not the repo", async () => {
    const { run, adapter } = await start([RESEARCH, DESIGN, SHAPE, PLAN, PROBE]);
    for (const gate of ["G1", "G2", "G3"] as const) {
      await advance(run);
      await approve(run, gate);
    }
    await advance(run);

    const probeCall = adapter.calls.at(-1)!;
    expect(probeCall.workdir).toBe(worktreePath(run.meta.run, "probe"));
    expect(probeCall.write).toBe(true);

    // Read-only phases never get one.
    expect(adapter.calls[0]!.workdir).toBe(repo);
    expect(adapter.calls[0]!.write).toBe(false);
  });

  test("discards the worktree even when the probe fails", async () => {
    const run = await toProbe([RESEARCH, DESIGN, SHAPE, PLAN, { error: "boom" }, { error: "boom" }]);
    await advance(run);

    expect(await pathExists(worktreePath(run.meta.run, "probe"))).toBe(false);
    expect((await readState(run)).status).toBe("failed");
  });

  test("appends its deviations to the project ledger", async () => {
    const run = await toProbe([RESEARCH, DESIGN, SHAPE, PLAN, PROBE]);
    await advance(run);

    // Nothing reads the ledger yet. It is written from run one anyway, because
    // promotion needs three recurrences and history cannot be backfilled.
    const entries = await readLedger("project", repo);
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({
      kind: "project",
      run: "demo",
      pattern: "signature",
      severity: "local",
    });
  });

  test("must show what the checkpoint actually printed", async () => {
    // Observed live: the probe returned a trace in 66 seconds, which is not long
    // enough to have implemented anything. A trace written from the plan rather than
    // from a run is the paragraph the trace was meant to replace, wearing evidence's
    // clothes — so the gate does not open without the oracle's own output.
    const { checkpoint_output, ...unproven } = JSON.parse(PROBE);
    const noEvidence = JSON.stringify(unproven);

    const run = await toProbe([RESEARCH, DESIGN, SHAPE, PLAN, noEvidence, noEvidence]);
    await advance(run);

    expect((await readState(run)).status).toBe("failed");
    expect((await readManifest(run)).at(-1)!.notes.join(" ")).toContain("no checkpoint_output");
  });

  test("JSON wrapped in prose is unwrapped rather than failed", async () => {
    // Also observed live: told its status value was invalid, the phase answered the
    // correction conversationally instead of re-emitting the artifact.
    const chatty = `All done. Here is the result:\n\n${PROBE}\n\nLet me know if you need more.`;

    const run = await toProbe([RESEARCH, DESIGN, SHAPE, PLAN, chatty]);
    await advance(run);

    expect((await readState(run)).gate).toBe("G4");
    expect(JSON.parse((await readArtifact(run, "probe.json"))!).traces).toHaveLength(1);
  });

  test("a trace over the node budget is rejected, not stored", async () => {
    const wide = JSON.stringify({
      traces: [
        {
          unit: "RU-1",
          source: "agent",
          entry: "x",
          nodes: Array.from({ length: 41 }, (_, i) => ({
            id: `n${i}`,
            symbol: `s${i}`,
            file: "a.ts",
            line: i + 1,
            status: "new",
            children: [],
          })),
        },
      ],
      deviations: [],
      checkpoint_output: "24 pass",
    });

    const run = await toProbe([RESEARCH, DESIGN, SHAPE, PLAN, wide, wide]);
    await advance(run);

    expect((await readState(run)).status).toBe("failed");
    expect((await readManifest(run)).at(-1)!.notes.join(" ")).toContain("exceeds the run budget of 40");
  });
});

describe("gate coverage", () => {
  test("a gate binds to every artifact produced so far, not just its own", async () => {
    const { run } = await start([RESEARCH, DESIGN]);
    await advance(run);

    const covered = (await gateArtifacts(run, phase("reconcile"))).map((a) => a.path);
    expect(covered).toEqual(["research.md", "design.md"]);
  });

  test("editing an upstream artifact voids a downstream approval", async () => {
    const { run } = await start([RESEARCH, DESIGN]);
    await advance(run);
    await approve(run, "G1");

    // design.md §12.3: an approval covers the chain, so a hand-edit upstream voids
    // it and everything after it rather than only the phase that produced it.
    await writeArtifact(run, "research.md", "different findings");
    const lines = (await advance(run)).join("\n");
    expect(lines).toContain("valtay approve G1");
  });
});

describe("cross-vendor runs", () => {
  /**
   * A repo bound to two hosts, with the phase skills present in both roots.
   *
   * This is the arrangement invariant 9 needs and that no run could have before the
   * codex adapter existed: `adapterFor("codex")` threw at the first invocation.
   */
  async function crossVendorRepo(): Promise<void> {
    await writeFile(
      resolve(repo, "valtay.toml"),
      [
        "[hosts.claude-code]",
        'bin = "claude"',
        'adapter = "claude-code"',
        "",
        "[hosts.codex]",
        'bin = "codex"',
        'adapter = "codex"',
        "",
        "[roles.default]",
        'host = "claude-code"',
        'model = "sonnet"',
        'timeout = "10m"',
        "",
        "[roles.designer]",
        'host = "codex"',
        'model = "gpt-5.6-luna"',
      ].join("\n")
    );

    await installSkills(resolve(repo, ".codex", "skills"));
    await git(repo, ["add", "-A"]);
    await git(repo, ["commit", "--quiet", "-m", "cross-vendor"]);
  }

  test("a role bound to codex runs on the codex adapter", async () => {
    await crossVendorRepo();

    const claude = createReplayAdapter("claude-code", [RESEARCH]);
    const codex = createReplayAdapter("codex", [DESIGN]);
    const restoreClaude = registerAdapter(claude);
    const restoreCodex = registerAdapter(codex);
    restore = () => {
      restoreCodex();
      restoreClaude();
    };

    const path = resolve(repo, "runspec.md");
    await writeFile(path, SPEC);
    const run = await runStart({ spec: path, repo });
    await advance(run);

    // Research is the default binding, Reconcile is the codex one. The split is the
    // point: one vendor produced research.md, another produced design.md.
    expect(claude.calls).toHaveLength(1);
    expect(codex.calls).toHaveLength(1);
    expect(await readArtifact(run, "design.md")).toContain("End state");

    const manifest = await readManifest(run);
    expect(manifest.find((r) => r.phase === "research")?.host).toBe("claude-code");
    expect(manifest.find((r) => r.phase === "reconcile")?.host).toBe("codex");
  });

  test("the run records that it was graded across vendors", async () => {
    await crossVendorRepo();

    const claude = createReplayAdapter("claude-code", [RESEARCH]);
    const codex = createReplayAdapter("codex", [DESIGN]);
    const restoreClaude = registerAdapter(claude);
    const restoreCodex = registerAdapter(codex);
    restore = () => {
      restoreCodex();
      restoreClaude();
    };

    const path = resolve(repo, "runspec.md");
    await writeFile(path, SPEC);
    const run = await runStart({ spec: path, repo });

    // Before a second adapter existed this was false for every run, and
    // IMPLEMENTED.md recorded invariant 9 as violated by the environment.
    expect(run.meta.vendor_diversity).toBe(true);
  });

  test("a codex phase looks for its skill under .codex/, not .claude/", async () => {
    await crossVendorRepo();
    await rm(resolve(repo, ".codex", "skills", phaseSkillName("reconcile")), {
      recursive: true,
      force: true,
    });
    await git(repo, ["add", "-A"]);
    await git(repo, ["commit", "--quiet", "-m", "drop the codex reconcile skill"]);

    const claude = createReplayAdapter("claude-code", [RESEARCH]);
    const codex = createReplayAdapter("codex", []);
    const restoreClaude = registerAdapter(claude);
    const restoreCodex = registerAdapter(codex);
    restore = () => {
      restoreCodex();
      restoreClaude();
    };

    const path = resolve(repo, "runspec.md");
    await writeFile(path, SPEC);
    const run = await runStart({ spec: path, repo });
    const lines = (await advance(run)).join("\n");

    // The claude-code copy is still there, so a lookup that ignored the binding
    // would have found it and burned an invocation discovering the mistake.
    expect(codex.calls).toHaveLength(0);
    expect(lines).toContain(".codex/skills");
  });
});
