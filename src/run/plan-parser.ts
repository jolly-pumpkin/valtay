import { resolve } from "path";
import { readdir } from "node:fs/promises";
import type { Run, LayerReport, LayerStatus } from "./store.ts";

export interface PlanUnit {
  id: string;
  briefPath: string;
  deps: string[];
  files: string[];
  checkpoint?: string;
}

export interface Wave {
  units: PlanUnit[];
}

/**
 * Read all brief files from a run's `briefs/` directory and parse each one
 * into a PlanUnit with its dependency list extracted from the `## Dependencies` section.
 * Also reads plan.md to fill `checkpoint` from each unit's heading section.
 */
export async function parsePlanUnits(run: Run): Promise<PlanUnit[]> {
  const briefsDir = resolve(run.dir, "briefs");
  const entries = await readdir(briefsDir);
  const mdFiles = entries.filter((f) => f.endsWith(".md")).sort();

  // Parse checkpoints from plan.md if it exists
  const checkpoints = await extractCheckpoints(run.dir);

  const units: PlanUnit[] = [];

  for (const filename of mdFiles) {
    const id = filename.replace(/\.md$/, "");
    const briefPath = `briefs/${filename}`;
    const content = await Bun.file(resolve(briefsDir, filename)).text();

    const deps = extractDeps(id, content);
    const files = extractFiles(content);
    const checkpoint = checkpoints.get(id);
    units.push({ id, briefPath, deps, files, ...(checkpoint !== undefined && { checkpoint }) });
  }

  return units.sort((a, b) => {
    const numA = parseInt(a.id.replace(/^RU-/, ""), 10);
    const numB = parseInt(b.id.replace(/^RU-/, ""), 10);
    return numA - numB;
  });
}

/**
 * Parse `**Checkpoint:** \`<cmd>\`` lines from plan.md, keyed by the
 * `## RU-N` heading they appear under.
 */
async function extractCheckpoints(runDirPath: string): Promise<Map<string, string>> {
  const planPath = resolve(runDirPath, "plan.md");
  const planFile = Bun.file(planPath);
  const map = new Map<string, string>();

  if (!(await planFile.exists())) return map;

  const content = await planFile.text();
  const lines = content.split("\n");
  let currentUnit: string | null = null;

  for (const line of lines) {
    const unitMatch = line.match(/^## (RU-\d+)/);
    if (unitMatch) {
      currentUnit = unitMatch[1]!;
      continue;
    }
    // A layer heading (### L1) ends the unit's preamble
    if (/^### /.test(line)) {
      currentUnit = null;
      continue;
    }
    if (currentUnit) {
      const cpMatch = line.match(/\*\*Checkpoint:\*\*\s*`([^`]+)`/);
      if (cpMatch) {
        map.set(currentUnit, cpMatch[1]!);
      }
    }
  }

  return map;
}

function extractDeps(selfId: string, content: string): string[] {
  const lines = content.split("\n");
  let inSection = false;
  const sectionLines: string[] = [];

  for (const line of lines) {
    if (/^## Dependencies/i.test(line)) {
      inSection = true;
      continue;
    }
    if (inSection && /^## /.test(line)) {
      break;
    }
    if (inSection) {
      sectionLines.push(line);
    }
  }

  const sectionText = sectionLines.join("\n").trim();
  // "None", "None — independent of RU-1", "None. Uses RU-2's types." all mean none:
  // a planner explaining why there are no dependencies must not create one.
  if (!sectionText || /^none\b/i.test(sectionText)) {
    return [];
  }

  const matches = sectionText.match(/RU-\d+/g) ?? [];
  const unique = [...new Set(matches)].filter((id) => id !== selfId);
  return unique.sort((a, b) => {
    const numA = parseInt(a.replace(/^RU-/, ""), 10);
    const numB = parseInt(b.replace(/^RU-/, ""), 10);
    return numA - numB;
  });
}

/**
 * Extract the union of files from all `- **Files:** \`a\`, \`b\`` lines in the
 * brief's ## Layers section. Returns deduped, sorted, repo-relative paths.
 */
function extractFiles(content: string): string[] {
  const lines = content.split("\n");
  let inLayers = false;
  const files = new Set<string>();

  for (const line of lines) {
    if (/^## Layers/i.test(line)) {
      inLayers = true;
      continue;
    }
    if (inLayers && /^## /.test(line)) break;
    if (inLayers) {
      const match = line.match(/\*\*Files:\*\*\s*(.+)/);
      if (match) {
        const backtickPaths = match[1]!.match(/`([^`]+)`/g);
        if (backtickPaths) {
          for (const p of backtickPaths) files.add(p.replace(/`/g, ""));
        }
      }
    }
  }

  return [...files].sort();
}

/**
 * Topologically sort plan units into waves using Kahn's algorithm.
 * Each wave contains units whose dependencies are all satisfied by earlier waves.
 * Throws if a dependency cycle is detected.
 */
export function topoSortWaves(units: PlanUnit[]): Wave[] {
  const byId = new Map(units.map((u) => [u.id, u]));
  const placed = new Set<string>();
  const remaining = new Set(units.map((u) => u.id));
  const waves: Wave[] = [];

  // A dependency on a unit that is not in this set was satisfied earlier — the
  // retry loop re-sorts only the units still pending, and their finished
  // prerequisites are no longer in the list.
  const satisfied = (d: string) => placed.has(d) || !byId.has(d);

  while (remaining.size > 0) {
    const ready: PlanUnit[] = [];
    for (const id of remaining) {
      const unit = byId.get(id)!;
      if (unit.deps.every(satisfied)) {
        ready.push(unit);
      }
    }

    if (ready.length === 0) {
      throw new Error(`Dependency cycle among ${[...remaining].join(", ")}`);
    }

    for (const unit of ready) {
      placed.add(unit.id);
      remaining.delete(unit.id);
    }
    waves.push({ units: ready });
  }

  return waves;
}

/**
 * Parse a build report markdown file into an array of LayerReport entries.
 * Reports contain `## L1`, `## L2` etc. sections with **Status:**, **Reason:**,
 * and **Files touched:** fields.
 */
export function parseReport(unitId: string, content: string): LayerReport[] {
  const reports: LayerReport[] = [];
  const headerRe = /^## (L\d+)/m;
  const lines = content.split("\n");

  let currentLayer: string | null = null;
  let sectionLines: string[] = [];

  function flush() {
    if (currentLayer === null) return;
    const text = sectionLines.join("\n");

    const statusMatch = text.match(/\*\*Status:\*\*\s*(\w+)/);
    const status = (statusMatch?.[1]?.toLowerCase() ?? "pending") as LayerStatus;

    const reasonMatch = text.match(/\*\*Reason:\*\*\s*(.+)/);
    const reason = reasonMatch?.[1]?.trim();

    const filesMatch = text.match(/\*\*Files touched:\*\*\s*(.+)/);
    let files: string[] | undefined;
    if (filesMatch) {
      const backtickPaths = filesMatch[1]!.match(/`([^`]+)`/g);
      if (backtickPaths && backtickPaths.length > 0) {
        files = backtickPaths.map((p) => p.replace(/`/g, ""));
      }
    }

    const report: LayerReport = { unit: unitId, layer: currentLayer, status };
    if (reason) report.reason = reason;
    if (files) report.files = files;
    reports.push(report);
  }

  for (const line of lines) {
    const match = line.match(headerRe);
    if (match) {
      flush();
      currentLayer = match[1]!;
      sectionLines = [];
    } else {
      sectionLines.push(line);
    }
  }
  flush();

  return reports;
}
