import { stripFence, type HostAdapter, type HostRequest, type HostResult } from "./types.ts";

/** The subset of `--output-format json` this adapter reads. */
interface ClaudeResult {
  result?: string;
  is_error?: boolean;
  subtype?: string;
  usage?: Record<string, unknown>;
  total_cost_usd?: number;
  permission_denials?: unknown[];
}

/**
 * Tools a read-only phase must not have.
 *
 * `--permission-mode dontAsk` additionally denies Bash without prompting, so a
 * read-only phase cannot reach a shell redirect either — verified against the
 * binary: the denial lands in `permission_denials` and no file appears.
 */
const READ_ONLY_DENY = "Edit Write NotebookEdit";

/**
 * What a write phase is allowed, as an allowlist rather than a blanket skip.
 *
 * `bypassPermissions` looked like the obvious choice and is not usable: it maps to
 * `--dangerously-skip-permissions`, which refuses to run as root and so fails
 * outright in a container. `acceptEdits` plus an explicit list works everywhere,
 * grants Bash for the project's own checkpoint, and is a fence rather than the
 * absence of one.
 */
const WRITE_ALLOW = "Bash Read Write Edit NotebookEdit Glob Grep";

/**
 * Builds the argv for one invocation.
 *
 * The prompt is **not** an argument. `--disallowed-tools` and `--add-dir` are
 * variadic (`<tools...>`, `<directories...>`), so a trailing positional prompt is
 * swallowed by whichever one precedes it and the CLI then fails with "Input must be
 * provided either through stdin or as a prompt argument". Passing the payload on
 * stdin sidesteps the collision entirely and lifts the argument-length ceiling,
 * which matters once a phase's inputs are several artifacts long.
 */
export function claudeArgs(request: HostRequest): string[] {
  const { binding, write, readDirs = [] } = request;

  const args = ["-p", "--output-format", "json", "--model", binding.model];
  if (binding.effort) args.push("--effort", binding.effort);
  args.push("--append-system-prompt", request.prompt);

  if (write) {
    // Probe and Build run inside a worktree and need Bash for the project's own
    // checkpoint. The worktree is the outer fence; the allowlist is the inner one.
    args.push("--permission-mode", "acceptEdits", "--allowed-tools", WRITE_ALLOW);
  } else {
    args.push("--permission-mode", "dontAsk", "--disallowed-tools", READ_ONLY_DENY);
  }

  if (readDirs.length > 0) args.push("--add-dir", ...readDirs);
  return args;
}

async function invoke(request: HostRequest): Promise<HostResult> {
  const started = Bun.nanoseconds();

  const proc = Bun.spawn([request.host.bin, ...claudeArgs(request)], {
    cwd: request.workdir,
    stdin: new TextEncoder().encode(request.input),
    stdout: "pipe",
    stderr: "pipe",
    timeout: request.timeout_ms,
  });

  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);

  const duration_s = (Bun.nanoseconds() - started) / 1e9;

  if (proc.signalCode) {
    return {
      output: "",
      exit_code: exitCode ?? 1,
      duration_s,
      error: `${request.host.bin} killed by ${proc.signalCode} after ${Math.round(duration_s)}s (timeout ${request.timeout_ms}ms)`,
    };
  }

  if (exitCode !== 0) {
    return {
      output: "",
      exit_code: exitCode,
      duration_s,
      error: stderr.trim() || `${request.host.bin} exited ${exitCode}`,
    };
  }

  let parsed: ClaudeResult;
  try {
    parsed = JSON.parse(stdout) as ClaudeResult;
  } catch {
    return {
      output: "",
      exit_code: 1,
      duration_s,
      error: `${request.host.bin} did not return JSON: ${stdout.slice(0, 400)}`,
    };
  }

  const common = {
    duration_s,
    ...(parsed.usage ? { usage: parsed.usage } : {}),
    ...(parsed.total_cost_usd === undefined ? {} : { cost_usd: parsed.total_cost_usd }),
    ...(parsed.permission_denials?.length ? { permission_denials: parsed.permission_denials } : {}),
  };

  if (parsed.is_error || typeof parsed.result !== "string") {
    return {
      ...common,
      output: "",
      exit_code: 1,
      error: parsed.result ?? `${request.host.bin} reported ${parsed.subtype ?? "an error"}`,
    };
  }

  return { ...common, output: stripFence(parsed.result), exit_code: 0 };
}

export const claudeCodeAdapter: HostAdapter = { name: "claude-code", run: invoke };
