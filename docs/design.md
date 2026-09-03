# Valtay — Technical Design

**Consolidated.** Supersedes `DESIGN-01-callflow.md`, `DESIGN-02-intake-and-plan.md`,
and `DESIGN-03-self-correction.md`, and folds in decisions made after them: canonical
gate numbering, run-level batched gates, integration verification, editor-agnostic
render targets, and the enforcement hook set.

Companions: `PRD.md` (the argument), `PROVENANCE.md` (what is borrowed and why),
`VISION.md` (end state).
Diagram: *Valtay — Pipeline, Gates and Correction Loops* (Lucidchart).

| | |
|---|---|
| **Status** | Theory. No implementation. |
| **Version** | 1.0 |
| **Owner** | Collin |
| **Goal** | Land multiple tickets as multiple safe, reviewable PRs from one run. |

---

## 1. Thesis

Three claims. Everything else follows from one of them.

**C1 — Phases are processes, not prompt sections.** Each phase is a separate agent
invocation with a fresh context window, a short prompt, and file inputs. Control flow
between phases is ordinary code. The orchestrator never calls a model.

**C2 — The reviewable artifact is a path, not a paragraph.** For a given change, the
highest-value review artifact is the ordered call path from entry point to effect,
annotated inline, each node marked new / changed / unchanged.

**C3 — Deviations are telemetry.** When an agent departs from the plan to make code
work, that departure is the most informative signal the system produces.

**The enabling trick (§8.2):** at plan time there is no program to trace. The probe
implements the plan, traces it, and throws the code away — briefly making one.

---

## 2. Non-goals

- **Not an agent runtime.** Valtay drives Claude Code, Codex, OpenCode. It never
  calls a model API directly.
- **Not an IDE.** Front-ends push into surfaces editors already have. If we are
  writing layout code, we have failed.
- **Not multiplayer.** No shared sessions, comment threads, or dashboards. Reading
  `CODEOWNERS` is a planning constraint, not a collaboration feature.
- **Not a test framework.** Valtay consumes an oracle; it does not provide one.
- **Not a PR bot.** It stops at a branch or a stack. It never merges.
- **Not autonomous through a judgment gate.** Pre-authorization (§7.3) can clear
  *budget* gates against mechanical predicates a human wrote in advance. G1, G2 and
  G6 can never be pre-authorized.
- **Never self-editing.** Valtay proposes changes to its own prompts and config; it
  never applies them.

---

## 3. Vocabulary

Four levels. Only three are Valtay's.

| Level | Origin | Notes |
|---|---|---|
| **Ticket** | your tracker — *input* | advisory; Plan may merge, split, reorder, defer |
| **Run** | one `valtay start` | owns the artifact directory; gates are run-level |
| **Release unit** | *output* of Plan | independently shippable and revertible; probed, traced, conformance-checked |
| **Review layer** | *output* of Plan | one PR; 1..n per release unit, stacked |

A release unit contains 1..n review layers. When n > 1 they form a stack.

---

## 4. Architecture

Two halves that communicate only through the artifact store.

```
ENGINE (headless — CLI + files; runs over ssh, on a remote box, unattended)
  valtay CLI → Orchestrator (deterministic control flow, no model)
                 ├── Host Adapter    → claude / codex / opencode
                 ├── Trace Adapter   → project oracle
                 ├── Artifact Store  → .valtay/ (git-tracked)
                 └── Ledgers         → project + harness

REVIEW SURFACE (editor — reads the artifact store, never talks to the orchestrator)
  terminal links · Problems panel · optional extension
```

The split means the engine can run anywhere with no display, and the review surface
can be reimplemented per editor without touching pipeline logic.

### 4.1 Repo layout

**Run artifacts live outside the repo.** The repo gets two things:

```
repo/
  valtay.toml            ~20 lines — host binaries, default bindings, layer map
  .valtay/.gitignore     blank — holds the folder in git, yours to fill in
  ledger-project.jsonl   optional but recommended — durable project knowledge
```

Everything else is outside:

```
~/.valtay/
  config.toml                        user defaults
  phases/*.md                        phase prompts
  hooks/*                            enforcement fences
  ledger-harness.jsonl               facts about Valtay, not your code
  runs/<repo>/<run-id>/
    state.json  run.json  approvals.jsonl
    runspec.md (copy, hash-frozen)
    research.md design.md shape.<ext> plan.json
    RU-1/ probe.md assessment.json trace/*.json
  wt/                                worktrees, transient
```

`runspec.md` itself is yours to place — default beside the repo, `--commit` to put it
inside. See `RUNSPEC.md`.

The only genuine argument for committing anything beyond `valtay.toml` is
`ledger-project.jsonl`: it accumulates how *this codebase* resists change, which is
knowledge belonging to the repo rather than to one laptop. Everything else is run
scaffolding. Adopting Valtay costs one config file and one empty folder; abandoning
it costs nothing.

`init` never edits your root `.gitignore` — it drops a blank `.gitignore` inside
`.valtay/` instead. That keeps the command self-contained, works the same in a
directory that merely *holds* repos, and leaves you the one place to ignore run
artifacts if you decide to.

---

## 5. Roles

A role is a named job. Each phase invokes exactly one.

| Role | Phase | Judgment | Writes | Tier | Notes |
|---|---|---|---|---|---|
| `researcher` | 1 | medium | no | large | blind — sees only the run spec's assumptions section |
| `designer` | 2 | high | no | large | writes the delta, not a design |
| `shaper` | 3 | high | artifact only | large | declarations you hand-edit |
| `planner` | 4 | **highest** | no | large | constrained optimization |
| `prober` | 5 | medium | **yes** | cheap | implements to discover, then reverts |
| `assessor` | 5b | high | no | **mid** | §11 — references matter more than size |
| `warden` | 6 | medium | checks only | large | executable checks, never prose |
| `builder` | 7 | low | **yes** | cheap | decisions already made |
| `critic` | G1, G6 | high | no | large | **must not share a vendor with the author** |

**Fan-out:** only `prober` and `builder`. Prober fans out per release unit, builder
per review layer.

**Vendor diversity rule:** whoever produced an artifact does not grade it. This
includes you-and-your-agent as the author of the run spec — which is why
`valtay check` (§8.1) defaults to a different vendor than the session that drafted
it. Models self-prefer (§16.3), so same-vendor critique shares blind spots.

