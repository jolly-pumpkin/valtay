# Daemon — persistent sessions, tmux supervision, unattended pipeline

**Status:** not started
**Priority:** 4 (after auto-pass gates + dogfood prove the loop)

## Description

A background process that picks up approved runspecs and builds them unattended.
Green runs flow through without stopping. Drift stops the run, classifies the
problem, and waits. The daemon never merges — a human always owns that.

Full design: `docs/DAEMON.md`

## Execution model

Each phase runs in a **persistent native CLI session** (claude, codex, gemini)
inside its own tmux window, not as a headless `-p` one-shot. This gives the agent
its full feature set: context compaction, subagents, hooks, skills, CLAUDE.md.

The human can `tmux attach` and take over any phase. tmux is the supervisor, not
the execution model — falls back to headless when unavailable.

**Prompt delivery:** file-based handshake. Daemon writes to an inbox directory, the
agent's skill watches for it. No stdin piping, no terminal scraping. Host-agnostic.

## Halt classification

| Class | Causes | Recovery |
|---|---|---|
| `mechanical` | Timeout, bad JSON, crash, rate limit | Auto-retry |
| `needs-human` | Mandatory gate (G4, G6), drift, repeated failures | Parks, waits |

## Implementation phases

1. **Auto-pass gates** (`auto-pass-gates.md`) — conditional gate evaluation in the
   existing attended orchestrator. No daemon yet.
2. **Halt classification** — add `mechanical` vs `needs-human` to the failed state
3. **tmux session adapter** — new host adapter (`claude-code-native.ts`) that manages
   a persistent tmux session. Same `HostAdapter` interface as the headless adapter.
4. **The daemon loop** — `valtay daemon start`. Reads state, dispatches phases,
   evaluates gates, halts or advances.
5. **PR opening** — on completion, opens an implementation PR from the build worktree

## CLI

```
valtay daemon start [--run <name>] [--foreground]
valtay daemon status
valtay daemon stop
valtay daemon attach [--phase <id>]
```

## Depends on

- Auto-pass gates (`auto-pass-gates.md`) — unattended flow
- Dogfood self-run (`dogfood-self-run.md`) — proof the loop works end to end

## What the daemon does NOT do

- Never merges
- Never edits the runspec
- Never retries `needs-human` halts
- Never runs without an approved runspec
- No multi-run concurrency (v1)

## References

- `docs/DAEMON.md` — full design sketch
- `docs/design.md` §7.1 (invocation modes), §12.5 (attended vs unattended), §18.1 (daemon)
- `src/hosts/types.ts` — HostAdapter interface
- `src/hosts/claude-code.ts` — current headless adapter
- `src/run/orchestrator.ts` — advance() loop
