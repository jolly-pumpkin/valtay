#!/usr/bin/env bun

import { Command } from "commander";
import { runNew } from "./commands/new.ts";
import { runInit, formatInitResult } from "./commands/init.ts";
import { runStart, formatStartResult } from "./commands/start.ts";
import { runStatusLines, selectRun } from "./commands/status.ts";
import { runApprove, runReject, runOverride, runAcceptLayer } from "./commands/gate.ts";
import { runShow } from "./commands/show.ts";
import { runCheck } from "./commands/check.ts";
import { runUpgrade, formatUpgradeResult } from "./commands/upgrade.ts";
import { runCommand } from "./commands/run.ts";

const program = new Command()
  .name("valtay")
  .description("Runspec → Plan → Build → Verify")
  .version("0.0.1");

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
  .option("--skill", "install the skills even without a .claude/ directory")
  .action((opts) => report(async () => formatInitResult(await runInit(opts))));

program
  .command("upgrade")
  .description("Update installed skills to the current version")
  .option("--path <path>", "target directory", ".")
  .action((opts) => report(async () => formatUpgradeResult(await runUpgrade(opts))));

program
  .command("new")
  .description("Scaffold a run spec (no model call)")
  .argument("<name>", "run name")
  .action((name) => {
    runNew([name]);
  });

program
  .command("start")
  .description("Validate the run spec and open a run")
  .argument("<spec>", "path to runspec.md")
  .option("--run <name>", "run name (defaults to the spec's run: key)")
  .option("--repo <path>", "repo root")
  .action((spec, opts) =>
    report(async () => {
      const run = await runStart({ spec, ...opts });
      return formatStartResult(run);
    })
  );

program
  .command("run")
  .description("Run the full pipeline: plan → build → verify")
  .argument("<spec>", "path to runspec.md")
  .option("--run <name>", "run name (defaults to the spec's run: key)")
  .option("--repo <path>", "repo root")
  .action((spec, opts) => report(() => runCommand({ spec, ...opts })));

program
  .command("approve")
  .description("Accept drift findings at the verify gate")
  .argument("<gate>", "gate name (verify)")
  .option("--run <name>", "run name (optional when the repo has one run)")
  .option("--repo <path>", "repo root", ".")
  .action((gate, opts) => report(() => runApprove({ gate, ...opts })));

program
  .command("override")
  .description("Force-build a contested layer (reset to pending)")
  .argument("<unit>", "release unit id (e.g. RU-1)")
  .argument("<layer>", "layer id (e.g. L2)")
  .option("--run <name>", "run name (optional when the repo has one run)")
  .option("--repo <path>", "repo root", ".")
  .action((unit, layer, opts) => report(() => runOverride({ unit, layer, ...opts })));

program
  .command("accept")
  .description("Accept a contestation — mark layer done by exemption")
  .argument("<unit>", "release unit id (e.g. RU-1)")
  .argument("<layer>", "layer id (e.g. L2)")
  .option("--run <name>", "run name (optional when the repo has one run)")
  .option("--repo <path>", "repo root", ".")
  .action((unit, layer, opts) => report(() => runAcceptLayer({ unit, layer, ...opts })));

program
  .command("reject")
  .description("Reject verify and re-enter at a phase")
  .argument("<gate>", "gate name (verify)")
  .argument("<reason>", "what was wrong")
  .requiredOption("--to <phase>", "phase to re-enter at (plan, build)")
  .option("--run <name>", "run name (optional when the repo has one run)")
  .option("--repo <path>", "repo root", ".")
  .action((gate, reason, opts) => report(() => runReject({ gate, reason, ...opts })));

program
  .command("show")
  .description("Print one of the run's artifacts")
  .argument("<artifact>", "artifact path, e.g. plan.md or verify.json")
  .option("--run <name>", "run name (optional when the repo has one run)")
  .option("--repo <path>", "repo root", ".")
  .action((artifact, opts) => report(() => runShow({ artifact, ...opts })));

program
  .command("check")
  .description("Advisory lint over a run spec")
  .argument("<spec>", "path to the run spec to lint")
  .action((spec) => report(() => runCheck({ spec })));

program
  .command("status")
  .description("Where the run stands, phase by phase")
  .option("--run <name>", "run name (optional when the repo has one run)")
  .option("--repo <path>", "repo root", ".")
  .action((opts) => report(() => runStatusLines(opts)));

await program.parseAsync();
