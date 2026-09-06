import { test, expect, describe } from "bun:test";
import {
  allDeviations,
  executionOrder,
  layerFor,
  probeMetrics,
  renderTrace,
  renderTree,
  validateTrace,
  withLayers,
  type ProbeResult,
  type Trace,
} from "./trace.ts";
import type { ResolvedConfig } from "./config.ts";

const config = {
  run: { max_units: 5, max_layers: 12, max_trace_nodes: 7 },
} as ResolvedConfig;

const LAYERS = { "src/ui/**": "ui", "src/game/**": "game", "src/platform/**": "io" };

const trace = (over: Partial<Trace> = {}): Trace => ({
  unit: "RU-1",
  source: "agent",
  entry: "input_event",
  nodes: [
    { id: "n1", symbol: "input_event", file: "src/platform/main.ts", line: 210, status: "unchanged", children: ["n2"] },
    {
      id: "n2",
      symbol: "ui_hit_test",
      file: "src/ui/hit.ts",
      line: 44,
      status: "changed",
      note: "returns element, no longer mutates",
      children: ["n3"],
    },
    { id: "n3", symbol: "player_take_damage", file: "src/game/player.ts", line: 31, status: "new", children: [] },
  ],
  ...over,
});

describe("layers", () => {
  test("derive from the config's path globs", () => {
    expect(layerFor("src/ui/hit.ts", LAYERS)).toBe("ui");
    expect(layerFor("src/game/deep/nested/player.ts", LAYERS)).toBe("game");
    expect(layerFor("src/other/thing.ts", LAYERS)).toBeUndefined();
  });

  test("are filled in where the trace left them out, and never overwritten", () => {
    const filled = withLayers(
      trace({ nodes: [{ ...trace().nodes[0]!, layer: "declared" }, ...trace().nodes.slice(1)] }),
      LAYERS
    );

    expect(filled.nodes[0]!.layer).toBe("declared");
    expect(filled.nodes[1]!.layer).toBe("ui");
    expect(filled.nodes[2]!.layer).toBe("game");
  });
});

describe("execution order", () => {
  test("is depth-first from the root, because position encodes causality", () => {
    expect(executionOrder(trace()).map((n) => n.id)).toEqual(["n1", "n2", "n3"]);
  });

  test("still surfaces a node no root reaches", () => {
    const orphaned = trace({
      nodes: [...trace().nodes, { id: "n9", symbol: "stray", file: "a.ts", line: 1, status: "new", children: [] }],
    });
    expect(executionOrder(orphaned).map((n) => n.id)).toContain("n9");
  });

  test("terminates on a cycle rather than hanging", () => {
    const cyclic = trace({
      nodes: [
        { id: "n1", symbol: "a", file: "a.ts", line: 1, status: "new", children: ["n2"] },
        { id: "n2", symbol: "b", file: "b.ts", line: 2, status: "new", children: ["n1"] },
      ],
    });
    expect(executionOrder(cyclic)).toHaveLength(2);
  });
});

describe("the flat render", () => {
  const lines = renderTrace(withLayers(trace(), LAYERS));

  test("is path:line:col, so a terminal and a problem matcher both take it", () => {
    expect(lines[0]).toStartWith("src/platform/main.ts:210:1:");
    expect(lines[2]).toStartWith("src/game/player.ts:31:1:");
  });

  test("encodes status with a sign rather than colour", () => {
    expect(lines[0]).toContain("- input_event");
    expect(lines[1]).toContain("~ ui_hit_test");
    expect(lines[2]).toContain("+ player_take_damage");
  });

  test("puts the layer in a fixed-width column, so a violation pops out", () => {
    const columns = lines.map((line) => line.slice(line.indexOf("["), line.indexOf("]") + 1));
    expect(new Set(columns.map((c) => c.length)).size).toBe(1);
    expect(columns).toEqual(["[io  ]", "[ui  ]", "[game]"]);
  });

  test("keeps the annotation on its own node", () => {
    expect(lines[1]).toContain("— returns element, no longer mutates");
    expect(lines[0]).not.toContain("returns element");
  });
});

