import { test, expect, describe, beforeEach, afterEach } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
  appendDeviations,
  readDeviations,
  recurrences,
  type DeviationEntry,
} from "./ledger.ts";

let root: string;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "valtay-ledger-"));
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

describe("appendDeviations", () => {
  test("writes entries to ledger-project.jsonl", async () => {
    const e = entry({ file: "src/foo.ts" });
    await appendDeviations(root, [e]);

    const text = await Bun.file(resolve(root, ".valtay/ledger-project.jsonl")).text();
    const lines = text.trim().split("\n");
    expect(lines).toHaveLength(1);
    expect(JSON.parse(lines[0]!)).toEqual(e);
  });

  test("deduplicates: same (run, kind, unit, layer, file, detail) not written twice", async () => {
    const e = entry({ file: "src/foo.ts" });
    await appendDeviations(root, [e]);
    await appendDeviations(root, [e]);

    const entries = await readDeviations(root);
    expect(entries).toHaveLength(1);
  });

  test("deduplicates within the same batch", async () => {
    const e = entry({ file: "src/foo.ts" });
    await appendDeviations(root, [e, e]);

    const entries = await readDeviations(root);
    expect(entries).toHaveLength(1);
  });

  test("writes entries with different keys", async () => {
    const e1 = entry({ file: "src/foo.ts", detail: "a" });
    const e2 = entry({ file: "src/foo.ts", detail: "b" });
    await appendDeviations(root, [e1, e2]);

    const entries = await readDeviations(root);
    expect(entries).toHaveLength(2);
  });

  test("skips nothing when the file does not exist", async () => {
    const e = entry();
    await appendDeviations(root, [e]);

    const entries = await readDeviations(root);
    expect(entries).toHaveLength(1);
  });

  test("no-ops when given an empty array", async () => {
    await appendDeviations(root, []);
    const exists = await Bun.file(resolve(root, ".valtay/ledger-project.jsonl")).exists();
    expect(exists).toBe(false);
  });
});

describe("readDeviations", () => {
  test("returns only valid DeviationEntry rows", async () => {
    const e = entry();
    await appendDeviations(root, [e]);

    const entries = await readDeviations(root);
    expect(entries).toHaveLength(1);
    expect(entries[0]!.kind).toBe("drift");
  });

  test("skips old-shape entries (kind: 'project', severity: 'local')", async () => {
    const path = resolve(root, ".valtay/ledger-project.jsonl");
    const { mkdir } = await import("node:fs/promises");
    await mkdir(resolve(root, ".valtay"), { recursive: true });

    const oldEntry = JSON.stringify({
      kind: "project",
      severity: "local",
      pattern: "signature",
      detail: "old format",
    });
    const newEntry = JSON.stringify(entry());
    await Bun.write(path, oldEntry + "\n" + newEntry + "\n");

    const entries = await readDeviations(root);
    expect(entries).toHaveLength(1);
    expect(entries[0]!.kind).toBe("drift");
  });

  test("returns empty array when file does not exist", async () => {
    const entries = await readDeviations(root);
    expect(entries).toEqual([]);
  });
});

describe("recurrences", () => {
  test("groups by pattern, sorted by count descending", () => {
    const entries: DeviationEntry[] = [
      entry({ pattern: "drift:a", ts: "2026-09-01T00:00:00Z", run: "r1" }),
      entry({ pattern: "drift:a", ts: "2026-09-02T00:00:00Z", run: "r2" }),
      entry({ pattern: "drift:a", ts: "2026-09-03T00:00:00Z", run: "r3" }),
      entry({ pattern: "fence:b", ts: "2026-09-01T00:00:00Z", run: "r1" }),
    ];

    const result = recurrences(entries);
    expect(result).toHaveLength(2);
    expect(result[0]!.pattern).toBe("drift:a");
    expect(result[0]!.count).toBe(3);
    expect(result[1]!.pattern).toBe("fence:b");
    expect(result[1]!.count).toBe(1);
  });

  test("returns distinct run names per pattern", () => {
    const entries: DeviationEntry[] = [
      entry({ pattern: "drift:a", run: "r1", ts: "2026-09-01T00:00:00Z" }),
      entry({ pattern: "drift:a", run: "r1", ts: "2026-09-02T00:00:00Z" }),
      entry({ pattern: "drift:a", run: "r2", ts: "2026-09-03T00:00:00Z" }),
    ];

    const result = recurrences(entries);
    expect(result[0]!.runs).toEqual(["r1", "r2"]);
  });

  test("latest is the entry with the most recent ts", () => {
    const entries: DeviationEntry[] = [
      entry({ pattern: "drift:a", ts: "2026-09-01T00:00:00Z", detail: "first" }),
      entry({ pattern: "drift:a", ts: "2026-09-03T00:00:00Z", detail: "third" }),
      entry({ pattern: "drift:a", ts: "2026-09-02T00:00:00Z", detail: "second" }),
    ];

    const result = recurrences(entries);
    expect(result[0]!.latest.detail).toBe("third");
  });

  test("returns empty array for empty input", () => {
    expect(recurrences([])).toEqual([]);
  });
});
