# Example: a complete run spec

A filled-in spec, end to end. Note the density: resolutions say *why*, gaps carry
dispositions, and every assumption stands on its own without the rest of the file.

```markdown
---
run: player-damage
repo: ~/work/foundry
created: 2026-09-02
mode: attended

sources:
  prd:     ~/work/docs/plant3-prd.md
  design:  ~/work/docs/plant3-tech-design.md
  epic:    LIN-482
  tickets: [LIN-483, LIN-484, LIN-485, LIN-486]

roles:
  intake:     { host: codex,  model: gpt-5.6-sol,   effort: high }
  researcher: { host: claude, model: opus,          effort: high }
  designer:   { host: claude, model: opus,          effort: high }
  shaper:     { host: claude, model: opus,          effort: high }
  planner:    { host: claude, model: opus,          effort: high }
  prober:     { host: codex,  model: gpt-5.6-luna,  effort: max }
  assessor:   { host: codex,  model: gpt-5.6-terra, effort: high }
  warden:     { host: claude, model: opus,          effort: high }
  builder:    { host: codex,  model: gpt-5.6-luna,  effort: max }
  critic:     { host: codex,  model: gpt-5.6-sol,   effort: high }

skills:
  - name: foundry-test-suite
    path: ~/.claude/skills/foundry-test-suite
    used_by: [prober, builder]
    provides: tests
  - name: foundry-headless
    path: ~/.claude/skills/foundry-headless
    used_by: [prober]
    provides: oracle

trace:
  tier: runtime
  command: "pnpm sim --json --scenario {scenario}"

layers:
  "src/ui/**":       ui
  "src/game/**":     game
  "src/platform/**": io

plan:
  stacking: gh-stack
  max_semantic_loc: 400
  max_teams_per_layer: 2
  max_multiteam_per_unit: 1

run_budget:
  max_units: 4
  max_layers: 10
  max_trace_nodes: 35

gates:
  G3: { auto_pass_if: "layers <= 4 and multiteam_layers <= 1 and new_flags == 0" }

artifacts_dir: ~/.valtay/runs/foundry/player-damage
---

# Player takes damage when an enemy leaks

## Intent

Enemies that reach the end of the path currently vanish with no consequence. The
player should lose health, the HUD should show it, and running out should end the
run. Scope is the damage path only — the death/end-run screen is a separate epic.

## Tickets

**LIN-483 — wave-completion event in sim**
Sim emits an event when an enemy reaches the end of the path.

**LIN-484 — player health model**
Health lives on the player, with a max and a current value.

**LIN-485 — apply damage on leak**
One damage per leaked enemy. Behind a flag.

**LIN-486 — HUD health indicator**
Display current health. No animation this pass.

## Conflicts

- **C-1** LIN-484 puts health on `Player`; tech design §2 puts it on `RunState`.
  → **RESOLVED: Player.** RunState is serialized to save files and adding a field
  breaks save compatibility.
- **C-2** PRD §3 says health persists across waves; LIN-485's acceptance criteria
  imply a per-wave reset.
  → **RESOLVED: persists.** Per-wave reset makes the damage meaningless.

## Gaps

- **G-1** LIN-486 has no tech design coverage. → in scope, design it in Reconcile.
- **G-2** No ticket covers migrating existing saves. → **out of scope**, saves are
  pre-release and can be invalidated.

## Assumptions to verify

- **A-1** Tech design §4.2 assumes `sim` emits events. Verify: it may mutate
  `RunState` directly.
- **A-2** Assumes enemies are removed on leak. Verify: they may be marked, not
  removed.
- **A-3** Verify whether the HUD has an existing subscription mechanism.

## Out of scope

- Death / end-run screen
- Health pickups or regeneration
- Save migration

## Notes

The `foundry-headless` skill runs the sim at ~40k fps, so probes are cheap here —
prefer more probe iterations over fewer.
```

## What makes this one work

- **Intent names its own boundary** ("the damage path only") and that boundary reappears
  verbatim in `## Out of scope`. Nothing is implied.
- **Both conflicts are real and both are resolved**, each with a reason that would let
  someone else reach the same decision.
- **Both gaps carry a disposition.** `G-2` is excluded *with a justification*, which is
  what keeps it from resurfacing during planning.
- **All three assumptions are self-contained and phrased as verifications.** Read them
  alone, with no other section visible — they still make sense, and none of them tells
  the researcher what to find. That is the test.
