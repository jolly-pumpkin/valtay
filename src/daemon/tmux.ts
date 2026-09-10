import { $ } from "bun";

/** Create a detached tmux session that runs `command`. */
export async function createSession(name: string, command: string): Promise<void> {
  await $`tmux new-session -d -s ${name} ${command}`.quiet();
}

/** True when a tmux session with `name` exists. */
export async function hasSession(name: string): Promise<boolean> {
  const result = await $`tmux has-session -t ${name}`.nothrow().quiet();
  return result.exitCode === 0;
}

/** Kill a tmux session by name. No-op if it does not exist. */
export async function killSession(name: string): Promise<void> {
  await $`tmux kill-session -t ${name}`.nothrow().quiet();
}

/** Return the shell command string to attach to a tmux session. */
export function attachCommand(name: string): string {
  return `tmux attach -t ${name}`;
}