describe("the tree render", () => {
  const lines = renderTree(withLayers(trace(), LAYERS));

  test("leads with the counts and the trust level", () => {
    expect(lines[0]).toContain("RU-1");
    expect(lines[0]).toContain("3 nodes");
    expect(lines[0]).toContain("source: agent");
  });

  test("shows nesting, which the flat list cannot", () => {
    const indents = lines.slice(2).map((line) => line.length - line.trimStart().length);
    expect(Math.max(...indents)).toBeGreaterThan(0);
  });

  test("puts the annotation under its node, never in a footnote", () => {
    const noteAt = lines.findIndex((line) => line.includes("returns element"));
    expect(lines[noteAt - 1]).toContain("ui_hit_test");
  });
});

describe("validation", () => {
  test("accepts a well-formed trace", () => {
    expect(validateTrace(trace(), config)).toEqual([]);
  });

  test("requires a source, because the reviewer must know what to trust", () => {
    expect(validateTrace(trace({ source: "vibes" as never }), config).join(" ")).toContain(
      "how much to trust"
    );
  });

  test("rejects an unknown status", () => {
    const bad = trace({ nodes: [{ ...trace().nodes[0]!, status: "maybe" as never }] });
    expect(validateTrace(bad, config).join(" ")).toContain("expected new, changed or unchanged");
  });

  test("catches a child that does not exist", () => {
    const dangling = trace({ nodes: [{ ...trace().nodes[0]!, children: ["nowhere"] }] });
    expect(validateTrace(dangling, config).join(" ")).toContain("points at missing child nowhere");
  });

  test("enforces the node cap, because a trace you cannot hold you cannot review", () => {
    const wide = trace({
      nodes: Array.from({ length: 8 }, (_, i) => ({
        id: `n${i}`,
        symbol: `s${i}`,
        file: "a.ts",
        line: i,
        status: "new" as const,
        children: [],
      })),
    });

    expect(validateTrace(wide, config).join(" ")).toContain("8 nodes exceeds the run budget of 7");
  });

  test("rejects a trace with no nodes at all", () => {
    expect(validateTrace(trace({ nodes: [] }), config)).toContain("no nodes");
  });
});

describe("the measurements a G4 predicate reads", () => {
  const probe = (over: Partial<ProbeResult> = {}): ProbeResult => ({
    traces: [trace({ source: "runtime" })],
    deviations: [],
    ...over,
  });

  test("reports the source when every trace agrees", () => {
    expect(probeMetrics(probe())["trace.source"]).toBe("runtime");
  });

  // §12.4 wants `trace.source == "runtime"` to mean every path was executed, not most
  // of them, so the weakest trace in the set is the one that answers.
  test("reports the weakest source when they disagree", () => {
    const mixed = probe({ traces: [trace({ source: "runtime" }), trace({ source: "static" })] });
    expect(probeMetrics(mixed)["trace.source"]).toBe("static");
  });

  test("no traces is the weakest case there is, not a free pass", () => {
    expect(probeMetrics(probe({ traces: [] }))["trace.source"]).toBe("agent");
  });

  test("an unrecognized source is weaker than any real one", () => {
    const bogus = probe({ traces: [trace({ source: "vibes" as never })] });
    expect(probeMetrics(bogus)["trace.source"]).toBe("vibes");
  });

  test("counts deviations from the probe and from the traces alike", () => {
    const both = probe({
      deviations: [{ kind: "k", detail: "top-level", severity: "local" }],
      traces: [trace({ source: "runtime", deviations: [{ kind: "k", detail: "in-trace", severity: "local" }] })],
    });

    expect(probeMetrics(both)["deviations"]).toBe(2);
    expect(allDeviations(both).map((d) => d.detail)).toEqual(["top-level", "in-trace"]);
  });

  test("only an explicit cosmetic or local is non-structural", () => {
    const graded = probe({
      deviations: [
        { kind: "k", detail: "a", severity: "cosmetic" },
        { kind: "k", detail: "b", severity: "local" },
        { kind: "k", detail: "c", severity: "structural" },
      ],
    });
    expect(probeMetrics(graded)["structural_deviations"]).toBe(1);
  });

  // Nothing classifies severity while Assess is unbuilt, so unclassified is the common
  // case. Treating it as harmless would auto-pass G4 on findings nobody has read.
  test("an unclassified deviation counts as structural", () => {
    const raw = probe({ deviations: [{ kind: "k", detail: "unread" }] });
    expect(probeMetrics(raw)["structural_deviations"]).toBe(1);
  });
});