---

## 6. Binding

### 6.1 Schema

```toml
[hosts.claude-code]
bin = "claude"; adapter = "claude-code"
[hosts.codex]
bin = "codex";  adapter = "codex"

[roles.default]
host = "claude-code"; model = "sonnet"; effort = "medium"; timeout = "10m"

[roles.researcher] host="claude-code"; model="opus"; effort="high"
[roles.designer]   host="claude-code"; model="opus"; effort="high"
[roles.shaper]     host="claude-code"; model="opus"; effort="high"
[roles.planner]    host="claude-code"; model="opus"; effort="high"

[roles.intake]     host="codex"; model="gpt-5.6-sol"; effort="high"
[roles.assessor]   host="codex"; model="gpt-5.6-terra"; effort="high"
[roles.critic]     host="codex"; model="gpt-5.6-sol"; effort="high"

[roles.prober]  host="codex"; model="gpt-5.6-luna"; effort="max"; timeout="20m"
[roles.builder] host="codex"; model="gpt-5.6-luna"; effort="max"; timeout="20m"
  fallback = { host="codex", model="gpt-5.6-terra", effort="high" }
```

**Model strings are opaque.** Valtay never validates, maps, or normalizes them. No
model registry, no staleness when a vendor renames a tier. A rejected string is a
phase failure with the host's own error text in the manifest.

### 6.2 Resolution

Most specific wins, resolved **once** at run start and frozen into the manifest:

```
CLI flag → run pin → ./valtay.toml → ~/.valtay/config.toml → [roles.default] → built-in
```

Re-running a single phase re-resolves only that phase and records the change.

### 6.3 Why the expensive model runs first

Everything blue in the diagram — research through plan — happens before any code
exists. The cheap tier only executes decisions already approved. That inverts the
common instinct (put the good model on hard implementation) and follows from C2: the
plan is the artifact whose errors compound, and a bounded edit that goes wrong is
caught at the next gate.

---

## 7. Host adapters

### 7.1 Interface

```
run(RoleBinding, prompt_file, input_files, workdir, write: bool)
  -> { stdout, files_written, exit_code, duration, usage? }
```

One shot. No conversation. No session reuse. A host that cannot do this cannot be a
Valtay host.

**Capability declaration** — adapters declare what they support; absent capabilities
degrade explicitly:

| Capability | If absent |
|---|---|
| `structured_output` | adapter parses stdout (fragile) |
| `tool_hooks` | mechanical invariants fall back to gating level |
| `effort` | dropped, with a manifest note |
| `worktrees` | Valtay manages them via git |

### 7.2 Invocation

**claude-code**

```bash
claude -p --model opus --output-format json \
  --append-system-prompt-file ~/.valtay/phases/designer.md \
  --add-dir "$WT" \
  --disallowed-tools "Edit,Write,NotebookEdit" \
  "$(cat "$IN")"
```

Append rather than replace the system prompt — replacing it breaks the host's own
tool guidance.

**codex**

```bash
codex exec -m gpt-5.6-luna -c model_reasoning_effort=max --cd "$WT" \
  "$(cat "$PROMPT" "$IN")"
```

Inline overrides rather than generated `[profiles.*]` blocks: generating profiles
writes into another tool's config (violating §4.1 installer discipline) and hides the
effective binding from the call site.

> **Verify before building:** exact `-c` override syntax on `codex exec`, and whether
> a structured output format exists. 30-minute spike; do it before adapter code.

### 7.3 The Codex plugin

`openai/codex-plugin-cc` provides `/codex:review`, `/codex:adversarial-review`,
`/codex:rescue` and async job control inside Claude Code.

**Use it for the `critic` role interactively. Do not route pipeline phases through
it.** Going through the plugin means a phase's inputs are mediated by a live Claude
session (violating "no conversation state crosses a phase boundary"), failure
semantics belong to someone else's code, and it adds a layer between Valtay and a
binary it already calls.

---

## 8. The pipeline

| # | Phase | Input | Output | Gate | Budget |
|---|---|---|---|---|---|
| — | *(run spec)* | authored by you in a session — see §8.1 | `runspec.md` | — | — |
| 1 | **Research** | run spec assumptions **only** | `research.md` | — | ≤25 |
| 2 | **Reconcile** | request + research | `design.md` — the delta | **G1** | ≤30 |
| 3 | **Shape** | design | `shape.<ext>` — declarations | **G2** | ≤30 |
| 4 | **Plan** | shape + design | `plan.json` — units + layers | **G3** | ≤40 |
| 5 | **Probe** | plan + shape | `trace/*.json`, `probe.md`; **code reverted** | — | ≤40 |
| 5b | **Assess** | probe diff + approved artifacts | `assessment.json` | **G4** | ≤25 |
| 6 | **Invariants** | assessment + ledger | executable checks | **G5** | ≤25 |
| 7 | **Build** | everything | code, per review layer | — | ≤35 |
| 7b | **Conformance** | built code + approved trace | trace diff | — | mechanical |
| 7c | **Integration** | all units merged | checkpoint results + merged trace | **G6** | mechanical |
| 8 | **Retro** | manifest, assessments, approvals | ledger entries | — | ≤20 |

**Instruction budgets** are per phase. A phase that wants more must be split.
Frontier models follow ~150–200 instructions reliably; a monolithic planning prompt
can spend 85 before system prompt and tools are counted.

**Fresh context per phase.** Each phase is a new session receiving file paths, never
conversation history.

### 8.1 Input: the run spec

There is no Intake phase. The run's entire input is **one file you author**, in
whatever session you like. Full format in `RUNSPEC.md`.

```bash
valtay new player-damage --repo . --tickets LIN-483,LIN-484,LIN-485,LIN-486
   # pure scaffolding — NO model call.
   # pre-fills what is derivable without one: repo, git remote, CODEOWNERS,
   # detected skills, default bindings, ticket stubs. Leaves TODO markers.

#   ...you and an agent session fill it out conversationally...

valtay check runspec.md      # optional, cross-vendor, advisory only
valtay start runspec.md
```

**Why not a phase.** Filling out a spec is a conversation — you argue about scope,
cut a ticket, decide a conflict. A session does that well; a one-shot phase does not.
Removing it means Valtay's first model call is Research.

**What replaces Intake's value.** Its real contribution was cross-vendor conflict
detection. Two cheap recoveries, both used:

