import { resolve } from "path";
import { tmpdir } from "node:os";
import { rm } from "node:fs/promises";
import { stripFence, type HostAdapter, type HostRequest, type HostResult } from "./types.ts";

/**
 * The `--json` events this adapter reads.
 *
 * `codex exec --json` emits JSONL: `thread.started`, `turn.started`,
 * `item.started` / `item.completed` (item types `agent_message`, `reasoning`,
 * `command_execution`, `error`), then `turn.completed` or `turn.failed`. Everything
 * else is ignored rather than typed — the stream carries more than a phase needs.
 */
interface CodexEvent {
  type?: string;
  message?: string;
  item?: { type?: string; text?: string; message?: string };
  usage?: Record<string, unknown>;
  error?: { message?: string };
}

/**
 * The sandbox a read-only phase runs under.
 *
 * Verified against codex-cli 0.153.3 with `codex sandbox`: under `read-only` a write
 * anywhere — inside the working root included — fails with "Read-only file system",
 * while reads outside it still succeed. That is the same fence `--permission-mode
 * dontAsk` gives claude-code, reached from the other direction: claude denies the
 * write *tools*, codex denies the write *syscall*.
 */
const READ_ONLY_SANDBOX = "read-only";

/**
 * What a write phase runs under.
 *
 * Not `danger-full-access`, and not `--dangerously-bypass-approvals-and-sandbox`:
 * both are the codex analogue of the `bypassPermissions` finding in
 * `claude-code.ts` — the absence of a fence rather than a fence. `workspace-write`
 * confines writes to the working root, which is the worktree, which is exactly the
 * boundary Valtay already relies on.
 *
 * Verified: writing under the working root succeeds, writing to its parent fails.
 * Note that codex also treats `/tmp` and `$TMPDIR` as writable roots by default, so
 * a worktree placed under `/tmp` has a wider fence than one placed elsewhere — that
 * is codex's default, not a choice this adapter makes.
 */
const WRITE_SANDBOX = "workspace-write";

/**
 * Builds the argv for one invocation.
 *
 * `codex exec` defaults to `approval: never` (confirmed in its own startup banner),
 * so there is no approval flag to pass — a headless phase is never asked to confirm
 * a command.
 *
 * `readDirs` is deliberately absent. `--add-dir` exists, but its documented meaning
 * is "additional directories that should be **writable**", and reads outside the
 * working root already succeed under both sandboxes (verified above). Passing the
 * run directory would therefore buy nothing and would let a write phase write into
 * the run's own artifacts — widening the fence to fix a problem that does not exist.
 */
export function codexArgs(request: HostRequest, lastMessagePath: string): string[] {
  const { binding, write } = request;

  const args = [
    "exec",
    "--json",
    "--skip-git-repo-check",
    "--model",
    binding.model,
    "--cd",
    request.workdir,
    "--sandbox",
    write ? WRITE_SANDBOX : READ_ONLY_SANDBOX,
    "--output-last-message",
    lastMessagePath,
  ];

  // `-c key=value` parses `value` as TOML and falls back to a literal string.
  // `model_reasoning_effort` is a real config field, not a guess: `--strict-config`
  // accepts it and rejects a typo of it, and setting it changes the "reasoning
  // effort:" line in codex's startup banner.
  if (binding.effort) args.push("-c", `model_reasoning_effort=${binding.effort}`);

  // `-` makes codex read the prompt from stdin. Same reason as claude-code: it lifts
  // the argv length ceiling, which matters once a phase's inputs are several
  // artifacts long.
  args.push("-");
  return args;
}

/**
 * The stdin payload: the phase's instructions, then its inputs.
 *
 * This is where codex differs from claude-code, and the difference is a capability
 * gap rather than a preference. design.md §7.4 wants an adapter to deliver a **name**
 * — and codex has no way to accept one. Verified against 0.153.3: a leading
 * `/valtay-research` is passed through to the model verbatim (the turn's input item
 * is the literal text, with no expansion), naming a skill that does not exist raises
 * nothing at all, and codex's own skill loading is a *relevance* ranking over the
 * installed catalogue — the binary runs `weighted_lexical_v1`, `fielded_bm25_v1` and
 * friends to guess which skill the prompt is about.
 *
 * A phase chosen by lexical similarity is precisely what the orchestrator exists to
 * prevent, so the body is inlined instead. The skill is still installed at
 * `.codex/skills/valtay-<phase>/SKILL.md` (`skills.ts`), because that keeps the
 * pre-flight check honest, keeps `prompt_sha` a hash of a real file, and is where
 * this belongs the day codex grows a deterministic invocation.
 *
 * The body is fenced in a `<skill>` element because that is the shape codex's own
 * loader uses for injected skills, so the model sees instructions in a form it
 * already treats as instructions.
 */
export function codexPayload(skillBody: string, input: string): string {
  return `<skill>\n${skillBody.trim()}\n</skill>\n\n${input}`;
}

