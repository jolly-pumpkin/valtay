# Conformance (7b)

**Status:** not built
**Priority:** 10 (requires tier 1 trace adapter)
**Phase:** 7b — after Build, before Integration
**Artifact:** trace diff (approved vs built)

## Description

Re-trace the built code and diff against the approved trace. Detects nodes added or removed, status changes, files touched outside the declared set, and layers mixing mechanical with semantic changes.

## Why it was deferred

`block_on = "runtime"` makes it advisory at Tier 3, so it cannot fail a build. It needs a runtime oracle (Tier 1 trace adapter) before it is worth having.

## Depends on

- Tier 1 trace adapter (ticket: `tier1-trace-adapter.md`)

## References

- `docs/design.md` section 11.2
- `docs/IMPLEMENTED.md` "Deliberately not built"
