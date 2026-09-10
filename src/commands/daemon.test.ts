import { test, expect, describe, beforeEach, afterEach } from "bun:test";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve, join } from "node:path";
import { $ } from "bun";
import { resolveConfig } from "../config.ts";
import { parseRunspec } from "../runspec.ts";
import { createRun, writeState, readState, type Run } from "../run/store.ts";
import { readDaemon, writeDaemon, type DaemonState } from "../daemon/store.ts";
import { daemonStart, daemonStatus, daemonStop, daemonAttach } from "./daemon.ts";

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

async function tmuxAvailable(): Promise<boolean> {
  return (await $`which tmux`.nothrow().quiet()).exitCode === 0;
}

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "valtay-daemon-cmd-"));
  repo = resolve(root, "myrepo");
  await mkdir(resolve(repo, ".git"), { recursive: true });
});

afterEach(async () => {
  if (await tmuxAvailable()) {
    await $`tmux kill-session -t valtay-demo`.nothrow().quiet();
  }
  await rm(root, { recursive: true, force: true });
});

describe("daemonStatus", () => {
  test("reports no daemon when daemon.json is missing", async () => {
    await newRun();
    const lines = await daemonStatus({ repo, run: "demo" });
    expect(lines[0]).toContain("No daemon");
  });

  test("detects dead tmux session and updates to mechanical halt when run is pending", async () => {
    const run = await newRun();
    await writeDaemon(run, {
      session: "valtay-demo",
      pid: null,
      started: new Date().toISOString(),
      status: "running",
    });

    // state.json is "pending" (initial state) — session died mid-work → mechanical
    const lines = await daemonStatus({ repo, run: "demo" });
    expect(lines[0]).toContain("halted");
    expect(lines[0]).toContain("mechanical");

    const daemon = await readDaemon(run);
    expect(daemon?.status).toBe("halted");
    expect(daemon?.halt?.class).toBe("mechanical");
  });

  test("detects dead session after clean completion and sets status to complete", async () => {
    const run = await newRun();
    await writeDaemon(run, {
      session: "valtay-demo",
      pid: null,
      started: new Date().toISOString(),
      status: "running",
    });

    // Simulate: orchestrator advanced to complete
    await writeState(run, {
      phase: "verify",
      status: "complete",
      completed: ["plan", "build", "verify"],
      updated: new Date().toISOString(),
    });

    const lines = await daemonStatus({ repo, run: "demo" });
    expect(lines[0]).toContain("complete");

    const daemon = await readDaemon(run);
    expect(daemon?.status).toBe("complete");
    expect(daemon?.halt).toBeUndefined();
  });

  test("detects dead session after verify drift and sets halt to needs-human", async () => {
    const run = await newRun();
    await writeDaemon(run, {
      session: "valtay-demo",
      pid: null,
      started: new Date().toISOString(),
      status: "running",
    });

    // Simulate: orchestrator parked at verify gate with drift
    await writeState(run, {
      phase: "verify",
      status: "awaiting_gate",
      gate: "verify",
      completed: ["plan", "build"],
      updated: new Date().toISOString(),
      note: "Verify found 2 drift finding(s).",
    });

    const lines = await daemonStatus({ repo, run: "demo" });
    expect(lines[0]).toContain("halted");
    expect(lines[0]).toContain("needs-human");
    expect(lines.join("\n")).toContain("2 drift");

    const daemon = await readDaemon(run);
    expect(daemon?.status).toBe("halted");
    expect(daemon?.halt?.class).toBe("needs-human");
  });

  test("shows halt details for a halted daemon", async () => {
    const run = await newRun();
    await writeDaemon(run, {
      session: "valtay-demo",
      pid: null,
      started: new Date().toISOString(),
      status: "halted",
      halt: { class: "needs-human", reason: "verify drift" },
    });

    const lines = await daemonStatus({ repo, run: "demo" });
    expect(lines.join("\n")).toContain("needs-human");
    expect(lines.join("\n")).toContain("verify drift");
  });
});

describe("daemonStop", () => {
  test("writes halted state even when no tmux session exists", async () => {
    const run = await newRun();
    const lines = await daemonStop({ repo, run: "demo" });
    expect(lines[0]).toContain("stopped");

    const state = await readDaemon(run);
    expect(state?.status).toBe("halted");
    expect(state?.halt?.reason).toBe("stopped by user");
  });
});

describe("daemonAttach", () => {
  test("throws when no tmux session exists", async () => {
    await newRun();
    await expect(daemonAttach({ repo, run: "demo" })).rejects.toThrow(/No tmux session/);
  });

  test("returns session name when session exists", async () => {
    if (!(await tmuxAvailable())) return;
    await newRun();
    await daemonStart({ repo, run: "demo" });
    const result = await daemonAttach({ repo, run: "demo" });
    expect(result.session).toBe("valtay-demo");
  });
});

describe("daemonStart", () => {
  test("throws when daemon is already running with live session", async () => {
    if (!(await tmuxAvailable())) return;
    await newRun();

    // First start
    await daemonStart({ repo, run: "demo" });
    // Second start should fail
    await expect(daemonStart({ repo, run: "demo" })).rejects.toThrow(/already running/);
  });

  test("writes daemon.json on start", async () => {
    if (!(await tmuxAvailable())) return;
    await newRun();

    const lines = await daemonStart({ repo, run: "demo" });
    expect(lines[0]).toContain("Daemon started");

    const run = await newRun("check").catch(() => null);
    // Read from the original run
    const { loadRun } = await import("../run/store.ts");
    const originalRun = await loadRun(resolve(repo, ".valtay/runs/demo"));
    const state = await readDaemon(originalRun);
    expect(state?.status).toBe("running");
    expect(state?.session).toBe("valtay-demo");
  });
});
