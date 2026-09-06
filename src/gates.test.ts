import { test, expect, describe } from "bun:test";
import {
  checkPredicate,
  evaluate,
  failedClause,
  parsePredicate,
  type Scope,
} from "./gates.ts";

const scope: Scope = {
  layers: 4,
  multiteam_layers: 1,
  max_semantic_loc: 200,
  new_flags: 0,
  "trace.source": "runtime",
};

/** The predicate design.md §12.4 writes, verbatim. */
const G3 = "layers <= 4 and multiteam_layers <= 1 and max_semantic_loc <= 200 and new_flags == 0";

const holds = (source: string, over: Scope = {}) =>
  evaluate(parsePredicate(source), { ...scope, ...over });

describe("parsing", () => {
  test("reads a comparison into its three parts", () => {
    expect(parsePredicate("layers <= 4")).toEqual([{ variable: "layers", op: "<=", value: 4 }]);
  });

  test("reads the predicate the design doc writes", () => {
    expect(parsePredicate(G3).map((c) => c.variable)).toEqual([
      "layers",
      "multiteam_layers",
      "max_semantic_loc",
      "new_flags",
    ]);
  });

  test("reads dotted names and quoted strings", () => {
    expect(parsePredicate('trace.source == "runtime"')).toEqual([
      { variable: "trace.source", op: "==", value: "runtime" },
    ]);
  });

  test("reads negative numbers and every operator", () => {
    for (const op of ["<=", ">=", "==", "!=", "<", ">"] as const) {
      expect(parsePredicate(`layers ${op} -1`)).toEqual([{ variable: "layers", op, value: -1 }]);
    }
  });

  test("tolerates whatever spacing the human used", () => {
    expect(parsePredicate("layers<=4   and   new_flags==0")).toHaveLength(2);
  });

  // `and` inside a literal is text, not a connective — which is why the parser walks
  // the string rather than splitting on the word first.
  test("does not split inside a quoted literal", () => {
    expect(parsePredicate('trace.source == "cats and dogs"')).toEqual([
      { variable: "trace.source", op: "==", value: "cats and dogs" },
    ]);
  });

  test("refuses an empty predicate", () => {
    expect(() => parsePredicate("   ")).toThrow(/Unparseable predicate/);
  });

  test("refuses an unsupported connective, rather than guessing", () => {
    expect(() => parsePredicate("layers <= 4 or new_flags == 0")).toThrow(/expected "and"/);
  });

  test("refuses a bare name, an unbalanced quote and a stray operator", () => {
    expect(() => parsePredicate("layers")).toThrow(/Unparseable predicate/);
    expect(() => parsePredicate('trace.source == "runtime')).toThrow(/Unparseable predicate/);
    expect(() => parsePredicate("layers =< 4")).toThrow(/Unparseable predicate/);
  });
});

describe("evaluation", () => {
  test("passes when every clause holds", () => {
    expect(holds(G3)).toBe(true);
  });

  test("fails when any one clause does not", () => {
    expect(holds(G3, { layers: 5 })).toBe(false);
    expect(holds(G3, { new_flags: 1 })).toBe(false);
  });

  test("compares strings for equality", () => {
    expect(holds('trace.source == "runtime"')).toBe(true);
    expect(holds('trace.source == "runtime"', { "trace.source": "agent" })).toBe(false);
    expect(holds('trace.source != "agent"')).toBe(true);
  });

  test("compares numbers on every boundary", () => {
    expect(holds("layers < 4")).toBe(false);
    expect(holds("layers <= 4")).toBe(true);
    expect(holds("layers > 3")).toBe(true);
    expect(holds("layers >= 5")).toBe(false);
  });

  // A silent `false` would park the gate forever with nothing to read, so every
  // mistake in the predicate is loud.
  test("throws on a name the scope cannot answer", () => {
    expect(() => holds("layer <= 4")).toThrow(/Unknown variable "layer"/);
  });

  test("throws when the types do not line up", () => {
    expect(() => holds('layers == "four"')).toThrow(/Cannot compare layers/);
    expect(() => holds("trace.source <= 4")).toThrow(/Cannot compare trace.source/);
  });

  test("throws when a string is ordered", () => {
    expect(() => holds('trace.source < "runtime"')).toThrow(/needs numbers/);
  });
});

describe("the failing clause", () => {
  test("names the clause and what was actually measured", () => {
    expect(failedClause(parsePredicate(G3), { ...scope, layers: 9 })).toBe(
      "layers <= 4 (actual: 9)"
    );
  });

  test("quotes a string comparison the way the predicate wrote it", () => {
    expect(
      failedClause(parsePredicate('trace.source == "runtime"'), {
        ...scope,
        "trace.source": "agent",
      })
    ).toBe('trace.source == "runtime" (actual: "agent")');
  });

  test("is null when nothing failed", () => {
    expect(failedClause(parsePredicate(G3), scope)).toBeNull();
  });
});

describe("eligibility", () => {
  test("accepts a budget gate's predicate", () => {
    expect(checkPredicate("G3", G3)).toHaveLength(4);
    expect(checkPredicate("G4", 'trace.source == "runtime"')).toHaveLength(1);
  });

  // design.md §12.4. G6 especially: "that rule does not get a flag."
  test("refuses every judgment gate", () => {
    for (const gate of ["G1", "G2", "G6"]) {
      expect(() => checkPredicate(gate, "layers <= 4")).toThrow(/can never be pre-authorized/);
    }
  });

  test("refuses G5, which the built pipeline does not have", () => {
    expect(() => checkPredicate("G5", "layers <= 4")).toThrow(/not in the built pipeline/);
  });

  test("refuses a gate that does not exist", () => {
    expect(() => checkPredicate("G7", "layers <= 4")).toThrow(/No gate G7/);
  });

  test("refuses a name the gate does not measure, listing what it does", () => {
    expect(() => checkPredicate("G3", 'trace.source == "runtime"')).toThrow(
      /names "trace.source".*Available: layers, multiteam_layers/s
    );
  });
});
