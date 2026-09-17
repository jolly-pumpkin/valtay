export interface DispatchUsage {
  input_tokens?: number;
  output_tokens?: number;
  cache_creation_input_tokens?: number;
  cache_read_input_tokens?: number;
  cost_usd?: number;
  num_turns?: number;
  cli_duration_ms?: number;
  permission_denials?: number;
}

export interface DispatchOpts {
  /** Working directory for the CLI process */
  cwd: string;
  /** Model name (e.g. "sonnet", "opus", "gpt-5.4-mini") */
  model: string;
  /** Whether the phase may write files (build = true, plan/verify = false) */
  write: boolean;
  /**
   * Absolute run directory. A read-only phase may write here and nowhere else —
   * this is how plan produces plan.md/briefs and verify produces verify.json
   * while the repo stays fenced (design.md §15.1, artifact write scope).
   */
  artifactDir?: string;
  /** Optional effort level */
  effort?: string;
  /** Environment variables to merge with process.env */
  env?: Record<string, string>;
  /** Absolute path to append every stdout line to (JSONL log). */
  logPath?: string;
  /** Called once per stdout line during streaming. */
  onEvent?: (line: string) => void;
}

export interface DispatchResult {
  ok: boolean;
  exitCode: number;
  stdout: string;
  stderr: string;
  usage?: DispatchUsage;
  /**
   * The parsed last JSON line whose `type` is "result" from stream-json output.
   * Set by spawnProvider for claude; undefined for codex or when no result line
   * appears. parseClaudeUsage and dispatchNotes both read this instead of
   * parsing stdout as a single JSON object.
   * stdout stays the raw JSONL (codex already is).
   */
  result?: Record<string, unknown>;
}

export interface Provider {
  name: string;
  dispatch(prompt: string, opts: DispatchOpts): Promise<DispatchResult>;
}

/**
 * Permission rules a read-only phase gets under `dontAsk`. Everything not listed
 * is denied without prompting: writes outside the run dir, and any Bash command
 * other than the read-only git subcommands verify needs for its diff.
 */
export function readOnlyRules(artifactDir?: string): string[] {
  const rules = ["Read", "Glob", "Grep", "Bash(git diff *)", "Bash(git log *)", "Bash(git show *)"];
  if (artifactDir) {
    // Permission-rule paths: a leading `//` means absolute from the filesystem root.
    const abs = artifactDir.replace(/^\/+/, "");
    rules.push(`Edit(//${abs}/**)`, `Write(//${abs}/**)`);
  }
  return rules;
}

/**
 * Build claude CLI args. Prompt goes on stdin (trailing `-` is not needed;
 * we pipe to stdin directly). Per design.md §7.2:
 * - Read-only: --permission-mode dontAsk, allow list = read tools + read-only git
 *              + Edit/Write scoped to the run dir. `--disallowed-tools` is not used
 *              here because it removes a tool outright, so no allow rule could
 *              reopen it for the artifact.
 * - Write:     --permission-mode acceptEdits --allowed-tools Bash Read Write Edit NotebookEdit Glob Grep
 *
 * Tool rules are passed as separate argv entries, the way the CLI reference shows
 * them ("Bash(git log *)" "Read"), because a rule can contain a space. The list
 * is always the last thing in argv: the flag is variadic and the prompt is on stdin.
 */
export function buildClaudeArgs(opts: DispatchOpts): string[] {
  const args = ["claude", "-p", "--output-format", "stream-json", "--verbose", "--model", opts.model];
  if (opts.effort) args.push("--effort", opts.effort);

  if (opts.write) {
    args.push("--permission-mode", "acceptEdits");
    args.push("--allowed-tools", "Bash", "Read", "Write", "Edit", "NotebookEdit", "Glob", "Grep");
  } else {
    // Verify runs with cwd in the integration worktree; the run dir lives in the
    // main repo, so it has to be added explicitly for the CLI to touch it at all.
    if (opts.artifactDir) args.push("--add-dir", opts.artifactDir);
    args.push("--permission-mode", "dontAsk");
    args.push("--allowed-tools", ...readOnlyRules(opts.artifactDir));
  }

  return args;
}

