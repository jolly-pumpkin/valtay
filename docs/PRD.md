# Valtay — Product Requirements Document

Named for the Valtay of *Dungeon Crawler Carl* — the relentlessly bureaucratic,
managerial species who administer things nobody asked them to administer. The name
is a design commitment, not a joke: this system's entire value is procedural.
Gates that will not open without evidence, approvals bound to artifact hashes, an
append-only ledger, and a daemon that is forbidden from signing its own paperwork.
If a proposed feature would not survive a compliance review, it does not belong here.

| | |
|---|---|
| **Status** | Argued, and now partly built. The spine runs end to end; see `IMPLEMENTED.md`. |
| **Version** | 0.2 |
| **Date** | 2026-09-01 |
| **Owner** | Collin |
| **One line** | A host-agnostic harness that runs coding agents as a gated pipeline of short, fresh-context phases, and makes the reviewable artifact an executable call trace instead of a wall of prose. |

---

## 0. How to read this

This is a design argument, not a build plan. Sections 1–4 are the claims. Sections
5–13 are the system that follows from them. Section 14 is how we'd know it worked.
Section 15 is what might be wrong.

Every design decision that comes from published research or from someone else's
scar tissue is marked with a bracketed reference to the appendix, so it's clear
which parts are borrowed and which parts are speculation.

**Changes in 0.2.** Reviewed against ThePrimeagen's `99`, a shipped Neovim plugin
that already solves two things this document treated as open. [R11] The host-adapter
interface (§11) is now grounded in a working provider abstraction rather than
invented. The review surface (§8) moved from a renderer we build to the editor's
quickfix list, which we do not. §5 splits the orchestrator from the review surface
as a consequence.

---

## 1. Problem

Coding agents produce code faster than a human can form an accurate mental model
of it. The bottleneck moved from writing to review, and the review surface did not
change to match. We still review a unified diff and a prose plan — the same two
artifacts as when a human wrote the code at human speed.

Three failure modes are well documented and mutually reinforcing.

**F1 — Instruction budget overload.** Frontier models follow roughly 150–200
instructions with good consistency. A monolithic planning prompt can spend 85 on
its own before system prompt and tool definitions are counted. Past the budget,
compliance degrades unpredictably rather than gracefully. [R1]

**F2 — Context degradation.** Quality falls off well before the context window
fills — HumanLayer puts the onset around 40% utilization. A pipeline that carries
one conversation through six phases spends its last phases in the degraded region.
This predicts, specifically, that the *final* phases of any long single-session
workflow will be the worst ones, regardless of what they ask for. [R1]

**F3 — Wrong review representation.** A plan written as prose forces the reviewer
to reconstruct control flow by reading and remembering. That reconstruction is the
expensive part. Reachability questions — "what reaches this, what does this reach" —
are among the hardest questions developers ask about code, and answering one
manually can take tens of minutes and end in a confident wrong answer. [R3]

F3 is the one nobody is addressing. It is the core of this product.

### 1.1 Why existing harnesses don't solve it

| System | Solves | Leaves open |
|---|---|---|
| CRISPY / HumanLayer | F1, F2, team alignment | Review artifact is still prose (a 200-line design doc). No verification oracle. |
| ai-conductor | Process discipline, adversarial review | Locked to one host. Prose artifacts. No context-window strategy. |
| Pi | Harness ownership, model portability | Deliberately unopinionated — supplies primitives, not a workflow. |
| ThePrimeagen's six-phase | Gating, and the revert probe (see §4.3) | Single conversation (F2). Horizontal slicing. Deviations discarded. |

Nothing on that list treats the *representation* of the plan as the design problem.

---

## 2. Thesis

Three claims. Everything else in this document is a consequence of one of them.

**C1 — Phases are processes, not prompt sections.**
A phase is a separate agent invocation with a fresh context window, a short prompt,
and file inputs. Control flow between phases is ordinary code, not conditional
prose inside a mega-prompt. This is the direct remedy for F1 and F2. [R1]

**C2 — The reviewable artifact is a path, not a paragraph.**
For a given change, the highest-value review artifact is the ordered call path from
entry point to effect, annotated inline, with each node marked new / changed /
unchanged. A diagram and a text can carry identical information while costing
wildly different amounts to use: diagrams group what you need together by location,
eliminating search, and convert deductive questions into perceptual ones. [R2, R3, R4]

