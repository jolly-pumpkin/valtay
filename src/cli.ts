#!/usr/bin/env bun

import { Command } from "commander";
import { runNew } from "./commands/new.ts";
import { runInit, formatInitResult } from "./commands/init.ts";
import { runStart, formatStartResult } from "./commands/start.ts";
import { runStatusLines, selectRun } from "./commands/status.ts";
import { runApprove, runReject } from "./commands/gate.ts";
import { runShow } from "./commands/show.ts";
import { runTrace } from "./commands/trace.ts";
import { runCheck } from "./commands/check.ts";
import { advance, retry } from "./run/orchestrator.ts";

const program = new Command()
  .name("valtay")
  .description("Land multiple tickets as safe, reviewable PRs from one run")
  .version("0.0.1");

/** Commands report failure the same way: the message, exit 1, no stack trace. */
async function report(work: () => Promise<string[]>): Promise<void> {
  try {
    for (const line of await work()) console.log(line);
  } catch (err) {
    console.error(err instanceof Error ? err.message : String(err));
    process.exit(1);
  }
}

program
  .command("init")
  .description("Write valtay.toml and .valtay/ into a repo or a directory of repos")
  .option("--path <path>", "target directory", ".")
  .option("--force", "overwrite an existing valtay.toml")
  .option("--workspace", "treat the target as a directory of repos")
  .option("--skill", "install the valtay-compose skill even without a .claude/ directory")
  .action((opts) => report(async () => formatInitResult(await runInit(opts))));

program
  .command("new")
  .description("Scaffold a run spec (no model call)")
  .argument("<name>", "run name")
  .option("--tickets <ids>", "comma-separated ticket IDs")
  .option("--mode <mode>", "attended or unattended", "attended")
  .action((name, opts) => {
    const args: string[] = [name];
    if (opts.tickets) args.push("--tickets", opts.tickets);
    if (opts.mode) args.push("--mode", opts.mode);
    runNew(args);
  });

program
  .command("start")
  .description("Freeze the run spec and open a run")
  .argument("<spec>", "path to runspec.md")
  .option("--run <name>", "run name (defaults to the spec's run: key)")
  .option("--repo <path>", "repo root (defaults to the spec's repo: key)")
  .action((spec, opts) =>
    report(async () => {
      const run = await runStart({ spec, ...opts });
      return [...formatStartResult(run), "", ...(await advance(run))];
    })
  );

program
  .command("approve")
  .description("Record approval of a gate and carry the run on")
  .argument("<gate>", "gate ID, e.g. G1")
  .option("--run <name>", "run name (optional when the repo has one run)")
  .option("--repo <path>", "repo root", ".")
  .action((gate, opts) => report(() => runApprove({ gate, ...opts })));

program
  .command("reject")
  .description("Reject a gate and re-enter at the artifact that was wrong")
  .argument("<gate>", "gate ID, e.g. G3")
  .argument("<reason>", "what was wrong — the phase gets this verbatim")
  .requiredOption("--to <artifact>", "artifact to re-enter at, e.g. design or plan.json")
  .option("--run <name>", "run name (optional when the repo has one run)")
  .option("--repo <path>", "repo root", ".")
  .action((gate, reason, opts) => report(() => runReject({ gate, reason, ...opts })));

program
  .command("show")
  .description("Print one of the run's artifacts")
  .argument("<artifact>", "artifact path or stem, e.g. design or plan.json")
  .option("--run <name>", "run name (optional when the repo has one run)")
  .option("--repo <path>", "repo root", ".")
  .action((artifact, opts) => report(() => runShow({ artifact, ...opts })));

program
  .command("trace")
  .description("Render a unit's call path as path:line:col")
  .argument("[unit]", "release unit, e.g. RU-1")
  .option("--tree", "nested tree instead of the flat list")
  .option("--run <name>", "run name (optional when the repo has one run)")
  .option("--repo <path>", "repo root", ".")
  .action((unit, opts) => report(() => runTrace({ unit, ...opts })));

program
  .command("check")
  .description("Advisory lint over a run spec's frontmatter and sections")
  .argument("<spec>", "path to the run spec to lint")
  .action((spec) => report(() => runCheck({ spec })));

program
  .command("resume")
  .description("Carry the run forward from wherever it stopped")
  .option("--retry", "re-attempt a phase that failed")
  .option("--run <name>", "run name (optional when the repo has one run)")
  .option("--repo <path>", "repo root", ".")
  .action((opts) =>
    report(async () => {
      const run = await selectRun(opts);
      const preamble = opts.retry ? await retry(run) : [];
      return [...preamble, ...(await advance(run))];
    })
  );

program
  .command("status")
  .description("Where the run stands, phase by phase")
  .option("--run <name>", "run name (optional when the repo has one run)")
  .option("--repo <path>", "repo root", ".")
  .action((opts) => report(() => runStatusLines(opts)));

await program.parseAsync();
