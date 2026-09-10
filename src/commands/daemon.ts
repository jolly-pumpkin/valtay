import { resolve } from "path";
import { selectRun, type RunSelector } from "./status.ts";
import { readDaemon, writeDaemon, type DaemonState } from "../daemon/store.ts";
import { readState } from "../run/store.ts";
import { createSession, hasSession, killSession, attachCommand } from "../daemon/tmux.ts";
import { buildPrompt } from "../daemon/prompt.ts";

function sessionName(runName: string): string {
  return `valtay-${runName}`;
}

export async function daemonStart(options: RunSelector): Promise<string[]> {
  const run = await selectRun(options);
  const name = run.meta.run;
  const session = sessionName(name);

  const existing = await readDaemon(run);
  if (existing && existing.status === "running") {
    if (await hasSession(session)) {
      throw new Error(
        `Daemon for run "${name}" is already running. Use \`valtay daemon status\` or \`valtay daemon attach\`.`
      );
    }
    // Session died but daemon.json still says running — will be caught below
  }

  if (await hasSession(session)) {
    throw new Error(
      `tmux session "${session}" already exists. Kill it first or use a different run name.`
    );
  }

  const runspecPath = resolve(run.dir, "runspec.md");
  const prompt = buildPrompt(name, runspecPath);
  // Escape single quotes in the prompt for shell safety
  const escaped = prompt.replace(/'/g, "'\\''");
  const command = `claude '${escaped}'`;

  await createSession(session, command);

  const state: DaemonState = {
    session,
    pid: null, // tmux manages the process; we don't track the inner PID
    started: new Date().toISOString(),
    status: "running",
  };
  await writeDaemon(run, state);

  return [
    `Daemon started for run "${name}".`,
    `  session: ${session}`,
    `  attach:  tmux attach -t ${session}`,
  ];
}

export async function daemonStatus(options: RunSelector): Promise<string[]> {
  const run = await selectRun(options);
  const name = run.meta.run;
  const state = await readDaemon(run);

  if (!state) {
    return [`No daemon has been started for run "${name}".`];
  }

  // Detect dead tmux session — classify using state.json
  if (state.status === "running" && !(await hasSession(state.session))) {
    const runState = await readState(run);

    let updated: DaemonState;
    if (runState.status === "complete") {
      updated = { ...state, status: "complete", pid: null };
    } else if (runState.status === "awaiting_gate") {
      updated = {
        ...state,
        status: "halted",
        pid: null,
        halt: { class: "needs-human", reason: runState.note ?? "verify drift" },
      };
    } else {
      updated = {
        ...state,
        status: "halted",
        pid: null,
        halt: { class: "mechanical", reason: "tmux session died unexpectedly" },
      };
    }
    await writeDaemon(run, updated);

    if (updated.status === "complete") {
      return [`Daemon for run "${name}": complete`];
    }

    const lines = [`Daemon for run "${name}": halted (${updated.halt!.class})`];
    lines.push(`  reason: ${updated.halt!.reason}`);
    if (updated.halt!.class === "mechanical") {
      lines.push(`  recovery: \`valtay daemon start\` to restart`);
    } else {
      lines.push(`  recovery: \`valtay approve verify\` or fix and restart`);
    }
    return lines;
  }

  const lines = [`Daemon for run "${name}": ${state.status}`];

  if (state.status === "running") {
    lines.push(`  session: ${state.session}`);
    lines.push(`  started: ${state.started}`);
    lines.push(`  attach:  ${attachCommand(state.session)}`);
  }

  if (state.halt) {
    lines.push(`  class:   ${state.halt.class}`);
    lines.push(`  reason:  ${state.halt.reason}`);
    if (state.halt.class === "mechanical") {
      lines.push(`  recovery: \`valtay daemon start\` to restart`);
    } else {
      lines.push(`  recovery: \`valtay approve verify\` or fix and restart`);
    }
  }

  return lines;
}

export async function daemonStop(options: RunSelector): Promise<string[]> {
  const run = await selectRun(options);
  const name = run.meta.run;
  const session = sessionName(name);
  const state = await readDaemon(run);

  await killSession(session);

  const halted: DaemonState = {
    session,
    pid: null,
    started: state?.started ?? new Date().toISOString(),
    status: "halted",
    halt: { class: "mechanical", reason: "stopped by user" },
  };
  await writeDaemon(run, halted);

  return [`Daemon for run "${name}" stopped.`];
}

/** Resolves the tmux session name for a run, throwing if no session exists. */
export async function daemonAttach(options: RunSelector): Promise<{ session: string }> {
  const run = await selectRun(options);
  const session = sessionName(run.meta.run);

  if (!(await hasSession(session))) {
    throw new Error(
      `No tmux session "${session}". Start one with \`valtay daemon start\`.`
    );
  }

  return { session };
}
