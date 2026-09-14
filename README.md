# valtay

A harness that runs coding agents as a gated pipeline. You write the design,
the AI plans, builds, and verifies. If the build drifts from your design, the
run stops and shows you exactly where.

The runner dispatches to provider CLIs — Claude Code (`claude -p`) or
Codex (`codex -q`) — based on your runspec config. All orchestration
(wave sorting, worktree management, merging) is deterministic TypeScript.
The AI only does creative work: planning, coding, verifying.

Named for the Valtay of *Dungeon Crawler Carl* — the relentlessly bureaucratic
species who administer things nobody asked them to administer.

## How it works

```
runspec (you) → plan (AI) → build (AI) → verify (AI)
                                             │
                                      drift? → STOP, shows you where
                                      clean? → done
```

## Quick start

```bash
bun install
bun link                          # puts `valtay` on PATH

valtay init                       # writes config + installs skills
valtay new my-change              # scaffold a run spec
# edit .valtay/runs/my-change/runspec.md — write your design
valtay run .valtay/runs/my-change/runspec.md
```

That's it. The runner creates the run, plans, builds in parallel worktrees,
verifies, and returns the result.

## Provider configuration

The runspec frontmatter declares which provider handles each phase:

```yaml
---
run: player-damage
host: claude                      # default provider for all phases
model: opus

phases:
  plan:   { host: claude, model: sonnet }
  build:  { host: codex, model: gpt-5.4-mini }
  verify: { host: claude, model: opus }
---
```

Mix and match — or use one provider for everything. The runner dispatches
to whatever CLI the runspec says.

## The run spec

The run spec is a single markdown file — your design, stated precisely enough
that the AI can plan, build, and verify against it.

```yaml
---
run: player-damage
created: 2026-09-06

host: claude
model: opus
effort: high

phases:
  plan:   { model: sonnet, effort: medium }
  build:  { model: opus,   effort: high }
  verify: { model: opus,   effort: high }

retries: 2
---

# Player takes damage when an enemy leaks

## Design

Enemies that reach the end of the path deal 1 damage to the player.

​```typescript
interface Player {
  health: number;      // starts at max_health
  max_health: number;  // default 20
}

function applyLeakDamage(player: Player, enemy: Enemy): void;
​```

## Out of scope

- Death screen
- Health pickups

## Notes

The game has a JSON mode at ~40k fps — use it for verification.
```

## What the runner does

```
valtay run runspec.md
    │
    ├── creates the run (freezes runspec, writes state.json)
    │
    ├── PLAN: dispatches to configured provider
    │         provider writes plan.md + briefs/RU-N.md
    │
    ├── BUILD: parses briefs, topo-sorts dependency waves
    │          for each wave:
    │            creates git worktrees per unit
    │            dispatches subagents in parallel
    │            merges worktree branches in order
    │            writes ledger.json
    │
    ├── VERIFY: dispatches to configured provider
    │           provider writes verify.json
    │
    └── returns: complete | drift | contested | blocked | failed
```

Build subagents work in isolated git worktrees. Wave ordering and merging
are handled by the runner in TypeScript — no tokens spent on mechanical work.

## After the run

If verify finds drift, the runner prints the findings and you decide:

```bash
valtay show verify.json           # see the findings
valtay approve verify             # accept drift and complete
valtay reject verify "fix X" --to build   # go back to build, re-run
```

If a build subagent contests a layer (says the plan is wrong), the run
halts and you resolve it:

```bash
valtay accept RU-1 L2             # mark layer done by exemption
valtay override RU-1 L2           # force re-build, no contesting
```

## Flows

### Happy path — `valtay run`

```
 YOU                         RUNNER                     PROVIDER
  │                           │                              │
  ├── valtay run runspec.md ─►│                              │
  │                           ├── create run ────────────────│
  │                           ├── dispatch plan ────────────►│
  │                           │              writes plan.md  │
  │                           ├── parse briefs, sort waves ──│
  │                           ├── dispatch build (parallel) ►│
  │                           │   ┌─ RU-1 in worktree ──────►│
  │                           │   └─ RU-2 in worktree ──────►│
  │                           │           writes reports/    │
  │                           ├── merge worktrees ───────────│
  │                           ├── dispatch verify ──────────►│
  │                           │           writes verify.json │
  │                           │   status: clean              │
  │  ◄── "complete" ──────────┤                              │
```

### Drift detected

```
  │  ◄── "drift: 2 findings" ─┤
  │                            │
  ├── valtay show verify.json  │
  │   ◄── "Player.health       │
  │       missing in build"    │
  │                            │
  │   (accept or fix)          │
  ├── valtay approve verify ──►│   → complete
  │   OR                       │
  ├── valtay reject verify ───►│   → re-enter at plan or build
  │     --to build             │
  ├── valtay run runspec.md ──►│   → re-run
```

## CLI commands

| Command | What it does |
|---|---|
| `valtay run <spec>` | Run the full pipeline: plan → build → verify |
| `valtay init` | Write config + install skills into the repo |
| `valtay upgrade` | Update skills to current version |
| `valtay new <name>` | Scaffold a run spec |
| `valtay check <spec>` | Advisory lint over a run spec |
| `valtay start <spec>` | Create a run without executing (for manual phase control) |
| `valtay status` | Where the run stands, phase by phase |
| `valtay show <artifact>` | Print an artifact |
| `valtay approve verify` | Accept drift findings |
| `valtay reject verify <reason> --to <phase>` | Reject and re-enter |
| `valtay override <unit> <layer>` | Force-build a contested layer |
| `valtay accept <unit> <layer>` | Accept a contestation by exemption |

## Skills

Valtay installs four skills into your coding harness:

- **valtay-compose** — helps you write run specs
- **valtay-plan** — cuts your design into release units and layers
- **valtay-build** — implements the plan (used by the runner for subagent prompts)
- **valtay-verify** — checks the build against your design for drift

Skills are also used as prompt templates by the runner when dispatching to providers.