- **A `valtay-compose` skill** your session loads, carrying the checklist for a
  complete spec: conflicts between documents, gaps with no design coverage,
  assumptions phrased as *questions* rather than findings, explicit out-of-scope.
  Ships with Valtay as an asset and is installed at the project level by
  `valtay init` — see `RUNSPEC.md`.
- **`valtay check`** — a lint, not a phase. No artifacts, no gate, no state. Runs
  cross-vendor by default and reports what the drafting session missed. **Advisory,
  never blocking** — the same prioritizer-not-authority stance as the assessor
  (§16.3).

**On invariant 2 (§21).** The run spec is partly produced by a conversation, which
looks like conversation state crossing a boundary. It isn't: Valtay reads a *file*
that a human authored and owns, and never sees the session that helped write it. The
session is a text editor with opinions.

`start` freezes the spec's SHA into the manifest, so editing it mid-run is a detected
event rather than a silent divergence.

### 8.2 Research stays blind

Research receives the run spec's `## Assumptions to verify` section and nothing else.
Not the intent, not the tickets, not the referenced design.

**Blindness is enforced by the section boundary**, which is why assumptions are a
distinct heading rather than prose — a phase receives sections, not the file. A
researcher that has read the proposed design returns evidence *for* the design, and
the entire value of Reconcile is comparing two independently produced pictures.

### 8.3 Reconcile writes the delta

When a tech design exists, phase 2 does not write one:

```markdown
## Deltas
D-1  design §2 puts health on RunState. RunState is serialized to save
     files (src/save.odin:88); adding a field breaks save compat.
D-2  design §4.3 assumes enemies are removed on leak. They are marked,
     not removed (src/game/wave.odin:140).

## Open questions
Q-1  Does health persist across waves? PRD and T-106 disagree.
```

Far shorter than a design document, and reviewing it is the highest-leverage minute
in the pipeline: it is where a document written before anyone read the code meets the
code.

### 8.4 Shape is code

Phase 3 emits actual declarations in the project's language. You edit them by typing.
Prose is a failure mode here — describing an API change in English is slower and less
precise than writing the signature.

Shape is **global to the run**, not per-unit. Types and signatures are inherently
cross-cutting, and this is what lets G2 be one gate regardless of ticket count.

---

## 9. Planning

One phase decides releasability and reviewability together, because they trade
against each other and a trade-off cannot be resolved in two sequential phases.

### 9.1 The cost model

```
total ≈ Σ C1(layer) + N·C2 + C3(coherence) + Σ C4(release unit)
```

- **C1 — review cost**, superlinear in layer size. Detection degrades above ~400 LOC
  per sitting and above ~500 LOC/hour; effectiveness falls after ~60 minutes. [R2]
- **C2 — fixed cost per layer.** CI, review latency, approvals, rebases. Not small:
  median first feedback is <1 hour for small changes, ~5 hours for large. [R3]
- **C3 — fragmentation.** Layers that individually mean nothing force the reviewer
  to hold the whole across sittings, or approve without understanding.
- **C4 — risk**, proportional to behavior change reaching production. An inert layer
  carries ~zero.

The optimum is interior. Neither one giant PR nor twenty tiny ones.

### 9.2 Stacking changes the optimum

With plain PRs, one PR = one review = one release, so shrinking for reviewability
multiplies deploys. With a stack, **merging any PR merges everything below it
atomically and CI evaluates against the final target branch** — so a stack is N
reviews and **1 release**. [R4]

```toml
[plan]
stacking = "gh-stack"   # gh-stack | graphite | none
```

| Stacking | Optimum shifts toward |
|---|---|
| available | more, smaller layers; unit sized for coherence |
| none | fewer, larger PRs; feature flags carry release safety |

Getting this wrong hurts both ways: six-layer stacks with no tooling is weeks of
rebase misery; one 600-line PR in a repo that has stacking wastes the mechanism.

### 9.3 Decomposition heuristics

Applied in order:

1. **Release-unit boundary first.** Cut where a coherent, deployable, revertible
   piece of value ends. This dominates.
2. **Mechanical from semantic.** Renames, moves, formatting go in their own layer,
   always. A 2,000-line pure rename costs a reviewer almost nothing; 200 mixed lines
   cost more than either separately. **No layer may contain both** — checkable, and
   it belongs in the hook set.
3. **Additive before activating.** Layers adding unreferenced code are inert: they
   cannot change behavior and carry no C4. Push as much as possible into inert layers
   so risk concentrates in one small activating layer.
4. **Ownership partition.** `footprint(layer) = { owner(f) : f ∈ files(layer) }` from
   CODEOWNERS. **Target: ≤1 multi-team layer per release unit, and it is the
   smallest.** At Google the median change has one reviewer and fewer than 25% have
   more than one. [R3]
5. **Size budget, last.** Split further only if a layer still exceeds budget after
   1–4. Splitting for size alone pays C3 for nothing.

**When no cut satisfies both 1 and 4, report it rather than optimize around it.** A
change that unavoidably touches four teams in one inseparable step usually means the
*design* crosses a boundary it shouldn't — a G1 finding, not a packaging problem.

### 9.4 Run budget

N is capped by **your review capacity at G3 and G4**, not by compute:

```toml
[run]
max_units       = 5
max_layers      = 12
max_trace_nodes = 40      # total across all units at G4
```

When a ticket set exceeds it: *"these 12 tickets exceed the run budget — here is a
2-run split at the natural dependency seam."* Refusing to batch too much is part of
batching well.

### 9.5 The plan artifact

