#!/usr/bin/env bun

import { Command } from "commander";
import { runNew } from "./commands/new.ts";

const program = new Command()
  .name("valtay")
  .description("Land multiple tickets as safe, reviewable PRs from one run")
  .version("0.0.1");

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

program.parse();
