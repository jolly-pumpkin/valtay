import { test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtemp, mkdir, rm, readFile, writeFile, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve, join } from "node:path";
import { runInit, type InitResult } from "./init.ts";
import { COMPOSE_SKILL, phaseSkillName, shippedSkills, skillRelDir } from "../skills.ts";
import { PHASES } from "../run/phases.ts";

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

/** A repo that already carries Claude config, so the skill install is in scope. */
async function makeClaudeRepo(...segments: string[]): Promise<string> {
  const dir = await makeRepo(...segments);
  await mkdir(resolve(dir, ".claude"), { recursive: true });
  return dir;
}

/** A file inside one installed skill. */
const skillFile = (root: string, name: string, rel: string) =>
  resolve(root, skillRelDir(name), rel);

/** The compose skill, which is the one with reference files to check. */
const composeFile = (root: string, rel: string) =>
  skillFile(root, COMPOSE_SKILL.name, rel);

const outcomeOf = (result: InitResult, name: string) =>
  result.skills.find((s) => s.name === name)?.outcome;

test("every skill is installed into a repo that already has .claude/", async () => {
  const repo = await makeClaudeRepo("repo");

  const result = await runInit({ path: repo });

  expect(result.skillsDirs).toEqual([resolve(repo, ".claude", "skills")]);
  expect(result.skills.every((s) => s.outcome === "written")).toBe(true);

  for (const asset of COMPOSE_SKILL.files) {
    expect(await exists(composeFile(repo, asset.rel))).toBe(true);
  }

  const md = await readFile(composeFile(repo, "SKILL.md"), "utf-8");
  expect(md.startsWith("---\n")).toBe(true);
  expect(md).toContain(`name: ${COMPOSE_SKILL.name}`);
  expect(md).toContain("description:");
});

test("a phase skill lands where the host will look for it", async () => {
  const repo = await makeClaudeRepo("repo");

  const result = await runInit({ path: repo });

  // The adapter names `/valtay-research`; Claude Code resolves that against
  // `<workdir>/.claude/skills/`. These two have to agree or the phase runs
  // uninstructed.
  for (const def of PHASES) {
    const name = phaseSkillName(def.id);
    expect(outcomeOf(result, name)).toBe("written");

    const md = await readFile(skillFile(repo, name, "SKILL.md"), "utf-8");
    expect(md).toContain(`name: ${name}`);
  }
});

test("a codex-only project gets its skills where codex looks, and no .claude/", async () => {
  // Before the codex adapter this installed nothing at all: the gate was the
  // `.claude/` marker, so a codex-bound phase reached a host that had never been
  // given its instructions.
  const repo = await makeRepo("repo");
  await mkdir(resolve(repo, ".codex"), { recursive: true });

  const result = await runInit({ path: repo });

  expect(result.skillsDirs).toEqual([resolve(repo, ".codex", "skills")]);
  expect(result.skills.every((s) => s.outcome === "written")).toBe(true);
  expect(await exists(resolve(repo, ".codex", "skills", COMPOSE_SKILL.name, "SKILL.md"))).toBe(true);
  expect(await exists(resolve(repo, ".claude"))).toBe(false);
});

test("with no agent config at all the skills are absent", async () => {
  const repo = await makeRepo("repo");

  const result = await runInit({ path: repo });

  expect(result.skills.every((s) => s.outcome === "absent")).toBe(true);
  expect(await exists(resolve(repo, ".claude"))).toBe(false);
});

test("a repo carrying both markers gets the skills in both roots", async () => {
  // The cross-vendor case invariant 9 needs: whichever host a role is bound to, the
  // phase is present where that host looks for it.
  const repo = await makeRepo("repo");
  await mkdir(resolve(repo, ".claude"), { recursive: true });
  await mkdir(resolve(repo, ".codex"), { recursive: true });

  const result = await runInit({ path: repo });

  expect(result.skillsDirs.sort()).toEqual(
    [resolve(repo, ".claude", "skills"), resolve(repo, ".codex", "skills")].sort()
  );

  for (const def of PHASES) {
    const name = phaseSkillName(def.id);
    expect(await exists(resolve(repo, skillRelDir(name, "claude-code"), "SKILL.md"))).toBe(true);
    expect(await exists(resolve(repo, skillRelDir(name, "codex"), "SKILL.md"))).toBe(true);
  }
});

