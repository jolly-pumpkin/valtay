# Run spec format

YAML frontmatter (machine-readable config) + Markdown body (human-readable design).

## Frontmatter

```yaml
---
run: <name>
created: <date>

host: <host>                    # default host for all phases
model: <model>                  # default model
effort: <effort>                # default effort

phases:
  plan:   { model: <model>, effort: <effort> }
  build:  { model: <model>, effort: <effort> }
  verify: { model: <model>, effort: <effort> }

retries: <int>                  # max retry attempts for blocked layers (default: 1)
---
```

### Frontmatter rules

- **`host`, `model`, `effort`** — top-level defaults. Per-phase overrides merge over these.
- **`phases`** — override model/effort for individual phases. Omit to use defaults.
- **Model strings are opaque.** Valtay never validates or normalizes them.

## Body sections

Three sections. Order matters for readability, not parsing.

### `## Design`

The human's design: structures, interfaces, and intent. This IS the input to
the pipeline. The plan phase reads it to decide how to cut the work. The build
phase reads it to know what to implement. The verify phase reads it to check
for drift.

Write it as you would write a tech design — types, function signatures,
data flow, constraints. Code is better than prose where a declaration would do.

### `## Out of scope`

Explicit exclusions. Naming them prevents scope creep and stops the builder
from pulling adjacent work in.

### `## Notes`

Free-form hints for the pipeline. Delete the section if empty.

## Section contract

| Section | Consumed by | Notes |
|---|---|---|
| Frontmatter | Runner | Read at `valtay run`, frozen in run dir |
| Design | Plan, Build, Verify | The source of truth |
| Out of scope | Plan, Build | Exclusion fence |
| Notes | Any phase | Hints, not constraints |

## Lifecycle

1. **`valtay new`** — scaffold with TODOs
2. **The user** — fill it out (this skill helps)
3. **`valtay run`** — creates the run, freezes the spec's SHA, executes the pipeline
4. **Post-run** — an immutable record of what was requested
