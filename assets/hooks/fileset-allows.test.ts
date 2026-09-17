import { test, expect, describe, beforeEach, afterEach } from "bun:test";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { filesetAllows } from "./fileset-allows.ts";

let tmp: string;
let manifest: string;

beforeEach(async () => {
  tmp = await mkdtemp(join(tmpdir(), "valtay-fileset-allows-"));
  manifest = join(tmp, "fileset.txt");
});

afterEach(async () => {
  await rm(tmp, { recursive: true, force: true });
});

describe("filesetAllows", () => {
  test("allows absolute path that matches manifest entry exactly", async () => {
    await Bun.write(manifest, "/abs/path/reports/RU-1.md\nsrc/foo.ts\n");
    expect(await filesetAllows(manifest, "/abs/path/reports/RU-1.md")).toBe(true);
  });

  test("allows repo-relative path when projectDir is provided", async () => {
    await Bun.write(manifest, "src/foo.ts\n");
    expect(await filesetAllows(manifest, "/repo/src/foo.ts", "/repo")).toBe(true);
  });

  test("denies path not in manifest", async () => {
    await Bun.write(manifest, "src/foo.ts\n");
    expect(await filesetAllows(manifest, "/repo/src/bar.ts", "/repo")).toBe(false);
  });

  test("denies when no projectDir and path is not absolute match", async () => {
    await Bun.write(manifest, "src/foo.ts\n");
    expect(await filesetAllows(manifest, "/repo/src/foo.ts")).toBe(false);
  });

  test("handles projectDir with trailing slash", async () => {
    await Bun.write(manifest, "src/foo.ts\n");
    expect(await filesetAllows(manifest, "/repo/src/foo.ts", "/repo/")).toBe(true);
  });

  test("handles empty manifest", async () => {
    await Bun.write(manifest, "");
    expect(await filesetAllows(manifest, "/repo/src/foo.ts", "/repo")).toBe(false);
  });

  test("ignores blank lines in manifest", async () => {
    await Bun.write(manifest, "src/foo.ts\n\n\nsrc/bar.ts\n");
    expect(await filesetAllows(manifest, "/repo/src/foo.ts", "/repo")).toBe(true);
    expect(await filesetAllows(manifest, "/repo/src/bar.ts", "/repo")).toBe(true);
  });

  test("trims whitespace from manifest entries", async () => {
    await Bun.write(manifest, "  src/foo.ts  \n");
    expect(await filesetAllows(manifest, "/repo/src/foo.ts", "/repo")).toBe(true);
  });

  test("does not allow partial path matches", async () => {
    await Bun.write(manifest, "src/foo.ts\n");
    expect(await filesetAllows(manifest, "/repo/src/foo.tsx", "/repo")).toBe(false);
  });

  test("mixed absolute and relative entries", async () => {
    await Bun.write(manifest, "src/a.ts\n/run/reports/RU-1.md\n");
    expect(await filesetAllows(manifest, "/repo/src/a.ts", "/repo")).toBe(true);
    expect(await filesetAllows(manifest, "/run/reports/RU-1.md", "/repo")).toBe(true);
    expect(await filesetAllows(manifest, "/repo/src/b.ts", "/repo")).toBe(false);
  });
});

describe("fileset hook denial logging", () => {
  test("deny appends a line to denials.log", async () => {
    // Set up a run-dir-like structure: <tmp>/filesets/RU-1.txt and <tmp>/hooks/
    const filesetsDir = join(tmp, "filesets");
    const hooksDir = join(tmp, "hooks");
    await mkdir(filesetsDir, { recursive: true });
    await mkdir(hooksDir, { recursive: true });

    const filesetPath = join(filesetsDir, "RU-1.txt");
    await Bun.write(filesetPath, "src/allowed.ts\n");

    const hookScript = resolve(import.meta.dir, "fileset.ts");
    const event = JSON.stringify({
      tool_input: { file_path: "/repo/src/denied.ts" },
    });

    const proc = Bun.spawn(["bun", hookScript], {
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
      env: {
        ...process.env,
        VALTAY_FILESET: filesetPath,
        CLAUDE_PROJECT_DIR: "/repo",
      },
    });
    proc.stdin.write(event);
    proc.stdin.end();
    await proc.exited;

    const denialsPath = join(hooksDir, "denials.log");
    const exists = await Bun.file(denialsPath).exists();
    expect(exists).toBe(true);

    const content = await Bun.file(denialsPath).text();
    const lines = content.split("\n").filter(Boolean);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain("RU-1");
    expect(lines[0]).toContain("/repo/src/denied.ts");
  });
});