test("--skill installs into a repo with no .claude/", async () => {
  const repo = await makeRepo("repo");

  const result = await runInit({ path: repo, skill: true });

  expect(outcomeOf(result, COMPOSE_SKILL.name)).toBe("written");
  expect(await exists(composeFile(repo, "SKILL.md"))).toBe(true);
  expect(await exists(skillFile(repo, phaseSkillName("research"), "SKILL.md"))).toBe(true);
});

test("re-running leaves a hand-edited skill alone unless --force", async () => {
  const repo = await makeClaudeRepo("repo");
  await runInit({ path: repo });
  await writeFile(composeFile(repo, "SKILL.md"), "# hand-edited\n");

  const second = await runInit({ path: repo });
  expect(second.skills.every((s) => s.outcome === "skipped")).toBe(true);
  expect(await readFile(composeFile(repo, "SKILL.md"), "utf-8")).toBe("# hand-edited\n");

  const forced = await runInit({ path: repo, force: true });
  expect(forced.skills.every((s) => s.outcome === "written")).toBe(true);
  expect(await readFile(composeFile(repo, "SKILL.md"), "utf-8")).toContain(
    `name: ${COMPOSE_SKILL.name}`
  );
});

test("a missing reference file is restored without touching a hand-edited SKILL.md", async () => {
  const repo = await makeClaudeRepo("repo");
  await runInit({ path: repo });
  await writeFile(composeFile(repo, "SKILL.md"), "# hand-edited\n");
  await rm(composeFile(repo, "reference/format.md"));

  const second = await runInit({ path: repo });

  expect(outcomeOf(second, COMPOSE_SKILL.name)).toBe("written");
  expect(await exists(composeFile(repo, "reference/format.md"))).toBe(true);
  expect(await readFile(composeFile(repo, "SKILL.md"), "utf-8")).toBe("# hand-edited\n");
});

test("workspace mode installs the skills at the workspace root", async () => {
  const ws = resolve(root, "work");
  await mkdir(resolve(ws, ".claude"), { recursive: true });
  const web = await makeRepo("work", "web");

  const result = await runInit({ path: ws });

  expect(result.mode).toBe("workspace");
  expect(outcomeOf(result, COMPOSE_SKILL.name)).toBe("written");
  expect(await exists(composeFile(ws, "SKILL.md"))).toBe(true);
  // Child repos are left alone — you init each one separately.
  expect(await exists(composeFile(web, "SKILL.md"))).toBe(false);
});

test("every phase in the pipeline ships a skill", async () => {
  const names = (await shippedSkills()).map((s) => s.name);

  // A phase added without one would otherwise fail at run time, in the middle of a
  // run, rather than here.
  for (const def of PHASES) {
    expect(names).toContain(phaseSkillName(def.id));
  }
});

test("every shipped skill asset resolves and carries skill frontmatter", async () => {
  const skills = await shippedSkills();
  expect(skills.length).toBeGreaterThan(PHASES.length);

  for (const skill of skills) {
    for (const asset of skill.files) {
      const file = Bun.file(asset.source);
      expect(await file.exists()).toBe(true);
      expect((await file.text()).trim().length).toBeGreaterThan(0);
    }

    const skillMd = skill.files.find((a) => a.rel === "SKILL.md");
    expect(skillMd).toBeDefined();

    const [, frontmatter] = (await Bun.file(skillMd!.source).text()).split("---\n");
    expect(frontmatter).toContain(`name: ${skill.name}`);
    expect(frontmatter).toContain("description:");
  }
});

test("phase skills never auto-invoke", async () => {
  // A phase is chosen by the orchestrator, never by a model deciding it looks
  // relevant — and these sit in the repo, so without this they would surface in the
  // developer's own sessions too.
  for (const def of PHASES) {
    const skill = (await shippedSkills()).find((s) => s.name === phaseSkillName(def.id));
    const text = await Bun.file(skill!.files[0]!.source).text();
    expect(text).toContain("disable-model-invocation: true");
  }
});

test("repo names needing escapes stay valid TOML", async () => {
  const ws = resolve(root, "work");
  await mkdir(ws, { recursive: true });
  await makeRepo("work", 'odd"name');

  await runInit({ path: ws });

  const parsed = Bun.TOML.parse(await readFile(resolve(ws, "valtay.toml"), "utf-8")) as any;
  expect(parsed.workspace.repos).toEqual(['odd"name']);
});
