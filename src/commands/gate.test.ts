import { test, expect, describe, beforeEach, afterEach } from "bun:test";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve, join } from "node:path";
import { runStart } from "./start.ts";
import { runApprove, runReject, runOverride, runAcceptLayer } from "./gate.ts";
import { runShow } from "./show.ts";
import { runStatusLines } from "./status.ts";
import {
  findRun,
  readApprovals,
  readArtifact,
  readContestations,
  readLedger,
  readState,
  writeArtifact,
  writeLedger,
  type BuildLedger,
} from "../run/store.ts";

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
  await writeArtifact(run, "plan.md", '{"epic":"check","release_units":[]}');
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

    // Defect 1.1: approve must actually complete the run
    const state = await readState(run);
    expect(state.status).toBe("complete");
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
    expect(state.status).toBe("pending");
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

  test("reject --to build resets only implicated units and writes rejection.md", async () => {
    const path = resolve(repo, "runspec.md");
    await writeFile(path, SPEC);
    const run = await runStart({ spec: path, repo });

    // Place artifacts including briefs with file lists
    await writeArtifact(run, "plan.md", "# Plan\n\n## RU-1 — A\n\n### L1\n- **Files:** `src/a.ts`\n\n## RU-2 — B\n\n### L1\n- **Files:** `src/b.ts`\n");
    await mkdir(resolve(run.dir, "briefs"), { recursive: true });
    await writeFile(resolve(run.dir, "briefs", "RU-1.md"), "# Brief\n\n## Layers\n\n### L1\n- **Files:** `src/a.ts`\n\n## Dependencies\n\nNone\n");
    await writeFile(resolve(run.dir, "briefs", "RU-2.md"), "# Brief\n\n## Layers\n\n### L1\n- **Files:** `src/b.ts`\n\n## Dependencies\n\nNone\n");
    await writeArtifact(run, "build.md", "- done");
    await writeArtifact(
      run,
      "verify.json",
      JSON.stringify({
        status: "drift",
        findings: [{ what: "A type", actual: "missing", file: "src/a.ts", severity: "drift" }],
      }),
    );

    const ledger: BuildLedger = {
      units: [
        { unit: "RU-1", layers: [{ unit: "RU-1", layer: "L1", status: "done", files: ["src/a.ts"] }] },
        { unit: "RU-2", layers: [{ unit: "RU-2", layer: "L1", status: "done", files: ["src/b.ts"] }] },
      ],
      updated: "",
    };
    await writeLedger(run, ledger);

    const { advance } = await import("../run/orchestrator.ts");
    await advance(run);

    await runReject({
      repo,
      gate: "verify",
      to: "build",
      reason: "src/a.ts is wrong",
    });

    const updatedLedger = await readLedger(await findRun(repo));
    // RU-1 (implicated) should be reset to pending
    const ru1 = updatedLedger!.units.find((u) => u.unit === "RU-1");
    expect(ru1!.layers[0]!.status).toBe("pending");
    // RU-2 (not implicated) should stay done
    const ru2 = updatedLedger!.units.find((u) => u.unit === "RU-2");
    expect(ru2!.layers[0]!.status).toBe("done");

    // rejection.md should exist with the reason and findings
    const rejContent = await readArtifact(await findRun(repo), "rejection.md");
    expect(rejContent).not.toBeNull();
    expect(rejContent).toContain("src/a.ts is wrong");
    expect(rejContent).toContain("## Findings");
    expect(rejContent).toContain("`src/a.ts`");
  });

  test("reject --to plan resets all units", async () => {
    const path = resolve(repo, "runspec.md");
    await writeFile(path, SPEC);
    const run = await runStart({ spec: path, repo });

    await writeArtifact(run, "plan.md", "# Plan\n\n## RU-1 — A\n\n### L1\n- **Files:** `src/a.ts`\n");
    await mkdir(resolve(run.dir, "briefs"), { recursive: true });
    await writeFile(resolve(run.dir, "briefs", "RU-1.md"), "# Brief\n\n## Layers\n\n### L1\n- **Files:** `src/a.ts`\n\n## Dependencies\n\nNone\n");
    await writeArtifact(run, "build.md", "- done");
    await writeArtifact(
      run,
      "verify.json",
      JSON.stringify({ status: "drift", findings: [] }),
    );

    const ledger: BuildLedger = {
      units: [
        { unit: "RU-1", layers: [{ unit: "RU-1", layer: "L1", status: "done", files: ["src/a.ts"] }] },
      ],
      updated: "",
    };
    await writeLedger(run, ledger);

    const { advance } = await import("../run/orchestrator.ts");
    await advance(run);

    await runReject({
      repo,
      gate: "verify",
      to: "plan",
      reason: "start over",
    });

    // --to plan voids the ledger outright: the plan that produced its units is about to change
    const after = await findRun(repo);
    const state = await readState(after);
    expect(state.phase).toBe("plan");
    expect(state.status).toBe("pending");
    expect(await readLedger(after)).toBeNull();
  });
});

