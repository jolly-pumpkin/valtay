import { test, expect, describe, beforeEach, afterEach } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { createWorktree, removeWorktree, branchExists, git } from "./worktree.ts";

let repo: string;
let wt: string;

async function commitAll(dir: string, msg: string): Promise<string> {
  await git(dir, ["add", "-A"]);
  await git(dir, ["-c", "user.name=t", "-c", "user.email=t@t", "commit", "-qm", msg]);
  return (await git(dir, ["rev-parse", "HEAD"])).stdout;
}

beforeEach(async () => {
  repo = await mkdtemp(resolve(tmpdir(), "vt-wt-repo-"));
  wt = resolve(await mkdtemp(resolve(tmpdir(), "vt-wt-")), "w");
  await git(repo, ["init", "-q", "-b", "main"]);
  await writeFile(resolve(repo, "a.txt"), "a\n");
  await commitAll(repo, "init");
});

afterEach(async () => {
  await rm(repo, { recursive: true, force: true });
  await rm(resolve(wt, ".."), { recursive: true, force: true });
});

describe("createWorktree", () => {
  test("creates the branch from ref when it does not exist", async () => {
    await createWorktree(repo, wt, "valtay/x", "HEAD", { reuse: true });
    expect(await branchExists(repo, "valtay/x")).toBe(true);
    const main = (await git(repo, ["rev-parse", "main"])).stdout;
    expect((await git(wt, ["rev-parse", "HEAD"])).stdout).toBe(main);
  });

  test("with reuse, reopening an existing branch keeps its commits (re-entered run)", async () => {
    await createWorktree(repo, wt, "valtay/x", "HEAD");
    await writeFile(resolve(wt, "b.txt"), "b\n");
    const merged = await commitAll(wt, "wave 1 merged");
    await removeWorktree(repo, wt);

    await createWorktree(repo, wt, "valtay/x", "HEAD", { reuse: true });
    expect((await git(wt, ["rev-parse", "HEAD"])).stdout).toBe(merged);
  });

  test("without reuse, -B resets the branch to ref (rebuilt unit starts fresh)", async () => {
    await createWorktree(repo, wt, "valtay/x-RU-1", "HEAD");
    await writeFile(resolve(wt, "b.txt"), "b\n");
    await commitAll(wt, "half-built");
    await removeWorktree(repo, wt);

    await createWorktree(repo, wt, "valtay/x-RU-1", "HEAD");
    const main = (await git(repo, ["rev-parse", "main"])).stdout;
    expect((await git(wt, ["rev-parse", "HEAD"])).stdout).toBe(main);
  });
});
