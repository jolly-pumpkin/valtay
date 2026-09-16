import { test, expect, describe } from "bun:test";
import { mkdtemp, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve, join } from "node:path";
import { resolveConfig } from "./config.ts";
import { parseRunspec } from "./runspec.ts";

function spec(yaml: string) {
  const raw = `---\n${yaml}\n---\n\n# Test\n\n## Design\n\ntest\n`;
  return parseRunspec(raw, "/tmp/runspec.md");
}

describe("resolveConfig setup precedence", () => {
  test("frontmatter setup wins over toml", async () => {
    const tmp = await mkdtemp(join(tmpdir(), "valtay-cfg-"));
    await Bun.write(resolve(tmp, "valtay.toml"), 'setup = "toml-cmd"\n');

    const config = resolveConfig(spec("run: t\nsetup: fm-cmd"), tmp);
    expect(config.setup).toBe("fm-cmd");
  });

  test("toml setup used when frontmatter absent", async () => {
    const tmp = await mkdtemp(join(tmpdir(), "valtay-cfg-"));
    await Bun.write(resolve(tmp, "valtay.toml"), 'setup = "toml-cmd"\n');

    const config = resolveConfig(spec("run: t"), tmp);
    expect(config.setup).toBe("toml-cmd");
  });

  test("setup is undefined when neither frontmatter nor toml provides it", () => {
    const config = resolveConfig(spec("run: t"));
    expect(config.setup).toBeUndefined();
  });
});
