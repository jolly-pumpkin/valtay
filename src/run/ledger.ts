import { resolve, dirname } from "path";
import { mkdir, appendFile } from "node:fs/promises";

export type DeviationKind =
  | "drift"       // verify finding, severity drift
  | "minor"       // verify finding, severity minor
  | "contested"   // builder contested a layer
  | "blocked"     // layer blocked after dispatch
  | "fence"       // file touched outside the unit's fileset
  | "checkout";   // main checkout changed during a wave

const VALID_KINDS = new Set<string>([
  "drift", "minor", "contested", "blocked", "fence", "checkout",
]);

export interface DeviationEntry {
  ts: string;           // ISO 8601
  run: string;          // run name
  unit?: string;        // release unit id when applicable
  layer?: string;       // layer id when applicable
  kind: DeviationKind;
  file?: string;        // repo-relative path when known
  detail: string;       // finding's what/actual, contestation reason, blocked reason, or file list
  pattern: string;      // recurrence key: kind + ":" + file (or kind alone when no file)
}

const LEDGER_FILE = ".valtay/ledger-project.jsonl";

function dedupKey(e: DeviationEntry): string {
  return [e.run, e.kind, e.unit ?? "", e.layer ?? "", e.file ?? "", e.detail].join("\0");
}

/** Append deviation entries to <repoRoot>/.valtay/ledger-project.jsonl.
 *  Older entries with a different shape are left in place — readDeviations skips them.
 *
 *  Idempotent: an entry is skipped when the ledger already holds one with the
 *  same (run, kind, unit, layer, file, detail). This is the "once per run"
 *  guarantee. advance() parses verify.json on every call — end of run, approve,
 *  re-entry — so without dedup, verify findings would be appended 2–3× per run.
 *  Runner-side emissions have the same exposure on re-entry. The dedup key is
 *  cheap: load existing entries, build a Set of composite keys, skip matches. */
export async function appendDeviations(
  repoRoot: string,
  entries: DeviationEntry[],
): Promise<void> {
  if (entries.length === 0) return;

  const path = resolve(repoRoot, LEDGER_FILE);

  // Read existing raw lines to build dedup set (works even with old-shape entries)
  const file = Bun.file(path);
  const existing = new Set<string>();
  if (await file.exists()) {
    const text = await file.text();
    for (const line of text.split("\n")) {
      if (!line.trim()) continue;
      try {
        const parsed = JSON.parse(line) as Record<string, unknown>;
        if (VALID_KINDS.has(parsed.kind as string)) {
          existing.add(dedupKey(parsed as unknown as DeviationEntry));
        }
      } catch {
        // skip unparseable lines
      }
    }
  }

  const newLines: string[] = [];
  for (const entry of entries) {
    const key = dedupKey(entry);
    if (!existing.has(key)) {
      newLines.push(JSON.stringify(entry));
      existing.add(key); // prevent dupes within the same batch
    }
  }

  if (newLines.length === 0) return;

  await mkdir(dirname(path), { recursive: true });
  await appendFile(path, newLines.join("\n") + "\n");
}

/** Read all valid DeviationEntry rows from ledger-project.jsonl.
 *  Rows that don't match the schema (old format) are silently skipped.
 *  A row is valid when its `kind` field is one of the DeviationKind literals. */
export async function readDeviations(
  repoRoot: string,
): Promise<DeviationEntry[]> {
  const path = resolve(repoRoot, LEDGER_FILE);
  const file = Bun.file(path);
  if (!(await file.exists())) return [];

  const entries: DeviationEntry[] = [];
  for (const line of (await file.text()).split("\n")) {
    if (!line.trim()) continue;
    try {
      const parsed = JSON.parse(line) as Record<string, unknown>;
      if (VALID_KINDS.has(parsed.kind as string)) {
        entries.push(parsed as unknown as DeviationEntry);
      }
    } catch {
      // skip unparseable lines
    }
  }
  return entries;
}

/** Group entries by pattern, sorted by count descending.
 *  Each group carries the count, distinct run names, and the latest entry. */
export function recurrences(
  entries: DeviationEntry[],
): Array<{ pattern: string; count: number; runs: string[]; latest: DeviationEntry }> {
  const groups = new Map<string, { count: number; runs: Set<string>; latest: DeviationEntry }>();

  for (const entry of entries) {
    const existing = groups.get(entry.pattern);
    if (existing) {
      existing.count++;
      existing.runs.add(entry.run);
      if (entry.ts > existing.latest.ts) existing.latest = entry;
    } else {
      groups.set(entry.pattern, {
        count: 1,
        runs: new Set([entry.run]),
        latest: entry,
      });
    }
  }

  return [...groups.entries()]
    .map(([pattern, g]) => ({
      pattern,
      count: g.count,
      runs: [...g.runs].sort(),
      latest: g.latest,
    }))
    .sort((a, b) => b.count - a.count);
}
