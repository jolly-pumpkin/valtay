# Second host adapter and cross-vendor critic

**Status:** not built
**Priority:** 8 (after skills-as-phases makes it buildable)

## Description

Install a second host adapter (e.g., Codex) so that invariant 9 (whoever produced an
artifact does not grade it) can be satisfied. Currently only `claude-code` (headless)
is installed, so the cross-vendor critic and cross-vendor assessment are impossible.

## Two kinds of new adapter

1. **Cross-vendor headless** (this ticket) — a `codex` adapter that runs
   `codex exec -m <model>` as a headless one-shot, same pattern as the existing
   `claude-code` adapter. Enables the critic role and vendor diversity.

2. **Native/tmux adapter** (`daemon.md` Phase 3) — a `claude-code-native` adapter
   that manages a persistent tmux session instead of a one-shot subprocess. Same
   `HostAdapter` interface, different lifecycle. Enables the daemon.

Both produce `HostResult` through the same interface. The native adapter is for the
daemon; this ticket is for cross-vendor review.

## Enables

- Assess phase (5b) — cross-vendor grading
- `valtay check` running cross-vendor by default (currently falls back to same vendor)
- Critic role at G1 and G6

## References

- `docs/design.md` §6, §7 (binding, host adapters)
- `docs/design.md` §7.1 (headless vs native invocation modes)
- `docs/IMPLEMENTED.md` "Deliberately not built"
- `docs/DAEMON.md` — native adapter as daemon Phase 3
