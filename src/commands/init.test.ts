import { test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtemp, mkdir, rm, readFile, writeFile, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve, join } from "node:path";
import { runInit } from "./init.ts";

let root: string;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "valtay-init-"));
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

/** A directory that looks like a git repo to `init` (a `.git` dir is enough). */
async function makeRepo(...segments: string[]): Promise<string> {
  const dir = resolve(root, ...segments);
  await mkdir(resolve(dir, ".git"), { recursive: true });
  return dir;
}

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

test("repo mode writes valtay.toml and a blank .valtay/.gitignore", async () => {
  const repo = await makeRepo("repo");

  const result = await runInit({ path: repo });

  expect(result.mode).toBe("repo");
  expect(result.root).toBe(repo);
  expect(result.config).toBe("written");
  expect(result.gitignore).toBe("written");

  const toml = Bun.TOML.parse(await readFile(resolve(repo, "valtay.toml"), "utf-8")) as any;
  expect(toml.roles.default).toBeDefined();
  expect(toml.trace).toBeDefined();
  expect(toml.layers).toBeDefined();
  expect(toml.workspace).toBeUndefined();

  const ignore = await readFile(resolve(repo, ".valtay", ".gitignore"), "utf-8");
  expect(ignore).toBe("");
});

test("repo mode never creates or edits the repo's own .gitignore", async () => {
  const repo = await makeRepo("repo");
  await writeFile(resolve(repo, ".gitignore"), "node_modules/\n");

  await runInit({ path: repo });

  expect(await readFile(resolve(repo, ".gitignore"), "utf-8")).toBe("node_modules/\n");

  const bare = await makeRepo("bare");
  await runInit({ path: bare });
  expect(await exists(resolve(bare, ".gitignore"))).toBe(false);
});

test("repo mode resolves up to the repo root from a subdirectory", async () => {
  const repo = await makeRepo("repo");
  const nested = resolve(repo, "src", "deep");
  await mkdir(nested, { recursive: true });

  const result = await runInit({ path: nested });

  expect(result.root).toBe(repo);
  expect(await exists(resolve(repo, "valtay.toml"))).toBe(true);
  expect(await exists(resolve(nested, "valtay.toml"))).toBe(false);
});

test("a .git file counts as a repo, as in worktrees and submodules", async () => {
  const repo = resolve(root, "worktree");
  await mkdir(repo, { recursive: true });
  await writeFile(resolve(repo, ".git"), "gitdir: /elsewhere/.git/worktrees/wt\n");

  const result = await runInit({ path: repo });

  expect(result.mode).toBe("repo");
  expect(result.root).toBe(repo);
});

test("workspace mode records the child repos and omits per-repo tables", async () => {
  const ws = resolve(root, "work");
  await mkdir(ws, { recursive: true });
  await makeRepo("work", "web");
  await makeRepo("work", "api");
  await mkdir(resolve(ws, "notes"), { recursive: true }); // not a repo

  const result = await runInit({ path: ws });

  expect(result.mode).toBe("workspace");
  expect(result.root).toBe(ws);
  expect(result.repos).toEqual(["api", "web"]);

  const toml = Bun.TOML.parse(await readFile(resolve(ws, "valtay.toml"), "utf-8")) as any;
  expect(toml.workspace.repos).toEqual(["api", "web"]);
  expect(toml.trace).toBeUndefined();
  expect(toml.layers).toBeUndefined();

  expect(await readFile(resolve(ws, ".valtay", ".gitignore"), "utf-8")).toBe("");
  // Child repos are left alone — you init each one separately.
  expect(await exists(resolve(ws, "web", "valtay.toml"))).toBe(false);
});

test("workspace mode handles a directory with no repos in it", async () => {
  const ws = resolve(root, "empty");
  await mkdir(ws, { recursive: true });

  const result = await runInit({ path: ws });

  expect(result.mode).toBe("workspace");
  expect(result.repos).toEqual([]);
  expect(await readFile(resolve(ws, "valtay.toml"), "utf-8")).toContain("repos = []");
});

test("--workspace overrides detection for a repo that also holds repos", async () => {
  const parent = await makeRepo("mono");
  await makeRepo("mono", "pkg-a");

  const result = await runInit({ path: parent, workspace: true });

  expect(result.mode).toBe("workspace");
  expect(result.repos).toEqual(["pkg-a"]);
});

