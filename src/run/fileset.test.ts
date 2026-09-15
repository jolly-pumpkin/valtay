import { test, expect, describe, beforeEach, afterEach } from "bun:test";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve, join } from "node:path";
import { importGraph, waveConflicts, formatConflicts } from "./fileset.ts";
import type { FilesetConflict } from "./fileset.ts";
import type { Wave } from "./plan-parser.ts";

let root: string;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "valtay-fileset-"));
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

describe("importGraph", () => {
  test("resolves relative imports with extension", async () => {
    await mkdir(resolve(root, "src"), { recursive: true });
    await Bun.write(resolve(root, "src/a.ts"), `import { foo } from "./b.ts";\n`);
    await Bun.write(resolve(root, "src/b.ts"), `export const foo = 1;\n`);

    const graph = await importGraph(root, ["src/a.ts", "src/b.ts"]);
    expect(graph.get("src/a.ts")).toEqual(new Set(["src/b.ts"]));
    expect(graph.get("src/b.ts")).toEqual(new Set());
  });

  test("resolves imports without extension (.ts)", async () => {
    await mkdir(resolve(root, "src"), { recursive: true });
    await Bun.write(resolve(root, "src/a.ts"), `import { foo } from "./b";\n`);
    await Bun.write(resolve(root, "src/b.ts"), `export const foo = 1;\n`);

    const graph = await importGraph(root, ["src/a.ts"]);
    expect(graph.get("src/a.ts")).toEqual(new Set(["src/b.ts"]));
  });

  test("resolves imports without extension (.tsx)", async () => {
    await mkdir(resolve(root, "src"), { recursive: true });
    await Bun.write(resolve(root, "src/a.ts"), `import { Comp } from "./comp";\n`);
    await Bun.write(resolve(root, "src/comp.tsx"), `export const Comp = () => null;\n`);

    const graph = await importGraph(root, ["src/a.ts"]);
    expect(graph.get("src/a.ts")).toEqual(new Set(["src/comp.tsx"]));
  });

  test("resolves directory index imports", async () => {
    await mkdir(resolve(root, "src/utils"), { recursive: true });
    await Bun.write(resolve(root, "src/a.ts"), `import { helper } from "./utils";\n`);
    await Bun.write(resolve(root, "src/utils/index.ts"), `export const helper = 1;\n`);

    const graph = await importGraph(root, ["src/a.ts"]);
    expect(graph.get("src/a.ts")).toEqual(new Set(["src/utils/index.ts"]));
  });

  test("resolves parent-relative imports", async () => {
    await mkdir(resolve(root, "src/sub"), { recursive: true });
    await Bun.write(resolve(root, "src/sub/child.ts"), `import { root } from "../root";\n`);
    await Bun.write(resolve(root, "src/root.ts"), `export const root = 1;\n`);

    const graph = await importGraph(root, ["src/sub/child.ts"]);
    expect(graph.get("src/sub/child.ts")).toEqual(new Set(["src/root.ts"]));
  });

  test("ignores bare package imports", async () => {
    await mkdir(resolve(root, "src"), { recursive: true });
    await Bun.write(
      resolve(root, "src/a.ts"),
      `import { resolve } from "path";\nimport fs from "node:fs";\nimport { foo } from "./b";\n`,
    );
    await Bun.write(resolve(root, "src/b.ts"), `export const foo = 1;\n`);

    const graph = await importGraph(root, ["src/a.ts"]);
    expect(graph.get("src/a.ts")).toEqual(new Set(["src/b.ts"]));
  });

  test("handles non-existent files gracefully", async () => {
    const graph = await importGraph(root, ["src/missing.ts"]);
    expect(graph.get("src/missing.ts")).toEqual(new Set());
  });

  test("handles unresolvable specifiers", async () => {
    await mkdir(resolve(root, "src"), { recursive: true });
    await Bun.write(resolve(root, "src/a.ts"), `import { x } from "./no-such-file";\n`);

    const graph = await importGraph(root, ["src/a.ts"]);
    expect(graph.get("src/a.ts")).toEqual(new Set());
  });

  test("handles re-exports (export from)", async () => {
    await mkdir(resolve(root, "src"), { recursive: true });
    await Bun.write(resolve(root, "src/a.ts"), `export { foo } from "./b";\n`);
    await Bun.write(resolve(root, "src/b.ts"), `export const foo = 1;\n`);

    const graph = await importGraph(root, ["src/a.ts"]);
    expect(graph.get("src/a.ts")).toEqual(new Set(["src/b.ts"]));
  });
});

