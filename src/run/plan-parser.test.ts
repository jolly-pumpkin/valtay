import { test, expect, describe, beforeEach, afterEach } from "bun:test";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve, join } from "node:path";
import { parsePlanUnits, topoSortWaves, parseReport } from "./plan-parser.ts";
import type { PlanUnit } from "./plan-parser.ts";
import type { Run } from "./store.ts";

let root: string;
let runDir: string;
let run: Run;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "valtay-plan-parser-"));
  runDir = resolve(root, "run");
  await mkdir(resolve(runDir, "briefs"), { recursive: true });
  await mkdir(resolve(runDir, "reports"), { recursive: true });
  run = {
    dir: runDir,
    meta: {
      run: "test",
      repo: root,
      created: new Date().toISOString(),
      runspec: { path: "runspec.md", sha: "abc" },
      config: { host: "claude", model: "sonnet", retries: 1 } as any,
    },
  };
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

describe("parsePlanUnits", () => {
  test("single unit with no dependencies", async () => {
    await Bun.write(
      resolve(runDir, "briefs", "RU-1.md"),
      "# RU-1\n\n## Dependencies\n\nNone\n\n## Layers\n\n- L1: do stuff\n"
    );

    const units = await parsePlanUnits(run);
    expect(units).toHaveLength(1);
    expect(units[0]!.id).toBe("RU-1");
    expect(units[0]!.briefPath).toBe("briefs/RU-1.md");
    expect(units[0]!.deps).toEqual([]);
  });

  test("two units where RU-2 depends on RU-1", async () => {
    await Bun.write(
      resolve(runDir, "briefs", "RU-1.md"),
      "# RU-1\n\n## Dependencies\n\nNone\n\n## Layers\n\n- L1: base\n"
    );
    await Bun.write(
      resolve(runDir, "briefs", "RU-2.md"),
      "# RU-2\n\n## Dependencies\n\nDepends on RU-1 for base types.\n\n## Layers\n\n- L1: extend\n"
    );

    const units = await parsePlanUnits(run);
    expect(units).toHaveLength(2);
    expect(units[0]!.id).toBe("RU-1");
    expect(units[0]!.deps).toEqual([]);
    expect(units[1]!.id).toBe("RU-2");
    expect(units[1]!.deps).toEqual(["RU-1"]);
  });

  test("brief with 'None' in dependencies section returns empty deps", async () => {
    await Bun.write(
      resolve(runDir, "briefs", "RU-1.md"),
      "# RU-1\n\n## Dependencies\n\nNone\n"
    );

    const units = await parsePlanUnits(run);
    expect(units[0]!.deps).toEqual([]);
  });

  test("brief with no dependencies section returns empty deps", async () => {
    await Bun.write(
      resolve(runDir, "briefs", "RU-1.md"),
      "# RU-1\n\n## Layers\n\n- L1: standalone work\n"
    );

    const units = await parsePlanUnits(run);
    expect(units[0]!.deps).toEqual([]);
  });
});

describe("topoSortWaves", () => {
  test("all independent units land in one wave", () => {
    const units: PlanUnit[] = [
      { id: "RU-1", briefPath: "briefs/RU-1.md", deps: [] },
      { id: "RU-2", briefPath: "briefs/RU-2.md", deps: [] },
      { id: "RU-3", briefPath: "briefs/RU-3.md", deps: [] },
    ];

    const waves = topoSortWaves(units);
    expect(waves).toHaveLength(1);
    expect(waves[0]!.units).toHaveLength(3);
  });

  test("chain produces one unit per wave", () => {
    const units: PlanUnit[] = [
      { id: "RU-1", briefPath: "briefs/RU-1.md", deps: [] },
      { id: "RU-2", briefPath: "briefs/RU-2.md", deps: ["RU-1"] },
      { id: "RU-3", briefPath: "briefs/RU-3.md", deps: ["RU-2"] },
    ];

    const waves = topoSortWaves(units);
    expect(waves).toHaveLength(3);
    expect(waves[0]!.units[0]!.id).toBe("RU-1");
    expect(waves[1]!.units[0]!.id).toBe("RU-2");
    expect(waves[2]!.units[0]!.id).toBe("RU-3");
  });

  test("diamond dependency produces three waves", () => {
    const units: PlanUnit[] = [
      { id: "RU-1", briefPath: "briefs/RU-1.md", deps: [] },
      { id: "RU-2", briefPath: "briefs/RU-2.md", deps: ["RU-1"] },
      { id: "RU-3", briefPath: "briefs/RU-3.md", deps: ["RU-1"] },
      { id: "RU-4", briefPath: "briefs/RU-4.md", deps: ["RU-2", "RU-3"] },
    ];

    const waves = topoSortWaves(units);
    expect(waves).toHaveLength(3);
    expect(waves[0]!.units.map((u) => u.id)).toEqual(["RU-1"]);
    expect(waves[1]!.units.map((u) => u.id).sort()).toEqual(["RU-2", "RU-3"]);
    expect(waves[2]!.units.map((u) => u.id)).toEqual(["RU-4"]);
  });

  test("cycle throws", () => {
    const units: PlanUnit[] = [
      { id: "RU-1", briefPath: "briefs/RU-1.md", deps: ["RU-2"] },
      { id: "RU-2", briefPath: "briefs/RU-2.md", deps: ["RU-1"] },
    ];

    expect(() => topoSortWaves(units)).toThrow("Dependency cycle");
  });
});

