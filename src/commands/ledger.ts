import { resolve } from "path";
import { readdir } from "node:fs/promises";
import {
  appendDeviations,
  readDeviations,
  recurrences,
  type DeviationEntry,
  type DeviationKind,
} from "../run/ledger.ts";

const PROPOSAL_THRESHOLD = 3;

interface VerifyJson {
  status: string;
  findings?: Array<{
    what: string;
    actual: string;
    file: string;
    severity: "drift" | "minor";
  }>;
}

interface LedgerJson {
  units: Array<{
    unit: string;
    layers: Array<{
      unit: string;
      layer: string;
      status: string;
      reason?: string;
      files?: string[];
    }>;
    fenceViolations?: string[];
  }>;
}

async function backfillEntries(repoRoot: string): Promise<DeviationEntry[]> {
  const runsDir = resolve(repoRoot, ".valtay", "runs");
  let dirs: string[];
  try {
    dirs = (await readdir(runsDir, { withFileTypes: true }))
      .filter((e) => e.isDirectory())
      .map((e) => e.name);
  } catch {
    return [];
  }

  const entries: DeviationEntry[] = [];
  const now = new Date().toISOString();

  for (const runName of dirs) {
    const runDir = resolve(runsDir, runName);

    // verify.json → drift/minor entries
    const verifyFile = Bun.file(resolve(runDir, "verify.json"));
    if (await verifyFile.exists()) {
      try {
        const data = (await verifyFile.json()) as VerifyJson;
        if (data.findings) {
          for (const f of data.findings) {
            entries.push({
              ts: now,
              run: runName,
              kind: f.severity as DeviationKind,
              file: f.file,
              detail: `${f.what}: ${f.actual}`,
              pattern: `${f.severity}:${f.file}`,
            });
          }
        }
      } catch {
        // skip malformed verify.json
      }
    }

    // ledger.json → contested, blocked, fence entries
    const ledgerFile = Bun.file(resolve(runDir, "ledger.json"));
    if (await ledgerFile.exists()) {
      try {
        const data = (await ledgerFile.json()) as LedgerJson;
        for (const u of data.units) {
          for (const l of u.layers) {
            if (l.status === "contested") {
              entries.push({
                ts: now,
                run: runName,
                unit: u.unit,
                layer: l.layer,
                kind: "contested",
                detail: l.reason ?? "contested",
                pattern: "contested",
              });
            } else if (l.status === "blocked") {
              entries.push({
                ts: now,
                run: runName,
                unit: u.unit,
                layer: l.layer,
                kind: "blocked",
                detail: l.reason ?? "blocked",
                pattern: "blocked",
              });
            }
          }

          if (u.fenceViolations) {
            for (const file of u.fenceViolations) {
              entries.push({
                ts: now,
                run: runName,
                unit: u.unit,
                kind: "fence",
                file,
                detail: file,
                pattern: `fence:${file}`,
              });
            }
          }
        }
      } catch {
        // skip malformed ledger.json
      }
    }
  }

  return entries;
}

/** Print one line per pattern, most recurrent first:
 *    3x  fence:src/run/runner.ts        runs: record, verify-blind, fileset-graph
 *    2x  minor:src/run/provider.ts      runs: record, verify-blind
 *
 *  --min N is a display filter (default 1): hide patterns with count < N.
 *  The proposal threshold is separate and hardcoded at 3.
 *
 *  For every pattern with count >= 3 (the proposal threshold):
 *    proposal: add a rule for "fence:src/run/runner.ts" — hook, lint, or
 *    an AGENTS.md line, in that order of preference.
 *  Valtay does not apply proposals.
 *
 *  --backfill: scan .valtay/runs/*, read each run's verify.json and
 *  ledger.json, emit the same DeviationEntry rows the pipeline would have
 *  produced, deduped against what's already in ledger-project.jsonl.
 *  Idempotent — safe to run repeatedly. */
export async function runLedger(opts: {
  min?: number;
  backfill?: boolean;
  repo?: string;
}): Promise<string[]> {
  const repoRoot = resolve(opts.repo ?? ".");
  const min = opts.min ?? 1;

  if (opts.backfill) {
    const entries = await backfillEntries(repoRoot);
    if (entries.length > 0) {
      await appendDeviations(repoRoot, entries);
    }
  }

  const entries = await readDeviations(repoRoot);
  if (entries.length === 0) return ["No deviations recorded."];

  const groups = recurrences(entries);
  const lines: string[] = [];

  for (const g of groups) {
    if (g.count < min) continue;
    const countStr = `${g.count}\u00d7`.padStart(5);
    const runsStr = `runs: ${g.runs.join(", ")}`;
    lines.push(`${countStr}  ${g.pattern.padEnd(40)} ${runsStr}`);

    if (g.count >= PROPOSAL_THRESHOLD) {
      lines.push(`  proposal: add a rule for "${g.pattern}" \u2014 hook, lint, or an AGENTS.md line, in that order of preference.`);
    }
  }

  if (lines.length === 0) return ["No deviations above minimum threshold."];

  return lines;
}
