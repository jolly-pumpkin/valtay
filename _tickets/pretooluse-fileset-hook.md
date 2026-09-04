# PreToolUse file-set hook

**Status:** not built
**Priority:** 6 (after dogfooding path and invariants)

## Description

Move the file-set fence from detection (checking the commit after the fact) to prevention (blocking the write before it happens) using a `PreToolUse` hook.

A builder on layer L3 may only write files in its declared set. The hook denies Edit/Write/NotebookEdit for files outside the set, making it impossible for a worker to silently add a third team to a PR.

## Current state

The file-set fence exists as detection — the commit is checked afterwards. The code knowingly differs from the design here (documented in IMPLEMENTED.md).

## References

- `docs/design.md` section 15.1
- `docs/IMPLEMENTED.md` "Where the code knowingly differs from the design"
- `docs/IMPLEMENTED.md` "Next, in order" item 3
