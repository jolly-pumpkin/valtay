import { resolve, dirname, relative, join } from "path";
import type { Wave } from "./plan-parser.ts";

export type ConflictKind = "shared-file" | "import-edge";

export interface FilesetConflict {
  kind: ConflictKind;
  from: string;   // unit id
  to: string;     // unit id
  file: string;   // the shared file, or the imported file declared by `to`
  via?: string;   // import-edge only: the file in `from` that imports `file`
}

const EXTENSIONS = [".ts", ".tsx", ".js", ".jsx"];
const INDEX_NAMES = EXTENSIONS.map((ext) => `index${ext}`);

async function resolveSpecifier(
  integrationRoot: string,
  fromFile: string,
  specifier: string,
): Promise<string | null> {
  const fromDir = dirname(resolve(integrationRoot, fromFile));
  const target = resolve(fromDir, specifier);
  const relTarget = relative(integrationRoot, target);

  // Exact match
  if (await Bun.file(target).exists()) {
    return relTarget;
  }

  // Try adding extensions
  for (const ext of EXTENSIONS) {
    const withExt = target + ext;
    if (await Bun.file(withExt).exists()) {
      return relative(integrationRoot, withExt);
    }
  }

  // Try as directory with index.*
  for (const idx of INDEX_NAMES) {
    const indexPath = join(target, idx);
    if (await Bun.file(indexPath).exists()) {
      return relative(integrationRoot, indexPath);
    }
  }

  return null;
}

function extractRelativeSpecifiers(source: string): string[] {
  const specifiers: string[] = [];
  const re = /(?:from|import|require)\s*\(\s*['"]([^'"]+)['"]\s*\)|from\s+['"]([^'"]+)['"]/g;
  let match: RegExpExecArray | null;
  while ((match = re.exec(source)) !== null) {
    const spec = match[1] ?? match[2];
    if (spec && (spec.startsWith("./") || spec.startsWith("../"))) {
      specifiers.push(spec);
    }
  }
  return specifiers;
}

// file -> repo-relative files it imports. Relative specifiers only ("./", "../").
// Resolves .ts/.tsx/.js/.jsx and <dir>/index.*. Ignores bare package imports.
// Built from files that exist in the integration worktree
// (worktreePath(runName, "integration")), so wave 2 sees files wave 1 merged
// and the user's dirty working copy never leaks in.
export async function importGraph(
  integrationRoot: string,
  files: string[],
): Promise<Map<string, Set<string>>> {
  const graph = new Map<string, Set<string>>();

  for (const file of files) {
    const absPath = resolve(integrationRoot, file);
    const bunFile = Bun.file(absPath);

    if (!(await bunFile.exists())) {
      graph.set(file, new Set());
      continue;
    }

    const source = await bunFile.text();
    const specifiers = extractRelativeSpecifiers(source);
    const imports = new Set<string>();

    for (const spec of specifiers) {
      const resolved = await resolveSpecifier(integrationRoot, file, spec);
      if (resolved !== null) {
        imports.add(resolved);
      }
    }

    graph.set(file, imports);
  }

  return graph;
}

// shared-file: a file declared by two units in the wave.
// import-edge: a file in unit A's set imports a file in unit B's set, or vice
//              versa. Each edge is reported once regardless of direction.
export function waveConflicts(
  wave: Wave,
  graph: Map<string, Set<string>>,
): FilesetConflict[] {
  const conflicts: FilesetConflict[] = [];

  // Build file -> unit-id ownership map
  const fileOwner = new Map<string, string>();

  // Detect shared-file conflicts
  for (const unit of wave.units) {
    for (const file of unit.files) {
      const existing = fileOwner.get(file);
      if (existing !== undefined) {
        conflicts.push({
          kind: "shared-file",
          from: existing,
          to: unit.id,
          file,
        });
      } else {
        fileOwner.set(file, unit.id);
      }
    }
  }

  // Detect import-edge conflicts
  const seenEdges = new Set<string>();

  for (const unit of wave.units) {
    for (const file of unit.files) {
      const imports = graph.get(file);
      if (!imports) continue;

      for (const imported of imports) {
        const importedOwner = fileOwner.get(imported);
        if (importedOwner !== undefined && importedOwner !== unit.id) {
          // Deduplicate: each edge reported once regardless of direction
          const edgeKey = [unit.id, importedOwner].sort().join(":") + ":" + [file, imported].sort().join(":");
          if (!seenEdges.has(edgeKey)) {
            seenEdges.add(edgeKey);
            conflicts.push({
              kind: "import-edge",
              from: unit.id,
              to: importedOwner,
              file: imported,
              via: file,
            });
          }
        }
      }
    }
  }

  return conflicts;
}

// Human-readable conflict descriptions.
// e.g. "RU-1 src/run/runner.ts imports src/run/store.ts declared by RU-2 in
//       the same wave — declare a dependency or merge the units"
export function formatConflicts(conflicts: FilesetConflict[]): string[] {
  return conflicts.map((c) => {
    if (c.kind === "shared-file") {
      return `${c.from} and ${c.to} both declare ${c.file} in the same wave — merge the units or split the file`;
    }
    return `${c.from} ${c.via} imports ${c.file} declared by ${c.to} in the same wave — declare a dependency or merge the units`;
  });
}