/**
 * Pulls the artifact, usage and failure out of a `--json` run.
 *
 * The last `agent_message` wins: a turn can emit several, and the final one is the
 * answer. `turn.failed` and top-level `error` events carry codex's own text, which is
 * reported unparaphrased.
 */
export function parseCodexStream(stdout: string): {
  message?: string;
  usage?: Record<string, unknown>;
  error?: string;
} {
  let message: string | undefined;
  let usage: Record<string, unknown> | undefined;
  let error: string | undefined;

  for (const line of stdout.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed.startsWith("{")) continue;

    let event: CodexEvent;
    try {
      event = JSON.parse(trimmed) as CodexEvent;
    } catch {
      continue; // A partial line from a killed process is not a parse failure.
    }

    if (event.type === "item.completed" && event.item?.type === "agent_message") {
      message = event.item.text ?? event.item.message ?? message;
    }
    if (event.type === "turn.completed" && event.usage) usage = event.usage;
    if (event.type === "turn.failed") error = event.error?.message ?? "codex reported turn.failed";
  }

  return {
    ...(message === undefined ? {} : { message }),
    ...(usage === undefined ? {} : { usage }),
    ...(error === undefined ? {} : { error }),
  };
}

/**
 * Where the final message is dropped.
 *
 * Deliberately not inside `workdir`. For a read-only phase the working directory is
 * the user's own checkout, which a read-only phase has no business writing to even
 * briefly; for a write phase it is the worktree whose file set Build inspects, where
 * a stray file is exactly what the fence is looking for. The temp directory is
 * neither.
 *
 * Safe despite the sandbox: `--sandbox` governs the shell commands the *model* runs,
 * not the CLI's own output file, so this is written even under `read-only`.
 */
function lastMessagePathFor(): string {
  const unique = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  return resolve(tmpdir(), `valtay-codex-${unique}.txt`);
}

async function invoke(request: HostRequest): Promise<HostResult> {
  const started = Bun.nanoseconds();
  const lastMessagePath = lastMessagePathFor();

  const notes: string[] = [];
  // The skill is read here rather than passed in because `HostRequest` carries a name
  // and a path — a body is this adapter's problem, not the orchestrator's.
  let skillBody: string;
  try {
    skillBody = await Bun.file(request.skill.path).text();
  } catch {
    return {
      output: "",
      exit_code: 1,
      duration_s: (Bun.nanoseconds() - started) / 1e9,
      error: `could not read ${request.skill.path}`,
    };
  }

  notes.push(
    `codex has no deterministic skill invocation; ${request.skill.name} was inlined from ${request.skill.path}`
  );
  if (request.readDirs?.length) {
    notes.push(
      `readDirs not passed to codex: reads outside the working root are already permitted, and --add-dir grants writes (${request.readDirs.join(", ")})`
    );
  }

  try {
    const proc = Bun.spawn([request.host.bin, ...codexArgs(request, lastMessagePath)], {
      cwd: request.workdir,
      stdin: new TextEncoder().encode(codexPayload(skillBody, request.input)),
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
    const parsed = parseCodexStream(stdout);
    const common = { duration_s, notes, ...(parsed.usage ? { usage: parsed.usage } : {}) };

    // Not a formality: on a network outage codex retries forever rather than
    // exiting, so the spawn timeout is the only thing that ends the invocation.
    if (proc.signalCode) {
      return {
        ...common,
        output: "",
        exit_code: exitCode ?? 1,
        error: `${request.host.bin} killed by ${proc.signalCode} after ${Math.round(duration_s)}s (timeout ${request.timeout_ms}ms)`,
      };
    }

    if (exitCode !== 0) {
      return {
        ...common,
        output: "",
        exit_code: exitCode,
        // `||`, not `??`: an empty stderr is a string, so `??` would fall through to
        // it and hand back an empty error — which `runPhase` reads as no failure at
        // all, turning a crashed invocation into a silently empty artifact.
        error: parsed.error || stderr.trim() || `${request.host.bin} exited ${exitCode}`,
      };
    }

    if (parsed.error) {
      return { ...common, output: "", exit_code: 1, error: parsed.error };
    }

    // `--output-last-message` is the artifact, and codex does not write the file at
    // all when a turn does not complete — so its absence is a reliable failure
    // signal rather than an empty answer. The event stream is the fallback.
    const file = Bun.file(lastMessagePath);
    const text = (await file.exists()) ? await file.text() : parsed.message;

    if (text === undefined) {
      return {
        ...common,
        output: "",
        exit_code: 1,
        error: `${request.host.bin} produced no final message`,
      };
    }

    return { ...common, output: stripFence(text), exit_code: 0 };
  } finally {
    await rm(lastMessagePath, { force: true }).catch(() => {});
  }
}

export const codexAdapter: HostAdapter = { name: "codex", run: invoke };
