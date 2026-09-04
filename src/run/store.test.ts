import { test, expect, describe, beforeEach, afterEach } from "bun:test";
import { mkdtemp, mkdir, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve, join } from "node:path";
import { resolveConfig } from "../config.ts";
import { parseRunspec, sha256 } from "../runspec.ts";
import {
  appendApproval,
  appendManifest,
  createRun,
  findRun,
  isApproved,
  latestDecision,
  loadRun,
  readManifest,
  readState,
  runDir,
  staleArtifacts,
  writeArtifact,
  writeState,
  type ApprovalRecord,
  type ManifestRecord,
  type Run,
} from "./store.ts";

let root: string;
let repo: string;

const SPEC = `---
run: demo
---

# Demo

## Assumptions to verify

- **A-1** Verify something.
`;

async function newRun(name = "demo"): Promise<Run> {
  const spec = parseRunspec(SPEC, resolve(root, "runspec.md"));
  return createRun(repo, name, spec, await resolveConfig(repo, spec));
}

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "valtay-store-"));
  repo = resolve(root, "myrepo");
  await mkdir(resolve(repo, ".git"), { recursive: true });
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

describe("createRun", () => {
  test("freezes the spec and writes the initial state", async () => {
    const run = await newRun();

    expect(run.dir).toBe(runDir(repo, "demo"));
    expect(run.meta.runspec.sha).toBe(sha256(SPEC));
    expect(run.meta.vendor_diversity).toBe(false);

    // The frozen copy, not the original path, is what the run actually reads.
    expect(await readFile(resolve(run.dir, "runspec.md"), "utf-8")).toBe(SPEC);

    const state = await readState(run);
    expect(state).toMatchObject({ phase: "research", status: "pending", completed: [] });
  });

  test("refuses to reopen an existing run", async () => {
    await newRun();
    await expect(newRun()).rejects.toThrow(/already exists/);
  });

  test("round-trips through loadRun", async () => {
    const run = await newRun();
    const reloaded = await loadRun(run.dir);
    expect(reloaded.meta).toEqual(run.meta);
  });
});

describe("findRun", () => {
  test("resolves the only run without being named", async () => {
    const run = await newRun();
    expect((await findRun(repo)).dir).toBe(run.dir);
  });

  test("refuses to guess between several", async () => {
    await newRun("one");
    await newRun("two");

    await expect(findRun(repo)).rejects.toThrow(/one, two/);
    expect((await findRun(repo, "two")).meta.run).toBe("two");
  });

  test("says so when the repo has no runs", async () => {
    await expect(findRun(repo)).rejects.toThrow(/No runs/);
  });
});

describe("approvals bind to artifact hashes", () => {
  const approval = (artifacts: ApprovalRecord["artifacts"]): ApprovalRecord => ({
    ts: new Date().toISOString(),
    gate: "G1",
    decision: "approve",
    artifacts,
  });

  test("an approval stands while its artifacts are untouched", async () => {
    const run = await newRun();
    const ref = await writeArtifact(run, "design.md", "## Deltas\nD-1 something\n");

    await appendApproval(run, approval([ref]));

    expect(await isApproved(run, "G1")).toBe(true);
    expect(await staleArtifacts(run, (await latestDecision(run, "G1"))!)).toEqual([]);
  });

  test("hand-editing an approved artifact voids the approval", async () => {
    const run = await newRun();
    const ref = await writeArtifact(run, "design.md", "original");
    await appendApproval(run, approval([ref]));

    // design.md §12.3: this is the intended workflow, not an error.
    await writeArtifact(run, "design.md", "edited by hand");

    expect(await isApproved(run, "G1")).toBe(false);
    expect(await staleArtifacts(run, (await latestDecision(run, "G1"))!)).toEqual(["design.md"]);
  });

  test("a deleted artifact voids it too", async () => {
    const run = await newRun();
    await appendApproval(run, approval([{ path: "gone.md", sha: sha256("x") }]));
    expect(await isApproved(run, "G1")).toBe(false);
  });

  test("the latest decision wins, and a rejection is not an approval", async () => {
    const run = await newRun();
    const ref = await writeArtifact(run, "design.md", "v1");

    await appendApproval(run, approval([ref]));
    await appendApproval(run, {
      ts: new Date().toISOString(),
      gate: "G1",
      decision: "reject",
      to: "design.md",
      reason: "does health persist?",
      artifacts: [ref],
    });

    const decision = await latestDecision(run, "G1");
    expect(decision?.decision).toBe("reject");
    expect(decision?.to).toBe("design.md");
    expect(await isApproved(run, "G1")).toBe(false);
  });

  test("gates with no decision are not approved", async () => {
    expect(await isApproved(await newRun(), "G4")).toBe(false);
  });
});

describe("manifest", () => {
  test("appends one record per invocation, in order", async () => {
    const run = await newRun();
    const record = (attempt: number, exit: number): ManifestRecord => ({
      ts: new Date().toISOString(),
      phase: "research",
      role: "researcher",
      host: "claude-code",
      model: "sonnet",
      prompt_sha: sha256("prompt"),
      inputs: [],
      outputs: [],
      duration_s: 1,
      exit_code: exit,
      attempt,
      notes: [],
    });

    // Invariant 7: failures appear in the manifest too.
    await appendManifest(run, record(1, 1));
    await appendManifest(run, record(2, 0));

    const manifest = await readManifest(run);
    expect(manifest).toHaveLength(2);
    expect(manifest.map((r) => r.exit_code)).toEqual([1, 0]);
    expect(manifest[1]!.attempt).toBe(2);
  });
});

describe("state", () => {
  test("writeState restamps `updated` and survives a reload", async () => {
    const run = await newRun();
    const before = (await readState(run)).updated;

    await writeState(run, {
      phase: "reconcile",
      status: "awaiting_gate",
      gate: "G1",
      completed: ["research"],
      updated: "ignored",
    });

    const state = await readState(await loadRun(run.dir));
    expect(state.phase).toBe("reconcile");
    expect(state.gate).toBe("G1");
    expect(state.completed).toEqual(["research"]);
    expect(state.updated).not.toBe("ignored");
    expect(Date.parse(state.updated)).toBeGreaterThanOrEqual(Date.parse(before));
  });
});