There is a field observation worth more than any of those citations. `99` ships
both a "find me the locations" command and a "rewrite this selection" command, and
its author's own advice is to **favor `search` over code replacement for most
work.** [R11] An experienced engineer built an AI editor plugin and concluded that
the navigation output was more valuable than the generation output. C2 is that
observation generalized: the agent's highest-value product is a path, and the
human's job is the code.

**C3 — Deviations are telemetry, not noise.**
When an agent has to depart from the plan to make the code work, that departure is
the single most informative signal the system produces. It should be captured,
accumulated across changes, and promoted into permanent harness configuration once
it recurs. Today every workflow throws it away.

---

## 3. Non-goals

Explicitly out of scope, permanently unless revisited:

- **Not an agent runtime.** Valtay drives Claude Code, Codex, and others. It never
  talks to a model API directly. If it ends up needing to, the design is wrong.
- **Not an IDE.** No custom UI framework, no bespoke viewer, no window manager. A
  thin editor plugin that pushes results into surfaces the editor already has
  (quickfix, location list) is in scope; anything that requires us to draw a widget
  is not. The test: if we are writing layout code, we have failed.
- **Not multiplayer.** No shared sessions, no comment threads, no team dashboards.
  Those exist because RPI broke at 10,000 users; we are optimizing for one expert.
- **Not a test framework.** Valtay consumes an oracle; it does not provide one.
- **Not a PR bot.** It stops at a branch. What happens after is your normal process.
- **Not autonomous.** There is no mode where the pipeline runs end to end without a
  human approving gates. That is the product, not a limitation of it.

---

## 4. Users and modes

**Primary user: one experienced engineer who reads code.** Valtay assumes taste and
does not try to substitute for it. It assumes the user *will* read the final diff —
HumanLayer spent six months not reading generated code and publicly reversed the
position. [R1] Valtay's claim is not "review less," it is "review the right thing
first, so that reading the diff confirms rather than discovers."

**Mode A — Desk.** Full keyboard. User edits artifacts directly rather than
describing changes in English. Describing an API change in prose is slower and
worse than typing the signature; the system must never force prose where a
declaration would do.

**Mode B — Away.** Phone, spotty network, minutes at a time. The user can advance
the pipeline, answer open questions, approve or reject gates, and read trace
artifacts — but cannot be expected to read 400 lines of code on a 6" screen. Every
gate must have a form that is reviewable in under 60 seconds.

Mode B is not a degraded fallback. It is a first-class constraint that improves the
desk experience, because it forces every artifact to have a legible summary form.

---

### 4.1 The central design problem

C2 says review a call path. But at plan time **the code does not exist yet.** You
cannot trace a program you haven't written. This is the reason nobody does this.

**Resolution: the probe.** Before the plan is approved, the agent implements it
throwaway-style, runs it under the project's oracle, records the execution trace,
then **reverts the code and keeps only the trace and a deviation report.**

The probe is what makes trace review possible at plan time. It converts a
hypothetical plan into a real, executed path, at the cost of one cheap
implementation that is immediately discarded. It also happens to produce C3's
telemetry for free — the places the agent had to leave the plan are exactly the
places the plan was wrong.

This is the load-bearing idea in the entire document. If the probe doesn't work,
Valtay is just CRISPY with a different phase count.

---

## 5. Architecture

Two halves, deliberately separated: an **engine** that is a CLI and files, and a
**review surface** that lives in the editor. They communicate only through the
artifact store. Either can be replaced or run without the other.