async function startWithContestedLedger() {
  const path = resolve(repo, "runspec.md");
  await writeFile(path, SPEC);
  const run = await runStart({ spec: path, repo });

  await writeArtifact(run, "plan.md", '{"epic":"check","release_units":[]}');
  await writeArtifact(run, "build.md", "- partial");

  const ledger: BuildLedger = {
    units: [
      {
        unit: "RU-1",
        layers: [
          { unit: "RU-1", layer: "L1", status: "done", files: ["src/a.ts"] },
          { unit: "RU-1", layer: "L2", status: "contested", reason: "unnecessary" },
        ],
      },
    ],
    updated: "",
  };
  await writeLedger(run, ledger);

  // Advance to get to awaiting_gate
  const { advance } = await import("../run/orchestrator.ts");
  await advance(run);

  return run;
}

describe("override", () => {
  test("resets a contested layer to pending", async () => {
    await startWithContestedLedger();

    const lines = await runOverride({ repo, unit: "RU-1", layer: "L2" });
    expect(lines.some((l) => l.includes("overridden"))).toBe(true);

    const run = await findRun(repo);
    const ledger = await readLedger(run);
    expect(ledger!.units[0]!.layers[1]!.status).toBe("pending");
    expect(ledger!.units[0]!.layers[1]!.suppressContestation).toBe(true);

    const contestations = await readContestations(run);
    expect(contestations).toHaveLength(1);
    expect(contestations[0]!.decision).toBe("override");

    const state = await readState(run);
    expect(state.phase).toBe("build");
    expect(state.status).toBe("pending");
    expect(state.rerun).toBe(true);
  });

  test("refuses to override a non-contested layer", async () => {
    await startWithContestedLedger();
    await expect(runOverride({ repo, unit: "RU-1", layer: "L1" })).rejects.toThrow(/not contested/);
  });

  test("refuses unknown unit", async () => {
    await startWithContestedLedger();
    await expect(runOverride({ repo, unit: "RU-99", layer: "L1" })).rejects.toThrow(/No unit/);
  });
});

describe("accept layer", () => {
  test("marks a contested layer done by exemption", async () => {
    await startWithContestedLedger();

    const lines = await runAcceptLayer({ repo, unit: "RU-1", layer: "L2" });
    expect(lines.some((l) => l.includes("accepted"))).toBe(true);

    const run = await findRun(repo);
    const ledger = await readLedger(run);
    expect(ledger!.units[0]!.layers[1]!.status).toBe("done");

    const contestations = await readContestations(run);
    expect(contestations).toHaveLength(1);
    expect(contestations[0]!.decision).toBe("accept");
  });

  test("reports all done when the last contested layer is accepted", async () => {
    await startWithContestedLedger();

    const lines = await runAcceptLayer({ repo, unit: "RU-1", layer: "L2" });
    expect(lines.some((l) => l.includes("valtay run"))).toBe(true);
  });

  test("refuses to accept a non-contested layer", async () => {
    await startWithContestedLedger();
    await expect(runAcceptLayer({ repo, unit: "RU-1", layer: "L1" })).rejects.toThrow(/not contested/);
  });
});

