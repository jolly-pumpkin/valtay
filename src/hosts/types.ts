import type { HostDef, RoleBinding } from "../config.ts";

/**
 * The role's standing instructions, as a skill the host loads through its own skill
 * system rather than a string Valtay injects.
 *
 * A phase is a skill: `valtay init` installs it where the host looks, the adapter names
 * it, and the host reads the file itself. That is what makes a phase portable — the
 * next adapter spawns a different binary rather than reimplementing prompt injection.
 */
export interface PhaseSkill {
  /** Name the host loads it by, e.g. `valtay-research`. */
  name: string;
  /** Absolute path to the SKILL.md the host will read. Inside `workdir`. */
  path: string;
}

export interface HostRequest {
  binding: RoleBinding;
  host: HostDef;
  skill: PhaseSkill;
  /** This invocation's inputs, as one payload. Becomes the user message. */
  input: string;
  /** Working directory. A worktree for write phases, the repo for read-only ones. */
  workdir: string;
  /** Extra directories the host may reach, beyond `workdir`. */
  readDirs?: string[];
  /** Whether the phase may write source and run commands. */
  write: boolean;
  timeout_ms: number;
}

export interface HostResult {
  /** What the phase produced — for a read-only phase, the artifact itself. */
  output: string;
  exit_code: number;
  duration_s: number;
  usage?: Record<string, unknown>;
  cost_usd?: number;
  /** Tool calls the fence refused. Recorded so a phase looping against an unseen
   *  fence is visible in the manifest rather than merely slow (design.md §15.3). */
  permission_denials?: unknown[];
  /** Set when the invocation failed; the host's own text, never paraphrased. */
  error?: string;
}

export interface HostAdapter {
  /** Matches `adapter` in the `[hosts.*]` table. */
  name: string;
  run(request: HostRequest): Promise<HostResult>;
}

/**
 * Strips a single fence wrapping the whole output.
 *
 * Phase prompts ask for the bare artifact, and models mostly comply — but a
 * Markdown artifact returned inside ```` ```markdown ```` is common enough, and
 * harmless enough, to unwrap here rather than fail the phase over.
 */
export function stripFence(output: string): string {
  const trimmed = output.trim();
  const match = trimmed.match(/^(```|~~~)[^\n]*\n([\s\S]*?)\n?\1$/);
  return match ? match[2]!.trim() : trimmed;
}
