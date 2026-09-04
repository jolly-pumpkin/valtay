# Run spec format

YAML frontmatter (machine-readable config) + Markdown body (human-readable intent).
Section boundaries are enforcement boundaries — the Research phase receives only
`## Assumptions to verify`.

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

- **`sources`** — pointers to existing documents. Reconcile diffs these against the
  codebase. If `design` is absent, Reconcile writes one instead of a delta.
- **`roles`** — merged over `valtay.toml` and `~/.valtay/config.toml` at run start,
  then frozen in the manifest. Most specific wins.
- **`skills`** — `used_by` controls which phase invocations load the skill. `provides`
  is a tag for the orchestrator (e.g. a phase that needs `oracle` fails fast if no
  skill provides it).
- **`mode`** — attended runs deep (the user clears gates as they go); unattended runs
  wide (all units advance to their first unpassable gate, then park).
- **Model strings are opaque.** Valtay never validates or normalizes them.
- **Gates `G1`, `G2`, and `G6` can never be pre-authorized** via `auto_pass_if`.

## Body sections

Seven sections. Order matters for readability, not parsing.

### `## Intent`

What the user wants to be true when this run ships. One paragraph. Not how — that is
the design's job. Not what tickets say — the author is the authority on scope.

### `## Tickets`

Each ticket as a bold ID, a dash, and a one-line summary. The plan may merge, split,
reorder, or defer these — they are advisory input, not binding structure.

```markdown
**LIN-483 — wave-completion event in sim**
Sim emits an event when an enemy reaches the end of the path.
```

### `## Conflicts`

Cross-document contradictions, with resolution status. Each conflict gets an ID and a
resolution arrow.

```markdown
- **C-1** LIN-484 puts health on `Player`; tech design §2 puts it on `RunState`.
  → **RESOLVED: Player.** RunState is serialized to save files and adding a field
  breaks save compatibility.
- **C-2** PRD §3 says health persists across waves; LIN-485 implies per-wave reset.
  → **UNRESOLVED** — needs product decision before start.
```

An unresolved conflict blocks the start of a run. Resolve it or move it to out-of-scope.

### `## Gaps`

Design coverage holes. Each gets an ID and a disposition: in-scope (Reconcile handles
it) or out-of-scope (acknowledged, excluded).

```markdown
- **G-1** LIN-486 has no tech design coverage. → in scope, design it in Reconcile.
- **G-2** No ticket covers migrating existing saves. → **out of scope**.
```

### `## Assumptions to verify`

**The only section Research receives.** Research never sees Intent, Tickets, Conflicts,
Gaps, or anything else. Blindness is enforced by the section boundary.

Frame each assumption as something to **verify**, not a claim. Research investigates;
Reconcile compares findings against the design. The value is the gap between what was
assumed and what the code actually does.

```markdown
- **A-1** Tech design §4.2 assumes `sim` emits events. Verify: it may mutate
  `RunState` directly.
- **A-2** Assumes enemies are removed on leak. Verify: they may be marked, not removed.
```

### `## Out of scope`

Explicit exclusions. Naming them prevents scope creep in planning and protects against
a helpful agent pulling adjacent work in.

### `## Notes`

Free-form. Hints for the pipeline — probe iteration preferences, known quirks, anything
that doesn't fit elsewhere.

## Section contract

| Section | Consumed by | Notes |
|---|---|---|
| Frontmatter | Orchestrator | Merged at run start, frozen in manifest |
| Intent | Reconcile, Plan | Scope authority |
| Tickets | Plan | Advisory; plan may restructure |
| Conflicts | Reconcile | Must all be resolved before start |
| Gaps | Reconcile, Plan | Dispositioned coverage holes |
| Assumptions to verify | **Research only** | Blind — no other section visible |
| Out of scope | Plan, Build | Exclusion fence |
| Notes | Any phase | Hints, not constraints |

## Lifecycle

1. **`valtay new`** — scaffold with TODOs
2. **The user + a session** — fill it out (this skill helps)
3. **Start the run** — the spec's SHA is frozen into the manifest, so editing it
   mid-run is a detected event rather than a silent divergence
4. **Post-run** — an immutable record of what was requested