```
  ENGINE (headless — CLI, files, works over ssh or from a phone)
  ┌─────────────────────────────────────────────────────────────┐
  │                                                             │
  │  valtay CLI ─▶ ┌──────────────────┐                         │
  │                │  Orchestrator    │  deterministic control  │
  │                │                  │  flow — a program,      │
  │                └───┬──────────┬───┘  not a prompt           │
  │      spawns one    │          │ reads/writes                │
  │      short session ▼          ▼                             │
  │        ┌───────────┐    ┌──────────────────┐                │
  │        │   Host    │    │  Artifact store  │                │
  │        │  Adapter  │    │ .valtay/<slice>/ │                │
  │        │           │    │  git-tracked     │                │
  │        │ claude    │    └────────┬─────────┘                │
  │        │ codex     │             │                          │
  │        │ opencode  │             │                          │
  │        │ ...       │             │                          │
  │        └─────┬─────┘             │        ┌──────────┐      │
  │              ▲                   │        │  Ledger  │      │
  │        ┌─────┴──────┐            │        │ devs →   │      │
  │        │   Trace    │◀── oracle  │        │ invars   │      │
  │        │  Adapter   │  (headless │        └──────────┘      │
  │        │ (per-lang) │   run/test)│                          │
  │        └────────────┘            │                          │
  └──────────────────────────────────┼──────────────────────────┘
                                     │  trace.json + artifacts
                     ┌───────────────┴───────────────┐
                     ▼                               ▼
  REVIEW SURFACE (editor)            MODE B (phone / no editor)
  ┌──────────────────────┐           ┌──────────────────────┐
  │ quickfix list        │           │ ASCII trace tree     │
  │ — one entry per node │           │ — same trace, static │
  │ — jump to file:line  │           │ — read + approve     │
  │ — annotations inline │           │   gates, no jumping  │
  └──────────────────────┘           └──────────────────────┘
```

Six components. Each is replaceable without touching the others.

**Orchestrator.** Owns the phase sequence, the gates, and the context policy. Pure
control flow in a normal language. Never contains prompt logic — if the
orchestrator is deciding something by asking a model, that decision belongs in a
phase.

**Host adapter.** Wraps one agent runtime behind a narrow interface (§11). Valtay's
portability lives entirely here.

**Artifact store.** A git-tracked directory per slice. Artifacts are the only
channel between phases; no conversation state crosses a phase boundary. This is C1
made physical — the artifact *is* the handoff, so a phase can be re-run in
isolation, cached, or hand-edited.

**Trace adapter.** Turns a project into a trace (§12). Tiered, because most
projects will not start with a good oracle.

**Review surface.** Renders a trace where the user can act on it (§8). In the
editor this is the quickfix list; away from the editor it is a static tree. It
reads the artifact store and never talks to the orchestrator, which is what lets
the engine run on a remote machine while review happens locally.

**Ledger.** Append-only deviation log with a promotion rule (§9).

### 5.1 Why the split

Fusing them was the mistake in 0.1. Separated, three things fall out for free:

- The engine can run anywhere — cloud worker, remote box, a laptop you walked away
  from — because it needs no display.
- The review surface can be reimplemented per editor without touching pipeline
  logic. A Neovim plugin first because that is where the quickfix list is best, but
  nothing about the design is Neovim-specific.
- Mode B stops being a compromise. The phone gets the same artifacts, minus
  navigation, which is the only thing a phone genuinely cannot do well.

---

## 6. The pipeline

Eight phases. The count is not the point — the gates and the context boundaries
are. Mapping to prior art is given so the lineage is legible.

| # | Phase | Input | Output | Gate | Instr. budget | Maps to |
|---|---|---|---|---|---|---|
| 0 | **Question** | user request | `question.md` — research objectives only | none | ≤15 | CRISPY Questions |
| 1 | **Research** | `question.md` *only* | `research.md` — facts about the codebase | none | ≤25 | CRISPY Research |
| 2 | **Design** | request + research | `design.md` — current state, end state, decisions, **open questions** | **G1** answer open questions | ≤30 | CRISPY Design |
| 3 | **Shape** | design | `shape.<ext>` — real type & function declarations | **G2** approve shape | ≤30 | Prime 1+2 |
| 4 | **Slice** | shape + design | `slices.md` — vertical slices, each with TODOs and a checkpoint | **G3** approve slicing | ≤35 | Prime 3 / CRISPY Structure |
| 5 | **Probe** | slices + shape | `trace/*.json`, `probe.md` — deviation report. **Code reverted.** | **G4** approve trace | ≤40 | Prime 4 ⭐ |
| 6 | **Invariants** | probe + ledger | executable checks (hooks/tests), not prose | **G5** approve checks | ≤25 | Prime 5 |
| 7 | **Build** | everything above | working code, per slice | **G6** read the diff | ≤35 | Prime 6 / CRISPY Work |

### 6.1 Phase rules

**Fresh context per phase.** Every phase is a new session. It receives file paths,
not conversation history. No phase may exceed the budget in the table; a phase that
wants more instructions must be split.

**Research is blind.** Phase 1 receives `question.md` and nothing else. It does not
know what is being built. This is what makes it return facts rather than
confirmation of a plan it has already seen. [R1]

