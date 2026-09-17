import { test, expect, describe, beforeEach, afterEach } from "bun:test";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve, join } from "node:path";
import { runStart, formatStartResult } from "./start.ts";
import { runStatusLines } from "./status.ts";
import { appendApproval, appendInvocation, findRun, writeArtifact, type InvocationRecord } from "../run/store.ts";
import { sha256 } from "../runspec.ts";

let root: string;
let repo: string;
const savedHome = process.env["VALTAY_HOME"];

function spec(body: string): string {
  return `---\nrun: demo\nhost: claude\nmodel: sonnet\n---\n\n# Demo\n\n${body}\n`;
}

const COMPLETE = spec("## Design\n\nDo the thing.\n");

async function writeSpec(content: string): Promise<string> {
  const path = resolve(repo, "runspec.md");
  await writeFile(path, content);
  return path;
}

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "valtay-start-"));
  repo = resolve(root, "valtay");
  await mkdir(resolve(repo, ".git"), { recursive: true });
  process.env["VALTAY_HOME"] = resolve(root, "home");
});

afterEach(async () => {
  if (savedHome === undefined) delete process.env["VALTAY_HOME"];
  else process.env["VALTAY_HOME"] = savedHome;
  await rm(root, { recursive: true, force: true });
});

describe("preflight", () => {
  test("a spec with no design section blocks", async () => {
    const path = await writeSpec(spec("## Notes\n\nsome notes\n"));
    await expect(runStart({ spec: path, repo })).rejects.toThrow(/Design/);
  });

  test("a spec outside any repo blocks", async () => {
    const loose = resolve(root, "loose.md");
    await writeFile(loose, COMPLETE);
    await expect(runStart({ spec: loose, repo: root })).rejects.toThrow(/No git repository/);
  });
});

describe("start", () => {
  test("freezes the spec and reports", async () => {
    const path = await writeSpec(COMPLETE);
    const run = await runStart({ spec: path, repo });

    expect(run.meta.repo).toBe(repo);
    expect(run.meta.runspec.sha).toBe(sha256(COMPLETE));

    const lines = formatStartResult(run).join("\n");
    expect(lines).toContain('Started run "demo"');
    expect(lines).toContain("valtay run");
  });

  test("--run overrides the spec's own name", async () => {
    const path = await writeSpec(COMPLETE);
    const run = await runStart({ spec: path, repo, run: "other" });

    expect(run.meta.run).toBe("other");
    expect((await findRun(repo, "other")).dir).toBe(run.dir);
  });
});

describe("status", () => {
  test("lists every phase and marks the current one", async () => {
    await runStart({ spec: await writeSpec(COMPLETE), repo });
    const lines = await runStatusLines({ repo });
    const text = lines.join("\n");

    expect(text).toContain('Run "demo"');
    expect(text).toContain("state   pending");
    for (const phase of ["Plan", "Build", "Verify"]) {
      expect(text).toContain(phase);
    }

    expect(lines.find((l) => l.includes("Plan"))?.startsWith(">")).toBe(true);
  });

  test("shows a voided approval rather than hiding it", async () => {
    await runStart({ spec: await writeSpec(COMPLETE), repo });
    const run = await findRun(repo);

    const ref = await writeArtifact(run, "verify.json", '{"status":"clean"}');
    await appendApproval(run, {
      ts: new Date().toISOString(),
      gate: "verify",
      decision: "approve",
      artifacts: [ref],
    });
    expect((await runStatusLines({ repo })).join("\n")).toContain("verify approved");

    await writeArtifact(run, "verify.json", "hand-edited");
    expect((await runStatusLines({ repo })).join("\n")).toContain("verify approval VOID");
  });

  test("warns when the frozen spec copy has been edited", async () => {
    await runStart({ spec: await writeSpec(COMPLETE), repo });
    const run = await findRun(repo);

    await writeArtifact(run, "runspec.md", `${COMPLETE}\nextra\n`);
    expect((await runStatusLines({ repo })).join("\n")).toContain("no longer matches");
  });

  test("shows cost/time summary from manifest invocations", async () => {
    await runStart({ spec: await writeSpec(COMPLETE), repo });
    const run = await findRun(repo);

    const base: Omit<InvocationRecord, "phase" | "unit" | "duration_ms" | "usage" | "exit_code"> = {
      ts: new Date().toISOString(),
      attempt: 1,
      host: "claude",
      model: "opus",
      prompt_sha: "abc123",
      notes: [],
    };

    await appendInvocation(run, {
      ...base,
      phase: "plan",
      duration_ms: 298_000,
      exit_code: 0,
      usage: { cost_usd: 0.71 },
    });
    await appendInvocation(run, {
      ...base,
      phase: "build",
      unit: "RU-1",
      duration_ms: 200_000,
      exit_code: 0,
      usage: { cost_usd: 1.0 },
    });
    await appendInvocation(run, {
      ...base,
      phase: "build",
      unit: "RU-2",
      duration_ms: 250_000,
      exit_code: 0,
      usage: { cost_usd: 1.02 },
    });
    await appendInvocation(run, {
      ...base,
      phase: "build",
      unit: "RU-2",
      attempt: 2,
      duration_ms: 200_000,
      exit_code: 0,
      usage: { cost_usd: 1.0 },
    });
    await appendInvocation(run, {
      ...base,
      phase: "verify",
      duration_ms: 135_000,
      exit_code: 0,
      usage: { cost_usd: 0.4 },
    });

    const text = (await runStatusLines({ repo })).join("\n");

    expect(text).toContain("plan");
    expect(text).toContain("$0.71");
    expect(text).toContain("1 call");
    expect(text).toContain("3 calls");
    expect(text).toContain("(RU-1, RU-2 x2)");
    expect(text).toContain("$0.40");
    expect(text).toContain("total");
    expect(text).toContain("$4.13");
    expect(text).toContain("1083s");
  });

  test("marks failed calls in cost/time summary", async () => {
    await runStart({ spec: await writeSpec(COMPLETE), repo });
    const run = await findRun(repo);

    await appendInvocation(run, {
      ts: new Date().toISOString(),
      phase: "plan",
      attempt: 1,
      host: "claude",
      model: "opus",
      prompt_sha: "abc123",
      duration_ms: 60_000,
      exit_code: 1,
      usage: { cost_usd: 0.3 },
      notes: [],
    });

    const text = (await runStatusLines({ repo })).join("\n");
    expect(text).toContain("(1 failed)");
  });
});
