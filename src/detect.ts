import { resolve } from "path";
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

const HOST_BY_MARKER: Record<Marker, HostSpec> = {
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
