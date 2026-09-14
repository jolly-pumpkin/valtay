import { resolve, dirname } from "path";
import { appendFile, mkdir, readdir } from "node:fs/promises";
import { pathExists } from "../detect.ts";
import { sha256, type Runspec } from "../runspec.ts";
import type { ResolvedConfig } from "../config.ts";

export type PhaseId = "plan" | "build" | "verify";
export type GateId = "verify";

export type RunStatus =
  /** the phase named in `phase` has not been invoked yet */
  | "pending"
  /** waiting on a human at `gate` */
  | "awaiting_gate"
  /** the phase failed after its retries; the run halts here */
  | "failed"
  /** every phase is through its gate */
  | "complete";

export interface RunState {
  phase: PhaseId;
  status: RunStatus;
  gate?: GateId;
  completed: PhaseId[];
  updated: string;
  note?: string;
  /**
   * Re-run `phase` even though its artifact exists. Set by a typed rejection, which
   * is the difference between resuming an interrupted run (keep what is on disk) and
   * re-entering a phase whose output was wrong (produce it again).
   */
  rerun?: boolean;
}

export interface ArtifactRef {
  /** Relative to the run directory. */
  path: string;
  sha: string;
}

/**
 * One record per phase invocation, including failures and fallbacks (invariant 7).
 * Fields mirror design.md §17; `cost_usd`, `usage` and `permission_denials` come
 * straight off the host adapter's structured result.
 */
/**
 * One record per artifact placed, for auditability.
 * Simpler than the old manifest — the orchestrator no longer invokes phases,
 * so there is no exit_code, duration, or retry count to record.
 */
export interface ManifestRecord {
  ts: string;
  phase: PhaseId;
  artifact: ArtifactRef;
  notes: string[];
}

export interface ApprovalRecord {
  ts: string;
  gate: GateId;
  decision: "approve" | "reject";
  /** Why the human approved or rejected. */
  reason?: string;
  /** Every artifact the gate covered, hashed. A later edit voids the approval. */
  artifacts: ArtifactRef[];
}

export interface RunMeta {
  run: string;
  repo: string;
  created: string;
  runspec: { path: string; sha: string };
  config: ResolvedConfig;
  /** Pre-build HEAD commit. Recorded so verify can diff against it. */
  baseCommit?: string;
  /** Runner-owned integration branch. Human merges this when done. */
  integrationBranch?: string;
}

export interface Run {
  dir: string;
  meta: RunMeta;
}

/** `<repoRoot>/.valtay/runs/<run-name>`. */
export function runDir(repoRoot: string, name: string): string {
  return resolve(repoRoot, ".valtay", "runs", name);
}

export function artifactPath(run: Run, rel: string): string {
  return resolve(run.dir, rel);
}

export async function writeArtifact(run: Run, rel: string, content: string): Promise<ArtifactRef> {
  await Bun.write(artifactPath(run, rel), content);
  return { path: rel, sha: sha256(content) };
}

export async function readArtifact(run: Run, rel: string): Promise<string | null> {
  const file = Bun.file(artifactPath(run, rel));
  return (await file.exists()) ? file.text() : null;
}

/** Current hash of an artifact on disk, or null when it is missing. */
export async function hashArtifact(run: Run, rel: string): Promise<string | null> {
  const content = await readArtifact(run, rel);
  return content === null ? null : sha256(content);
}

export async function createRun(
  repoRoot: string,
  name: string,
  spec: Runspec,
  config: ResolvedConfig
): Promise<Run> {
  const dir = runDir(repoRoot, name);
  if (await pathExists(resolve(dir, "run.json"))) {
    throw new Error(`Run "${name}" already exists at ${dir} — use \`valtay status\` or pick another name`);
  }

  const meta: RunMeta = {
    run: name,
    repo: repoRoot,
    created: new Date().toISOString(),
    runspec: { path: spec.path, sha: sha256(spec.raw) },
    config,
  };

  await mkdir(dir, { recursive: true });
  const run: Run = { dir, meta };

  await Bun.write(resolve(dir, "run.json"), `${JSON.stringify(meta, null, 2)}\n`);
  await writeArtifact(run, "runspec.frozen.md", spec.raw); // immutable reference copy
  await writeArtifact(run, "runspec.md", spec.raw); // working copy
  await writeState(run, {
    phase: "plan",
    status: "pending",
    completed: [],
    updated: meta.created,
  });

  return run;
}

export async function loadRun(dir: string): Promise<Run> {
  const file = Bun.file(resolve(dir, "run.json"));
  if (!(await file.exists())) throw new Error(`No run at ${dir}`);
  return { dir, meta: (await file.json()) as RunMeta };
}

/**
 * Locates a run for `repoRoot`. With no name, resolves the only run there — an
 * ambiguous match is an error rather than a guess, since every gate command acts on
 * whatever this returns.
 */
export async function findRun(repoRoot: string, name?: string): Promise<Run> {
  if (name) return loadRun(runDir(repoRoot, name));

  const parent = resolve(repoRoot, ".valtay", "runs");
  let entries: string[];
  try {
    entries = (await readdir(parent, { withFileTypes: true }))
      .filter((e) => e.isDirectory())
      .map((e) => e.name);
  } catch {
    entries = [];
  }

  if (entries.length === 0) throw new Error(`No runs for ${repoRoot}. Start one with \`valtay start\`.`);
  if (entries.length > 1) {
    throw new Error(`Several runs for ${repoRoot}: ${entries.sort().join(", ")}. Name one with --run.`);
  }
  return loadRun(resolve(parent, entries[0]!));
}

