# Assess phase (5b)

**Status:** not built
**Priority:** 9 (requires second host adapter)
**Phase:** 5b — after Probe, before Invariants
**Artifact:** `assessment.json`
**Gate:** feeds G4

## Description

Cross-vendor classification of probe deviations. The assessor receives the probe diff and approved artifacts, and classifies each deviation as cosmetic, local, or structural.

`fix_lives_in` drives control flow — structural deviations escalate to the named artifact's phase.

## Why it was deferred

The human classifies deviations at G4 today. The design (section 16.3) frames the assessor as a prioritizer, not an authority. With only one vendor installed it cannot satisfy invariant 9 (whoever produced an artifact does not grade it).

## Depends on

- A second host adapter (for cross-vendor grading)

## References

- `docs/design.md` sections 10.3, 16.3
- `docs/IMPLEMENTED.md` "Deliberately not built"