**Shape is code, not prose.** Phase 3 emits actual declarations in the project's
language. The user edits them by typing, not by describing. Prose is a failure mode
here.

**Slices are vertical.** Phase 4 must produce thin end-to-end slices, each
independently checkpointable. Horizontal plans — all of layer A, then all of layer
B — are explicitly rejected; that ordering is one of the things CRISPY changed
about RPI, and it is the one structural place Valtay disagrees with Prime's method. [R1]

**Slice size is bounded by legibility.** If a slice's trace exceeds ~7 nodes, the
slice is too large. This is not a style rule — working memory holds 3–5 chunks, and
a trace you cannot hold is a trace you cannot review. [R5] The renderer's node count
is therefore also the planner's constraint, which gives slice-sizing an objective
test for the first time.

**Probe reverts.** Phase 5's code is deleted. Its outputs are the trace and the
deviation report. If the user wants to keep probe code, that is a signal the slicing
was right and the probe should have been the build — a config flag may allow
promotion, but the default is revert.

**Invariants are executable.** Phase 6 emits hooks, lint rules, or tests. Never
prose assertions. Models are demonstrably weak at generating meaningful invariants;
the recovery is to generate few and make them mechanical. [enforcement ladder, R6]

### 6.2 Gates

A gate is a stop. The orchestrator does not advance until an approval is recorded.
Approvals are written to `.valtay/<slice>/approvals.jsonl` with a timestamp and the
artifact hash approved, so a later artifact edit invalidates the approval.

Rejection at any gate re-runs that phase with the rejection text appended as
additional input — not the whole conversation, just the correction.

Every gate must be answerable in Mode B. G6 (read the diff) is the exception and is
allowed to require a desk.

---

## 7. Artifact formats

All artifacts live in `.valtay/<slice-id>/` and are committed. They are input to
future phases and to future changes, so they are written for machines and humans
both.

### 7.1 Trace schema

The one format worth specifying now, because everything downstream depends on it.

```json
{
  "slice": "player-damage-on-leak",
  "source": "runtime",
  "entry": "input_event",
  "nodes": [
    {
      "id": "n0",
      "symbol": "input_event",
      "file": "src/main.odin",
      "line": 210,
      "layer": "io",
      "status": "unchanged",
      "note": null,
      "children": ["n1"]
    },
    {
      "id": "n1",
      "symbol": "ui_hit_test",
      "file": "src/ui/hit.odin",
      "line": 44,
      "layer": "ui",
      "status": "changed",
      "note": "returns element; no longer mutates game state",
      "todo": 4,
      "children": ["n2"]
    }
  ],
  "deviations": [
    {
      "todo": 7,
      "kind": "signature",
      "detail": "player_take_damage needed the wave index to attribute the leak",
      "file": "src/game/player.odin"
    }
  ]
}
```

Required properties:

- `source` is one of `runtime` | `static` | `agent` — the reviewer must always know
  how much to trust the path (§12).
- `layer` is derived from a project-configured path→layer map. It exists so the
  renderer can color it (§8.3).
- `status` ∈ `new` | `changed` | `unchanged`, per node.
- `note` is the inline annotation. It is **inline by requirement**, not in a
  companion document. Splitting a diagram from its explanation imposes an
  integration cost on working memory that can erase the benefit of having the
  diagram at all. [R7]

### 7.2 Other artifacts

| File | Shape |
|---|---|
| `question.md` | 3–7 research objectives, no implementation detail |
| `research.md` | facts with file:line citations, no recommendations |
| `design.md` | ≤200 lines. Current state / end state / decisions made / **open questions** |
| `shape.<ext>` | declarations only, compiles or parses |
| `slices.md` | ordered slices, each: goal, TODOs with file:line, checkpoint command |
| `probe.md` | per-slice deviation list, generated by phase 5 |
| `approvals.jsonl` | append-only gate record |

---

## 8. Review surface

### 8.1 Three levels

Borrowed directly from Trailblazer's finding that a hierarchy of answer → tour →
walkthrough lets a reader choose depth without losing coherence. [R4]

1. **Line.** One sentence: what this slice does, how many nodes, how many deviations.
2. **Trace.** The annotated call path. This is the default view and the one designed
   for Mode B.
3. **Detail.** Full artifact or full diff. Desk only.

### 8.2 Primary render target: the quickfix list

