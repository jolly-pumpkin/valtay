import { test, expect, describe, beforeEach, afterEach } from "bun:test";
import { mkdtemp, mkdir, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve, join } from "node:path";
import { resolveConfig } from "../config.ts";
import { parseRunspec, sha256 } from "../runspec.ts";
import {
  appendApproval,
  appendContestation,
  appendManifest,
  createRun,
  findRun,
  isApproved,
  latestDecision,
  loadRun,
  readContestations,
  readLedger,
  readManifest,
  readRetryState,
  readState,
  runDir,
  staleArtifacts,
  writeArtifact,
  writeLedger,
  writeRetryState,
  writeState,
  type ApprovalRecord,
  type BuildLedger,
  type ManifestRecord,
  type RetryState,
  type Run,
} from "./store.ts";

let root: string;
let repo: string;

const SPEC = `---
run: demo
host: claude
model: sonnet
---

# Demo

## Design

Some design content.
`;

async function newRun(name = "demo"): Promise<Run> {
  const spec = parseRunspec(SPEC, resolve(root, "runspec.md"));
  return createRun(repo, name, spec, resolveConfig(spec));
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

    expect(await readFile(resolve(run.dir, "runspec.md"), "utf-8")).toBe(SPEC);

    const state = await readState(run);
    expect(state).toMatchObject({ phase: "plan", status: "pending", completed: [] });
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
    gate: "verify",
    decision: "approve",
    artifacts,
  });

  test("an approval stands while its artifacts are untouched", async () => {
    const run = await newRun();
    const ref = await writeArtifact(run, "verify.json", '{"status":"clean","findings":[]}');

    await appendApproval(run, approval([ref]));

    expect(await isApproved(run, "verify")).toBe(true);
    expect(await staleArtifacts(run, (await latestDecision(run, "verify"))!)).toEqual([]);
  });

  test("hand-editing an approved artifact voids the approval", async () => {
    const run = await newRun();
    const ref = await writeArtifact(run, "verify.json", "original");
    await appendApproval(run, approval([ref]));

    await writeArtifact(run, "verify.json", "edited by hand");

    expect(await isApproved(run, "verify")).toBe(false);
    expect(await staleArtifacts(run, (await latestDecision(run, "verify"))!)).toEqual(["verify.json"]);
  });

  test("a deleted artifact voids it too", async () => {
    const run = await newRun();
    await appendApproval(run, approval([{ path: "gone.md", sha: sha256("x") }]));
    expect(await isApproved(run, "verify")).toBe(false);
  });

  test("the latest decision wins, and a rejection is not an approval", async () => {
    const run = await newRun();
    const ref = await writeArtifact(run, "verify.json", "v1");

    await appendApproval(run, approval([ref]));
    await appendApproval(run, {
      ts: new Date().toISOString(),
      gate: "verify",
      decision: "reject",
      reason: "drift not acceptable",
      artifacts: [ref],
    });

    const decision = await latestDecision(run, "verify");
    expect(decision?.decision).toBe("reject");
    expect(await isApproved(run, "verify")).toBe(false);
  });

  test("gates with no decision are not approved", async () => {
    expect(await isApproved(await newRun(), "verify")).toBe(false);
  });
});

describe("manifest", () => {
  test("appends one record per artifact, in order", async () => {
    const run = await newRun();
    const record = (phase: "plan" | "build"): ManifestRecord => ({
      ts: new Date().toISOString(),
      phase,
      artifact: { path: `${phase}.json`, sha: sha256(phase) },
      notes: [],
    });

    await appendManifest(run, record("plan"));
    await appendManifest(run, record("build"));

    const manifest = await readManifest(run);
    expect(manifest).toHaveLength(2);
    expect(manifest.map((r) => r.phase)).toEqual(["plan", "build"]);
  });
});

describe("ledger", () => {
  test("round-trips through write and read", async () => {
    const run = await newRun();
    const ledger: BuildLedger = {
      units: [
        {
          unit: "RU-1",
          layers: [
            { unit: "RU-1", layer: "L1", status: "done", files: ["src/foo.ts"] },
            { unit: "RU-1", layer: "L2", status: "blocked", reason: "missing dep" },
          ],
          branch: "valtay/missing-RU-1",
        },
      ],
      updated: "",
    };

    await writeLedger(run, ledger);
    const read = await readLedger(run);

    expect(read).not.toBeNull();
    expect(read!.units).toHaveLength(1);
    expect(read!.units[0]!.layers).toHaveLength(2);
    expect(read!.units[0]!.layers[0]!.status).toBe("done");
    expect(read!.units[0]!.layers[1]!.reason).toBe("missing dep");
    expect(Date.parse(read!.updated)).not.toBeNaN();
  });

  test("returns null when no ledger exists", async () => {
    const run = await newRun();
    expect(await readLedger(run)).toBeNull();
  });
});

describe("retry state", () => {
  test("round-trips through write and read", async () => {
    const run = await newRun();
    const state: RetryState = {
      attempt: 1,
      max: 2,
      history: [{ attempt: 1, blocked: ["RU-1/L2"] }],
    };

    await writeRetryState(run, state);
    const read = await readRetryState(run);

    expect(read).toEqual(state);
  });

  test("returns null when no retry state exists", async () => {
    const run = await newRun();
    expect(await readRetryState(run)).toBeNull();
  });
});

describe("contestations", () => {
  test("appends records and reads them back in order", async () => {
    const run = await newRun();

    await appendContestation(run, {
      ts: "2026-09-11T00:00:00Z",
      unit: "RU-1",
      layer: "L2",
      decision: "accept",
      reason: "builder was right",
    });

    await appendContestation(run, {
      ts: "2026-09-11T00:01:00Z",
      unit: "RU-2",
      layer: "L1",
      decision: "override",
    });

    const records = await readContestations(run);
    expect(records).toHaveLength(2);
    expect(records[0]!.decision).toBe("accept");
    expect(records[1]!.decision).toBe("override");
  });

  test("returns empty array when no contestations exist", async () => {
    const run = await newRun();
    expect(await readContestations(run)).toEqual([]);
  });
});

describe("state", () => {
  test("writeState restamps `updated` and survives a reload", async () => {
    const run = await newRun();
    const before = (await readState(run)).updated;

    await writeState(run, {
      phase: "build",
      status: "pending",
      completed: ["plan"],
      updated: "ignored",
    });

    const state = await readState(await loadRun(run.dir));
    expect(state.phase).toBe("build");
    expect(state.completed).toEqual(["plan"]);
    expect(state.updated).not.toBe("ignored");
    expect(Date.parse(state.updated)).toBeGreaterThanOrEqual(Date.parse(before));
  });
});
