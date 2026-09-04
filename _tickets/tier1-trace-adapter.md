# Tier 1 trace adapter

**Status:** not built
**Priority:** 7 (highest-leverage for enforcement, after dogfooding path)

## Description

A deterministic runtime trace adapter that records the actual call sequence from a headless mode. This is Tier 1 in the trace adapter hierarchy — exact traces that may block builds, unlike the current Tier 3 agent-discovered traces which are advisory only.

## Why it matters

This is the single highest-leverage thing a project can do for its own agent workflow:

- Exact traces (not agent-guessed)
- Cheap probes
- Enforceable conformance (conformance can only block when `block_on = "runtime"`)
- Enables probe-as-sampler later

## Open question

What does a Tier 1 headless mode look like for a TypeScript service or a Go backend? This is entirely unspecified (design.md section 23, Q1).

## Blocks

- Conformance (7b) becoming enforceable

## References

- `docs/design.md` sections 14, 23 Q1
- `docs/IMPLEMENTED.md` "Next, in order" item 4