**The trace renders into the editor's quickfix list, one entry per node, in
execution order.** We do not build a viewer.

```
.valtay/…/trace.json  ──▶  :copen

src/main.odin|210| io    ─  input_event
src/ui/hit.odin|44|  ui  ~  ui_hit_test — returns element, no longer mutates
src/game/cmd.odin|12| game +  game_enqueue_command  #4
src/game/sim.odin|88| game ─  sim_step
src/game/wave.odin|140|game ~  enemy_reach_end — marks completed, not removed
src/game/player.odin|31|game + player_take_damage  #7  ⚠ needed wave index
```

Rationale, in order of weight:

1. **Navigation is the finding.** Trailblazer's participants valued clickable
   links from explanation to editor location above the quality of the explanation
   itself. [R4] A static tree in a terminal has no links. A quickfix entry is a
   link — `:cn` walks the execution path through the actual code.
2. **It already exists and is already in the user's hands.** `99` returns search
   results to the quickfix list; the `55` prototype pushes git hunks into it. [R11,
   R9] The muscle memory, the keybindings, and the window management are done.
3. **It is the correct data structure.** A quickfix list is an ordered,
   position-indexed collection of file:line + text. A trace is an ordered,
   position-indexed collection of file:line + annotation. These are the same type.
4. **Split-attention is satisfied by construction.** The annotation rides on the
   entry, and the entry opens the code. There is no companion document to
   cross-reference. [R7]

Constraints that survive from 0.1: execution order is the list order (position
encodes causality), status is a fixed-width column, annotation is inline, and the
list should not exceed ~7 entries per slice.

Sign-encoding for status — `+` new, `~` changed, `─` unchanged — rather than color,
because quickfix highlighting is unreliable across setups and a leading glyph in a
fixed column scans as well.

### 8.3 Secondary render: the tree

The ASCII tree is the **summary and the Mode B view**, not the main artifact. It is
what you read when you have no editor, and what the CLI prints when you want the
shape at a glance before jumping in.

```
player-damage-on-leak                          6 nodes · 1 deviation

input_event                                         io
└→ ui_hit_test                       CHANGED        ui
   │  returns element, no longer mutates
   └→ game_enqueue_command           NEW     #4     game
      └→ sim_step                                   game
         └→ enemy_reach_end          CHANGED  #6    game
            │  marks completed instead of removing
            └→ player_take_damage    NEW     #7     game
               │  ⚠ needed wave index — not in plan
```

It shows nesting, which the flat quickfix list cannot. That is its one advantage
and the reason it survives at all: depth is legible here and invisible there.

Design constraints, all of them from the research rather than taste:

- **Ordered top to bottom by execution.** Position encodes causality, which is the
  cheapest possible encoding to read.
- **Status in a fixed column.** Preattentive scanning works on aligned position and
  color; ragged inline markers do not scan.
- **Annotation attached to its node.** Never a footnote. [R7]
- **≤7 nodes.** Beyond that, split the slice.
- **Deviations marked in the trace itself**, not only in `probe.md` — the whole
  point is that the reviewer sees the surprise where it happened.

### 8.4 Layer coloring

Nodes are colored by `layer`. A layering violation — a `ui` node downstream of a
`game` node, say — becomes a color appearing where it shouldn't, which is a
pop-out rather than a thing the reviewer must remember to check for.

This is the specific mechanism by which Valtay compensates for a known human
weakness: the reviewer who reliably fails to notice logic leaking into the UI layer
does not have to notice it. The representation notices.

In the quickfix list the layer is a fixed-width text column rather than a color,
which scans nearly as well and survives any colorscheme.

### 8.5 Trace diff

For a change to existing behavior, the more valuable artifact is not the trace but
the **difference between two traces** — the same oracle scenario run on `main` and
on the worktree.

```
  input_event
  └→ ui_hit_test
+    └→ game_enqueue_command
     └→ sim_step
-       └→ enemy_remove
+       └→ enemy_mark_dead
+          └→ player_take_damage
```

"What did this change actually do to control flow" is one of the questions a text
diff answers worst and this answers directly.

---

## 9. Deviation ledger

`.valtay/ledger.jsonl`, append-only, project-scoped, committed.

Every probe deviation is appended with its slice, kind, and detail. The ledger is
an input to phase 6 (invariants) and phase 2 (design).

**Promotion rule.** When a deviation of the same kind and location recurs **three
times**, the orchestrator surfaces it and proposes promotion to either:

