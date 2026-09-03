import { resolve } from "path";
import { appendFile, mkdir } from "node:fs/promises";
import { valtayHome } from "./config.ts";
import type { Deviation } from "./trace.ts";

export type LedgerKind = "project" | "harness";

export interface LedgerEntry {
  ts: string;
  kind: LedgerKind;
  run: string;
  /** What recurred. Grouping key for promotion, once promotion exists. */
  pattern: string;
  detail: string;
  file?: string;
  severity?: string;
}

/**
 * Two ledgers, because they promote to different places.
 *
 * `ledger-project.jsonl` accumulates how *this codebase* resists change and belongs
 * to the repo. `ledger-harness.jsonl` accumulates facts about Valtay itself — three
 * rejections for the same reason is a fact about a phase prompt, not about your code
 * — and belongs to the machine.
 */
export function ledgerPath(kind: LedgerKind, repoRoot: string): string {
  return kind === "project"
    ? resolve(repoRoot, ".valtay", "ledger-project.jsonl")
    : resolve(valtayHome(), "ledger-harness.jsonl");
}

async function append(path: string, entries: LedgerEntry[]): Promise<void> {
  if (entries.length === 0) return;
  await mkdir(resolve(path, ".."), { recursive: true });
  await appendFile(path, entries.map((entry) => `${JSON.stringify(entry)}\n`).join(""));
}

/**
 * Records what the probe had to depart from the plan to do.
 *
 * Nothing reads this yet — promotion after three recurrences is not built. It is
 * written from the first run anyway, because the promotion rule is worthless without
 * history and history cannot be backfilled.
 */
export async function recordDeviations(
  repoRoot: string,
  run: string,
  deviations: Deviation[]
): Promise<number> {
  const entries: LedgerEntry[] = deviations.map((deviation) => ({
    ts: new Date().toISOString(),
    kind: "project",
    run,
    pattern: deviation.kind,
    detail: deviation.detail,
    ...(deviation.file ? { file: deviation.file } : {}),
    ...(deviation.severity ? { severity: deviation.severity } : {}),
  }));

  await append(ledgerPath("project", repoRoot), entries);
  return entries.length;
}

/**
 * Records a gate rejection against the harness.
 *
 * Your rejections are the most informative signal the system produces about itself:
 * three rejections of the same phase for the same reason is evidence about that
 * phase's prompt, and no other harness captures it.
 */
export async function recordRejection(
  run: string,
  gate: string,
  target: string,
  reason: string
): Promise<void> {
  await append(ledgerPath("harness", ""), [
    {
      ts: new Date().toISOString(),
      kind: "harness",
      run,
      pattern: `${gate}-rejected-to-${target}`,
      detail: reason,
    },
  ]);
}

export async function readLedger(kind: LedgerKind, repoRoot: string): Promise<LedgerEntry[]> {
  const file = Bun.file(ledgerPath(kind, repoRoot));
  if (!(await file.exists())) return [];

  return (await file.text())
    .split("\n")
    .filter((line) => line.trim())
    .map((line) => JSON.parse(line) as LedgerEntry);
}
