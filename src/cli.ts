#!/usr/bin/env bun

import { Command } from "commander";
import { runNew } from "./commands/new.ts";
import { runInit, formatInitResult } from "./commands/init.ts";

const program = new Command()
  .name("valtay")
  .description("Land multiple tickets as safe, reviewable PRs from one run")
  .version("0.0.1");

program
  .command("init")
  .description("Write valtay.toml and .valtay/ into a repo or a directory of repos")
  .option("--path <path>", "target directory", ".")
  .option("--force", "overwrite an existing valtay.toml")
  .option("--workspace", "treat the target as a directory of repos")
  .option("--repo", "treat the target as a repo root")
  .option("--skill", "install the valtay-compose skill even without a .claude/ directory")
  .action(async (opts) => {
    try {
      const result = await runInit(opts);
      for (const line of formatInitResult(result)) console.log(line);
    } catch (err) {
      console.error(err instanceof Error ? err.message : String(err));
      process.exit(1);
    }
  });

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

await program.parseAsync();
