import { test, expect, describe, beforeEach, afterEach } from "bun:test";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve, join } from "node:path";
import { resolveConfig } from "../config.ts";
import { parseRunspec } from "../runspec.ts";
import { createRun, type Run } from "../run/store.ts";
import { readDaemon, writeDaemon, type DaemonState } from "./store.ts";

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
  root = await mkdtemp(join(tmpdir(), "valtay-daemon-store-"));
  repo = resolve(root, "myrepo");
  await mkdir(resolve(repo, ".git"), { recursive: true });
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

describe("daemon store", () => {
  test("readDaemon returns null when no daemon.json exists", async () => {
    const run = await newRun();
    expect(await readDaemon(run)).toBeNull();
  });

  test("writeDaemon + readDaemon round-trips", async () => {
    const run = await newRun();
    const state: DaemonState = {
      session: "valtay-demo",
      pid: 12345,
      started: new Date().toISOString(),
      status: "running",
    };

    await writeDaemon(run, state);
    const loaded = await readDaemon(run);

    expect(loaded).toEqual(state);
  });

  test("writeDaemon overwrites previous state", async () => {
    const run = await newRun();
    await writeDaemon(run, {
      session: "valtay-demo",
      pid: 100,
      started: new Date().toISOString(),
      status: "running",
    });

    const halted: DaemonState = {
      session: "valtay-demo",
      pid: null,
      started: new Date().toISOString(),
      status: "halted",
      halt: { class: "mechanical", reason: "tmux session died" },
    };
    await writeDaemon(run, halted);

    expect(await readDaemon(run)).toEqual(halted);
  });
});
