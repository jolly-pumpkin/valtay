import { test, expect, describe } from "bun:test";
import { extractJson, trimPreamble, renderPayload } from "./invoke.ts";

describe("trimPreamble", () => {
  test("drops a working note ahead of the artifact", () => {
    expect(trimPreamble("Checked the store. Now writing.\n\n## Findings\n\nbody", "## Findings")).toBe(
      "## Findings\n\nbody"
    );
  });

  test("leaves an artifact that already starts correctly", () => {
    expect(trimPreamble("## Findings\n\nbody", "## Findings")).toBe("## Findings\n\nbody");
  });

  test("does not chase a later occurrence of the heading", () => {
    const doc = "## Findings\n\nsee also ## Findings below";
    expect(trimPreamble(doc, "## Findings")).toBe(doc);
  });

  test("leaves output alone when the phase declares no leading heading", () => {
    expect(trimPreamble("anything at all")).toBe("anything at all");
  });
});

describe("extractJson", () => {
  test("pulls the object out of a sentence", () => {
    expect(extractJson('All done. Here it is:\n{"a":1}\nLet me know.')).toBe('{"a":1}');
  });

  test("keeps nested objects whole", () => {
    const nested = '{"a":{"b":{"c":[1,2]}},"d":3}';
    expect(extractJson(`prose ${nested} more prose`)).toBe(nested);
  });

  test("is not confused by braces inside strings", () => {
    // A deviation's `detail` can easily contain a brace.
    const tricky = '{"detail":"the call site needs a { here","ok":true}';
    expect(extractJson(`note: ${tricky}`)).toBe(tricky);
  });

  test("is not confused by an escaped quote before a brace", () => {
    const escaped = '{"detail":"they said \\"use { \\" and left","ok":true}';
    expect(JSON.parse(extractJson(`x ${escaped} y`))).toEqual({
      detail: 'they said "use { " and left',
      ok: true,
    });
  });

  test("stops at the matching brace, not the last one in the reply", () => {
    expect(extractJson('{"a":1} and separately {"b":2}')).toBe('{"a":1}');
  });

  test("returns the input unchanged when there is no object", () => {
    expect(extractJson("no json here")).toBe("no json here");
  });
});

describe("renderPayload", () => {
  test("labels each input so a phase can tell them apart", () => {
    const payload = renderPayload([
      { label: "Intent", content: "do the thing" },
      { label: "Research findings", content: "it appends" },
    ]);

    expect(payload).toContain("# Intent\n\ndo the thing");
    expect(payload).toContain("# Research findings\n\nit appends");
    expect(payload.indexOf("# Intent")).toBeLessThan(payload.indexOf("# Research findings"));
  });
});