describe("parseReport", () => {
  test("report with all layers done", () => {
    const content = [
      "# RU-1 Build Report",
      "",
      "## L1",
      "",
      "**Status:** done",
      "**Files touched:** `src/a.ts`, `src/b.ts`",
      "",
      "## L2",
      "",
      "**Status:** done",
      "**Files touched:** `src/c.ts`",
    ].join("\n");

    const reports = parseReport("RU-1", content);
    expect(reports).toHaveLength(2);
    expect(reports[0]!.unit).toBe("RU-1");
    expect(reports[0]!.layer).toBe("L1");
    expect(reports[0]!.status).toBe("done");
    expect(reports[0]!.files).toEqual(["src/a.ts", "src/b.ts"]);
    expect(reports[1]!.layer).toBe("L2");
    expect(reports[1]!.status).toBe("done");
    expect(reports[1]!.files).toEqual(["src/c.ts"]);
  });

  test("report with a contested layer includes reason", () => {
    const content = [
      "## L1",
      "",
      "**Status:** done",
      "**Files touched:** `src/a.ts`",
      "",
      "## L2",
      "",
      "**Status:** contested",
      "**Reason:** This layer requires an external API that conflicts with the design.",
    ].join("\n");

    const reports = parseReport("RU-1", content);
    expect(reports).toHaveLength(2);
    expect(reports[1]!.status).toBe("contested");
    expect(reports[1]!.reason).toBe(
      "This layer requires an external API that conflicts with the design."
    );
    expect(reports[1]!.files).toBeUndefined();
  });

  test("report with a blocked layer includes reason", () => {
    const content = [
      "## L1",
      "",
      "**Status:** blocked",
      "**Reason:** Missing dependency on RU-2 output.",
    ].join("\n");

    const reports = parseReport("RU-1", content);
    expect(reports).toHaveLength(1);
    expect(reports[0]!.status).toBe("blocked");
    expect(reports[0]!.reason).toBe("Missing dependency on RU-2 output.");
  });

  test("report with mixed statuses", () => {
    const content = [
      "## L1",
      "",
      "**Status:** done",
      "**Files touched:** `src/x.ts`",
      "",
      "## L2",
      "",
      "**Status:** blocked",
      "**Reason:** Waiting on L1 output from RU-3.",
      "",
      "## L3",
      "",
      "**Status:** contested",
      "**Reason:** Unnecessary complexity.",
      "",
      "## L4",
      "",
      "**Status:** pending",
    ].join("\n");

    const reports = parseReport("RU-2", content);
    expect(reports).toHaveLength(4);
    expect(reports[0]!.status).toBe("done");
    expect(reports[0]!.files).toEqual(["src/x.ts"]);
    expect(reports[1]!.status).toBe("blocked");
    expect(reports[1]!.reason).toBe("Waiting on L1 output from RU-3.");
    expect(reports[2]!.status).toBe("contested");
    expect(reports[2]!.reason).toBe("Unnecessary complexity.");
    expect(reports[3]!.status).toBe("pending");
    expect(reports[3]!.reason).toBeUndefined();
    expect(reports[3]!.files).toBeUndefined();
  });
});