describe("show", () => {
  test("prints an artifact by stem or by path", async () => {
    await startAndPlaceArtifacts();

    expect((await runShow({ repo, artifact: "plan" })).join("\n")).toContain("check");
    expect((await runShow({ repo, artifact: "plan.md" })).join("\n")).toContain("check");
  });

  test("names what exists when asked for something that does not", async () => {
    const path = resolve(repo, "runspec.md");
    await writeFile(path, SPEC);
    await runStart({ spec: path, repo });

    await expect(runShow({ repo, artifact: "plan.md" })).rejects.toThrow(/No plan.md/);
  });
});

describe("reject voids downstream artifacts", () => {
  const { downstreamArtifacts } = require("./gate.ts") as typeof import("./gate.ts");
  const { pathExists } = require("../detect.ts") as typeof import("../detect.ts");

  test("--to verify voids verify.json and checkpoint.md only", () => {
    expect(downstreamArtifacts("verify", ["RU-1"])).toEqual(["verify.json", "checkpoint.md"]);
  });

  test("--to build also voids build.md and the implicated units' reports, never ledger.json", () => {
    const v = downstreamArtifacts("build", ["RU-1"]);
    expect(v).toContain("build.md");
    expect(v).toContain("reports/RU-1.md");
    expect(v).not.toContain("reports/RU-2.md");
    expect(v).not.toContain("ledger.json");
  });

  test("--to plan voids everything the plan produced", () => {
    const v = downstreamArtifacts("plan", []);
    for (const f of ["plan.md", "briefs", "reports", "ledger.json", "verify.json", "checkpoint.md"]) expect(v).toContain(f);
  });

  test("a rebuild re-entry deletes the stale verify.json and checkpoint.md on disk", async () => {
    const path = resolve(repo, "runspec.md");
    await writeFile(path, SPEC);
    const run = await runStart({ spec: path, repo });
    await writeArtifact(run, "plan.md", "# Plan\n\n## RU-1 — A\n\n### L1\n- **Files:** `src/a.ts`\n");
    await mkdir(resolve(run.dir, "briefs"), { recursive: true });
    await writeFile(resolve(run.dir, "briefs", "RU-1.md"), "# Brief\n\n## Layers\n\n### L1\n- **Files:** `src/a.ts`\n\n## Dependencies\n\nNone\n");
    await writeArtifact(run, "build.md", "- done");
    await writeArtifact(run, "checkpoint.md", "## RU-1 — `x` — exit 2 — 1s");
    await mkdir(resolve(run.dir, "reports"), { recursive: true });
    await writeFile(resolve(run.dir, "reports", "RU-1.md"), "# Report: RU-1\n\n## L1 — a\n- **Status:** done\n");
    await writeArtifact(run, "verify.json", JSON.stringify({ status: "drift", findings: [{ what: "w", actual: "a", file: "src/a.ts", severity: "drift" }] }));
    await writeLedger(run, { units: [{ unit: "RU-1", layers: [{ unit: "RU-1", layer: "L1", status: "done", files: ["src/a.ts"] }] }], updated: "" });
    const { advance } = await import("../run/orchestrator.ts");
    await advance(run);

    await runReject({ repo, gate: "verify", to: "build", reason: "fix it" });

    for (const gone of ["verify.json", "checkpoint.md", "build.md", "reports/RU-1.md"]) {
      expect(await pathExists(resolve(run.dir, gone))).toBe(false);
    }
    expect(await pathExists(resolve(run.dir, "ledger.json"))).toBe(true);
    expect(await pathExists(resolve(run.dir, "rejection.md"))).toBe(true);
  });
});
