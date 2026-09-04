# Dogfood: run Valtay on itself

**Status:** not started
**Priority:** 3 (after skills-as-phases and auto-pass-gates)

## Description

Run Valtay on itself using the new skill-based phases and conditional gates. This validates three things at once:

1. **Skills as phases** work end-to-end through a real pipeline run
2. **Auto-pass gates** flow through when predicates are met
3. **Artifacts as state** — the pipeline recovers and resumes correctly

Pick a change with real structural risk so the probe has a chance to return `fix_lives_in: design.md` and the escalation loop actually fires. The first run was a small additive change (valtay check); a fair test needs complexity where a reviewer would struggle to reconstruct the control flow.

## Proves

- The refactored pipeline works end-to-end
- The escalation loop works (C2 under real structural complexity)
- Unattended flow through budget gates
- The pipeline is self-hosting

## Depends on

- Skills as phases (`skills-as-phases.md`)
- Auto-pass gates (`auto-pass-gates.md`)

## References

- `docs/IMPLEMENTED.md` "Next, in order" item 1
- `docs/IMPLEMENTED.md` "What the first run does not prove"
