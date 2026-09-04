import { resolve, dirname } from "path";
import { existsSync } from "fs";
import { stat } from "node:fs/promises";

/** Agent-config markers Valtay knows how to look for, in probe order. */
const MARKERS = [".claude/", "codex.json", ".codex/"] as const;

export type Marker = (typeof MARKERS)[number];

export interface HostSpec {
  name: string;
  bin: string;
  adapter: string;
}

/**
 * Exported so `skills.ts` can be checked against it: every adapter a repo can be
 * detected as ends up in `valtay.toml`, and one with no skill root is an init that
 * produces a config no phase can run under.
 */
export const HOST_BY_MARKER: Record<Marker, HostSpec> = {
  ".claude/": { name: "claude-code", bin: "claude", adapter: "claude-code" },
  "codex.json": { name: "codex", bin: "codex", adapter: "codex" },
  ".codex/": { name: "codex", bin: "codex", adapter: "codex" },
};

/** The host assumed when a directory carries no agent config at all. */
export const DEFAULT_HOST: HostSpec = HOST_BY_MARKER[".claude/"];

/** Agent-config markers present in `dir`, as literal path fragments. */
export function detectSkills(dir: string): Marker[] {
  return MARKERS.filter((m) => existsSync(resolve(dir, m.replace(/\/$/, ""))));
}

/** Async twin of `detectSkills`, for callers already in async code. */
export async function detectMarkers(dir: string): Promise<Marker[]> {
  const found = await Promise.all(
    MARKERS.map(async (m) => ((await pathExists(resolve(dir, m.replace(/\/$/, "")))) ? m : null))
  );
  return found.filter((m): m is Marker => m !== null);
}

/**
 * Hosts to pre-fill in valtay.toml, unioned across `dirs` and de-duplicated by
 * name. Falls back to `DEFAULT_HOST` when nothing is detected anywhere.
 */
export async function detectHosts(dirs: string[]): Promise<HostSpec[]> {
  const byName = new Map<string, HostSpec>();
  for (const dir of dirs) {
    for (const marker of await detectMarkers(dir)) {
      const host = HOST_BY_MARKER[marker];
      if (!byName.has(host.name)) byName.set(host.name, host);
    }
  }
  return byName.size > 0 ? [...byName.values()] : [DEFAULT_HOST];
}

/** True if `path` exists as anything — file, directory, or symlink target. */
export async function pathExists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
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