- a line in the project's agent instructions (`AGENTS.md` / `CLAUDE.md`), or
- an executable invariant (preferred).

Promotion is a gated action; the system never edits agent instructions on its own.

This is the compounding mechanism, and it is what makes Valtay get better with use
rather than staying flat. It is also the piece with the least prior art — no
existing harness captures plan-deviation as structured data.

---

## 10. Enforcement ladder

Four levels, borrowed from ai-conductor, which is the clearest articulation of the
idea. [R6] Every rule in a Valtay project declares its level:

| Level | Mechanism | Reliability |
|---|---|---|
| Advisory | text in a prompt | low |
| Gating | phase blocked until evidence produced | medium |
| Structural | separate session with restricted inputs | high |
| Mechanical | hook, lint rule, or test | absolute |

The design bias is to move rules down this table over time. The ledger's promotion
rule is the mechanism that does it. A rule that keeps being violated at Advisory is
evidence it should be Mechanical, not evidence it should be repeated louder.

---

## 11. Host adapter interface

The portability boundary. **This is not a novel design** — `99` already ships a
working version of it, switching between four agent CLIs behind one config: [R11]

| Provider | Binary | Default model |
|---|---|---|
| OpenCode (its default) | `opencode` | `opencode/claude-sonnet-4-5` |
| Claude Code | `claude` | `claude-sonnet-4-5` |
| Cursor Agent | `cursor-agent` | `sonnet-4.5` |
| Gemini | `gemini` | auto |

The shape of that table is the whole abstraction: a binary name and a model string.
Valtay should copy it rather than invent, and should treat `opencode` as a first-class
target alongside Claude Code and Codex — it is the default in the one shipped tool
we have evidence from, and it is the most open of the four.

A host adapter must provide exactly this:

```
run(prompt: string,
    inputs: FilePath[],
    workdir: Path,
    write_allowed: bool) -> { stdout, files_written, exit_code }
```

One shot. No conversation. No session reuse. If a host cannot run a
non-interactive, file-scoped invocation, it cannot be a Valtay host.

**Capability declaration.** Adapters declare optional capabilities:

| Capability | If absent |
|---|---|
| `subagents` | phases run sequentially instead of fanned out |
| `hooks` | mechanical invariants fall back to Gating level |
| `worktrees` | Valtay manages worktrees itself via git |
| `mcp` | trace adapter must be a CLI rather than a tool |

Known targets at v1: Claude Code, Codex CLI, OpenCode. Pi is a natural fourth
because its print/JSON mode matches the interface almost exactly.

**Context-injection convention.** `99` uses two sigils in prompts: `#rules` pulls in
`SKILL.md` files, `@files` fuzzy-includes project files respecting `.gitignore`.
[R11] Valtay's phase prompts should adopt the same convention rather than a private
one — it means a Valtay phase prompt is legible to, and reusable by, a `99` user, and
it makes phase prompts ordinary skills rather than a bespoke format.

**Explicit stance on model choice:** Valtay does not select models and does not care
which one runs a phase. Phase-to-model mapping is user config. A workflow that only
works on one model is a workflow with a hidden dependency on that model's quirks.

---

## 12. Trace adapter interface

The hard part of the product, and the part most likely to determine whether it is
adoptable.

```
trace(entry: Symbol|Scenario, workdir: Path) -> Trace
```

Three tiers, in descending order of trust. The tier is recorded in the trace's
`source` field and displayed to the reviewer.

**Tier 1 — Runtime (`source: "runtime"`).** The project has a deterministic
headless mode; Valtay runs a scenario and records the actual call sequence. This is
the gold standard and it is what makes a trace *evidence* rather than a claim. The
inspiration case — a game with a JSON-driven headless mode running at tens of
thousands of frames per second — is the ideal: traces are nearly free, and the
trace diff in §8.4 is exact.

**Tier 2 — Static (`source: "static"`).** Language-server or compiler-driven call
graph, pruned to paths through the changed symbols. Available for most typed
languages, cheap, but cannot resolve dynamic dispatch and will over- or
under-approximate.

**Tier 3 — Agent-discovered (`source: "agent"`).** An agent explores with
go-to-definition and find-references and reports the path it walked. Weakest
guarantee, universal availability. This is not a hypothetical fallback — it is
essentially what Trailblazer does, and it measurably beat a strong baseline on
speed, completion, and retention. [R4]

