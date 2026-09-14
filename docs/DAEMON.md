# Valtay Daemon Design

## What it is

A background process that picks up approved runspecs and builds them unattended.
Green runs flow through without stopping. Drift stops the run, classifies the
problem, and waits. The daemon never merges — a human always owns that.

## Execution model: native persistent sessions in tmux

Each phase runs in a **persistent native CLI session** (claude, codex, gemini)
inside its own tmux window, not as a headless `-p` one-shot.

### Why persistent over one-shot

| Concern | One-shot (`-p`) | Persistent session |
|---|---|---|
| Context bootstrap | ~50K tokens per invocation | Once at session start |
| Course correction | Kill and re-spawn | Feed a follow-up prompt |
| Compaction | Dies at context limit | Auto-compact keeps it alive |
| Subagents | Can spawn, but parent dies after | Parent stays, subagents report back |
| Hooks | Fire, but session ends | Fire throughout, usable as mid-phase checks |
| CLAUDE.md / skills | Loaded fresh each time | Loaded once, kept warm |
| Human takeover | Can't — process already exited | `tmux attach`, same session |
| Host features | Subset (no /commands, no interactive skills) | Full native feature set |

### Why tmux

tmux is the supervisor, not the execution model. It provides:

- Process persistence (survives terminal disconnect)
- Named windows per phase (human can `tmux attach -t valtay:research`)
- Session survival across SSH drops
- Works identically for claude, codex, or gemini CLI

If the user doesn't have tmux, the daemon falls back to direct subprocess
(headless `-p` mode). tmux is preferred, not required.

## Architecture

```
valtay daemon start
  └─ tmux session "valtay-<run>"
       └─ daemon loop (Bun process)
            ├─ reads state.json + artifacts on disk
            ├─ determines next phase
            ├─ for each phase:
            │    ├─ creates tmux window "phase-<id>"
            │    ├─ spawns host CLI in that window
            │    ├─ delivers prompt via file-based handshake
            │    ├─ polls for artifact on disk
            │    ├─ validates artifact
            │    ├─ evaluates gate
            │    │    ├─ green → close window, advance
            │    │    └─ drift → halt, keep window for human
            │    └─ records manifest entry
            └─ all gates passed → open PR, stop
```

## Prompt delivery: file-based handshake

The daemon communicates with the running agent through files, not stdin piping
or terminal scraping. This is the most host-agnostic approach — any CLI that
reads CLAUDE.md / skills can pick up instructions from disk.

### The mechanism

1. Phase skill (SKILL.md) instructs the agent to watch an inbox directory
2. Daemon writes prompt to `.valtay/runs/<run>/inbox/<phase>.md`
3. Agent picks it up, does the work, writes artifact to the run directory
4. Daemon polls for the artifact, validates it, evaluates the gate

### Initial prompt

The first prompt is delivered as a CLI argument when spawning the session:

```bash
# tmux mode
tmux new-window -t "valtay-<run>" -n "phase-research" \
  "claude --model opus-4-6 --append-system-prompt <skill>"

# Then pipe the payload to the running session
# via tmux send-keys or file-based inbox
```

### Follow-up prompts (corrections, rejections)

When a gate rejects or validation fails:

1. Daemon writes correction to `.valtay/runs/<run>/inbox/<phase>-correction.md`
2. The skill's watch loop picks it up
3. Agent re-attempts within the same context window
4. No 50K token re-bootstrap, rejection reason stays in context

## The daemon loop

```
loop:
  state = read state.json
  if state.status == "complete" or "halted": idle()

  phase = current phase from state
  artifact = check artifact on disk

  if !artifact or state.rerun:
    session = ensure_session(phase)    # tmux window or subprocess
    deliver_prompt(session, phase)
    artifact = poll_for_artifact(phase, timeout)

    if !artifact:
      halt("mechanical", "phase timed out")
      continue

    validation = validate(artifact)
    if !validation.ok:
      deliver_correction(session, validation.error)
      artifact = poll_for_artifact(phase, retry_timeout)
      if !artifact or !validate(artifact).ok:
        halt("mechanical", validation.error)
        continue

  record_manifest(phase, artifact)

  gate = evaluate_gate(phase)
  if gate == "green":
    advance to next phase
  elif gate == "mandatory_stop":   # G4 probe, G6 diff
    halt("needs-human", "mandatory review")
  elif gate == "drift":
    halt("needs-human", "drift detected")
```

## Halt classification

