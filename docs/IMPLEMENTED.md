# What is built, and what the first run taught us

`PRD.md` is the argument and `design.md` is the design. This is the honest gap
between them and the code, plus what changed because we ran it rather than because
we read it.

| | |
|---|---|
| **Status** | The spine runs end to end. One complete run on this repo, all six gates. |
| **Proof** | Valtay built `valtay check` (`src/commands/check.ts`) — 205 lines across three files, two commits, checkpoint green. |

---

## The pipeline as built

| # | Phase | Artifact | Gate | Built |
|---|---|---|---|---|
| 1 | Research | `research.md` | — | yes |
| 2 | Reconcile | `design.md` | G1 | yes |
| 3 | Shape | `shape.<ext>` | G2 | yes |
| 4 | Plan | `plan.json` | G3 | yes |
| 5 | Probe | `probe.json` | G4 | yes |
| 5b | Assess | `assessment.json` | — | **no** |
| 6 | Invariants | executable checks | G5 | **no** |
| 7 | Build | `build.md` + a branch | G6 | yes |
| 7b | Conformance | trace diff | — | **no** |
| 7c | Integration | merged checkpoints | — | **no** |
| 8 | Retro | ledger promotion | — | **no** |

CLI: `init`, `new`, `check`, `start`, `status`, `show`, `trace`, `approve`,
`reject`, `resume`, `resume --retry`.

### Deliberately not built, and why

- **Assess (5b).** The human classifies deviations at G4. §16.3 calls the assessor a
  prioritizer rather than an authority, and with one vendor installed it cannot
  satisfy invariant 9 anyway.
- **Invariants (6) and G5.** Additive; nothing in a single-unit run consumes them.
  **G5 is absent rather than auto-passed**, so nothing records an approval nobody
  gave.
- **Conformance (7b).** `block_on = "runtime"` makes it advisory at Tier 3, so it
  cannot fail a build. It needs a runtime oracle before it is worth having.
- **Integration (7c).** Degenerate with one release unit.
- **Retro and promotion (8).** Needs many runs of ledger history. The ledger is
  **written** from run one, because promotion needs three recurrences and history
  cannot be backfilled.
- **Stacking, CODEOWNERS, multi-team planning.** Every heuristic in §9.3 clause 4 is
  a no-op for one developer in one repo.
- **The cross-vendor critic.** The `codex` adapter now exists, so the *environment*
  can satisfy invariant 9 — but `assessor`, `warden` and `critic` are still bindable
  roles that no phase invokes, and `valtay check` still makes no model call. Those are
  their own tickets.

### Built since the first run

- **A phase is a skill.** Phase instructions ship as `assets/phases/<id>/SKILL.md` and
  `valtay init` installs them into `.claude/skills/`; the adapter names
  `/valtay-<phase>` instead of injecting the text with `--append-system-prompt`
  (design.md §7.4). This is the portability prerequisite — the codex adapter now has
  to spawn a binary, not reimplement prompt delivery. Verified against the binary:
  `claude -p` does not auto-invoke a skill on relevance, but it does expand a leading
  `/name` on stdin, and a payload sent without one comes back visibly uninstructed.
- **A second host adapter.** `src/hosts/codex.ts` runs `codex exec` as a headless
  one-shot, and a role bound to `[hosts.codex]` now runs instead of throwing
  `No adapter "codex"`. `valtay init` installs the phase skills into every detected
  host's root rather than always `.claude/skills/`, which is what a codex-only repo
  needed to work at all. Verified against codex-cli 0.153.3: the sandbox modes are a
  real read/write fence, `-c model_reasoning_effort` is a recognized field, and
  `--output-last-message` is the artifact. **Not yet verified end to end** — no
  OpenAI credentials were available, so no phase has run against a live codex model.
  The native/tmux adapter for the daemon is still unbuilt.

### Where the code knowingly differs from the design

- **The probe's artifact is `probe.json`**, not §8's `probe.md` plus `trace/*.json`.
  Read-only phases return their artifact on stdout and the orchestrator writes it,
  which makes §15.1's "a phase may write only its declared output" mechanical without
  hooks — so the phase writes nothing at all, and one structured document keeps that
  true. `valtay trace` renders it.
- **The file-set fence is detection, not prevention.** §15.1 wants a `PreToolUse`
  hook that refuses the write; we check the commit afterwards. Same rule, one rung
  lower on the ladder. A layer that widened its own footprint is named at G6 and in
  the manifest rather than stopped at the keystroke.
