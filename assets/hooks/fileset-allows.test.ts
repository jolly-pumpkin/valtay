import { test, expect, describe, beforeEach, afterEach } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
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
