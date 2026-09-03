import { resolve } from "path";
import { rm } from "node:fs/promises";
import { valtayHome } from "./config.ts";
import { pathExists } from "./detect.ts";

export interface GitResult {
  ok: boolean;
  stdout: string;
  stderr: string;
}

export async function git(repoRoot: string, args: string[]): Promise<GitResult> {
  const proc = Bun.spawn(["git", ...args], {
    cwd: repoRoot,
    stdout: "pipe",
    stderr: "pipe",
  });

  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);

  return { ok: exitCode === 0, stdout: stdout.trim(), stderr: stderr.trim() };
}

/** Where a run's worktrees live — outside the repo, so they cannot be committed. */
export function worktreePath(runName: string, label: string): string {
  return resolve(valtayHome(), "wt", `${runName}-${label}`);
}

/**
 * A fresh worktree on a new branch off `ref`.
 *
 * The worktree is the write fence for the phases that need one: a builder cannot
 * touch the checkout you are working in, and the probe's revert is `remove` rather
 * than an undo of edits already made.
 */
export async function createWorktree(
  repoRoot: string,
  path: string,
  branch: string,
  ref = "HEAD"
): Promise<void> {
  if (await pathExists(path)) await removeWorktree(repoRoot, path);

  // -B so a re-entered phase reuses the branch name rather than failing on it.
  const result = await git(repoRoot, ["worktree", "add", "--quiet", "-B", branch, path, ref]);
  if (!result.ok) throw new Error(`Could not create worktree at ${path}: ${result.stderr}`);
}

/**
 * Discards a worktree and everything in it.
 *
 * This is the probe's revert (design.md §10.1), and it is what makes the probe a
 * falsifier rather than a draft — there is no code left to be tempted by, only the
 * trace and the deviations it produced.
 */
export async function removeWorktree(repoRoot: string, path: string): Promise<void> {
  await git(repoRoot, ["worktree", "remove", "--force", path]);

  // `worktree remove` refuses a directory it does not know about, which happens when
  // a previous run died between mkdir and registration. Clear it either way.
  if (await pathExists(path)) await rm(path, { recursive: true, force: true });
  await git(repoRoot, ["worktree", "prune"]);
}

/** The diff a write phase produced, for the reviewer and for the record. */
export async function worktreeDiff(path: string): Promise<string> {
  await git(path, ["add", "-A"]);
  return (await git(path, ["diff", "--cached"])).stdout;
}