- **Invariant 9 is now possible, and still not enforced.** A second adapter means a
  run *can* bind two vendors, and one that does records `vendor_diversity: true`. But
  that flag is weaker than the invariant it is named for: it is true when any two of
  the nine roles differ in host, not when the grader of an artifact differs from its
  producer. Nothing reads it to block, and the three grading roles are still never
  invoked. So a cross-vendor run is currently a run that *could* grade across vendors,
  not one that does.
- **The codex adapter inlines the phase body.** design.md §7.4 says an adapter
  delivers a name; codex has no deterministic way to accept one, so its adapter reads
  the installed SKILL.md and inlines it. The file still lives where codex's own loader
  reads it, and every invocation carries a manifest note saying the substitution
  happened. §7.2 has the evidence.

---

## What running it changed

Every item here is a rule that failed in practice, not one we reasoned about. Six of
the eight moved down the enforcement ladder — which is §15's own prescription, and it
is notable that we did not follow it by choice so much as get pushed there.

| What happened | What it changed |
|---|---|
| Research prepended a working note despite a prompt forbidding preamble | Phases declare the heading their artifact opens with; anything before it is dropped, and a missing heading fails validation and retries with the reason |
| The planner emitted `plan.json` on one line | JSON artifacts are re-serialized indented on the way in. A one-line plan cannot be reviewed at G3, let alone from a phone |
| The probe used a `status` value outside the schema | Caught by the trace validator, retried with the reason, corrected |
| Told its status was invalid, the phase replied in prose | JSON is extracted from a surrounding reply by brace matching, and the correction now says bluntly that the entire reply must be the artifact |
| `bypassPermissions` refused to run as root | Write phases use `acceptEdits` with an explicit tool allowlist — works everywhere, and a fence rather than the absence of one |
| A failed phase had no way back | `valtay resume --retry`, deliberate rather than something `advance` decides on its own |
| `build.md` pointed the reviewer at `main..HEAD` | Against a stale main that showed 58 files instead of the 2 the build touched. The branch's real base commit is recorded and used |
| A probe could report a trace it never ran | `checkpoint_output` is required — the oracle's own output. A trace written from the plan is the paragraph the trace was meant to replace, wearing evidence's clothes |

### What held without changes

- **Research blindness.** The section boundary carried all the way to the host
  payload. Research answered one assumption by contradicting it, which is the whole
  point of asking it blind.
- **Shape is code, not prose.** First attempt: parseable TypeScript, declarations
  only, correctly marked, reusing the helpers Research had found. No correction
  needed.
- **`alternatives_considered` is not decoration.** The planner rejected three real
  cuts and cited the decomposition heuristics by number. It applied heuristic 3
  unprompted — an inert 190-line layer and a 9-line activating one — which is exactly
  the risk concentration §9.3 asks for.
- **The ≤7 node rule.** The probe's trace came in at exactly seven, in execution
  order, every annotation on its own node.

---

## What the first run does not prove

- **C2 is still open.** Valtay is ~1,000 lines of TypeScript, which makes the ≤7-node
  rule easy to satisfy. The run tested C1 — fresh context per phase — far better than
  it tested path-over-prose review. A fair test needs a codebase where a reviewer
  would genuinely struggle to reconstruct the control flow.
- **Tier 3 traces cannot block.** Conformance stays advisory until a runtime oracle
  exists. A clean run is not verification.
- **One run is one data point, and both ledgers are empty.** The probe reported no
  deviations, so the project ledger has nothing; every gate was approved, so the
  harness ledger has nothing either. The findings in the table above came from
  validators rather than from gate rejections, which is why they are recorded here
  and not there — the ledger takes what the mechanism actually produced, and seeding
  it with anything else would put fabricated history in the one place the promotion
  rule has to be able to trust. Nothing about compounding is demonstrated yet, only
  made possible.
- **The probe was cheap here** — about a minute and $0.30 — but this was a small
  additive change. §23's Q4, whether the probe stays affordable at epic scale, is
  untouched.

## Next, in order

1. **A second run**, on a change with real structural risk, to see whether the probe
   ever returns `fix_lives_in: design.md` and the escalation loop actually fires.
2. **Invariants and G5**, the cheapest unbuilt phase.
3. **The `PreToolUse` file-set hook**, moving the fence from detection to prevention.
4. **A Tier 1 trace adapter**, which is what makes conformance enforceable and is the
   single highest-leverage thing a project can do for its own agent workflow.