**Adoption path.** A project starts at Tier 3 with zero setup. Adding a headless
mode moves it to Tier 1 and makes everything downstream better. Valtay should
actively nag about this: the single highest-leverage investment a project can make
in its own agent workflow is a cheap deterministic oracle.

---

## 13. Configuration

```toml
# valtay.toml
[host]
default = "claude-code"
phases.probe = "codex"          # per-phase override

[trace]
tier = "runtime"
command = "odin run . -json -scenario {scenario}"

[layers]
"src/ui/**"     = "ui"
"src/game/**"   = "game"
"src/platform/**" = "io"

[review]
max_nodes = 7
require_diff_read = true        # G6 cannot be approved from Mode B

[ledger]
promote_after = 3
```

---

## 14. Success metrics

Honest targets. HumanLayer's measured outcome after all of this was **2–3x, not
10x**, with the explicit note that chasing 10x produced a rework treadmill. [R1]
Valtay should be evaluated against 2–3x and against quality, not velocity.

| Metric | How measured | Target |
|---|---|---|
| Time to approve a slice plan | wall clock, G3→G4 | < 5 min |
| Mode B gate completion | % of gates approvable from phone | > 80% |
| Deviations per slice | ledger, rolling | decreasing over a project's life |
| Promotion rate | invariants promoted / month | > 0 and self-limiting |
| Rework rate | slices reopened after G6 | < 15% |
| Comprehension retention | can the user, a day later, reconstruct the control flow they approved? | qualitative, but the Trailblazer Parsons-puzzle design is a real test we could run [R4] |

The last one is the metric that actually matters and the one nobody measures.

---

## 15. Risks and open questions

**Q1 — Does trace review help for *plans*, or only for comprehension?**
Every study cited is about understanding existing code. Reviewing a proposed change
is a different task, and the transfer is assumed, not demonstrated. **This is the
biggest unvalidated assumption in the document.** Mitigation: the probe produces a
real trace of real executed code, which narrows the gap considerably — but it should
be tested before building the renderer.

**Q2 — Is the probe affordable?** Phase 5 implements and discards. On a large change
that could be the majority of the cost of the whole pipeline. Open: cap probe scope
to a single slice, or make probe opt-in past a size threshold.

**Q3 — N fresh sessions costs N system prompts.** Fresh context per phase trades
token cost for quality. Eight phases means eight cold starts. Needs measurement;
may argue for merging phases 0–1 and 6–7 in a cheap mode.

**Q4 — Tier 3 traces could be confidently wrong.** An agent-discovered path that
misses a branch is worse than no trace, because it looks authoritative. Mitigation:
display `source` prominently, and never allow a Tier 3 trace to satisfy a
mechanical invariant.

**Q5 — Does the ≤7 node rule survive contact with real code?** Plausible that
useful slices in a mature codebase routinely touch 15 nodes. If so, the renderer
needs collapsing, and the "legibility bounds slice size" claim weakens.

**Q6 — Greenfield vs. legacy.** All of this assumes there is a codebase to trace
through. On day-one greenfield work, phases 0–4 are useful and 5 is nearly empty.
Valtay should detect this and skip, not pretend.

**Q7 — Naming and scope creep.** The moment this grows a UI, it becomes CodeLayer
with fewer engineers. The non-goals in §3 are load-bearing.

---

## 16. Milestones

| | Deliverable | Proves |
|---|---|---|
| **M0** | This document, argued down to something we believe | — |
| **M1** | Orchestrator + Claude Code adapter + phases 0–4, prose artifacts only | C1: does fresh-context-per-phase actually beat one long session? |
| **M2** | Tier 3 trace adapter + quickfix render | C2, cheaply, before building the expensive tier |
| **M3** | Probe phase + deviation report | The load-bearing idea in §4.1 |
| **M4** | Tier 1 adapter for one project + trace diff | The oracle payoff |
| **M5** | Ledger + promotion + mechanical invariants | C3 and compounding |
| **M6** | Second host adapter (Codex) | Portability was real |

M1 and M3 are the two that can kill the project. Do them before anything pretty.

---

## Appendix A — References

