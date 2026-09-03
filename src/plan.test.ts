import { test, expect, describe } from "bun:test";
import { validatePlan } from "./plan.ts";
import type { ResolvedConfig } from "./config.ts";

const config = {
  run: { max_units: 5, max_layers: 12, max_trace_nodes: 40 },
} as ResolvedConfig;

const layer = (over: Record<string, unknown> = {}) => ({
  id: "L1",
  title: "feat(store): append-only manifest",
  kind: "semantic",
  inert: false,
  files: ["src/run/store.ts"],
  est_loc: { add: 40, del: 2 },
  ...over,
});

const plan = (over: Record<string, unknown> = {}) => ({
  epic: "append-only-manifest",
  release_units: [{ id: "RU-1", goal: "it appends", checkpoint: "bun test", layers: [layer()] }],
  alternatives_considered: [{ shape: "one big layer", rejected: "mixes mechanical with logic" }],
  ...over,
});

describe("a well-formed plan", () => {
  test("has no problems", () => {
    expect(validatePlan(plan(), config)).toEqual([]);
  });
});

describe("structure", () => {
  test("rejects a plan that is not an object", () => {
    expect(validatePlan([], config)).toEqual(["the plan is not a JSON object"]);
    expect(validatePlan("nope", config)).toHaveLength(1);
  });

  test("requires at least one release unit", () => {
    expect(validatePlan(plan({ release_units: [] }), config)).toContain("no release_units");
  });

  test("requires a checkpoint, because the probe has no oracle without one", () => {
    const missing = plan({
      release_units: [{ id: "RU-1", goal: "g", layers: [layer()] }],
    });
    expect(validatePlan(missing, config).join(" ")).toContain("no checkpoint command");

    const blank = plan({
      release_units: [{ id: "RU-1", goal: "g", checkpoint: "  ", layers: [layer()] }],
    });
    expect(validatePlan(blank, config).join(" ")).toContain("no checkpoint command");
  });

  test("requires each layer to declare its files — that is the build fence", () => {
    const unfenced = plan({
      release_units: [
        { id: "RU-1", goal: "g", checkpoint: "bun test", layers: [layer({ files: [] })] },
      ],
    });
    expect(validatePlan(unfenced, config).join(" ")).toContain("declares no files");
  });

  test("rejects a layer that is neither mechanical nor semantic", () => {
    // design.md §9.3: no layer may contain both, so the field holds one value.
    const both = plan({
      release_units: [
        {
          id: "RU-1",
          goal: "g",
          checkpoint: "bun test",
          layers: [layer({ kind: "mechanical and semantic" })],
        },
      ],
    });
    expect(validatePlan(both, config).join(" ")).toContain("expected mechanical or semantic");
  });

  test("requires alternatives, so the gate is a choice and not a rubber stamp", () => {
    expect(validatePlan(plan({ alternatives_considered: [] }), config).join(" ")).toContain(
      "rubber stamp"
    );
  });
});

describe("run budget", () => {
  test("rejects more units than the reviewer agreed to hold", () => {
    const units = Array.from({ length: 6 }, (_, i) => ({
      id: `RU-${i}`,
      goal: "g",
      checkpoint: "bun test",
      layers: [layer()],
    }));

    expect(validatePlan(plan({ release_units: units }), config).join(" ")).toContain(
      "exceeds the run budget of 5"
    );
  });

  test("counts layers across every unit, not per unit", () => {
    const wide = Array.from({ length: 3 }, (_, u) => ({
      id: `RU-${u}`,
      goal: "g",
      checkpoint: "bun test",
      layers: Array.from({ length: 5 }, (_, i) => layer({ id: `L${u}-${i}` })),
    }));

    expect(validatePlan(plan({ release_units: wide }), config).join(" ")).toContain(
      "15 review layers exceeds the run budget of 12"
    );
  });
});
