# Auto-pass gates — conditional gate evaluation

**Status:** not started
**Priority:** 2 (dogfooding prerequisite)

## Description

Evaluate `auto_pass_if` predicates so gates can pass without human approval when
conditions are met. Currently the predicate is parsed into the config type
(`config.ts:49`) and appears in the `valtay new` template, but `advance()` in
`orchestrator.ts` never evaluates it — every gate blocks unconditionally.

This is Phase 1 of the daemon implementation path (see `daemon.md`).

## What changes

- Add a predicate evaluator (~30 lines) that resolves expressions like
  `layers <= 4 and multiteam_layers <= 1 and max_semantic_loc <= 200 and new_flags == 0`
  against plan/artifact data
- Wire it into `orchestrator.ts:107` before the `isApproved` check
- When a predicate passes, auto-record an approval with `decision: "auto"` and the
  predicate that cleared it
- Respect design.md §12.4 restrictions:
  - **G1, G2, G6 — never auto-pass** (judgment gates)
  - **G3, G5 — yes** (budget gates)
  - **G4 — only when `trace.source == "runtime"` and zero structural deviations**

## Why now

Without auto-pass, every run blocks 4+ times for human input. Unattended runs
(design.md §12.5) are impossible, which means the daemon (§18.1) is useless even if
it exists. This is the single gate between "works attended" and "works unattended."

Gates are red lights, not stop signs — green runs should flow through. This ticket
makes that real.

## Enables

- Unattended runs (design.md §12.5)
- Running Valtay on itself (`dogfood-self-run.md`)
- Daemon (`daemon.md`) — Phase 1 of the daemon path

## References

- `src/config.ts:49` — `auto_pass_if` in type, never evaluated
- `src/run/orchestrator.ts:107` — unconditional gate block
- `src/run/store.ts` — approval recording
- `docs/design.md` §12.4 — pre-authorization rules
- `docs/design.md` §12.5 — attended vs unattended vs daemon
- `docs/DAEMON.md` — daemon design (Phase 1)