**[R1]** HumanLayer, evolution from RPI to CRISPY. Instruction budget of ~150–200;
planning prompt at 85; the 40% context "dumb zone"; vertical over horizontal
slicing; the public reversal on not reading generated code ("we tried not reading
the code for like six months, it did not end well"); 2–3x rather than 10x.
<https://www.zenml.io/llmops-database/evolution-from-rpi-to-crispy-multi-stage-workflow-for-production-coding-agents>

**[R2]** Larkin, J. & Simon, H. (1987). *Why a Diagram is (Sometimes) Worth Ten
Thousand Words.* Cognitive Science 11(1). Informational vs. computational
equivalence; locality; perceptual vs. logical inference.

**[R3]** LaToza, T. & Myers, B. *Visualizing Call Graphs* (REACHER). Reachability
questions as the hardest class; jEdit study, 12 participants: 78% success with the
visualization vs. 14% without; 7.2 min vs 11.1 min.
<https://www.cs.cmu.edu/~NatProg/papers/Paper3_LaTozaAndMyers_paper.pdf>

**[R4]** *Answering Developer Questions with Annotated Agent-Discovered Program
Traces* (Trailblazer), UIST 2025. 20 participants vs. Cursor baseline: 4.8 vs 7.3
min, 0 vs 7 failures, reduced NASA-TLX mental demand; Parsons-puzzle retention 2.8
vs 10.8 attempts, 75% vs 10% first-try. Design lessons: filter aggressively,
interleave explanation with navigation, hierarchical outputs.
<https://andrewhead.info/assets/pdf/trailblazer.pdf>

**[R5]** Working-memory capacity of 3–5 chunks as a constraint on code
presentation; intrinsic vs. extraneous load, and extraneous load as the part
designers can actually reduce. <https://arxiv.org/html/2511.14636>

**[R6]** ai-conductor. The advisory → gating → structural → mechanical enforcement
ladder; adversarial reviewer isolation.
<https://github.com/jstoup111/ai-conductor>

**[R7]** Chandler, P. & Sweller, J. (1992). *The Split-Attention Effect as a Factor
in the Design of Instruction.* British Journal of Educational Psychology. Why an
annotation must sit with the thing it annotates.

**[R8]** Xia et al. (2018). *Measuring Program Comprehension: A Large-Scale Field
Study with Professionals.* ~58% of developer time spent on comprehension.
<https://soarsmu.github.io/papers/2018/Xia2018ProgramComprehension.pdf>

**[R9]** ThePrimeagen's six-phase workflow (structures → interfaces → TODOs →
implement-then-revert → invariants → implement), and the JSON-mode headless oracle
that makes phase 4 possible. Source: streamed walkthrough, transcript on file.

**[R10]** Pi. Minimal core, extensions as the customization surface, print/JSON
execution modes. <https://pi.dev/>

**[R11]** ThePrimeagen, `99` — a shipped Neovim plugin, Lua, beta. Provider
abstraction over `opencode` / `claude` / `cursor-agent` / `gemini` as binary +
model string; `search` returns results to the quickfix list; `#rules` references
`SKILL.md` files and `@files` fuzzy-includes project files; stated philosophy that
"hand coding is still very important" and that the tool augments rather than
replaces. Notably, the author's own guidance is to favor `search` over code
replacement for most work. <https://github.com/ThePrimeagen/99>

---

## Appendix B — What is borrowed from where

| Element | Source | Changed how |
|---|---|---|
| Blind research phase | CRISPY | unchanged |
| Design doc with open questions | CRISPY | capped at 200 lines, open questions made a gate |
| Fresh context per phase | CRISPY | made physical — artifacts are the only channel |
| Instruction budget | CRISPY | published per phase in the contract table |
| Vertical slicing | CRISPY | bounded by trace legibility rather than judgment |
| Shape = declarations, not prose | Prime | unchanged; it's the right call |
| Implement-then-revert probe | Prime | extended to emit a trace, not just a report |
| Invariants phase | Prime | forced to be executable, since models are bad at prose invariants |
| Enforcement ladder | ai-conductor | unchanged |
| Host portability | Pi | narrowed to a one-shot interface |
| Provider abstraction (binary + model) | `99` | copied outright |
| `#rules` / `@files` prompt sigils | `99` | copied outright |
| Quickfix list as review surface | `99`, `55` | extended from search hits and git hunks to trace nodes |
| Engine / review-surface split | — | consequence of the above |
| Call-path review artifact | REACHER / Trailblazer | applied to *plans* rather than to comprehension — the novel claim |
| Deviation ledger | — | no prior art found |