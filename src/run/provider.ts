export interface DispatchOpts {
  /** Working directory for the CLI process */
  cwd: string;
  /** Model name (e.g. "sonnet", "opus", "gpt-5.4-mini") */
  model: string;
  /** Whether the phase may write files (build = true, plan/verify = false) */
  write: boolean;
  /** Optional effort level */
  effort?: string;
  /** Environment variables to merge with process.env */
  env?: Record<string, string>;
}

export interface DispatchResult {
  ok: boolean;
  exitCode: number;
  stdout: string;
  stderr: string;
}

export interface Provider {
  name: string;
  dispatch(prompt: string, opts: DispatchOpts): Promise<DispatchResult>;
}

/**
 * Build claude CLI args. Prompt goes on stdin (trailing `-` is not needed;
 * we pipe to stdin directly). Per design.md §7.2:
 * - Read-only: --permission-mode dontAsk --disallowed-tools "Edit Write NotebookEdit"
 * - Write:     --permission-mode acceptEdits --allowed-tools "Bash Read Write Edit NotebookEdit Glob Grep"
 */
export function buildClaudeArgs(opts: DispatchOpts): string[] {
  const args = ["claude", "-p", "--output-format", "json", "--model", opts.model];
  if (opts.effort) args.push("--effort", opts.effort);

  if (opts.write) {
    args.push(
      "--permission-mode", "acceptEdits",
      "--allowed-tools", "Bash Read Write Edit NotebookEdit Glob Grep",
    );
  } else {
    args.push(
      "--permission-mode", "dontAsk",
      "--disallowed-tools", "Edit Write NotebookEdit",
    );
  }

  return args;
}

/**
 * Build codex CLI args. Per design.md §7.2:
 * - Read-only: --sandbox read-only
 * - Write:     --sandbox workspace-write
 * Prompt goes on stdin via trailing `-`.
 */
export function buildCodexArgs(opts: DispatchOpts): string[] {
  const sandbox = opts.write ? "workspace-write" : "read-only";
  const args = [
    "codex", "exec",
    "--json",
    "--skip-git-repo-check",
    "--model", opts.model,
    "--cd", opts.cwd,
    "--sandbox", sandbox,
  ];
  if (opts.effort) args.push("-c", `model_reasoning_effort=${opts.effort}`);
  args.push("-"); // prompt on stdin
  return args;
}

/**
 * Spawn a provider CLI with the prompt piped to stdin.
 * Both claude and codex accept the prompt on stdin to avoid argv length limits
 * and the variadic-flag trap (design.md §7.2).
 */
async function spawnProvider(
  args: string[],
  prompt: string,
  opts: DispatchOpts,
): Promise<DispatchResult> {
  const proc = Bun.spawn(args, {
    cwd: opts.cwd,
    stdin: new Blob([prompt]),
    stdout: "pipe",
    stderr: "pipe",
    env: { ...process.env, ...opts.env },
  });

  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);

  return { ok: exitCode === 0, exitCode, stdout: stdout.trim(), stderr: stderr.trim() };
}

function claudeProvider(): Provider {
  return {
    name: "claude",
    dispatch(prompt, opts) {
      return spawnProvider(buildClaudeArgs(opts), prompt, opts);
    },
  };
}

function codexProvider(): Provider {
  return {
    name: "codex",
    dispatch(prompt, opts) {
      return spawnProvider(buildCodexArgs(opts), prompt, opts);
    },
  };
}

export function providerFor(host: string): Provider {
  switch (host) {
    case "claude":
      return claudeProvider();
    case "codex":
      return codexProvider();
    default:
      throw new Error(`Unknown host: ${host}`);
  }
}
