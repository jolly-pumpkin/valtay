# Example: a complete run spec

A filled-in spec, end to end. Note the density: the design is concrete (types
and signatures, not paragraphs), out-of-scope names its boundaries, and notes
carry actionable hints.

```markdown
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

Enemies that reach the end of the path currently vanish. They should deal
damage to the player instead.

### Structures

```typescript
// On Player — new fields
interface Player {
  health: number;      // current health, starts at max_health
  max_health: number;  // default 20
}
```

### Interfaces

```typescript
// New — called when an enemy completes the path
function applyLeakDamage(player: Player, enemy: Enemy): void;

// Changed — needs to return whether the player is still alive
function processWaveEnd(state: GameState): { alive: boolean };
```

### Intent

One damage per leaked enemy. The HUD shows current health. Running out of
health ends the run (but the death screen is out of scope).

## Out of scope

- Death / end-run screen
- Health pickups or regeneration
- Save migration
- Enemy damage variation (all enemies deal 1 damage for now)

## Notes

The game has a JSON mode that runs at ~40k fps. Prefer using it for
verification over the graphical mode.
```

## What makes this one work

- **Design is concrete.** Types and function signatures, not paragraphs. The
  builder knows exactly what to implement.
- **Out of scope names its boundaries.** "Death screen" is excluded explicitly,
  so the builder won't try to add one.
- **Notes carry actionable hints.** The JSON mode tip saves the verify phase
  time.