```json
{
  "epic": "player-damage",
  "stacking": "gh-stack",
  "release_units": [{
    "id": "RU-1",
    "goal": "player loses health when an enemy leaks",
    "tickets": ["T-104","T-105","T-106","T-107"],
    "checkpoint": "odin run . -json -scenario leak_one_enemy",
    "rollback": "flag player_damage_enabled off",
    "layers": [
      {"id":"L1","title":"refactor(game): rename enemy_remove -> enemy_mark_dead",
       "kind":"mechanical","owners":["@core-game"],"inert":true,
       "files":["src/game/wave.odin","src/game/enemy.odin"],
       "est_loc":{"add":412,"del":412},"tickets":["T-104"]},
      {"id":"L2","title":"feat(game): Player.health model",
       "kind":"semantic","owners":["@core-game"],"inert":true,
       "files":["src/game/player.odin"],
       "est_loc":{"add":84,"del":2},"tickets":["T-105"]},
      {"id":"L3","title":"feat(game): apply damage on leak, behind flag",
       "kind":"semantic","owners":["@core-game","@ui"],"inert":false,
       "files":["src/game/wave.odin","src/ui/hud.odin"],
       "est_loc":{"add":49,"del":6},"tickets":["T-106","T-107"],
       "trace_segment":"n4..n6"}
    ],
    "flags":["player_damage_enabled"],
    "cleanup_tickets":["remove player_damage_enabled after 2 releases"]
  }],
  "release_plan": {
    "releases": [{"id":1,"units":["RU-1","RU-2"]},
                 {"id":2,"units":["RU-3"],"after":"RU-1 deployed"}]
  },
  "alternatives_considered": [
    {"shape":"1 layer","rejected":"551 LOC semantic, 2 teams, mixes mechanical with logic"},
    {"shape":"6 layers","rejected":"splits Player.health across 3 reviews; C3 with no C1 gain"}
  ]
}
```

`alternatives_considered` is not decoration. It is what makes G3 a choice among
shapes rather than a rubber stamp.

`release_plan` matters for the multi-ticket goal: expand/migrate/contract spans
releases, so "one run, two releases" must be visible at G3 rather than discovered
after merging.

---

## 10. Probe, assess, escalate

### 10.1 Probe

Implements the plan, runs it against the oracle, records the trace, **reverts**. Its
outputs are the trace and a deviation report.

The revert is load-bearing. It is what makes the probe a falsifier rather than a
draft, and it is what makes probe-as-sampler reachable later (running the same plan N
times cheaply and treating deviation frequency as signal).

A `[probe] promote = true` escape hatch may keep the code, but the default is revert.

### 10.2 Severity

| Severity | Definition | Action |
|---|---|---|
| **cosmetic** | naming, ordering, formatting | log only |
| **local** | plan's shape held, a detail was wrong | project ledger, continue |
| **structural** | the plan assumed something the codebase does not do | **halt, re-refer** |

**The test:** a deviation is structural if fixing it requires changing something
*above* the plan in the artifact chain. That is a mechanical question about which file
needs editing, which is why it can be applied consistently.

**The reframe:** some deviations are not evidence the plan was wrong — they are
evidence the *design* was wrong. Replanning against a bad design produces a better
plan for the wrong thing. The probe is the cheapest place in the pipeline to catch
that.

### 10.3 Assessment

Classification is a separate invocation with fresh context, cross-vendor from the
prober. An implementer grading its own deviations calls everything local.

```json
{"release_unit":"RU-1","verdict":"structural","deviations":[
  {"id":"D-1","severity":"structural",
   "claim":"design §4.2 assumes sim emits a wave-completion event",
   "reality":"sim mutates RunState directly; no event bus exists",
   "evidence":"src/game/sim.odin:212",
   "fix_lives_in":"design.md",
   "cost_if_ignored":"every consumer polls; the HUD ticket becomes unbuildable"}]}
```

`fix_lives_in` drives control flow. Everything else is for you.

### 10.4 Escalation

| `fix_lives_in` | Re-enters at | Returns through |
|---|---|---|
| `plan.json` | Plan (4) | G3 |
| `shape.*` | Shape (3) | G2, G3 |
| `design.md` | Reconcile (2) | G1, G2, G3 |
| `epic` | **halt** — Valtay does not rewrite tickets | — |

Probe code is already discarded, so re-entry costs one probe, not a rollback.

**Loop guard.** A design wrong in several ways will cycle:

```toml
[correction]
max_reentries_per_unit = 2
max_reentries_per_epic = 4
```

On exceeding: hard halt with a report naming every structural deviation and the
artifacts each implicates. That report is the deliverable — an epic that trips the
guard needs a person, and saying so is more useful than a fifth attempt. The counter
resets when a human hand-edits the implicated artifact.

**Per-unit isolation:** one unit escalating does not stop the others. It parks; the
run continues.

---

## 11. Build, conformance, integration

### 11.1 Build

One worker per review layer, each in its own worktree, receiving only its layer's
TODOs and declared file set. Merge order follows the release plan;
`max_parallel = 2` by default because more mostly buys merge conflicts.

### 11.2 Conformance — the missing bookend

Valtay traces to plan; it must trace to verify. After Build, **re-trace and diff
against the approved trace.**

```
approved                          built
  sim_step                          sim_step
  └→ enemy_reach_end        ~       └→ enemy_reach_end        ~
     └→ player_take_damage  +          └→ player_take_damage  +
        └→ hud_health_changed +           ├→ save_mark_dirty   +   NOT APPROVED
                                          └→ hud_health_changed +
```

| Failure | Severity |
|---|---|
| node in build, absent in approved | structural |
| node in approved, absent in build | structural |
| node status changed | local |
| file touched outside declared set | structural |
| layer mixes mechanical and semantic | structural |

**Trust gate.** A conformance check may only *block* on a trace at least as strong as
the one approved:

```toml
[conformance]
block_on = "runtime"     # runtime | static | never
```

With Tier 1 runtime traces the diff is exact and can reject a build. With Tier 3
agent-discovered traces it is advisory only — a confidently wrong trace rejecting
correct code is worse than no check.

This is the strongest practical argument for the oracle: Tier 1 is not just better
review, it is what makes verification *enforceable*.

### 11.3 Integration verification

**Individually safe does not compose.** Each unit was traced in its own worktree
against `main`. Activating two can interact in ways neither trace shows.

Before G6:

1. Merge every unit's stack into a staging branch.
2. Run **every** unit's checkpoint against the merged state, not just its own.
3. Trace the merged state and diff against the union of approved traces.

Step 3 catches emergent interaction — a node present in the merged trace but in none
of the individual approved traces. That class of bug is invisible to per-PR review,
and it is the specific thing that makes landing N PRs together safe rather than
hopeful.

---

## 12. Gates

### 12.1 Canonical set

Six gates **per run**, regardless of ticket count.

