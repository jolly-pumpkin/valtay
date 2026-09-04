# RUNSPEC.md — Run Specification Format

The run spec is the single input to a Valtay run. One Markdown file you author,
in whatever session you like. Valtay's first model call is Research; the run spec
is pure human artifact.

`valtay new` scaffolds one with TODO markers. `valtay check` lints it
cross-vendor. `valtay start` freezes its SHA into the manifest.

---

## Format

YAML frontmatter (machine-readable config) + Markdown body (human-readable
intent). Section boundaries are enforcement boundaries — Research receives
only `## Assumptions to verify`.

---

## Frontmatter

```yaml
---
run: <name>
repo: <path>
created: <date>
mode: attended | unattended

sources:
  prd:     <path-or-link>          # optional
  design:  <path-or-link>          # optional — Reconcile writes one if absent
  epic:    <tracker-id>            # optional
  tickets: [<id>, ...]

roles:
  # Override host/model/effort per role. Omit to use valtay.toml defaults.
  # Vendor diversity rule: whoever produced an artifact should not grade it.
  <role>: { host: <host>, model: <model>, effort: <effort> }

skills:
  - name: <skill-name>
    path: <path>
    used_by: [<role>, ...]         # which phases load this skill
    provides: <capability>         # tests | oracle | lint | ...

trace:
  tier: runtime | static | agent
  command: "<command with {scenario} placeholder>"

layers:
  "<glob>": <layer-name>

plan:
  stacking: gh-stack | graphite | none
  max_semantic_loc: <int>
  max_teams_per_layer: <int>
  max_multiteam_per_unit: <int>

run_budget:
  max_units: <int>
  max_layers: <int>
  max_trace_nodes: <int>

gates:
  <gate>: { auto_pass_if: "<predicate>" }

artifacts_dir: <path>              # default: ~/.valtay/runs/<repo>/<run>
---
```

### Frontmatter rules

- **`sources`** — pointers to existing documents. Reconcile diffs these against
  the codebase. If `design` is absent, Reconcile writes one instead of a delta.
- **`roles`** — merged over `valtay.toml` and `~/.valtay/config.toml` at run
  start, frozen in the manifest. Most specific wins.
- **`skills`** — `used_by` controls which phase invocations load the skill.
  `provides` is a tag for the orchestrator (e.g., a phase that needs `oracle`
  fails fast if no skill provides it).
- **`mode`** — attended runs deep (you clear gates as you go); unattended runs
  wide (all units advance to their first unpassable gate, then park).
- **Model strings are opaque.** Valtay never validates or normalizes them.

---

## Body sections

Seven sections. Order matters for readability, not parsing.

### `## Intent`

What you want to be true when this run ships. One paragraph. Not how — that is
the design's job. Not what tickets say — you are the authority on scope.

### `## Tickets`

Each ticket as a bold ID, a dash, and a one-line summary. The plan may merge,
split, reorder, or defer these — they are advisory input, not binding structure.

```markdown
**LIN-483 — wave-completion event in sim**
Sim emits an event when an enemy reaches the end of the path.
```

### `## Conflicts`

Cross-document contradictions, with resolution status. Drafted by `valtay-compose`,
resolved by you editing this file. Each conflict gets an ID and a resolution arrow.

```markdown
- **C-1** LIN-484 puts health on `Player`; tech design §2 puts it on `RunState`.
  → **RESOLVED: Player.** RunState is serialized to save files and adding a field
  breaks save compatibility.
- **C-2** PRD §3 says health persists across waves; LIN-485 implies per-wave reset.
  → **UNRESOLVED** — needs product decision before start.
```

An unresolved conflict blocks `valtay start`. Resolve or move to out-of-scope.

### `## Gaps`

Design coverage holes. Each gets an ID and a disposition: in-scope (Reconcile
handles it) or out-of-scope (acknowledged, excluded).

```markdown
- **G-1** LIN-486 has no tech design coverage. → in scope, design it in Reconcile.
- **G-2** No ticket covers migrating existing saves. → **out of scope**.
```

### `## Assumptions to verify`

**The only section Research receives.** Research never sees Intent, Tickets,
Conflicts, Gaps, or anything else. Blindness is enforced by the section boundary
(design §8.2).

Frame each assumption as something to **verify**, not a claim. Research
investigates; Reconcile compares findings against the design. The value is the
gap between what you assumed and what the code actually does.

