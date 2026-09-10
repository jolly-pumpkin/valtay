import { test, expect, describe, beforeEach, afterEach } from "bun:test";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve, join } from "node:path";
import { runStart } from "./start.ts";
import { runApprove, runReject } from "./gate.ts";
import { runShow } from "./show.ts";
import { runStatusLines } from "./status.ts";
import { findRun, readApprovals, readState, writeArtifact } from "../run/store.ts";

let root: string;
let repo: string;
const savedHome = process.env["VALTAY_HOME"];

const SPEC = `---
run: demo
host: claude
model: sonnet
---

# Demo

## Design

Add a lint.
`;

async function startAndPlaceArtifacts() {
  const path = resolve(repo, "runspec.md");
  await writeFile(path, SPEC);
  const run = await runStart({ spec: path, repo });

  // Place artifacts for all phases
  await writeArtifact(run, "plan.json", '{"epic":"check","release_units":[]}');
  await writeArtifact(run, "build.md", "- implemented check command");
  await writeArtifact(
    run,
    "verify.json",
    JSON.stringify({
      status: "drift",
      findings: [{ what: "lint", actual: "missing", file: "src/check.ts", severity: "drift" }],
    })
  );

  return run;
}

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "valtay-gate-"));
  repo = resolve(root, "valtay");
  await mkdir(resolve(repo, ".git"), { recursive: true });
  process.env["VALTAY_HOME"] = resolve(root, "home");
});

afterEach(async () => {
  if (savedHome === undefined) delete process.env["VALTAY_HOME"];
  else process.env["VALTAY_HOME"] = savedHome;
  await rm(root, { recursive: true, force: true });
});

describe("approve", () => {
  test("records the approval and completes the run", async () => {
    await startAndPlaceArtifacts();
    // First advance to get to the verify gate
    const { advance } = await import("../run/orchestrator.ts");
    await advance(await findRun(repo));

    const lines = (await runApprove({ repo, gate: "verify" })).join("\n");
    expect(lines).toContain("verify approved");

    const run = await findRun(repo);
    const approval = (await readApprovals(run)).at(-1)!;
    expect(approval.decision).toBe("approve");
  });

  test("refuses a gate that is not verify", async () => {
    await startAndPlaceArtifacts();
    await expect(runApprove({ repo, gate: "plan" })).rejects.toThrow(/only gate is "verify"/);
  });

  test("refuses when verify artifact does not exist", async () => {
    const path = resolve(repo, "runspec.md");
    await writeFile(path, SPEC);
    await runStart({ spec: path, repo });

    await expect(runApprove({ repo, gate: "verify" })).rejects.toThrow(/has not written/);
  });
});

describe("reject", () => {
  test("re-enters at the named phase", async () => {
    await startAndPlaceArtifacts();
    const { advance } = await import("../run/orchestrator.ts");
    await advance(await findRun(repo));

    await runReject({
      repo,
      gate: "verify",
      to: "build",
      reason: "lint is not wired up",
    });

    const state = await readState(await findRun(repo));
    expect(state.phase).toBe("build");
    expect(state.rerun).toBe(true);
  });

  test("refuses a target that is not a phase", async () => {
    await startAndPlaceArtifacts();
    const { advance } = await import("../run/orchestrator.ts");
    await advance(await findRun(repo));

    await expect(
      runReject({ repo, gate: "verify", to: "the vibes", reason: "wrong" })
    ).rejects.toThrow(/Cannot re-enter/);
  });

  test("refuses a rejection with no reason", async () => {
    await startAndPlaceArtifacts();
    const { advance } = await import("../run/orchestrator.ts");
    await advance(await findRun(repo));

    await expect(
      runReject({ repo, gate: "verify", to: "build", reason: "  " })
    ).rejects.toThrow(/needs a reason/);
  });
});

describe("show", () => {
  test("prints an artifact by stem or by path", async () => {
    await startAndPlaceArtifacts();

    expect((await runShow({ repo, artifact: "plan" })).join("\n")).toContain("check");
    expect((await runShow({ repo, artifact: "plan.json" })).join("\n")).toContain("check");
  });

  test("names what exists when asked for something that does not", async () => {
    const path = resolve(repo, "runspec.md");
    await writeFile(path, SPEC);
    await runStart({ spec: path, repo });

    await expect(runShow({ repo, artifact: "plan.json" })).rejects.toThrow(/No plan.json/);
  });
});
