import { resolve } from "path";
import type { Run } from "../run/store.ts";

/** Halt classification — what stopped the run */
export type HaltClass = "mechanical" | "needs-human";

export interface DaemonState {
  /** tmux session name, e.g. "valtay-daemon" */
  session: string;
  /** PID of the Claude Code process inside tmux */
  pid: number | null;
  /** When the session was created */
  started: string; // ISO 8601
  /** Current status */
  status: "running" | "halted" | "complete";
  /** If halted, why */
  halt?: { class: HaltClass; reason: string };
}

function daemonPath(run: Run): string {
  return resolve(run.dir, "daemon.json");
}

export async function readDaemon(run: Run): Promise<DaemonState | null> {
  const file = Bun.file(daemonPath(run));
  if (!(await file.exists())) return null;
  return (await file.json()) as DaemonState;
}

export async function writeDaemon(run: Run, state: DaemonState): Promise<void> {
  await Bun.write(daemonPath(run), `${JSON.stringify(state, null, 2)}\n`);
}