```markdown
- **A-1** Tech design §4.2 assumes `sim` emits events. Verify: it may mutate
  `RunState` directly.
- **A-2** Assumes enemies are removed on leak. Verify: they may be marked, not
  removed.
```

### `## Out of scope`

Explicit exclusions. Naming them prevents scope creep in planning and protects
against a helpful agent pulling adjacent work in.

### `## Notes`

Free-form. Hints for the pipeline — e.g., probe iteration preferences, known
quirks, anything that doesn't fit elsewhere.

---

## Section contract

| Section | Consumed by | Notes |
|---|---|---|
| Frontmatter | Orchestrator | Merged at run start, frozen in manifest |
| Intent | Reconcile, Plan | Scope authority |
| Tickets | Plan | Advisory; plan may restructure |
| Conflicts | Reconcile | Must all be resolved before `start` |
| Gaps | Reconcile, Plan | Dispositioned coverage holes |
| Assumptions to verify | **Research only** | Blind — no other section visible |
| Out of scope | Plan, Build | Exclusion fence |
| Notes | Any phase | Hints, not constraints |

---

## Scaffolding: `valtay new`

```
valtay new player-damage --repo . --tickets LIN-483,LIN-484,LIN-485
```

No model call. Pre-fills what is derivable without one:

- **`run` / `repo` / `created`** from args and clock
- **`sources.tickets`** from args
- **`roles`** from `valtay.toml` defaults (you override)
- **`skills`** from detected agent config (`.claude/`, `codex.json`, etc.)
- **`trace`** from `valtay.toml`
- **`layers`** from `valtay.toml`
- **`plan`** from `valtay.toml`
- **CODEOWNERS** resolved for ticket stubs if tracker adapter is configured
- **TODO markers** on everything else

Output: `~/.valtay/runs/<repo>/<name>/runspec.md` by default, or `--commit` to
place it in the repo.

---

## Linting: `valtay check`

```
valtay check runspec.md
```

Advisory, never blocking. Cross-vendor by default. Reports:

- Missing required sections
- Unresolved conflicts (these *do* block `start`)
- Assumptions phrased as claims instead of questions
- Gaps with no disposition
- Design references with no assumption coverage
- Constraints that contradict each other
- Out-of-scope items that overlap with ticket scope

No artifacts, no gate, no state. It is a lint.

---

## Lifecycle

1. **`valtay new`** — scaffold with TODOs
2. **You + a session** — fill it out (the `valtay-compose` skill helps)
3. **`valtay check`** — optional cross-vendor lint
4. **`valtay start`** — SHA frozen into manifest; editing mid-run is detected
5. **Post-run** — immutable record of what was requested

The session that helps you write the spec is a text editor with opinions.
Valtay reads a file, never a conversation.

---

## The skills `valtay init` installs

`valtay init` installs into `.claude/skills/` at the init root:

| Skill | Who loads it |
|---|---|
| `valtay-compose` | you, drafting a spec — the session picks it up automatically |
| `valtay-research` … `valtay-build` | the host, when a phase runs |

`valtay-compose` carries the completeness checklist plus `reference/format.md` (this
format, self-contained) and `reference/example.md` (the filled example below). The
phase skills are the phases themselves: an adapter names `/valtay-research` and the
host loads the file, which is what lets a second host run the same phase without
Valtay knowing how that host injects instructions (design.md §7.4).

**Commit `.claude/skills/`.** Probe and Build run in a git worktree, which carries
tracked files only — an uncommitted phase skill is a phase that cannot start, and the
run halts saying so before it spends anything.

The install is gated on the repo already having a `.claude/` directory, so Valtay
never creates one in a project that doesn't use Claude. Pass `--skill` to install
anyway, or `--force` to overwrite copies you have since hand-edited.

---

## Full example

```yaml
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
  researcher: { host: claude, model: opus,           effort: high }
  designer:   { host: claude, model: opus,           effort: high }
  shaper:     { host: claude, model: opus,           effort: high }
  planner:    { host: claude, model: opus,           effort: high }
  prober:     { host: codex,  model: gpt-5.6-luna,   effort: max }
  assessor:   { host: codex,  model: gpt-5.6-terra,  effort: high }
  warden:     { host: claude, model: opus,           effort: high }
  builder:    { host: codex,  model: gpt-5.6-luna,   effort: max }
  critic:     { host: codex,  model: gpt-5.6-sol,    effort: high }

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
