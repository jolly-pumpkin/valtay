import { test, expect, describe, beforeEach, afterEach } from "bun:test";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve, join } from "node:path";
import { resolveConfig } from "../config.ts";
import { parseRunspec } from "../runspec.ts";
import { advance } from "./orchestrator.ts";
import { createRun, readState, writeArtifact, type Run } from "./store.ts";

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
