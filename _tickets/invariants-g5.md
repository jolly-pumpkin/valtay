# Invariants phase (6) and G5

**Status:** not built
**Priority:** 5 (cheapest unbuilt phase, after dogfooding path)
**Phase:** 6 — after Assess, before Build
**Artifact:** executable checks
**Gate:** G5

## Description

The warden role produces executable checks (not prose) from the assessment and ledger. G5 is a budget gate where you approve those checks before Build begins.

## Why it was deferred

Additive — nothing in a single-unit run consumes invariant checks. G5 is absent rather than auto-passed, so nothing records an approval nobody gave.

## Priority

Listed as item 2 in "Next, in order" — the cheapest unbuilt phase.

## References

- `docs/design.md` sections 8, 12.1, 15
- `docs/IMPLEMENTED.md` "Deliberately not built"
