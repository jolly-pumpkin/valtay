# Second host adapter and cross-vendor critic

**Status:** headless half built; native/tmux adapter not built
**Priority:** 8 (after skills-as-phases makes it buildable)

## Description

Install a second host adapter (e.g., Codex) so that invariant 9 (whoever produced an
artifact does not grade it) can be satisfied. Before this, only `claude-code`
(headless) was installed, so the cross-vendor critic and cross-vendor assessment were
impossible.

## Two kinds of new adapter

1. **Cross-vendor headless** — ~~a `codex` adapter that runs `codex exec -m <model>`
   as a headless one-shot, same pattern as the existing `claude-code` adapter~~
   **Built.** `src/hosts/codex.ts`, verified against codex-cli 0.153.3. See
   `docs/design.md` §7.2 for what the spike settled and what it could not.

2. **Native/tmux adapter** (daemon phase 3) — a `claude-code-native` adapter
   that manages a persistent tmux session instead of a one-shot subprocess. Same
   `HostAdapter` interface, different lifecycle. Enables the daemon. **Not built.**

Both produce `HostResult` through the same interface. The native adapter is for the
daemon; the headless one was for cross-vendor review.

## What the headless half landed

- `src/hosts/codex.ts` and its registration in `src/hosts/index.ts`.
- Skill roots per host family (`HOST_SKILL_ROOTS`, `skillRootFor`), threaded through
  `skillRelDir`, `installedSkillPath` and `phaseSkillIn`. A codex-bound phase now
  looks for its skill under `.codex/skills/`, and an unknown adapter throws rather
  than silently falling back to `.claude/skills/`.
- `valtay init` installs into every detected host's root. A codex-only repo used to
  get no phase skills at all.
- `HostResult.notes`, so a capability the host could not honor reaches the manifest
  on a successful invocation rather than only on a failure (design.md §7.1).

## Still open

- **No live run.** No OpenAI credentials were available in the environment where this
  was built, so no phase has been run end to end against a real codex model. The
  argv surface, config validation and sandbox behaviour are verified against the
  binary; the model round trip is not.
- **Codex cannot be handed a skill name**, so the adapter inlines the body. If codex
  gains a deterministic invocation, `codexPayload` is the one function to change —
  the file is already installed where its loader reads.

## Enables (each its own ticket, none built here)

- Assess phase (5b) — cross-vendor grading (`_tickets/assess-phase.md`)
- `valtay check` running cross-vendor. Note: `src/commands/check.ts` makes **no model
  call at all** today — it is a deterministic lint over the spec. The cross-vendor
  half is unbuilt, not a same-vendor fallback.
- Critic role at G1 and G6. `assessor`, `warden` and `critic` are bindable roles that
  no phase invokes.

## References

- `docs/design.md` §6, §7 (binding, host adapters)
- `docs/design.md` §7.1 (headless vs native invocation modes), §7.2 (the codex spike)
- `docs/IMPLEMENTED.md` "Deliberately not built"
- `docs/design.md` §18.1 and `_tickets/daemon.md` — the native adapter as daemon
  phase 3. (`docs/DAEMON.md` is referenced in several places but has never existed in
  this repo.)