Halts are classified so the daemon knows what it can retry on its own:

### mechanical
Retryable without human input. Causes:
- Phase timed out
- Validation failed after retries (bad JSON, missing heading)
- Host process crashed
- Rate limit hit (pause, resume when clear)

Auto-recovery: wait, retry. On base-branch advance, rebase worktree and
re-open affected gates (delta-aware invalidation).

### needs-human
Daemon won't touch it. Causes:
- Mandatory gate (G4 probe, G6 diff)
- Drift detected at a conditional gate
- Repeated mechanical failures (3x same phase = escalate)
- Typed rejection from a previous review

Recovery: human runs `valtay approve`, `valtay reject`, or `valtay resume --retry`.

## Gate evaluation (auto-pass when green)

Gates are red lights, not stop signs:

| Gate | Auto-pass condition | Always stops |
|---|---|---|
| G1 | Research found no contradictions with the design | No |
| G2 | Shape parses and matches the design's API surface | No |
| G3 | Slices are within budget | No |
| G4 | — | **Yes** (the probe) |
| G6 | — | **Yes** (the diff) |

The auto-pass evaluator is a lightweight LLM call (or deterministic check where
possible) that returns green/not-green. It is NOT the same model that produced
the artifact — the evaluator is always a different vendor or at minimum a fresh
context (invariant 9: producer doesn't grade its own work).

## Session management

### One session per phase
Each phase gets its own tmux window. Windows are named `phase-<id>` for
discoverability. The daemon tracks which windows are alive.

### Session lifecycle
- **Created** when the phase starts
- **Kept alive** during retries and corrections (same context)
- **Closed** when the phase passes its gate
- **Preserved** on halt (human can attach and investigate)

### Host switching between phases
The runspec declares which host runs each phase:
```yaml
roles:
  researcher: { host: claude, model: opus }
  prober:     { host: codex,  model: o3-pro }
```

Each tmux window spawns the right binary. Research opens `claude`, Probe opens
`codex`. The daemon doesn't care — it just reads the runspec and spawns.

## Worktree management

Same as current Valtay behavior:
- Read-only phases (research, reconcile, shape, plan) work in the repo root
- Write phases (probe, build) get isolated git worktrees
- Probe worktree is discarded after the trace is captured
- Build worktree is kept — it becomes the PR branch

## CLI interface

```bash
# Start the daemon for a run
valtay daemon start [--run <name>]

# Start in foreground (no tmux, for debugging)
valtay daemon start --foreground

# Check daemon status
valtay daemon status

# Stop gracefully (bounded drain, 30s timeout)
valtay daemon stop

# Attach to watch a phase
valtay daemon attach [--phase <id>]
# shorthand for: tmux attach -t valtay-<run>:phase-<id>
```

## Fallback: headless mode

When tmux is not available, the daemon falls back to the current behavior:
`claude -p` one-shot subprocesses via `Bun.spawn`. Same orchestrator loop, same
gate evaluation, just without persistent sessions or human-attachable windows.

The `HostAdapter` interface already supports this — `claude-code.ts` does
exactly this today. The daemon adds a second adapter path (`claude-code-native`)
that manages a tmux session instead of a one-shot subprocess.

## What the daemon does NOT do

- **Never merges** — opens a PR, human decides
- **Never edits the runspec** — the spec is frozen at start
- **Never runs without an approved runspec** — the merge/approval is the handoff
- **Never retries needs-human halts** — only mechanical failures auto-recover
- **No intake pipeline** — discovering issues and drafting specs is out of scope
- **No multi-run concurrency** (v1) — one run at a time per daemon instance

## Implementation phases

### Phase 1: Auto-pass gates
Make gates conditional in the existing attended orchestrator. G1-G3 auto-pass
when their predicate is green. G4 and G6 always stop. No daemon yet — just
`valtay start` flowing further before stopping.

### Phase 2: Halt classification
Add `mechanical` vs `needs-human` to the failed state. `valtay resume --retry`
for mechanical, explicit human action for needs-human.

### Phase 3: tmux session adapter
A second host adapter that manages a persistent tmux session instead of a
one-shot subprocess. File-based prompt delivery. Artifact polling.

### Phase 4: The daemon loop
`valtay daemon start` — the outer loop that reads state, dispatches phases,
evaluates gates, and halts or advances. Uses the tmux adapter when available,
falls back to headless.

### Phase 5: PR opening
On run completion, the daemon opens an implementation PR from the build
worktree. Never merges.
