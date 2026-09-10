# valtay

A harness that runs coding agents as a gated pipeline. You write the design,
the AI plans, builds, and verifies. If the build drifts from your design, the
run stops and shows you exactly where.

The orchestrator never spawns agents — it's a state machine watching for
artifacts on disk. You invoke each phase as a skill in your interactive coding
session (Claude Code, Codex, etc). The CLI just tracks state and enforces gates.

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

valtay init                       # writes valtay.toml + installs skills (commit them)
valtay new my-change              # scaffold a run spec
# edit .valtay/runs/my-change/runspec.md — write your design
valtay start .valtay/runs/my-change/runspec.md
```

## The run loop

```bash
# 1. Run the plan skill in your Claude Code session
#    → it reads your design, writes plan.md to the run dir
valtay advance                    # CLI sees plan.md, advances to build

# 2. Run the build skill
#    → it reads plan.md + your design, implements the code
valtay advance                    # CLI sees build.md, advances to verify

# 3. Run the verify skill
#    → it compares what was built against your design
valtay advance                    # clean? done. drift? parks for your review.

# If drift:
valtay show verify.json           # see the findings
valtay approve verify             # accept drift and complete
valtay reject verify "fix X" --to build   # go back to build
```

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

## CLI commands

| Command | What it does |
|---|---|
| `valtay init` | Write config + install skills into the repo |
| `valtay new <name>` | Scaffold a run spec |
| `valtay check <spec>` | Advisory lint over a run spec |
| `valtay start <spec>` | Validate and open a run |
| `valtay advance` | Check for new artifacts and advance |
| `valtay status` | Where the run stands, phase by phase |
| `valtay show <artifact>` | Print an artifact |
| `valtay approve verify` | Accept drift findings |
| `valtay reject verify <reason> --to <phase>` | Reject and re-enter |

## Skills

Valtay installs four skills into your coding harness:

- **valtay-compose** — helps you write run specs
- **valtay-plan** — cuts your design into release units and layers
- **valtay-build** — implements the plan
- **valtay-verify** — checks the build against your design for drift
