import { resolve, basename, dirname } from "path";
import { appendFile, mkdir, readdir } from "node:fs/promises";
import { pathExists } from "../detect.ts";
import { sha256, type Runspec } from "../runspec.ts";
import { valtayHome, vendorDiversity, type ResolvedConfig } from "../config.ts";

export type PhaseId = "research" | "reconcile" | "shape" | "plan" | "probe" | "build";
export type GateId = "G1" | "G2" | "G3" | "G4" | "G5" | "G6";

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
export interface ManifestRecord {
  ts: string;
  phase: PhaseId;
  role: string;
  host: string;
  model: string;
  effort?: string;
  prompt_sha: string;
  inputs: ArtifactRef[];
  outputs: ArtifactRef[];
  duration_s: number;
  exit_code: number;
  attempt: number;
  usage?: Record<string, unknown>;
  cost_usd?: number;
  permission_denials?: unknown[];
  notes: string[];
}

export interface ApprovalRecord {
  ts: string;
  gate: GateId;
  decision: "approve" | "reject";
  unit?: string;
  /** Typed rejection: which artifact was wrong (design.md §12.3). */
  to?: string;
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
  vendor_diversity: boolean;
}

export interface Run {
  dir: string;
  meta: RunMeta;
}

export function runsRoot(): string {
  return resolve(valtayHome(), "runs");
}

/** `~/.valtay/runs/<repo-name>/<run-name>` (design.md §4.1). */
export function runDir(repoRoot: string, name: string): string {
  return resolve(runsRoot(), basename(repoRoot), name);
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
    // The spec's SHA is frozen here so editing it mid-run is a detected event
    // rather than a silent divergence (design.md §8.1).
    runspec: { path: spec.path, sha: sha256(spec.raw) },
    config,
    vendor_diversity: vendorDiversity(config),
  };

  await mkdir(dir, { recursive: true });
  const run: Run = { dir, meta };

  await Bun.write(resolve(dir, "run.json"), `${JSON.stringify(meta, null, 2)}\n`);
  await writeArtifact(run, "runspec.md", spec.raw);
  await writeState(run, {
    phase: "research",
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

  const parent = resolve(runsRoot(), basename(repoRoot));
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

/** True when `gate` carries a standing approval over unmodified artifacts. */
export async function isApproved(run: Run, gate: GateId): Promise<boolean> {
  const decision = await latestDecision(run, gate);
  if (!decision || decision.decision !== "approve") return false;
  return (await staleArtifacts(run, decision)).length === 0;
}