| Gate | After | You decide | Kind | Phone |
|---|---|---|---|---|
| **G1** | Reconcile | answer open questions; is the design right | judgment | yes |
| **G2** | Shape | approve types and signatures (you edit these) | judgment | desk |
| **G3** | Plan | units, layers, footprint, rejected alternatives | budget | yes |
| **G4** | Assess | approve traces; route structural deviations | mixed | yes |
| **G5** | Invariants | approve the mechanical checks | budget | yes |
| **G6** | Integration | read the diff | judgment | **desk only** |

Gate IDs appear in config, `approvals.jsonl`, and pre-authorization predicates. This
table is authoritative.

### 12.2 Run-level and set-based

Gates operate on the whole run, not per unit — four tickets × six gates would be 24
gate events and you would abandon it by run two. This works because Shape and Plan are
run-global artifacts, and because the ≤7-node rule keeps N traces reviewable in one
sitting (5 units ≈ 35 nodes).

**Gates are queues, not barriers.** A gate presents whatever is ready. You approve
RU-1 and RU-2's traces while RU-3 is still in re-entry; it appears at the next pass.

### 12.3 Mechanics

Approvals are written to `approvals.jsonl` with a timestamp and the **hash of every
artifact approved**. Hand-editing an artifact voids its approval and everything
downstream — that is the intended workflow, not an error.

**Typed rejection** is the core interaction:

```
valtay reject g4 RU-1 --to design "does health persist? decide first"
```

Naming *which artifact was wrong* is the same discipline `fix_lives_in` applies, with
you as the authority.

### 12.4 Pre-authorization

A decision made in advance, conditionally, can be cleared by a **mechanical
predicate** — never by a model.

```toml
[gates.G3]
auto_pass_if = "layers <= 4 and multiteam_layers <= 1 and max_semantic_loc <= 200 and new_flags == 0"
```

| Gate | Pre-authorizable |
|---|---|
| G1, G2, G6 | **never** |
| G3, G5 | yes |
| G4 | only when `trace.source == "runtime"` **and** zero structural deviations |

G6 stays manual permanently. HumanLayer spent six months not reading generated code
and publicly reversed. That rule does not get a flag.

### 12.5 Attended vs unattended

Same code path, one policy flag.

- **Attended** — runs deep, you clear gates as you go.
- **Unattended** — runs *wide*: every unit advances to its first unpassable gate, then
  parks. You return to N units queued at gates and clear them in one sitting.

---

## 13. The review surface

Editor-agnostic. The **contract is the text format**, not the panel.

### 13.1 The format

Default text render is machine-parseable, `path:line:col: message`:

```
src/main.odin:210:1:  [io]    - input_event
src/ui/hit.odin:44:1: [ui]    ~ ui_hit_test - returns element, no longer mutates
src/game/cmd.odin:12:1: [game] + game_enqueue_command  #4
src/game/player.odin:31:1: [game] + player_take_damage  #7  needed wave index
```

Decorative box-drawing is the flag, not the default, because the parseable form is
what every target consumes.

Constraints, all from the research rather than taste: execution order is list order
(position encodes causality); status in a fixed column with sign encoding (`+` new,
`~` changed, `-` unchanged) rather than color, which is unreliable across setups;
**annotation inline with its node, never a footnote** — splitting a diagram from its
explanation imposes an integration cost that can erase the benefit [R5]; ≤7 nodes per
unit.

Layer is a fixed-width column so a layering violation — a `ui` node downstream of a
`game` node — is a pop-out rather than something you must remember to check for.

### 13.2 Targets

| Tier | Target | Cost |
|---|---|---|
| 0 | **terminal `path:line:col`** — ctrl-clickable in VS Code and most terminals | zero |
| 1 | **`tasks.json` + problemMatcher → Problems panel**, F8 walks the trace | ~20 lines JSON |
| 1' | Neovim quickfix, `:cn` walks the trace | small plugin |
| 2 | editor extension with a TreeView | only if 0 and 1 fail |

```json
{"label":"valtay: trace","type":"shell","command":"valtay trace ${input:unit}",
 "problemMatcher":{"owner":"valtay","fileLocation":["relative","${workspaceFolder}"],
  "pattern":{"regexp":"^(.*):(\\d+):(\\d+):\\s+(.*)$","file":1,"line":2,"column":3,"message":4}}}
```

Mapping status onto diagnostic **severity** (error = unapproved deviation, warning =
changed, info = unchanged) gets colored icons from a panel someone else built.

Rationale: navigation is the finding. Trailblazer's participants valued clickable
links from explanation to editor location above the quality of the explanation
itself. [R6] A static tree has no links.

### 13.3 Three levels

1. **Line** — what this unit does, node count, deviation count.
2. **Trace** — the annotated path. Default view; phone-safe.
3. **Detail** — full artifact or diff. Desk only.

### 13.4 The PR body is a trace segment

```markdown
## What this changes, as a path

  sim_step                        -- unchanged
  └→ enemy_reach_end     CHANGED  ~  marks completed, does not remove
     └→ player_take_damage  NEW    +  applies 1 damage
        └→ hud_health_changed NEW  +  @ui — your part is this node

Stack: L1 <- L2 <- [L3 you are here]

## Review notes by owner
@core-game — nodes 1-3. The behavior change is `enemy_reach_end`.
@ui        — node 4 only. New handler, no state ownership.
```

Minimizing team *count* is the coarse lever. Minimizing each team's *read* is the
finer one, and the trace gives it free.

---

## 14. Trace adapters

```
trace(entry: Symbol|Scenario, workdir: Path) -> Trace
```

Three tiers; the tier is recorded in `source` and displayed to the reviewer.

| Tier | `source` | How | Trust |
|---|---|---|---|
| 1 | `runtime` | deterministic headless mode; record actual call sequence | exact — may block |
| 2 | `static` | LSP/compiler call graph pruned to changed symbols | approximate |
| 3 | `agent` | agent explores with go-to-def / find-refs | advisory only |

**Adoption path:** a project starts at Tier 3 with zero setup. Adding a headless mode
moves it to Tier 1 and makes everything downstream better — exact traces, cheap
probes, enforceable conformance, and eventually probe-as-sampler. Valtay should
actively nag about this.

### 14.1 Trace schema

```json
{"unit":"RU-1","source":"runtime","entry":"input_event",
 "nodes":[{"id":"n1","symbol":"ui_hit_test","file":"src/ui/hit.odin","line":44,
   "layer":"ui","status":"changed","note":"returns element; no longer mutates",
   "todo":4,"children":["n2"]}],
 "deviations":[{"todo":7,"kind":"signature",
   "detail":"player_take_damage needed the wave index","file":"src/game/player.odin"}]}
```

