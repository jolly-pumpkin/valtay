import { test, expect, describe, beforeEach, afterEach } from "bun:test";
import { mkdtemp, rm, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { runLedger } from "./ledger.ts";
import { appendDeviations, type DeviationEntry } from "../run/ledger.ts";

let root: string;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "valtay-ledger-cmd-"));
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

function entry(overrides: Partial<DeviationEntry> = {}): DeviationEntry {
  return {
    ts: "2026-09-17T00:00:00.000Z",
    run: "test-run",
    kind: "drift",
    detail: "something drifted",
    pattern: "drift:src/foo.ts",
    ...overrides,
  };
}

describe("runLedger", () => {
  test("fixture ledger: expected output lines, one per pattern, most recurrent first", async () => {
    await appendDeviations(root, [
      entry({ pattern: "fence:src/run/runner.ts", kind: "fence", run: "r1" }),
      entry({ pattern: "fence:src/run/runner.ts", kind: "fence", run: "r2", detail: "d2" }),
      entry({ pattern: "minor:src/run/provider.ts", kind: "minor", run: "r1" }),
    ]);

    const lines = await runLedger({ repo: root });
    expect(lines[0]).toContain("fence:src/run/runner.ts");
    expect(lines[0]).toContain("2\u00d7");
    // minor pattern should come after fence (lower count)
    const minorLine = lines.find((l) => l.includes("minor:src/run/provider.ts"));
    expect(minorLine).toBeDefined();
    expect(minorLine).toContain("1\u00d7");
  });

  test("--min 2 hides patterns with count < 2", async () => {
    await appendDeviations(root, [
      entry({ pattern: "fence:src/a.ts", kind: "fence", run: "r1" }),
      entry({ pattern: "fence:src/a.ts", kind: "fence", run: "r2", detail: "d2" }),
      entry({ pattern: "minor:src/b.ts", kind: "minor", run: "r1" }),
    ]);

    const lines = await runLedger({ repo: root, min: 2 });
    expect(lines.some((l) => l.includes("fence:src/a.ts"))).toBe(true);
    expect(lines.some((l) => l.includes("minor:src/b.ts"))).toBe(false);
  });

  test("proposal line appears for patterns with count >= 3", async () => {
    await appendDeviations(root, [
      entry({ pattern: "fence:src/a.ts", kind: "fence", run: "r1", detail: "d1" }),
      entry({ pattern: "fence:src/a.ts", kind: "fence", run: "r2", detail: "d2" }),
      entry({ pattern: "fence:src/a.ts", kind: "fence", run: "r3", detail: "d3" }),
    ]);

    const lines = await runLedger({ repo: root });
    const proposalLine = lines.find((l) => l.includes("proposal:"));
    expect(proposalLine).toBeDefined();
    expect(proposalLine).toContain("fence:src/a.ts");
  });

  test("no proposal for patterns with count < 3", async () => {
    await appendDeviations(root, [
      entry({ pattern: "fence:src/a.ts", kind: "fence", run: "r1", detail: "d1" }),
      entry({ pattern: "fence:src/a.ts", kind: "fence", run: "r2", detail: "d2" }),
    ]);

    const lines = await runLedger({ repo: root });
    expect(lines.some((l) => l.includes("proposal:"))).toBe(false);
  });

  test("--backfill scans run dirs and emits entries", async () => {
    // Create a fake run with verify.json and ledger.json
    const runDir = resolve(root, ".valtay", "runs", "fake-run");
    await mkdir(runDir, { recursive: true });

    await Bun.write(
      resolve(runDir, "verify.json"),
      JSON.stringify({
        status: "clean",
        findings: [
          {
            what: "something wrong",
            actual: "was different",
            file: "src/foo.ts",
            severity: "minor",
          },
        ],
      }),
    );

    await Bun.write(
      resolve(runDir, "ledger.json"),
      JSON.stringify({
        units: [
          {
            unit: "RU-1",
            layers: [
              { unit: "RU-1", layer: "L1", status: "contested", reason: "bad idea" },
            ],
            fenceViolations: ["src/bar.ts"],
          },
        ],
        updated: "2026-09-17T00:00:00Z",
      }),
    );

    const lines = await runLedger({ repo: root, backfill: true });

    // Should have entries for minor, contested, and fence
    expect(lines.some((l) => l.includes("minor:src/foo.ts"))).toBe(true);
    expect(lines.some((l) => l.includes("contested"))).toBe(true);
    expect(lines.some((l) => l.includes("fence:src/bar.ts"))).toBe(true);
  });

  test("--backfill is idempotent", async () => {
    const runDir = resolve(root, ".valtay", "runs", "fake-run");
    await mkdir(runDir, { recursive: true });

    await Bun.write(
      resolve(runDir, "verify.json"),
      JSON.stringify({
        status: "clean",
        findings: [
          { what: "x", actual: "y", file: "src/a.ts", severity: "minor" },
        ],
      }),
    );

    await runLedger({ repo: root, backfill: true });
    await runLedger({ repo: root, backfill: true });

    // Read raw lines — should have exactly one entry
    const text = await Bun.file(resolve(root, ".valtay/ledger-project.jsonl")).text();
    const dataLines = text.trim().split("\n").filter(Boolean);
    expect(dataLines).toHaveLength(1);
  });

  test("empty ledger shows no deviations message", async () => {
    const lines = await runLedger({ repo: root });
    expect(lines).toEqual(["No deviations recorded."]);
  });
});
