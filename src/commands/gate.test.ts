import { test, expect, describe, beforeEach, afterEach } from "bun:test";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve, join } from "node:path";
import { runStart } from "./start.ts";
import { runApprove, runReject } from "./gate.ts";
import { runShow } from "./show.ts";
import { runStatusLines } from "./status.ts";
import { createReplayAdapter, type ReplayAdapter } from "../hosts/replay.ts";
import { registerAdapter } from "../hosts/index.ts";
import { advance } from "../run/orchestrator.ts";
import { findRun, readApprovals, readArtifact, readState } from "../run/store.ts";

let root: string;
let repo: string;
let restore: () => void;
let adapter: ReplayAdapter;
const savedHome = process.env["VALTAY_HOME"];

const SPEC = `---
run: demo
---

# Demo

## Intent

Add a lint.

## Assumptions to verify

- **A-1** Verify whether the store appends.
`;

const RESEARCH = "## Findings\n\n### A-1\n\n**Verdict:** confirmed (src/run/store.ts:12).";
const DESIGN = "## End state\n\nA lint exists.\n\n## Deltas\n\nD-1 none.";
const DESIGN_2 = "## End state\n\nA lint exists, and it never blocks.\n\n## Deltas\n\nD-1 none.";
const SHAPE = "export function checkSpec(path: string): string[];";

const PLAN = JSON.stringify({
  epic: "check",
  release_units: [
    {
      id: "RU-1",
      goal: "the lint runs",
      checkpoint: "bun test",
      layers: [
        {
          id: "L1",
          title: "feat(cli): valtay check",
          kind: "semantic",
          inert: false,
          files: ["src/commands/check.ts"],
          est_loc: { add: 90, del: 0 },
        },
      ],
    },
  ],
  alternatives_considered: [{ shape: "fold into status", rejected: "status needs a run; check does not" }],
});

async function startRun(responses: Array<string | { error: string }>) {
  adapter = createReplayAdapter("claude-code", responses);
  restore = registerAdapter(adapter);

  const path = resolve(repo, "runspec.md");
  await writeFile(path, SPEC);
  const run = await runStart({ spec: path });
  await advance(run);
  return run;
}

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "valtay-gate-"));
  repo = resolve(root, "valtay");
  await mkdir(resolve(repo, ".git"), { recursive: true });
  await writeFile(resolve(repo, "package.json"), "{}");
  process.env["VALTAY_HOME"] = resolve(root, "home");
  restore = () => {};
});

afterEach(async () => {
  restore();
  if (savedHome === undefined) delete process.env["VALTAY_HOME"];
  else process.env["VALTAY_HOME"] = savedHome;
  await rm(root, { recursive: true, force: true });
});

describe("approve", () => {
  test("records the approval and carries the run to the next gate", async () => {
    await startRun([RESEARCH, DESIGN, SHAPE, PLAN]);
    const lines = (await runApprove({ repo, gate: "G1" })).join("\n");

    expect(lines).toContain("G1 approved over 2 artifact(s)");
    expect(lines).toContain("valtay approve G2");

    const run = await findRun(repo);
    const approval = (await readApprovals(run)).at(-1)!;
    expect(approval.decision).toBe("approve");
    expect(approval.artifacts.map((a) => a.path)).toEqual(["research.md", "design.md"]);
  });

  test("accepts a lowercase gate name", async () => {
    await startRun([RESEARCH, DESIGN, SHAPE, PLAN]);
    expect((await runApprove({ repo, gate: "g1" })).join("\n")).toContain("G1 approved");
  });

  test("refuses a gate that is not in this pipeline", async () => {
    await startRun([RESEARCH, DESIGN]);
    // G5 belongs to Invariants, which this pipeline does not run — so it is absent
    // rather than auto-passed, and approving it is an error rather than a no-op.
    await expect(runApprove({ repo, gate: "G5" })).rejects.toThrow(/No gate G5/);
  });

  test("refuses a gate whose phase has not produced anything", async () => {
    await startRun([RESEARCH, DESIGN, SHAPE, PLAN]);
    await expect(runApprove({ repo, gate: "G3" })).rejects.toThrow(/has not written plan.json/);
  });
});

describe("reject", () => {
  test("re-enters at the named artifact and re-runs from there", async () => {
    await startRun([RESEARCH, DESIGN, SHAPE, DESIGN_2]);
    await runApprove({ repo, gate: "G1" });

    const lines = (await runReject({
      repo,
      gate: "G2",
      to: "design",
      reason: "the end state does not say the lint never blocks",
    })).join("\n");

    expect(lines).toContain("re-entering at 2 Reconcile");
    expect(await readArtifact(await findRun(repo), "design.md")).toContain("never blocks");

    // Re-running Reconcile means Shape is asked again too, so G2 is never carried
    // over from an artifact produced against a design since rejected. G1 is asked
    // again as well, because rewriting design.md voided the approval bound to it.
    const state = await readState(await findRun(repo));
    expect(state.completed).toEqual(["research"]);
    expect(state).toMatchObject({ phase: "reconcile", gate: "G1" });
  });

  test("hands the reason to the re-entered phase verbatim", async () => {
    await startRun([RESEARCH, DESIGN, SHAPE, DESIGN_2]);
    await runApprove({ repo, gate: "G1" });
    await runReject({ repo, gate: "G2", to: "design", reason: "say it never blocks" });

    // A rejection re-runs the phase with the correction appended — not the whole
    // conversation, just what was wrong. Reconcile is the phase that takes the
    // research findings, which is how its invocation is told apart from Shape's.
    const rerun = adapter.calls.filter((c) => c.input.includes("# Research findings")).at(-1)!;
    expect(rerun.input).toContain("# Correction from your reviewer");
    expect(rerun.input).toContain("say it never blocks");

    // The first Reconcile ran before any rejection existed and carries none.
    const first = adapter.calls.filter((c) => c.input.includes("# Research findings"))[0]!;
    expect(first.input).not.toContain("# Correction from your reviewer");
  });

  test("refuses a target that is not an artifact", async () => {
    await startRun([RESEARCH, DESIGN]);
    await expect(
      runReject({ repo, gate: "G1", to: "the vibes", reason: "wrong" })
    ).rejects.toThrow(/Cannot re-enter at "the vibes"/);
  });

  test("refuses a rejection with no reason", async () => {
    await startRun([RESEARCH, DESIGN]);
    await expect(runReject({ repo, gate: "G1", to: "design", reason: "  " })).rejects.toThrow(
      /needs a reason/
    );
  });

  test("status shows the rejection rather than hiding it", async () => {
    await startRun([RESEARCH, DESIGN, SHAPE, PLAN, DESIGN_2, SHAPE, PLAN]);
    await runReject({ repo, gate: "G1", to: "design", reason: "not specific enough" });

    expect((await runStatusLines({ repo })).join("\n")).toContain("G1 rejected -> design");
  });
});

describe("show", () => {
  test("prints an artifact by stem or by path", async () => {
    await startRun([RESEARCH, DESIGN, SHAPE, PLAN]);

    expect((await runShow({ repo, artifact: "design" })).join("\n")).toContain("End state");
    expect((await runShow({ repo, artifact: "design.md" })).join("\n")).toContain("End state");
  });

  test("names what exists when asked for something that does not", async () => {
    await startRun([RESEARCH, DESIGN, SHAPE, PLAN]);
    await expect(runShow({ repo, artifact: "plan.json" })).rejects.toThrow(/No plan.json in this run/);
  });
});
