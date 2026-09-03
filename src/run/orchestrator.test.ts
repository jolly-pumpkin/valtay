import { test, expect, describe, beforeEach, afterEach } from "bun:test";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve, join } from "node:path";
import { runStart } from "../commands/start.ts";
import { createReplayAdapter, type ReplayAdapter } from "../hosts/replay.ts";
import { registerAdapter } from "../hosts/index.ts";
import { advance, gateArtifacts } from "./orchestrator.ts";
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

async function start(responses: Parameters<typeof createReplayAdapter>[1]): Promise<{
  run: Run;
  adapter: ReplayAdapter;
}> {
  const adapter = createReplayAdapter("claude-code", responses);
  restore = registerAdapter(adapter);

  const path = resolve(repo, "runspec.md");
  await writeFile(path, SPEC);
  return { run: await runStart({ spec: path }), adapter };
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

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "valtay-orch-"));
  repo = resolve(root, "valtay");
  await mkdir(resolve(repo, ".git"), { recursive: true });
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

  test("Reconcile is given the request and the research, but not the assumptions", async () => {
    const { run, adapter } = await start([RESEARCH, DESIGN]);
    await advance(run);

    const payload = adapter.calls[1]?.input ?? "";
    expect(payload).toContain("Make the store append");
    expect(payload).toContain("V-1");
    expect(payload).toContain("Verdict");
    expect(payload).toContain("Anything to do with the renderer");
  });

  test("an approved gate lets the run carry on", async () => {
    const { run } = await start([RESEARCH, DESIGN]);
    await advance(run);
    await approve(run, "G1");

    // Shape has no prompt shipped yet, so the next phase fails rather than silently
    // producing nothing — which is the behaviour we want from a missing prompt.
    await expect(advance(run)).rejects.toThrow(/No phase prompt for "shape"/);

    // G1 cleared, so Reconcile is behind us and Shape is the phase in flight.
    expect((await readState(run)).completed).toEqual(["research", "reconcile"]);
    expect((await readState(run)).phase).toBe("shape");
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
