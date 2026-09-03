import { test, expect, describe, beforeEach, afterEach } from "bun:test";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve, join } from "node:path";
import { resolveConfig, parseDuration, vendorDiversity, valtayHome } from "./config.ts";
import { parseRunspec } from "./runspec.ts";

let root: string;
let repo: string;
let home: string;
const savedHome = process.env["VALTAY_HOME"];

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "valtay-config-"));
  repo = resolve(root, "repo");
  home = resolve(root, "home");
  await mkdir(repo, { recursive: true });
  await mkdir(home, { recursive: true });
  process.env["VALTAY_HOME"] = home;
});

afterEach(async () => {
  if (savedHome === undefined) delete process.env["VALTAY_HOME"];
  else process.env["VALTAY_HOME"] = savedHome;
  await rm(root, { recursive: true, force: true });
});

const writeRepoToml = (body: string) => writeFile(resolve(repo, "valtay.toml"), body);
const writeUserToml = (body: string) => writeFile(resolve(home, "config.toml"), body);

const spec = (frontmatter: string) =>
  parseRunspec(`---\n${frontmatter}\n---\n\n# t\n`, resolve(root, "runspec.md"));

describe("defaults", () => {
  test("an empty repo still resolves a usable binding", async () => {
    const config = await resolveConfig(repo);

    expect(config.hosts["claude-code"]).toEqual({ bin: "claude", adapter: "claude-code" });
    expect(config.roles.researcher.host).toBe("claude-code");
    expect(config.roles.researcher.model).toBe("sonnet");
    expect(config.roles.researcher.timeout_ms).toBe(600_000);
    expect(config.trace.tier).toBe("agent");
    expect(config.run).toEqual({ max_units: 5, max_layers: 12, max_trace_nodes: 40 });
  });

  test("VALTAY_HOME redirects Valtay's own directory", () => {
    expect(valtayHome()).toBe(home);
  });
});

describe("precedence", () => {
  test("repo config beats user config, run spec beats both", async () => {
    await writeUserToml(`[roles.default]\nmodel = "user-model"\neffort = "low"\n`);
    await writeRepoToml(`[roles.default]\nmodel = "repo-model"\n`);

    const fromRepo = await resolveConfig(repo);
    expect(fromRepo.roles.planner.model).toBe("repo-model");
    expect(fromRepo.roles.planner.effort).toBe("low"); // untouched by the repo layer

    const fromSpec = await resolveConfig(
      repo,
      spec("roles:\n  planner: { model: spec-model, effort: max }")
    );
    expect(fromSpec.roles.planner.model).toBe("spec-model");
    expect(fromSpec.roles.planner.effort).toBe("max");
    // A per-role override in the spec leaves every other role on the repo default.
    expect(fromSpec.roles.builder.model).toBe("repo-model");
  });

  test("a per-role override beats roles.default in the same file", async () => {
    await writeRepoToml(
      `[roles.default]\nmodel = "sonnet"\n\n[roles.prober]\nmodel = "opus"\ntimeout = "20m"\n`
    );

    const config = await resolveConfig(repo);
    expect(config.roles.prober.model).toBe("opus");
    expect(config.roles.prober.timeout_ms).toBe(1_200_000);
    expect(config.roles.builder.model).toBe("sonnet");
  });

  test("trace, layers and budgets merge across sources", async () => {
    await writeRepoToml(
      `[trace]\ntier = "runtime"\ncommand = "bun test"\n\n[layers]\n"src/ui/**" = "ui"\n`
    );

    const config = await resolveConfig(repo, spec("run_budget:\n  max_units: 2"));
    expect(config.trace).toEqual({ tier: "runtime", command: "bun test" });
    expect(config.layers["src/ui/**"]).toBe("ui");
    expect(config.run.max_units).toBe(2);
    expect(config.run.max_layers).toBe(12);
  });

  test("an empty trace command is dropped rather than kept as a blank string", async () => {
    // `valtay init` writes `command = ""` as a TODO marker.
    await writeRepoToml(`[trace]\ntier = "agent"\ncommand = ""\n`);
    expect((await resolveConfig(repo)).trace.command).toBeUndefined();
  });
});

describe("host references", () => {
  test("resolves a host by table key or by binary name", async () => {
    await writeRepoToml(
      `[hosts.claude-code]\nbin = "claude"\n\n[hosts.codex]\nbin = "codex"\n\n` +
        `[roles.default]\nhost = "claude-code"\nmodel = "sonnet"\n`
    );

    // docs/RUNSPEC.md's example spells the host `claude`; design.md §6.1 spells the
    // same host `claude-code`. Both must resolve.
    const config = await resolveConfig(repo, spec("roles:\n  prober: { host: codex, model: luna }"));
    expect(config.roles.prober.host).toBe("codex");

    const byBin = await resolveConfig(repo, spec("roles:\n  prober: { host: claude, model: opus }"));
    expect(byBin.roles.prober.host).toBe("claude-code");
  });

  test("an unknown host fails at start rather than at invocation", async () => {
    await expect(
      resolveConfig(repo, spec("roles:\n  prober: { host: nonesuch, model: x }"))
    ).rejects.toThrow(/Unknown host "nonesuch"/);
  });

  test("an unknown trace tier is rejected", async () => {
    await writeRepoToml(`[trace]\ntier = "psychic"\n`);
    await expect(resolveConfig(repo)).rejects.toThrow(/psychic/);
  });
});

describe("vendor diversity", () => {
  test("is false when every role lands on one host", async () => {
    expect(vendorDiversity(await resolveConfig(repo))).toBe(false);
  });

  test("is true as soon as two roles differ", async () => {
    await writeRepoToml(
      `[hosts.claude-code]\nbin = "claude"\n\n[hosts.codex]\nbin = "codex"\n\n` +
        `[roles.default]\nhost = "claude-code"\nmodel = "sonnet"\n\n` +
        `[roles.prober]\nhost = "codex"\nmodel = "luna"\n`
    );
    expect(vendorDiversity(await resolveConfig(repo))).toBe(true);
  });
});

describe("parseDuration", () => {
  test("reads the suffixes design.md uses", () => {
    expect(parseDuration("10m", 0)).toBe(600_000);
    expect(parseDuration("20m", 0)).toBe(1_200_000);
    expect(parseDuration("90s", 0)).toBe(90_000);
    expect(parseDuration("2h", 0)).toBe(7_200_000);
    expect(parseDuration("500ms", 0)).toBe(500);
    expect(parseDuration("30", 0)).toBe(30_000);
    expect(parseDuration(undefined, 42)).toBe(42);
  });

  test("rejects nonsense rather than defaulting silently", () => {
    expect(() => parseDuration("soon", 0)).toThrow();
  });
});