describe("waveConflicts", () => {
  test("detects shared-file conflict", () => {
    const wave: Wave = {
      units: [
        { id: "RU-1", briefPath: "briefs/RU-1.md", deps: [], files: ["src/shared.ts", "src/a.ts"] },
        { id: "RU-2", briefPath: "briefs/RU-2.md", deps: [], files: ["src/shared.ts", "src/b.ts"] },
      ],
    };
    const graph = new Map<string, Set<string>>();

    const conflicts = waveConflicts(wave, graph);
    expect(conflicts).toHaveLength(1);
    expect(conflicts[0]).toEqual({
      kind: "shared-file",
      from: "RU-1",
      to: "RU-2",
      file: "src/shared.ts",
    });
  });

  test("detects import-edge conflict", () => {
    const wave: Wave = {
      units: [
        { id: "RU-1", briefPath: "briefs/RU-1.md", deps: [], files: ["src/a.ts"] },
        { id: "RU-2", briefPath: "briefs/RU-2.md", deps: [], files: ["src/b.ts"] },
      ],
    };
    // a.ts imports b.ts
    const graph = new Map<string, Set<string>>([
      ["src/a.ts", new Set(["src/b.ts"])],
      ["src/b.ts", new Set()],
    ]);

    const conflicts = waveConflicts(wave, graph);
    expect(conflicts).toHaveLength(1);
    expect(conflicts[0]).toEqual({
      kind: "import-edge",
      from: "RU-1",
      to: "RU-2",
      file: "src/b.ts",
      via: "src/a.ts",
    });
  });

  test("detects import-edge in reverse direction", () => {
    const wave: Wave = {
      units: [
        { id: "RU-1", briefPath: "briefs/RU-1.md", deps: [], files: ["src/a.ts"] },
        { id: "RU-2", briefPath: "briefs/RU-2.md", deps: [], files: ["src/b.ts"] },
      ],
    };
    // b.ts imports a.ts
    const graph = new Map<string, Set<string>>([
      ["src/a.ts", new Set()],
      ["src/b.ts", new Set(["src/a.ts"])],
    ]);

    const conflicts = waveConflicts(wave, graph);
    expect(conflicts).toHaveLength(1);
    expect(conflicts[0]!.kind).toBe("import-edge");
    expect(conflicts[0]!.from).toBe("RU-2");
    expect(conflicts[0]!.to).toBe("RU-1");
    expect(conflicts[0]!.file).toBe("src/a.ts");
    expect(conflicts[0]!.via).toBe("src/b.ts");
  });

  test("reports bidirectional import-edge only once", () => {
    const wave: Wave = {
      units: [
        { id: "RU-1", briefPath: "briefs/RU-1.md", deps: [], files: ["src/a.ts"] },
        { id: "RU-2", briefPath: "briefs/RU-2.md", deps: [], files: ["src/b.ts"] },
      ],
    };
    // Both import each other
    const graph = new Map<string, Set<string>>([
      ["src/a.ts", new Set(["src/b.ts"])],
      ["src/b.ts", new Set(["src/a.ts"])],
    ]);

    const conflicts = waveConflicts(wave, graph);
    const importEdges = conflicts.filter((c) => c.kind === "import-edge");
    expect(importEdges).toHaveLength(1);
  });

  test("no conflicts when units are independent", () => {
    const wave: Wave = {
      units: [
        { id: "RU-1", briefPath: "briefs/RU-1.md", deps: [], files: ["src/a.ts"] },
        { id: "RU-2", briefPath: "briefs/RU-2.md", deps: [], files: ["src/b.ts"] },
      ],
    };
    const graph = new Map<string, Set<string>>([
      ["src/a.ts", new Set()],
      ["src/b.ts", new Set()],
    ]);

    const conflicts = waveConflicts(wave, graph);
    expect(conflicts).toHaveLength(0);
  });

  test("import to file outside wave is not a conflict", () => {
    const wave: Wave = {
      units: [
        { id: "RU-1", briefPath: "briefs/RU-1.md", deps: [], files: ["src/a.ts"] },
      ],
    };
    // a.ts imports something not owned by any unit in the wave
    const graph = new Map<string, Set<string>>([
      ["src/a.ts", new Set(["src/external.ts"])],
    ]);

    const conflicts = waveConflicts(wave, graph);
    expect(conflicts).toHaveLength(0);
  });
});

describe("formatConflicts", () => {
  test("formats shared-file conflict", () => {
    const conflicts: FilesetConflict[] = [
      { kind: "shared-file", from: "RU-1", to: "RU-2", file: "src/shared.ts" },
    ];

    const messages = formatConflicts(conflicts);
    expect(messages).toHaveLength(1);
    expect(messages[0]).toContain("RU-1");
    expect(messages[0]).toContain("RU-2");
    expect(messages[0]).toContain("src/shared.ts");
    expect(messages[0]).toContain("same wave");
  });

  test("formats import-edge conflict", () => {
    const conflicts: FilesetConflict[] = [
      { kind: "import-edge", from: "RU-1", to: "RU-2", file: "src/b.ts", via: "src/a.ts" },
    ];

    const messages = formatConflicts(conflicts);
    expect(messages).toHaveLength(1);
    expect(messages[0]).toContain("RU-1");
    expect(messages[0]).toContain("src/a.ts");
    expect(messages[0]).toContain("imports");
    expect(messages[0]).toContain("src/b.ts");
    expect(messages[0]).toContain("RU-2");
    expect(messages[0]).toContain("same wave");
  });

  test("formats multiple conflicts", () => {
    const conflicts: FilesetConflict[] = [
      { kind: "shared-file", from: "RU-1", to: "RU-2", file: "src/shared.ts" },
      { kind: "import-edge", from: "RU-1", to: "RU-3", file: "src/c.ts", via: "src/a.ts" },
    ];

    const messages = formatConflicts(conflicts);
    expect(messages).toHaveLength(2);
  });
});
