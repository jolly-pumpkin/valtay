export interface DispatchOpts {
  /** Working directory for the CLI process */
  cwd: string;
  /** Model name (e.g. "sonnet", "opus", "gpt-5.4-mini") */
  model: string;
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

export function buildClaudeArgs(prompt: string, opts: DispatchOpts): string[] {
  const args = ["claude", "-p", prompt, "--model", opts.model];
  if (opts.effort) args.push("--effort", opts.effort);
  return args;
}

export function buildCodexArgs(prompt: string, opts: DispatchOpts): string[] {
  const args = ["codex", "-q", prompt, "--model", opts.model];
  return args;
}

async function spawnProvider(args: string[], opts: DispatchOpts): Promise<DispatchResult> {
  const proc = Bun.spawn(args, {
    cwd: opts.cwd,
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
      return spawnProvider(buildClaudeArgs(prompt, opts), opts);
    },
  };
}

function codexProvider(): Provider {
  return {
    name: "codex",
    dispatch(prompt, opts) {
      return spawnProvider(buildCodexArgs(prompt, opts), opts);
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
