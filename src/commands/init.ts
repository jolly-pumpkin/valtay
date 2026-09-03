import { resolve, dirname } from "path";
import { readdir } from "node:fs/promises";
import { detectHosts, pathExists, type HostSpec } from "../detect.ts";

export interface InitOptions {
  /** Target directory. Defaults to the process working directory. */
  path?: string;
  /** Overwrite an existing valtay.toml. Never touches .valtay/.gitignore. */
  force?: boolean;
  /** Force workspace mode even if the target sits inside a repo. */
  workspace?: boolean;
  /** Force repo mode, treating the target as a repo root if no .git is found. */
  repo?: boolean;
}

export type Mode = "repo" | "workspace";
export type Outcome = "written" | "skipped";

export interface InitResult {
  mode: Mode;
  /** Directory the files were written to — the repo root, or the workspace dir. */
  root: string;
  /** Child repo names, workspace mode only. */
  repos: string[];
  hosts: HostSpec[];
  configPath: string;
  config: Outcome;
  gitignorePath: string;
  gitignore: Outcome;
}

/**
 * Nearest ancestor of `start` (inclusive) holding a `.git` entry, or null.
 * `.git` is a file rather than a directory in worktrees and submodules, so the
 * check is deliberately type-agnostic.
 */
export async function findRepoRoot(start: string): Promise<string | null> {
  let dir = resolve(start);
  for (;;) {
    if (await pathExists(resolve(dir, ".git"))) return dir;
    const parent = dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

/** Immediate subdirectories of `dir` that are themselves repos, sorted. */
export async function findChildRepos(dir: string): Promise<string[]> {
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return [];
  }

  const candidates = entries
    .filter((e) => (e.isDirectory() || e.isSymbolicLink()) && !e.name.startsWith("."))
    .map((e) => e.name);

  const checked = await Promise.all(
    candidates.map(async (name) =>
      (await pathExists(resolve(dir, name, ".git"))) ? name : null
    )
  );

  return checked.filter((n): n is string => n !== null).sort();
}

function tomlString(value: string): string {
  return `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

function hostTables(hosts: HostSpec[]): string {
  return hosts
    .map((h) => `[hosts.${h.name}]\nbin = ${tomlString(h.bin)}\nadapter = ${tomlString(h.adapter)}`)
    .join("\n\n");
}

function rolesTable(hosts: HostSpec[]): string {
  return [
    "[roles.default]",
    `host = ${tomlString(hosts[0]!.name)}`,
    'model = "sonnet"',
    'effort = "medium"',
    'timeout = "10m"',
    "# TODO: per-role overrides — see docs/design.md §6.1",
  ].join("\n");
}

const PRECEDENCE =
  "# Precedence: runspec frontmatter -> ./valtay.toml -> ~/.valtay/config.toml -> built-in";

export function renderRepoConfig(hosts: HostSpec[]): string {
  return `# valtay.toml - repo config. See docs/design.md section 20.
${PRECEDENCE}

${hostTables(hosts)}

${rolesTable(hosts)}

[trace]
tier = "agent"  # TODO: runtime | static | agent
command = ""    # TODO: trace command, with a {scenario} placeholder

[layers]
# TODO: map path globs to layer names
# "src/ui/**" = "ui"
`;
}

export function renderWorkspaceConfig(hosts: HostSpec[], repos: string[]): string {
  const list =
    repos.length > 0
      ? `repos = [${repos.map(tomlString).join(", ")}]`
      : "repos = []  # TODO: no repos found in this directory";

  return `# valtay.toml - workspace config. See docs/design.md section 20.
${PRECEDENCE}
#
# This directory holds repos rather than being one. Settings that describe a
# single codebase - [trace], [layers] - belong in each repo's own valtay.toml.

[workspace]
${list}

${hostTables(hosts)}

${rolesTable(hosts)}
`;
}

/** Writes `content` to `path` unless it already exists (or `overwrite` is set). */
async function writeUnlessPresent(
  path: string,
  content: string,
  overwrite: boolean
): Promise<Outcome> {
  if (!overwrite && (await pathExists(path))) return "skipped";
  await Bun.write(path, content);
  return "written";
}

export async function runInit(options: InitOptions = {}): Promise<InitResult> {
  if (options.repo && options.workspace) {
    throw new Error("--repo and --workspace are mutually exclusive");
  }

  const target = resolve(options.path ?? ".");
  if (!(await pathExists(target))) {
    throw new Error(`No such directory: ${target}`);
  }

  const repoRoot = options.workspace ? null : await findRepoRoot(target);
  const mode: Mode = repoRoot || options.repo ? "repo" : "workspace";
  const root = repoRoot ?? target;

  const repos = mode === "workspace" ? await findChildRepos(root) : [];
  const hosts = await detectHosts([root, ...repos.map((r) => resolve(root, r))]);

  const configPath = resolve(root, "valtay.toml");
  const content =
    mode === "repo" ? renderRepoConfig(hosts) : renderWorkspaceConfig(hosts, repos);
  const config = await writeUnlessPresent(configPath, content, options.force === true);

  // Blank by design: it keeps .valtay/ present in git and gives you somewhere to
  // ignore run artifacts, without init ever editing the repo's own .gitignore.
  const gitignorePath = resolve(root, ".valtay", ".gitignore");
  const gitignore = await writeUnlessPresent(gitignorePath, "", false);

  return { mode, root, repos, hosts, configPath, config, gitignorePath, gitignore };
}

export function formatInitResult(result: InitResult): string[] {
  const lines: string[] = [];
  const label = result.mode === "repo" ? "repo" : "workspace";
  lines.push(`Initialized ${label} at ${result.root}`);

  const note = (outcome: Outcome, name: string) =>
    outcome === "written" ? `  wrote   ${name}` : `  skipped ${name} (already exists)`;

  lines.push(note(result.config, "valtay.toml"));
  lines.push(note(result.gitignore, ".valtay/.gitignore"));

  if (result.mode === "workspace") {
    lines.push(
      result.repos.length > 0
        ? `  found   ${result.repos.length} repo(s): ${result.repos.join(", ")}`
        : "  found   no repos in this directory"
    );
  }
  lines.push(`  hosts   ${result.hosts.map((h) => h.name).join(", ")}`);

  if (result.config === "skipped") {
    lines.push("Re-run with --force to overwrite valtay.toml.");
  }
  return lines;
}
