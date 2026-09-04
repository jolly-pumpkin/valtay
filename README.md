# valtay

A host-agnostic harness that runs coding agents as a gated pipeline of short,
fresh-context phases, and makes the reviewable artifact an executable call trace
instead of a wall of prose.

Named for the Valtay of *Dungeon Crawler Carl* — the relentlessly bureaucratic
species who administer things nobody asked them to administer. The name is a design
commitment: gates that will not open without evidence, approvals bound to artifact
hashes, an append-only manifest, and an orchestrator that contains no model.

```bash
bun install
bun link                                    # puts `valtay` on PATH

valtay init                                 # valtay.toml + .valtay/ + the skills (commit them)
valtay new my-change --repo . --tickets T-1 # scaffold a run spec, no model call
valtay check runspec.md                     # advisory lint
valtay start runspec.md                     # Research -> ... -> G1

valtay status                               # where the run stands
valtay show design                          # read what you are deciding about
valtay approve G1                           # ...and carry on
valtay reject G1 "does health persist?" --to design
valtay trace RU-1                           # the call path, as path:line:col
```

## Docs

- **`docs/PRD.md`** — the argument. Why review a path rather than a paragraph.
- **`docs/design.md`** — the design. Phases, gates, adapters, ledgers, invariants.
- **`docs/RUNSPEC.md`** — the run spec format, the single input to a run.
- **`docs/IMPLEMENTED.md`** — what is actually built, and what the first run
  changed about the design.

Valtay has been used to build Valtay: `src/commands/check.ts` was produced by a
complete run through all six gates.
