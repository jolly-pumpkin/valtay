import { test, expect, describe } from "bun:test";
import { buildPrompt } from "./prompt.ts";

describe("buildPrompt", () => {
  test("includes the run name and runspec path", () => {
    const prompt = buildPrompt("myrun", "/repo/.valtay/runs/myrun/runspec.md");
    expect(prompt).toContain('"myrun"');
    expect(prompt).toContain("/repo/.valtay/runs/myrun/runspec.md");
  });

  test("includes all three phase skills in order", () => {
    const prompt = buildPrompt("x", "/spec");
    const planIdx = prompt.indexOf("/valtay-plan");
    const buildIdx = prompt.indexOf("/valtay-build");
    const verifyIdx = prompt.indexOf("/valtay-verify");

    expect(planIdx).toBeGreaterThan(-1);
    expect(buildIdx).toBeGreaterThan(planIdx);
    expect(verifyIdx).toBeGreaterThan(buildIdx);
  });

  test("includes valtay advance calls with run name", () => {
    const prompt = buildPrompt("demo", "/spec");
    const advances = prompt.match(/valtay advance --run demo/g);
    expect(advances).toHaveLength(3);
  });

  test("includes exit code instructions", () => {
    const prompt = buildPrompt("x", "/spec");
    expect(prompt).toContain("exit with code 0");
    expect(prompt).toContain("exit with code 1");
  });
});
