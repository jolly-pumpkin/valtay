/**
 * The predicate language for gate pre-authorization (design.md §12.4).
 *
 * A decision made in advance, conditionally, is cleared by a *mechanical* predicate —
 * never by a model. That is why this is a hand-rolled comparison evaluator rather than
 * anything that could be talked into a `true`, and why the grammar is deliberately
 * small: comparisons joined by `and`, which is every form the design, the runspec docs
 * and the `valtay new` template actually use.
 */

/** Every gate design.md §12.1 names. That table is authoritative. */
export const ALL_GATES: readonly string[] = ["G1", "G2", "G3", "G4", "G5", "G6"];

/**
 * Gates a predicate may ever clear (design.md §12.4).
 *
 * G1, G2 and G6 are judgment gates and are absent permanently — G6 especially, which
 * "stays manual permanently. That rule does not get a flag."
 */
export const PRE_AUTHORIZABLE: readonly string[] = ["G3", "G4", "G5"];

/**
 * What each gate's predicate may name, and the whole reason a typo fails at
 * `valtay start` rather than three phases later at the gate itself.
 *
 * G5 is missing on purpose: it is not in the built pipeline (`run/phases.ts`), so
 * nothing measures anything for it.
 */
export const PREDICATE_VARIABLES: Record<string, readonly string[]> = {
  G3: ["layers", "multiteam_layers", "max_semantic_loc", "new_flags"],
  G4: ["trace.source", "deviations", "structural_deviations"],
};

const OPERATORS = ["<=", ">=", "==", "!=", "<", ">"] as const;
export type Operator = (typeof OPERATORS)[number];

export interface Comparison {
  variable: string;
  op: Operator;
  value: number | string;
}

/** What a predicate is evaluated against: one measurement per name. */
export type Scope = Record<string, number | string>;

const CLAUSE = /^([A-Za-z_]\w*(?:\.[A-Za-z_]\w*)*)\s*(<=|>=|==|!=|<|>)\s*(-?\d+|"[^"]*")/;

/**
 * Parses `layers <= 4 and trace.source == "runtime"`.
 *
 * Consumes the whole string rather than splitting on `and` first, so a quoted literal
 * containing the word cannot silently change what the predicate means. Anything
 * outside the grammar throws, naming the text that stopped it — the `parseDuration`
 * treatment, because a predicate nobody can parse is a config bug, not a `false`.
 */
export function parsePredicate(source: string): Comparison[] {
  const clauses: Comparison[] = [];
  let rest = source.trim();

  for (;;) {
    const match = rest.match(CLAUSE);
    if (!match) {
      throw new Error(
        `Unparseable predicate at ${JSON.stringify(rest)} — expected "<name> <op> <value>"`
      );
    }

    const literal = match[3]!;
    clauses.push({
      variable: match[1]!,
      op: match[2] as Operator,
      value: literal.startsWith('"') ? literal.slice(1, -1) : Number(literal),
    });

    rest = rest.slice(match[0].length).trim();
    if (rest === "") return clauses;

    if (!/^and\b/.test(rest)) {
      throw new Error(`Unparseable predicate at ${JSON.stringify(rest)} — expected "and"`);
    }
    rest = rest.slice(3).trim();
  }
}

/** Rejects a clause naming something the gate does not measure. */
export function checkVariables(clauses: Comparison[], gate: string): void {
  const allowed = PREDICATE_VARIABLES[gate] ?? [];

  for (const clause of clauses) {
    if (!allowed.includes(clause.variable)) {
      throw new Error(
        `${gate} auto_pass_if names "${clause.variable}", which nothing measures at that ` +
          `gate. Available: ${allowed.join(", ")}`
      );
    }
  }
}

/**
 * Everything that must hold for `gate` to carry `source` as its predicate.
 *
 * Called at config resolution so an ineligible gate, an unknown name or a malformed
 * expression fails at `valtay start`, when the human is still watching.
 */
export function checkPredicate(gate: string, source: string): Comparison[] {
  if (!ALL_GATES.includes(gate)) {
    throw new Error(`No gate ${gate}. Gates: ${ALL_GATES.join(", ")}`);
  }

  if (!PRE_AUTHORIZABLE.includes(gate)) {
    throw new Error(
      `${gate} can never be pre-authorized — it is a judgment gate (design.md §12.4)`
    );
  }

  if (!PREDICATE_VARIABLES[gate]) {
    throw new Error(
      `${gate} is not in the built pipeline, so nothing can evaluate a predicate for it`
    );
  }

  const clauses = parsePredicate(source);
  checkVariables(clauses, gate);
  return clauses;
}

/**
 * True when every clause holds. Throws when the scope cannot answer one.
 *
 * Strict on purpose: an unbound name or a number compared against a string is a
 * mistake in the predicate, and returning `false` for it would park the gate forever
 * with nothing to read.
 */
export function evaluate(clauses: Comparison[], scope: Scope): boolean {
  return clauses.every((clause) => {
    const actual = scope[clause.variable];
    if (actual === undefined) {
      throw new Error(
        `Unknown variable "${clause.variable}" — available: ${Object.keys(scope).join(", ")}`
      );
    }

    if (typeof actual !== typeof clause.value) {
      throw new Error(
        `Cannot compare ${clause.variable} (${typeof actual}) with ` +
          `${JSON.stringify(clause.value)} (${typeof clause.value})`
      );
    }

    if (clause.op === "==") return actual === clause.value;
    if (clause.op === "!=") return actual !== clause.value;

    if (typeof actual !== "number" || typeof clause.value !== "number") {
      throw new Error(`${clause.op} needs numbers, but ${clause.variable} is a string`);
    }

    switch (clause.op) {
      case "<=":
        return actual <= clause.value;
      case "<":
        return actual < clause.value;
      case ">=":
        return actual >= clause.value;
      case ">":
        return actual > clause.value;
    }
  });
}

/** The clause that failed, rendered for the gate's note. */
export function failedClause(clauses: Comparison[], scope: Scope): string | null {
  const failed = clauses.find((clause) => !evaluate([clause], scope));
  if (!failed) return null;

  const value = typeof failed.value === "string" ? `"${failed.value}"` : failed.value;
  return `${failed.variable} ${failed.op} ${value} (actual: ${JSON.stringify(scope[failed.variable])})`;
}