`layer` derives from a path→layer map in config. It exists so the renderer can encode
it.

---

## 15. Enforcement

Four levels. Every rule declares one. The design bias is to move rules *down* this
table over time, driven by ledger promotion.

| Level | Mechanism | Reliability |
|---|---|---|
| Advisory | text in a prompt | low |
| Gating | phase blocked until evidence exists | medium |
| Structural | separate session with restricted inputs | high |
| Mechanical | hook, lint rule, test | absolute |

### 15.1 In-loop hooks (strongest)

Where a host exposes tool interception, a mechanical invariant is enforced *before*
the bad edit rather than detected after.

**1. File-set fence** — a builder on layer L3 may only write files in its declared
set. Turns the drift tripwire from detection into prevention, and makes it impossible
for a worker to silently add a third team to a PR.

```json
{"hooks":{"PreToolUse":[{"matcher":"Edit|Write|NotebookEdit",
  "hooks":[{"type":"command","command":"${CLAUDE_PROJECT_DIR}/.valtay/hooks/fileset.sh"}]}]}}
```

```bash
FILE=$(jq -r '.tool_input.file_path')
if ! valtay fileset-allows "$VALTAY_LAYER" "$FILE"; then
  jq -n --arg f "$FILE" '{hookSpecificOutput:{hookEventName:"PreToolUse",
    permissionDecision:"deny",
    permissionDecisionReason:("outside declared file set: " + $f)}}'
  exit 2
fi
```

**2. Read-only phase fence** — phases 0–5b deny all source writes. Redundant with
`--disallowed-tools`, but survives flag drift and works on any host with hooks.

**3. Artifact write scope** — a phase may write only its declared output. Without
this, a helpful planner "fixing" `design.md` silently voids an approval you gave.

**4. Harness self-edit fence** — block any write to `~/.valtay/**`. Makes "Valtay
never edits itself" mechanical rather than a sentence in a document.

Also useful: `WorktreeCreate` aborts on non-zero exit (refuse a worktree for an
unapproved unit); `PostToolBatch` exit 2 stops the agentic loop (halt a wandering
builder in seconds).

**Do not** wire the assessor as a blocking verification hook. It is a prioritizer,
not an authority (§16) — advisory context only.

### 15.2 Git hooks (host-independent)

- **pre-commit** — mechanical purity: if the layer is `kind: mechanical`, verify the
  diff is semantically null (normalized token stream identical modulo identifier
  renames).
- **pre-push** — footprint: recompute CODEOWNERS from the actual diff; a layer that
  gained a team is blocked.
- **pre-push** — conformance has run clean.
- **pre-push** — semantic layer within `max_semantic_loc`.
- **commit-msg** — inject unit and layer IDs so the manifest can reconstruct.

### 15.3 Hooks are mostly generated

Only the four in §15.1 are hand-written. The rest **accumulate from ledger
promotion** — a deviation recurring three times becomes a hook, with evidence
attached and your approval required. That is the difference between a harness with a
fixed rulebook and one that learns the shape of your codebase.

Every hook denial lands in the manifest with its reason, and `valtay take` overrides —
otherwise you get a builder looping against a fence nobody can see.

---

## 16. Ledgers, retro, and calibration

### 16.1 Two ledgers

Different promotion targets, so they are separate files.

**`ledger-project.jsonl`** — facts about this codebase.

```json
{"kind":"project","pattern":"save-compat","count":3,
 "detail":"changes to RunState break save files (src/save.odin:88)",
 "promote_to":"invariant"}
```

**`ledger-harness.jsonl`** — facts about Valtay.

```json
{"kind":"harness","pattern":"planner-ownership","count":3,
 "detail":"3 consecutive G3 rejections: multi-team layer was not the smallest",
 "promote_to":"phase_prompt:planner"}
```

The harness ledger's inputs — **your gate rejections** and the manifest's retry
records — are currently the most informative unused signal in the system. Three
rejections for the same reason is a fact about the planner, not the codebase.

### 16.2 Promotion

After 3 recurrences, surfaced as a **proposal**: a diff against a hook, phase prompt,
or config value, with evidence attached, requiring approval like anything else.

A harness that silently rewrites its own prompts based on its own performance
assessment has no fixed point — you can no longer tell whether an output change came
from the code, the model, or the tool editing itself.

### 16.3 Assessing the assessor

The assessor's failure mode is **silent**: systematic under-reporting means the
escalation loop never fires and every run looks clean.

**What the literature rules out.** Ensembling does not work — a nine-judge panel
across seven model families carries ~2.18 effective independent votes (independence
ratio 24%, mean error correlation φ ≈ 0.39), panel accuracy falls 8–22 points below
the independence prediction, and the best single judge matches or beats the panel on
every dataset. [R7] Capture-recapture is also out: it needs 4–5 reviewers, degrades
badly at two, systematically underestimates, and **assumes reviewer independence**,
which φ ≈ 0.39 denies — it would produce a confident, badly optimistic estimate of
what was missed. [R8]

**But cross-vendor still matters, for bias not variance.** Models self-prefer: the
highest score any model receives is the one it gives itself. [R9] That is exactly the
prober-grading-itself failure. One assessor, different vendor. Not three.

**The finding that shapes the design.** A judge that cannot answer a question itself
agrees with human labels only 10–30% of the time; with a *correct human-written
reference*, 50–80% — and a weak judge with a correct reference beats a strong judge
with a synthetic one. Reference correctness dominates judge capability. [R10]

Valtay produces human-verified references at every gate. So the assessor's task is
framed as **comparison against approved artifacts**, never open judgment:

> Here is the approved design (human-verified). Here is the approved shape. Here is
> what the probe had to do. Which of these artifacts contains a claim the
> implementation contradicts?

This is why `assessor` is mid-tier: **a mid-tier assessor with approved references
should beat a frontier assessor without them.** First manifest-driven experiment.

**Five layers of observability**, cheapest first — L1 and L2 required:

- **L1 — remove the silence.** G4 shows *every* deviation with its classification,
  not just escalated ones. You are already at that gate; six one-line classifications
  cost seconds, and disagreeing is a normal rejection. Converts a silent failure into
  a noisy one for free.
