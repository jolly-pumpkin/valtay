# Retro and ledger promotion (8)

**Status:** not built
**Priority:** 12 (needs ledger history from many runs)
**Phase:** 8 — after Integration/G6
**Artifact:** ledger entries

## Description

After a run completes, the retro phase reads the manifest, assessments, and approvals, and writes entries to `ledger-project.jsonl` and `ledger-harness.jsonl`. After 3 recurrences of a pattern, promotion surfaces a proposal (a diff against a hook, phase prompt, or config value) requiring human approval.

## Why it was deferred

Needs many runs of ledger history before promotion has data to act on. The ledger is written from run one so history cannot be backfilled, but promotion itself needs three recurrences.

## References

- `docs/design.md` sections 16.1, 16.2
- `docs/IMPLEMENTED.md` "Deliberately not built"
