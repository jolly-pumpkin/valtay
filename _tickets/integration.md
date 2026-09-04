# Integration verification (7c)

**Status:** not built
**Priority:** 11 (requires conformance + multi-unit runs)
**Phase:** 7c — after Conformance, before G6
**Artifact:** merged checkpoints + merged trace

## Description

Merge every unit's stack into a staging branch, run every unit's checkpoint against the merged state, and trace the merged state to catch emergent interactions invisible to per-unit review.

## Why it was deferred

Degenerate with one release unit — there is nothing to integrate when there is only one unit.

## Depends on

- Multi-unit runs (more than one release unit in practice)
- Conformance (7b)

## References

- `docs/design.md` section 11.3
- `docs/IMPLEMENTED.md` "Deliberately not built"
