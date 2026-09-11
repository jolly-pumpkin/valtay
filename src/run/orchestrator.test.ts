import { test, expect, describe, beforeEach, afterEach } from "bun:test";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve, join } from "node:path";
import { resolveConfig } from "../config.ts";
import { parseRunspec } from "../runspec.ts";
import { advance } from "./orchestrator.ts";
import {
  createRun,
  readState,
  readRetryState,
  writeArtifact,
  writeLedger,
  writeRetryState,
  type BuildLedger,
  type Run,
} from "./store.ts";

let root: string;
let repo: string;

const SPEC = `---
run: test
host: claude
model: sonnet
---

# Test run

## Design

Some design.
`;

async function newRun(): Promise<Run> {
  const spec = parseRunspec(SPEC, resolve(root, "runspec.md"));
  return createRun(repo, "test", spec, resolveConfig(spec));
}

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "valtay-orch-"));
  repo = resolve(root, "myrepo");
  await mkdir(resolve(repo, ".git"), { recursive: true });
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

describe("advance", () => {
  test("waits for plan artifact", async () => {
    const run = await newRun();
    const lines = await advance(run);
    expect(lines.some((l) => l.includes("Waiting for Plan"))).toBe(true);

    const state = await readState(run);
    expect(state.phase).toBe("plan");
    expect(state.status).toBe("pending");
  });

  test("plan artifact auto-advances to build", async () => {
    const run = await newRun();
    await writeArtifact(run, "plan.md", '{"epic":"test","release_units":[]}');

    const lines = await advance(run);
    expect(lines.some((l) => l.includes("Plan: artifact found"))).toBe(true);

    const state = await readState(run);
    expect(state.phase).toBe("build");
    expect(state.completed).toContain("plan");
  });

  test("build artifact auto-advances to verify", async () => {
    const run = await newRun();
    await writeArtifact(run, "plan.md", '{"epic":"test"}');
    await writeArtifact(run, "build.md", "- implemented the thing");

    await advance(run);

    const state = await readState(run);
    expect(state.phase).toBe("verify");
    expect(state.completed).toContain("build");
  });

  test("clean verify completes the run", async () => {
    const run = await newRun();
    await writeArtifact(run, "plan.md", '{"epic":"test"}');
    await writeArtifact(run, "build.md", "- done");
    await writeArtifact(run, "verify.json", '{"status":"clean","findings":[]}');

    const lines = await advance(run);
    expect(lines.some((l) => l.includes("Run complete"))).toBe(true);

    const state = await readState(run);
    expect(state.status).toBe("complete");
  });

  test("drift verify parks the run", async () => {
    const run = await newRun();
    await writeArtifact(run, "plan.md", '{"epic":"test"}');
    await writeArtifact(run, "build.md", "- done");
    await writeArtifact(
      run,
      "verify.json",
      JSON.stringify({
        status: "drift",
        findings: [
          { what: "Player.health", actual: "missing", file: "src/player.ts", severity: "drift" },
        ],
      })
    );

    const lines = await advance(run);
    expect(lines.some((l) => l.includes("drift"))).toBe(true);

    const state = await readState(run);
    expect(state.status).toBe("awaiting_gate");
    expect(state.gate).toBe("verify");
  });

  test("build with all-done ledger advances to verify", async () => {
    const run = await newRun();
    await writeArtifact(run, "plan.md", '{"epic":"test"}');
    await writeArtifact(run, "build.md", "- done");
    await writeLedger(run, {
      units: [
        {
          unit: "RU-1",
          layers: [
            { unit: "RU-1", layer: "L1", status: "done", files: ["src/a.ts"] },
          ],
        },
      ],
      updated: "",
    });

    await advance(run);

    const state = await readState(run);
    expect(state.phase).toBe("verify");
    expect(state.completed).toContain("build");
  });

  test("build with contested layers halts the run", async () => {
    const run = await newRun();
    await writeArtifact(run, "plan.md", '{"epic":"test"}');
    await writeArtifact(run, "build.md", "- partial");
    await writeLedger(run, {
      units: [
        {
          unit: "RU-1",
          layers: [
            { unit: "RU-1", layer: "L1", status: "done", files: ["src/a.ts"] },
            { unit: "RU-1", layer: "L2", status: "contested", reason: "unnecessary complexity" },
          ],
        },
      ],
      updated: "",
    });

    const lines = await advance(run);
    expect(lines.some((l) => l.includes("contested"))).toBe(true);

    const state = await readState(run);
    expect(state.status).toBe("awaiting_gate");
    expect(state.note).toContain("contested");
  });

  test("contested dominates over blocked", async () => {
    const run = await newRun();
    await writeArtifact(run, "plan.md", '{"epic":"test"}');
    await writeArtifact(run, "build.md", "- partial");
    await writeLedger(run, {
      units: [
        {
          unit: "RU-1",
          layers: [
            { unit: "RU-1", layer: "L1", status: "blocked", reason: "missing dep" },
            { unit: "RU-1", layer: "L2", status: "contested", reason: "bad design" },
          ],
        },
      ],
      updated: "",
    });

    const lines = await advance(run);
    expect(lines.some((l) => l.includes("contested"))).toBe(true);

    const state = await readState(run);
    expect(state.status).toBe("awaiting_gate");
  });

  test("build with blocked layers retries within budget", async () => {
    const run = await newRun();
    await writeArtifact(run, "plan.md", '{"epic":"test"}');
    await writeArtifact(run, "build.md", "- partial");
    await writeLedger(run, {
      units: [
        {
          unit: "RU-1",
          layers: [
            { unit: "RU-1", layer: "L1", status: "done", files: ["src/a.ts"] },
            { unit: "RU-1", layer: "L2", status: "blocked", reason: "missing dep" },
          ],
        },
      ],
      updated: "",
    });

    const lines = await advance(run);
    expect(lines.some((l) => l.includes("Retry 1/1"))).toBe(true);

    const state = await readState(run);
    expect(state.phase).toBe("build");
    expect(state.status).toBe("pending");
    expect(state.rerun).toBe(true);

    const retry = await readRetryState(run);
    expect(retry).not.toBeNull();
    expect(retry!.attempt).toBe(1);
    expect(retry!.history).toHaveLength(1);
  });

  test("build with blocked layers fails when retries exhausted", async () => {
    const run = await newRun();
    await writeArtifact(run, "plan.md", '{"epic":"test"}');
    await writeArtifact(run, "build.md", "- partial");
    await writeLedger(run, {
      units: [
        {
          unit: "RU-1",
          layers: [
            { unit: "RU-1", layer: "L2", status: "blocked", reason: "still broken" },
          ],
        },
      ],
      updated: "",
    });
    // Already used the one retry
    await writeRetryState(run, {
      attempt: 1,
      max: 1,
      history: [{ attempt: 1, blocked: ["RU-1/L2"] }],
    });

    const lines = await advance(run);
    expect(lines.some((l) => l.includes("halted"))).toBe(true);

    const state = await readState(run);
    expect(state.status).toBe("failed");
  });

  test("build with pending layers stays in build phase", async () => {
    const run = await newRun();
    await writeArtifact(run, "plan.md", '{"epic":"test"}');
    await writeArtifact(run, "build.md", "- in progress");
    await writeLedger(run, {
      units: [
        {
          unit: "RU-1",
          layers: [
            { unit: "RU-1", layer: "L1", status: "done", files: ["src/a.ts"] },
            { unit: "RU-1", layer: "L2", status: "pending" },
          ],
        },
      ],
      updated: "",
    });

    const lines = await advance(run);
    expect(lines.some((l) => l.includes("pending"))).toBe(true);

    const state = await readState(run);
    expect(state.phase).toBe("build");
    expect(state.status).toBe("pending");
  });

  test("build without ledger auto-advances (backwards compat)", async () => {
    const run = await newRun();
    await writeArtifact(run, "plan.md", '{"epic":"test"}');
    await writeArtifact(run, "build.md", "- done");

    await advance(run);

    const state = await readState(run);
    expect(state.phase).toBe("verify");
    expect(state.completed).toContain("build");
  });

  test("invalid verify JSON fails the run", async () => {
    const run = await newRun();
    await writeArtifact(run, "plan.md", '{"epic":"test"}');
    await writeArtifact(run, "build.md", "- done");
    await writeArtifact(run, "verify.json", "not json");

    const lines = await advance(run);
    expect(lines.some((l) => l.includes("not valid JSON"))).toBe(true);

    const state = await readState(run);
    expect(state.status).toBe("failed");
  });
});