export async function readState(run: Run): Promise<RunState> {
  return (await Bun.file(resolve(run.dir, "state.json")).json()) as RunState;
}

export async function writeState(run: Run, state: RunState): Promise<void> {
  const stamped = { ...state, updated: new Date().toISOString() };
  await Bun.write(resolve(run.dir, "state.json"), `${JSON.stringify(stamped, null, 2)}\n`);
}

async function appendJsonl(path: string, record: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await appendFile(path, `${JSON.stringify(record)}\n`);
}

async function readJsonl<T>(path: string): Promise<T[]> {
  const file = Bun.file(path);
  if (!(await file.exists())) return [];
  return (await file.text())
    .split("\n")
    .filter((line) => line.trim())
    .map((line) => JSON.parse(line) as T);
}

export async function appendManifest(run: Run, record: ManifestRecord): Promise<void> {
  await appendJsonl(resolve(run.dir, "manifest.jsonl"), record);
}

export async function readManifest(run: Run): Promise<ManifestRecord[]> {
  return readJsonl<ManifestRecord>(resolve(run.dir, "manifest.jsonl"));
}

// --- Build ledger types ---

export type LayerStatus = "pending" | "done" | "blocked" | "contested";

export interface LayerReport {
  /** Release unit id, e.g. "RU-1" */
  unit: string;
  /** Layer id within that unit, e.g. "L1" */
  layer: string;
  status: LayerStatus;
  /** Required when blocked or contested. The builder's own words. */
  reason?: string;
  /** Files the builder actually touched (for done layers) */
  files?: string[];
  /** Set by `valtay override` — the subagent must implement, not contest. */
  suppressContestation?: boolean;
}

export interface UnitEntry {
  unit: string;
  layers: LayerReport[];
  /** Subagent worktree branch name, if applicable */
  branch?: string;
}

export interface BuildLedger {
  units: UnitEntry[];
  updated: string; // ISO 8601
}

export interface RetryState {
  attempt: number;
  max: number;
  /** Layer ids that were blocked on each attempt */
  history: Array<{ attempt: number; blocked: string[] }>;
}

export type ContestationDecision = "override" | "accept";

export interface ContestationRecord {
  ts: string;
  unit: string;
  layer: string;
  decision: ContestationDecision;
  reason?: string;
}

// --- Build ledger IO ---

export async function readLedger(run: Run): Promise<BuildLedger | null> {
  const file = Bun.file(resolve(run.dir, "ledger.json"));
  if (!(await file.exists())) return null;
  return (await file.json()) as BuildLedger;
}

export async function writeLedger(run: Run, ledger: BuildLedger): Promise<void> {
  const stamped = { ...ledger, updated: new Date().toISOString() };
  await Bun.write(resolve(run.dir, "ledger.json"), `${JSON.stringify(stamped, null, 2)}\n`);
}

export async function readRetryState(run: Run): Promise<RetryState | null> {
  const file = Bun.file(resolve(run.dir, "retry.json"));
  if (!(await file.exists())) return null;
  return (await file.json()) as RetryState;
}

export async function writeRetryState(run: Run, state: RetryState): Promise<void> {
  await Bun.write(resolve(run.dir, "retry.json"), `${JSON.stringify(state, null, 2)}\n`);
}

export async function appendContestation(run: Run, record: ContestationRecord): Promise<void> {
  await appendJsonl(resolve(run.dir, "contestations.jsonl"), record);
}

export async function readContestations(run: Run): Promise<ContestationRecord[]> {
  return readJsonl<ContestationRecord>(resolve(run.dir, "contestations.jsonl"));
}

export async function appendApproval(run: Run, record: ApprovalRecord): Promise<void> {
  await appendJsonl(resolve(run.dir, "approvals.jsonl"), record);
}

export async function readApprovals(run: Run): Promise<ApprovalRecord[]> {
  return readJsonl<ApprovalRecord>(resolve(run.dir, "approvals.jsonl"));
}

/** The most recent decision recorded for `gate`, or null. */
export async function latestDecision(run: Run, gate: GateId): Promise<ApprovalRecord | null> {
  const matching = (await readApprovals(run)).filter((a) => a.gate === gate);
  return matching.at(-1) ?? null;
}

/**
 * Artifacts whose content no longer matches what was approved.
 *
 * An empty list means the approval still stands. A non-empty one is not an error:
 * hand-editing an artifact to void its approval and everything downstream is the
 * intended workflow (design.md §12.3).
 */
export async function staleArtifacts(run: Run, record: ApprovalRecord): Promise<string[]> {
  const checked = await Promise.all(
    record.artifacts.map(async (ref) => ((await hashArtifact(run, ref.path)) === ref.sha ? null : ref.path))
  );
  return checked.filter((path): path is string => path !== null);
}

/**
 * True when `gate` carries a standing approval over unmodified artifacts.
 *
 * An auto-pass counts. It is bound to the same artifact hashes a human approval is,
 * so editing what it cleared voids it exactly the same way (design.md §12.3).
 */
export async function isApproved(run: Run, gate: GateId): Promise<boolean> {
  const decision = await latestDecision(run, gate);
  if (!decision || decision.decision === "reject") return false;
  return (await staleArtifacts(run, decision)).length === 0;
}
