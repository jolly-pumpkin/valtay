#!/usr/bin/env bun

import { Command } from "commander";
import { runNew } from "./commands/new.ts";
import { runInit, formatInitResult } from "./commands/init.ts";
import { runStart, formatStartResult } from "./commands/start.ts";
import { runStatusLines } from "./commands/status.ts";

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
  .option("--repo", "treat the target as a repo root")
  .option("--skill", "install the valtay-compose skill even without a .claude/ directory")
  .action((opts) => report(async () => formatInitResult(await runInit(opts))));

program
  .command("new")
  .description("Scaffold a run spec (no model call)")
  .argument("<name>", "run name")
  .option("--repo <path>", "repository path", ".")
  .option("--tickets <ids>", "comma-separated ticket IDs")
  .option("--mode <mode>", "attended or unattended", "attended")
  .option("--commit", "place runspec.md in the repo instead of ~/.valtay/")
  .action((name, opts) => {
    const args: string[] = [name];
    if (opts.repo) args.push("--repo", opts.repo);
    if (opts.tickets) args.push("--tickets", opts.tickets);
    if (opts.mode) args.push("--mode", opts.mode);
    if (opts.commit) args.push("--commit");
    runNew(args);
  });

program
  .command("start")
  .description("Freeze the run spec and open a run")
  .argument("<spec>", "path to runspec.md")
  .option("--run <name>", "run name (defaults to the spec's run: key)")
  .option("--repo <path>", "repo root (defaults to the spec's repo: key)")
  .action((spec, opts) =>
    report(async () => formatStartResult(await runStart({ spec, ...opts })))
  );

program
  .command("status")
  .description("Where the run stands, phase by phase")
  .option("--run <name>", "run name (optional when the repo has one run)")
  .option("--repo <path>", "repo root", ".")
  .action((opts) => report(() => runStatusLines(opts)));

await program.parseAsync();