- **L2 — ground in approved artifacts.** Above. Architectural, free, largest effect.
- **L3 — monitor the distribution.** Structural rate → 0 over many runs suggests
  under-reporting; >20% suggests over-reporting and the loop guard will thrash. The
  row that actually catches the silent failure: **`design.md` hand-edited outside the
  pipeline while the structural rate is zero.**
- **L4 — seeded deviations.** Replay known-structural cases from the project ledger
  and measure recall. The only technique producing a number, and it names blind-spot
  categories rather than just scoring. [R11]
- **L5 — delayed labels.** `design.md` hand-edited after a run, a unit reverted
  post-merge, a later epic hitting the same assumption. Slow, but the only signal
  grounded in reality rather than another model's opinion.

**Residual risk, stated honestly:** none of this makes the assessor trustworthy. It
makes it *observable*. Given the correlated-error result, no arrangement of models
buys a guarantee on an individual assessment. Which is the right conclusion anyway —
**the assessor is a prioritizer, not an authority.** Its job is putting the deviation
you most need to see at the top of a short list at a gate you were already standing
at.

---

## 17. The run manifest

`.valtay/runs/<id>/run.json`, append-only, one record per phase invocation.

```json
{"phase":2,"role":"designer","host":"claude-code","model":"opus","effort":"high",
 "prompt_sha":"a91f…","inputs":[{"path":"research.md","sha":"4c02…"}],
 "outputs":[{"path":"design.md","sha":"77bd…"}],
 "duration_s":94,"exit_code":0,
 "usage":{"input_tokens":18422,"output_tokens":2210},
 "attempt":1,"notes":[]}
```

Four things it buys: **reproducibility**; **approval integrity** (gates reference
artifact hashes); **comparison** — *"do Luna builds produce more deviations than Terra
builds?"* becomes a query, which is how the tier split gets validated with evidence
rather than defended with vibes; and **cost attribution per role**, the entire reason
to route implementation to a cheap tier.

---

## 18. Failure, retry, resume

```
exit != 0 or timeout
   -> retry once, same binding                 [attempt 2]
   -> fallback binding if declared             [attempt 3, note: fallback]
   -> phase FAILED, unit halts, status written

output present but schema-invalid
   -> re-run with the validation error appended, max 2 attempts -> FAILED
```

- **Never silently downgrade.** A fallback that fires is recorded with a note.
- **Never auto-advance past a gate on retry success.**
- **Halt the unit, not the run.** Other units continue.

State lives entirely on disk; there is no daemon holding it. "Resume" and "run on
another machine" are the same operation.

---

## 19. CLI

```
valtay init                       # writes valtay.toml + .valtay/ (repo or workspace)
valtay new <name> --repo . --tickets LIN-483,LIN-484
                                  # scaffolds runspec.md, no model call
valtay check runspec.md           # advisory lint, cross-vendor
valtay start runspec.md
valtay status [unit]
valtay show <artifact>
valtay trace <unit>               # path:line:col render
valtay diff trace <unit>          # approved vs built
valtay approve <gate> [unit]
valtay reject  <gate> [unit] --to <phase> "reason"
valtay amend   trace <unit>       # accept drift, re-baseline, recorded
valtay take <unit> / resume <unit>
valtay ledger [project|harness]
valtay calibrate assessor
```

Nine verbs, no chat. **There is no conversation with the coordinator** — it is a
program with no model in it. When you disagree, you disagree with an artifact, and
`reject --to` is how you say so.

---

## 20. Config reference

**Precedence** — most specific wins:

```
runspec.md frontmatter  →  ./valtay.toml  →  ~/.valtay/config.toml  →  built-in
```

`valtay.toml` holds only what is stable for the repo: host binaries, default
bindings, the layer map, and the trace command. Anything that varies per run —
role overrides, skills, budgets, gate pre-authorization — belongs in the run spec,
where you can see it beside the work it applies to.

```toml
[hosts.claude-code] bin="claude"; adapter="claude-code"
[hosts.codex]       bin="codex";  adapter="codex"

[roles.default]  host="claude-code"; model="sonnet"; effort="medium"; timeout="10m"
# per-role overrides — see §6.1

[run]
max_units=5; max_layers=12; max_trace_nodes=40

[plan]
stacking="gh-stack"
max_semantic_loc=400; target_semantic_loc=200; max_files_semantic=10
max_teams_per_layer=2; max_multiteam_per_unit=1
mechanical_loc_limit=0            # unlimited
require_inert_until_activation=true
show_alternatives=2

[plan.flags]
style="config_key"; template="flags.{name}"; cleanup_ticket=true

[trace]
tier="runtime"
command="odin run . -json -scenario {scenario}"

[layers]
"src/ui/**"="ui"; "src/game/**"="game"; "src/platform/**"="io"

[probe]
promote=false

[correction]
max_reentries_per_unit=2; max_reentries_per_epic=4
halt_on=["epic"]

[conformance]
enabled=true; block_on="runtime"; recheck_after="build"

[build]
max_parallel=2; fail_fast_on_file_set_violation=true

[critic]
required_at=["G1","G6"]; vendor_must_differ_from=["designer","builder"]

[assessor]
tier="mid"; vendor_must_differ_from=["prober"]
reference_artifacts=["design.md","shape.*","plan.json"]
show_all_at_gate=true             # non-negotiable

[assessor.calibration]
enabled=true; every_n_runs=20; seed_from="ledger-project"
seed_count=12; alert_recall_below=0.7

[retro]
enabled=true; ledgers=["project","harness"]; promote_after=3

[gates.G3]
auto_pass_if="layers <= 4 and multiteam_layers <= 1 and max_semantic_loc <= 200 and new_flags == 0"
```

---

## 21. Design invariants

If any of these is violated, the design has drifted:

1. The orchestrator makes no LLM calls.
2. No conversation state crosses a phase boundary. Artifacts only.
3. Every phase invocation is one non-interactive process.
4. Model strings are never interpreted by Valtay.
5. No judgment gate advances without a recorded human approval.
6. Read-only phases are enforced at the tool layer, not by instruction.
7. Every invocation appears in the manifest, including failures and fallbacks.
8. Valtay never edits its own prompts or config.
9. Whoever produced an artifact does not grade it.
10. The bash reference implementation can express every feature. If it cannot,
    orchestration logic has leaked.

---