test("--repo treats a directory without .git as a repo root", async () => {
  const dir = resolve(root, "plain");
  await mkdir(dir, { recursive: true });

  const result = await runInit({ path: dir, repo: true });

  expect(result.mode).toBe("repo");
  expect(result.root).toBe(dir);
  expect(await readFile(resolve(dir, "valtay.toml"), "utf-8")).toContain("[trace]");
});

test("--repo and --workspace together are rejected", async () => {
  const repo = await makeRepo("repo");
  expect(runInit({ path: repo, repo: true, workspace: true })).rejects.toThrow(
    "mutually exclusive"
  );
});

test("a missing target directory is rejected", async () => {
  expect(runInit({ path: resolve(root, "nope") })).rejects.toThrow("No such directory");
});

test("re-running leaves an existing valtay.toml alone unless --force", async () => {
  const repo = await makeRepo("repo");
  await runInit({ path: repo });
  await writeFile(resolve(repo, "valtay.toml"), "# hand-edited\n");

  const second = await runInit({ path: repo });
  expect(second.config).toBe("skipped");
  expect(second.gitignore).toBe("skipped");
  expect(await readFile(resolve(repo, "valtay.toml"), "utf-8")).toBe("# hand-edited\n");

  const forced = await runInit({ path: repo, force: true });
  expect(forced.config).toBe("written");
  expect(await readFile(resolve(repo, "valtay.toml"), "utf-8")).toContain("[roles.default]");
});

test("--force never clobbers a filled-in .valtay/.gitignore", async () => {
  const repo = await makeRepo("repo");
  await runInit({ path: repo });
  await writeFile(resolve(repo, ".valtay", ".gitignore"), "runs/\n");

  const forced = await runInit({ path: repo, force: true });

  expect(forced.gitignore).toBe("skipped");
  expect(await readFile(resolve(repo, ".valtay", ".gitignore"), "utf-8")).toBe("runs/\n");
});

test("hosts are pre-filled from detected agent config", async () => {
  const repo = await makeRepo("repo");
  await mkdir(resolve(repo, ".codex"), { recursive: true });

  const result = await runInit({ path: repo });

  expect(result.hosts.map((h) => h.name)).toEqual(["codex"]);
  const toml = await readFile(resolve(repo, "valtay.toml"), "utf-8");
  expect(toml).toContain("[hosts.codex]");
  expect(toml).toContain('host = "codex"');
});

test("workspace hosts union across the child repos", async () => {
  const ws = resolve(root, "work");
  await mkdir(ws, { recursive: true });
  const a = await makeRepo("work", "a");
  const b = await makeRepo("work", "b");
  await mkdir(resolve(a, ".claude"), { recursive: true });
  await mkdir(resolve(b, ".codex"), { recursive: true });

  const result = await runInit({ path: ws });

  expect(result.hosts.map((h) => h.name).sort()).toEqual(["claude-code", "codex"]);
});

test("with no agent config detected, the default host is emitted", async () => {
  const repo = await makeRepo("repo");

  const result = await runInit({ path: repo });

  expect(result.hosts.map((h) => h.name)).toEqual(["claude-code"]);
  expect(await readFile(resolve(repo, "valtay.toml"), "utf-8")).toContain("[hosts.claude-code]");
});

test("the generated config is valid TOML in both modes", async () => {
  const repo = await makeRepo("repo");
  await runInit({ path: repo });
  const repoToml = Bun.TOML.parse(await readFile(resolve(repo, "valtay.toml"), "utf-8")) as any;
  expect(repoToml.roles.default.host).toBe("claude-code");
  expect(repoToml.hosts["claude-code"].bin).toBe("claude");
  expect(repoToml.trace.tier).toBe("agent");
  expect(repoToml.layers).toEqual({});

  const ws = resolve(root, "work");
  await mkdir(ws, { recursive: true });
  await makeRepo("work", "web");
  await runInit({ path: ws });
  const wsToml = Bun.TOML.parse(await readFile(resolve(ws, "valtay.toml"), "utf-8")) as any;
  expect(wsToml.workspace.repos).toEqual(["web"]);
});

test("repo names needing escapes stay valid TOML", async () => {
  const ws = resolve(root, "work");
  await mkdir(ws, { recursive: true });
  await makeRepo("work", 'odd"name');

  await runInit({ path: ws });

  const parsed = Bun.TOML.parse(await readFile(resolve(ws, "valtay.toml"), "utf-8")) as any;
  expect(parsed.workspace.repos).toEqual(['odd"name']);
});
