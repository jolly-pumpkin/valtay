import { resolve } from "path";
import { rm } from "node:fs/promises";
import { findRepoRoot, detectHosts } from "../detect.ts";
import { skillRootFor, upgradeSkills, type UpgradeReport } from "../skills.ts";
import { skillsDirsFor } from "./init.ts";

export interface UpgradeOptions {
  path?: string;
  /** Remove obsolete skill directories instead of just warning. */
  clean?: boolean;
}

export interface UpgradeResult {
  root: string;
  skillsDirs: string[];
  reports: UpgradeReport[];
  cleaned: string[];
}

export async function runUpgrade(options: UpgradeOptions = {}): Promise<UpgradeResult> {
  const target = resolve(options.path ?? ".");
  const root = await findRepoRoot(target);
  if (!root) throw new Error(`No git repository at or above ${target}`);

  const hosts = await detectHosts([root]);
  const skillsDirs = skillsDirsFor(root, hosts);

  const reports: UpgradeReport[] = [];
  for (const dir of skillsDirs) {
    reports.push(...(await upgradeSkills(dir)));
  }

  const cleaned: string[] = [];
  if (options.clean) {
    for (const r of reports.filter((r) => r.outcome === "obsolete")) {
      await rm(r.dir, { recursive: true, force: true });
      cleaned.push(r.name);
    }
  }

  return { root, skillsDirs, reports, cleaned };
}

export function formatUpgradeResult(result: UpgradeResult): string[] {
  const lines: string[] = [`Upgrade skills in ${result.root}`, ""];

  const added = result.reports.filter((r) => r.outcome === "added");
  const updated = result.reports.filter((r) => r.outcome === "updated");
  const skipped = result.reports.filter((r) => r.outcome === "skipped");
  const unchanged = result.reports.filter((r) => r.outcome === "unchanged");
  const obsolete = result.reports.filter((r) => r.outcome === "obsolete");

  for (const r of added) lines.push(`  added     ${r.name}`);
  for (const r of updated) lines.push(`  updated   ${r.name}`);
  for (const r of unchanged) lines.push(`  current   ${r.name}`);
  for (const r of skipped) lines.push(`  skipped   ${r.name} (hand-edited)`);

  for (const r of obsolete) {
    if (result.cleaned.includes(r.name)) {
      lines.push(`  removed   ${r.name}`);
    } else {
      lines.push(`  obsolete  ${r.name} — remove with --clean`);
    }
  }

  if (added.length === 0 && updated.length === 0 && obsolete.length === 0) {
    lines.push("  Everything is up to date.");
  }

  if (added.length > 0 || updated.length > 0 || result.cleaned.length > 0) {
    lines.push("");
    lines.push("Commit the skills directory — write phases run in worktrees and only see tracked files.");
  }

  return lines;
}