## 22. Build path

| Stage | Deliverable | Proves |
|---|---|---|
| **v0** | shell scripts + Markdown phase prompts; you are the state machine | C1 and C2 in a weekend, nothing to maintain |
| **v1** | engine: orchestrator, adapters, manifest, resume — built only from annoyances v0 produced | the loop is worth automating |
| **v2** | Tier 1 trace on one project; trace diff; terminal + Problems panel render | the oracle payoff |
| **v3** | ledgers, promotion, hooks, cross-vendor critic | it improves with use |
| **v4** | probe-as-sampler; manifest-driven routing proposals | the parts nobody else can reach |
| **v5** | fewer phases | we knew which parts were scaffolding |

v0 and the probe are the two that can kill the project. Do them before anything
pretty.

---

## 23. Open questions

**Highest risk first.**

1. **Trace adapters for a real language.** Tier 1 needs a deterministic headless
   mode. What does that look like for a TypeScript service or a Go backend? Entirely
   unspecified, and conformance depends on it.
2. **Multi-repo.** Zero design. The artifact directory, CODEOWNERS lookup, and stack
   all assume one repo root; real epics span a service and a client.
3. **Tracker adapters.** `valtay new --tickets LIN-483` implies reading Linear. Needs
   `fetch(ids) -> [{id,title,body,acceptance}]` with Linear, Jira, and plain-file
   implementations. Least designed, first thing hit on day one.
3b. **Skill detection.** `valtay new` proposes `skills:` wiring by scanning. Probably
   needs a convention or an explicit block in `valtay.toml` rather than a guess.
4. **Probe cost at epic scale.** Building everything twice is fine for one unit and
   may dominate a twelve-ticket epic. Unmodeled.
5. **CI topology.** Whether layers run CI independently, and how long it takes,
   materially changes C2 and the planner's optimum.
6. **The core thesis is unvalidated.** All trace research measures comprehension of
   *existing* code, not review of *proposed* changes. The probe narrows the gap; it
   does not close it.
7. **Stack depth ceiling.** Atomic merge solves release coordination, but a 9-layer
   stack is a lot of open PRs and rebase surface. Suspect a practical cap near 4–5.
8. **CODEOWNERS staleness.** Fallbacks (blame concentration, directory convention)
   are heuristics and must be labeled as such — a confident wrong owner is worse than
   none.
9. **Ticket boundary vs unit boundary.** Slices win for structure, tickets ride as
   metadata. In some orgs the ticket boundary is politically load-bearing.
10. **Is `fix_lives_in` really mechanical?** If structural runs above ~20% of
    deviations, the test is miscalibrated.

---

## Appendix — references

**[R1]** HumanLayer, RPI → CRISPY. Instruction budget ~150–200; 40% context "dumb
zone"; vertical over horizontal slicing; the public reversal on not reading generated
code; 2–3x not 10x.
<https://www.zenml.io/llmops-database/evolution-from-rpi-to-crispy-multi-stage-workflow-for-production-coding-agents>

**[R2]** Cisco / SmartBear code review study. 200–400 LOC per review; 70–90% defect
discovery over 60–90 minutes; detection degrades above ~500 LOC/hour; effectiveness
falls after ~60 minutes.
<https://smartbear.com/learn/code-review/best-practices-for-peer-code-review/>

**[R3]** Sadowski et al., *Modern Code Review: A Case Study at Google*, ICSE-SEIP
2018. Median change 24 lines; ~90% under 10 files; median 1 reviewer; <25% have more
than one; first feedback <1h small / ~5h large.
<https://sback.it/publications/icse2018seip.pdf>

**[R4]** GitHub stacked pull requests. Merging any PR merges all unmerged PRs below
it atomically; CI and branch protection evaluate against the final target branch;
stack map for per-layer diffs. <https://github.github.com/gh-stack/>

**[R5]** Chandler & Sweller (1992), *The Split-Attention Effect as a Factor in the
Design of Instruction.* Why annotation must sit with the thing it annotates.

**[R6]** *Answering Developer Questions with Annotated Agent-Discovered Program
Traces* (Trailblazer), UIST 2025. 4.8 vs 7.3 min; 0 vs 7 failures; retention 2.8 vs
10.8 attempts (75% vs 10% first-try); filter aggressively, interleave explanation
with navigation, structure hierarchically.
<https://andrewhead.info/assets/pdf/trailblazer.pdf>

**[R7]** *Nine Judges, Two Effective Votes: Correlated Errors Undermine LLM
Evaluation Panels.* <https://arxiv.org/html/2605.29800>

**[R8]** Petersson, Thelin, Runeson, Wohlin, *Capture–recapture in software
inspections after 10 years research.* <https://wohlin.eu/jss04-1.pdf>

**[R9]** Verga et al., *Replacing Judges with Juries* (PoLL). Self-preference: each
model's highest score comes from itself. <https://arxiv.org/abs/2404.18796>

**[R10]** *No Free Labels: Limitations of LLM-as-a-Judge Without Human Grounding.*
<https://arxiv.org/html/2503.05061v1>

**[R11]** Error seeding and mutation adequacy.
<https://www2.cs.sfu.ca/~cameron/Teaching/473/seeding_mutation_adequacy.html>

**[R12]** LaToza & Myers, *Visualizing Call Graphs* (REACHER). Reachability questions
as the hardest class; 78% vs 14% success; 7.2 vs 11.1 min.
<https://www.cs.cmu.edu/~NatProg/papers/Paper3_LaTozaAndMyers_paper.pdf>

**[R13]** Larkin & Simon (1987), *Why a Diagram is (Sometimes) Worth Ten Thousand
Words.* Informational vs. computational equivalence; locality; perceptual vs. logical
inference.

**[R14]** ThePrimeagen, `99` — provider abstraction (binary + model), `search` →
quickfix, `#rules` / `@files` sigils, and the author's own advice to favor `search`
over code replacement. <https://github.com/ThePrimeagen/99>

**[R15]** ai-conductor — enforcement ladder, artifacts-as-interface, evidence-based
gates, installer discipline, bash reference implementation, daemon that never merges.
<https://github.com/jstoup111/ai-conductor>

**[R16]** Pi — RPC capability surface, JSONL framing, append-only sessions with
`since` cursors, fork-not-mutate, `tool_call` interception.
<https://pi.dev/docs/latest/rpc>