/**
 * Build codex CLI args. Per design.md §7.2:
 * - Read-only: --sandbox read-only
 * - Write:     --sandbox workspace-write
 * Prompt goes on stdin via trailing `-`.
 *
 * Not yet verified against the binary: under `read-only` the run dir is not
 * writable either, so plan/verify on codex cannot produce their artifacts.
 * §7.2 records `--add-dir` as "additional writable directories", which is
 * probably the fix; it is passed when an artifactDir is given, and the first
 * codex run will tell.
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
  if (!opts.write && opts.artifactDir) args.push("--add-dir", opts.artifactDir);
  if (opts.effort) args.push("-c", `model_reasoning_effort=${opts.effort}`);
  args.push("-"); // prompt on stdin
  return args;
}

/**
 * Spawn a provider CLI with the prompt piped to stdin.
 * Both claude and codex accept the prompt on stdin to avoid argv length limits
 * and the variadic-flag trap (design.md §7.2).
 *
 * Reads stdout incrementally line-by-line: each line is appended to
 * opts.logPath (when set), forwarded to opts.onEvent, and collected for the
 * final result. The last JSON line whose parsed `type` is "result" is stored
 * as result.result so callers don't need to re-parse the full JSONL.
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

  const lines: string[] = [];
  let resultObj: Record<string, unknown> | undefined;
  let logFile: Bun.FileSink | undefined;

  if (opts.logPath) {
    logFile = Bun.file(opts.logPath).writer({ highWaterMark: 1024 });
  }

  const decoder = new TextDecoder();
  let buffer = "";

  for await (const chunk of proc.stdout as AsyncIterable<Uint8Array>) {
    buffer += decoder.decode(chunk, { stream: true });
    const parts = buffer.split("\n");
    // Keep the last incomplete part in the buffer
    buffer = parts.pop()!;
    for (const line of parts) {
      if (!line) continue;
      lines.push(line);
      if (logFile) logFile.write(line + "\n");
      opts.onEvent?.(line);
      try {
        const parsed = JSON.parse(line);
        if (parsed.type === "result") resultObj = parsed;
      } catch { /* not JSON, skip */ }
    }
  }
  // Flush remaining buffer
  if (buffer) {
    lines.push(buffer);
    if (logFile) logFile.write(buffer + "\n");
    opts.onEvent?.(buffer);
    try {
      const parsed = JSON.parse(buffer);
      if (parsed.type === "result") resultObj = parsed;
    } catch { /* not JSON, skip */ }
  }

  if (logFile) logFile.end();

  const [stderr, exitCode] = await Promise.all([
    new Response(proc.stderr).text(),
    proc.exited,
  ]);

  const stdout = lines.join("\n");
  return { ok: exitCode === 0, exitCode, stdout, stderr: stderr.trim(), result: resultObj };
}

/**
 * Parse the claude result object into DispatchUsage.
 * Accepts the parsed result object (from DispatchResult.result) instead of
 * raw stdout. Returns undefined when the object is undefined or has no
 * usage fields.
 */
export function parseClaudeUsage(obj: Record<string, unknown> | undefined): DispatchUsage | undefined {
  if (!obj) return undefined;
  const usage: DispatchUsage = {};
  const u = obj.usage as Record<string, unknown> | undefined;
  if (u) {
    if (typeof u.input_tokens === "number") usage.input_tokens = u.input_tokens;
    if (typeof u.output_tokens === "number") usage.output_tokens = u.output_tokens;
    if (typeof u.cache_creation_input_tokens === "number") usage.cache_creation_input_tokens = u.cache_creation_input_tokens;
    if (typeof u.cache_read_input_tokens === "number") usage.cache_read_input_tokens = u.cache_read_input_tokens;
  }
  if (typeof obj.total_cost_usd === "number") usage.cost_usd = obj.total_cost_usd;
  if (typeof obj.num_turns === "number") usage.num_turns = obj.num_turns;
  if (typeof obj.duration_ms === "number") usage.cli_duration_ms = obj.duration_ms;
  if (Array.isArray(obj.permission_denials)) usage.permission_denials = (obj.permission_denials as unknown[]).length;
  return Object.keys(usage).length > 0 ? usage : undefined;
}

/**
 * Manifest notes for one dispatch: the claude session id when the CLI reports
 * one (so `claude --resume <id>` can reopen the phase's transcript), and on a
 * non-zero exit the CLI's own error subtype/result or the tail of stderr —
 * without this a failed phase is just an exit code in the manifest.
 */
export function dispatchNotes(result: DispatchResult): string[] {
  const notes: string[] = [];
  const obj = result.result;

  if (obj && typeof obj["session_id"] === "string") notes.push(`session:${obj["session_id"]}`);

  if (!result.ok) {
    const parts: string[] = [];
    if (obj && typeof obj["subtype"] === "string") parts.push(obj["subtype"] as string);
    if (obj && obj["is_error"] === true && typeof obj["result"] === "string") parts.push((obj["result"] as string).slice(0, 300));
    if (parts.length === 0 && result.stderr) parts.push(result.stderr.slice(-300));
    notes.push(`exit ${result.exitCode}: ${parts.join(" — ") || "no output"}`);
  }
  return notes;
}

/**
 * Parse codex `--json` JSONL stdout into DispatchUsage.
 * Looks for `turn.completed` events carrying usage data.
 * Returns undefined if no usage data is found.
 */
export function parseCodexUsage(stdout: string): DispatchUsage | undefined {
  try {
    const lines = stdout.split("\n").filter((l) => l.trim());
    for (const line of lines) {
      const obj = JSON.parse(line);
      if (obj.type === "turn.completed" && obj.usage) {
        const usage: DispatchUsage = {};
        if (typeof obj.usage.input_tokens === "number") usage.input_tokens = obj.usage.input_tokens;
        if (typeof obj.usage.output_tokens === "number") usage.output_tokens = obj.usage.output_tokens;
        if (typeof obj.usage.cached_input_tokens === "number") usage.cache_read_input_tokens = obj.usage.cached_input_tokens;
        return Object.keys(usage).length > 0 ? usage : undefined;
      }
    }
    return undefined;
  } catch {
    return undefined;
  }
}

function claudeProvider(): Provider {
  return {
    name: "claude",
    async dispatch(prompt, opts) {
      const result = await spawnProvider(buildClaudeArgs(opts), prompt, opts);
      result.usage = parseClaudeUsage(result.result);
      return result;
    },
  };
}

function codexProvider(): Provider {
  return {
    name: "codex",
    async dispatch(prompt, opts) {
      const result = await spawnProvider(buildCodexArgs(opts), prompt, opts);
      result.usage = parseCodexUsage(result.stdout);
      return result;
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
