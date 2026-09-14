# Valtay — review of the PRD against what is built

Reviewed 2026-09-14 at commit `ef5a776` (Update skills for active runner architecture).
Tests: 178 pass with a git identity set; 2 fail without one (the runner's merge step
needs `user.email`). `tsc --noEmit`: ~40 errors, all in code the runner no longer uses.

---

## Bottom line

The repo contains three generations of design and one generation of code, and the
code implements the newest, smallest one. The PRD (v0.2, eight phases, the probe,
trace review, the deviation ledger) describes a product; `design.md` and
`IMPLEMENTED.md` describe a second, larger one (Research → Reconcile → Shape → Plan →
Probe → Build, `probe.json`, `valtay trace`); the README and `src/` describe a third:
`plan → build → verify`, no probe, no trace, no human gate before code is written.

That third system is ~1,000 lines, cleanly written, well tested at the unit level, and
**has never run end to end against a real provider** — every run directory under
`.valtay/runs/` (`daemon`, `missing`, `skills`) was produced by the previous
"human runs the skills, orchestrator watches for artifacts" flow. The active runner
in `src/run/runner.ts` has only been exercised with a fake provider. Three of the
defects below would stop the first real run before it finishes.

By the PRD's own test — "if the probe doesn't work, Valtay is just CRISPY with a
different phase count" — the current build is CRISPY with a different phase count,
plus an LLM drift check. That may be the right MVP. But the PRD, `design.md`,
`IMPLEMENTED.md`, and `RUNSPEC.md` all still describe the other product, and the
pivot is recorded nowhere except the README and the last four commits.

---

## 1. Defects in what is built (verified against the code)

Ranked by how early they bite.

### 1.1 `valtay approve verify` cannot complete a run — `src/commands/gate.ts:37`, `src/run/orchestrator.ts:82`

`runApprove` appends an approval record and calls `advance()`. `advance()` reads
`verify.json`, sees `status: "drift"`, and parks the run at `awaiting_gate` again. It
never consults `isApproved()` / `latestDecision()` — those functions exist in
`store.ts` and have no callers outside tests. Reproduced: state before approve is
`awaiting_gate`, state after approve is `awaiting_gate`, with the same note.

The test titled "records the approval and completes the run" (`gate.test.ts:71`)
asserts only that the output contains "verify approved" and that a record was
appended; it never reads state. So the README's entire post-run flow for drift
(`valtay approve verify` → complete) is dead. Fix: in `advance()`, when the gate
artifact says drift, check `isApproved(run, "verify")` before parking.

### 1.2 The retry loop is dead code — `src/run/runner.ts:155-166`, `src/run/orchestrator.ts:164-201`

When a layer is `blocked` and `attempt < retries`, the orchestrator writes
`retry.json`, sets `status: "pending", rerun: true`, and returns "Retry 1/1". The
runner then reads state, finds `phase === "build"` rather than `"verify"`, and returns
`{ outcome: "failed", reason: "Unexpected state after build: build/pending" }`. Nothing
re-dispatches. Reproduced. With the default `retries: 1`, a single blocked layer
therefore produces a confusing `failed` rather than the documented `blocked` outcome —
`blocked` is reachable only when `retries: 0`, or on the second failure of a run
nobody can resume (see 1.5).

### 1.3 The provider invocations regress the verified spike — `src/run/provider.ts:24-33`

`design.md §7.2` records, in detail, what was verified against the binaries:
claude needs the payload on stdin, `--permission-mode dontAsk --disallowed-tools ...`
for read-only phases and `--permission-mode acceptEdits --allowed-tools ...` for write
phases; codex is `codex exec --json --sandbox ... --output-last-message ... -`.

The new provider does `claude -p <prompt> --model X [--effort Y]` with no permission
mode and no tool allow/deny list, and `codex -q <prompt> --model X`. Consequences:

- In headless `-p` mode without a permission mode, Write/Edit/Bash are denied when
  the model asks for them. The Plan phase has to write `plan.md` and `briefs/`; the
  build subagent has to write source and run `git commit`. Expect the first real run
  to fail at Plan with "Plan did not produce plan.md or briefs/".
- `codex -q` is the legacy Node CLI's flag. The codex CLI the design was verified
  against (0.153.x) uses `codex exec`. The codex path will not start.
- Invariant 6 ("read-only phases are enforced at the tool layer, not by
  instruction") is gone: Plan and Verify have no fence, and `plan/SKILL.md` rule 6
  ("your tools are read-only by construction") is now false.
- Prompt as argv rather than stdin: fine at today's sizes, but the spike found the
  variadic-flag trap and the argv ceiling; worth keeping the stdin form.

### 1.4 The runner merges into whatever branch you have checked out — `src/run/runner.ts:117-132`

After each wave, `git merge --no-ff <unit-branch>` runs in `repoRoot`, i.e. on the
user's live checkout, whatever branch it is on, whatever uncommitted state it has.
The PRD's non-goals ("Not a PR bot. It stops at a branch"), `design.md §2` ("It never
merges"), and `DAEMON.md` ("The daemon never merges — a human always owns that") all
say the opposite. This is also what makes the tests fail in an environment without a
git identity, and what makes a merge conflict surface as `blocked: Merge failed`
with the half-merged state left in the user's tree.

The mechanical need is real — wave 2 must see wave 1's output — but it can be met by
creating wave-N worktrees from an integration branch (`valtay/<run>`) that the runner
owns, and stopping there. The human merges `valtay/<run>`.

### 1.5 There is no way to resume, and the CLI advertises commands that don't exist

`valtay run` calls `createRun`, which throws `Run "x" already exists`. So after
`valtay reject verify ... --to build`, the README's "re-run" step (`valtay run
runspec.md`) is impossible; the `rerun: true` flag that reject sets is never read by
the runner. Meanwhile `orchestrator.ts:76`, `gate.ts:153` and `gate.ts:203` tell the
user to run `valtay advance`, which is not registered in `cli.ts`; `IMPLEMENTED.md`
lists `resume` and `resume --retry`, which are also not registered. `valtay override`
and `valtay accept` both end by telling the user to "run the build skill", which is
the previous architecture's instruction.

Needed: `valtay run` (or `valtay resume`) that opens an existing run and continues
from `state.phase`, honouring `rerun`, re-dispatching only pending/overridden layers.

### 1.6 Verify has no base to diff against — `assets/phases/verify/SKILL.md`, `src/run/prompts.ts:54`

The verify skill says "use `git diff` against the base branch". The prompt header
passes run dir, repo root, and runspec path — no base commit, no branch names, no
ledger. `IMPLEMENTED.md` records that the previous build recorded "the branch's real
base commit" after `main..HEAD` showed 58 files instead of 2. The new runner dropped
that. After 1.4, the "base" is the user's branch pre-merge, which nothing recorded.
Record the pre-build HEAD in `ledger.json` (or `run.json`) and put it in the verify
prompt.

### 1.7 Config naming split — `src/detect.ts:22` vs `src/run/provider.ts:70`

`valtay init` writes `host = "claude-code"` into `valtay.toml`; `providerFor()`
accepts only `"claude"` and `"codex"`. A runspec that copies the toml's host name
throws `Unknown host: claude-code`. And `resolveConfig()` reads the frontmatter only
("No valtay.toml merge for MVP"), so the toml that `init` writes, and the precedence
comment it prints, are decorative. Either drop the toml or read it; either way, one
host vocabulary.

### 1.8 `tsc` does not pass; dead modules from the previous architecture

`src/trace.ts`, `src/plan.ts`, `src/gates.ts`, `src/commands/trace.ts` are the
Research/Probe-era modules. `trace.ts` and `plan.ts` import `Scope` from `gates.ts`,
which no longer exports it; `trace.ts:181` reads `config.run.max_trace_nodes`, which
`ResolvedConfig` no longer has; `skills.test.ts` calls `loadSkill("research")`.
`commands/trace.ts` is not wired into `cli.ts`. Bun doesn't type-check on `bun test`,
so this passes CI-by-habit. Either delete them (recommended — git has them) or leave
them behind a compile-clean boundary, and add `tsc --noEmit` to `bun test`.

### 1.9 Parallel worktree creation races on the git lock — `src/run/runner.ts:94-98`

Units in a wave run under `Promise.all`; each calls `createWorktree`, which may call
`removeWorktree` → `git worktree prune`. Concurrent `git worktree add`/`prune` in the
same repo contend for `.git/worktrees` and `index.lock`. Create worktrees serially,
then dispatch in parallel.

### 1.10 Smaller

- The frozen runspec isn't frozen. `valtay new` writes
  `.valtay/runs/<name>/runspec.md`; `createRun` copies the spec to
  `.valtay/runs/<name>/runspec.md` — the same file. The SHA in `run.json` is of the
  editable file, so `status`'s "no longer matches its recorded hash" warning only
  fires if you edit it, which is exactly the case it is supposed to catch, but there
  is no untouched copy to compare against.
- Build worktrees have no `node_modules`, so "run the project's tests after each
  layer" fails on a fresh worktree unless the subagent installs first. Nothing in the
  brief says so. Worktrees and `valtay/<run>-<unit>` branches are never cleaned up.
- `assets/phases/build/SKILL.md` tells the builder to write `build.md`; the runner
  overwrites `build.md` with its own summary after the wave loop. The runner uses
  `SUBAGENT.md`, not `SKILL.md`, so the installed `valtay-build` skill is unused and
  contradicts the prompt that actually runs.
- `.claude/skills/valtay:compose/` (colon) is a stale duplicate of
  `valtay-compose/`; `upgrade`'s obsolete-detection only matches the `valtay-`
  prefix so it will never be cleaned.
- The phase skills lack `disable-model-invocation: true` (design §7.4). Installed
  into a project's `.claude/skills/`, `valtay-plan`/`build`/`verify` can be
  auto-triggered by an interactive Claude session on relevance.
- `run_budget` is parsed into `ResolvedConfig.run` and never read.
- `retries` defaults to 1 in code; README's example says 2; neither is documented.
- `.valtay/ledger-project.jsonl` has five identical entries stamped within three
  seconds — a double-write in the old probe path. Harmless now (nothing reads it)
  but it is the file the promotion rule "has to be able to trust".
- `.gitignore` ignores `docs/`, `.valtay/`, and `valtay.toml`. So the PRD, design,
  and IMPLEMENTED docs are not in the repository, and the two things `design.md §4.1`
  says the repo *should* carry (`valtay.toml`, `.valtay/ledger-project.jsonl`) are
  the two it ignores.

---

## 2. Where the code diverges from the PRD (by design, but undocumented)

The PRD's three claims and how the current build treats them:

| PRD element | Status in `src/` |
|---|---|
| C1 fresh context per phase | **Kept.** Each phase is one subprocess; artifacts are the only channel. This is the part that works. |
| C2 review a call path, not prose | **Absent.** No trace, no probe, no `valtay trace`, no quickfix render, no layer map. The reviewer gets `plan.md` (prose + layer list) and `verify.json`. |
| C3 deviations as telemetry, ledger, promotion | **Absent.** `ledger.json` is now a build-status ledger (done/blocked/contested), a different thing from the deviation ledger. `ledger-project.jsonl` is written by nothing. |
| §4.1 the probe — "the load-bearing idea in the entire document" | **Absent.** |
| §6 eight phases, six gates | Three phases, one gate, and that gate is auto-pass on clean. |
| §3 "Not autonomous. There is no mode where the pipeline runs end to end without a human approving gates. That is the product." | `valtay run` is exactly that mode. The human's only pre-code decision is the runspec. There is no G3 (approve the cut) before Build spends money, and no G6 (read the diff) — the LLM verifier stands in for the human reading the diff, which §4 says Valtay must assume the user *will* do. |
| §4 Mode B, 60-second gate forms | Nothing addresses it; `formatRunResult` is close to a Mode B summary by accident. |
| §11 host adapter interface (`run(prompt, inputs, workdir, write_allowed)`) | `Provider.dispatch(prompt, {cwd, model, effort})` — no `write_allowed`, no `files_written`, no capability declaration. Portability now rests on two `switch` cases and argv strings. |
| Invariant 9, whoever produced an artifact does not grade it | Default runspec (`valtay new`) puts Plan/Build/Verify all on claude. Nothing warns. |
| §13 config (`valtay.toml`, layers, trace tier, promote_after) | Written by `init`, read by nothing. |

None of this is necessarily wrong. `DAEMON.md` makes a coherent case for "gates are red
lights, not stop signs", and shipping plan→build→verify first is a reasonable way to
test C1 before paying for the probe. But three documents in `docs/` argue at length for
the opposite, `IMPLEMENTED.md` still says the probe is built and describes
`valtay trace`, and `RUNSPEC.md` documents a seven-section runspec with
`## Assumptions to verify` that the parser (`BODY_SECTIONS = design | out of scope |
notes`) will silently ignore. A reader who trusts the docs will write a spec whose
most important section is dropped on the floor.

The honest version of the pivot is a short section in the PRD: what was cut, what
the MVP is meant to prove (C1, and whether an LLM drift-check is worth its cost), and
what evidence would bring the probe back. `IMPLEMENTED.md` should be rewritten or
deleted; right now it is the most misleading file in the repo because it is the one
that claims to be the honest gap.

---

## 3. What is good

- The store layer (`store.ts`) is careful: hash-bound approvals, `staleArtifacts`,
  append-only jsonl, one-run-or-name-it resolution. It is more infrastructure than
  the current pipeline uses, which is fine — it is the right infrastructure.
- `runspec.ts` handles fences inside sections correctly; `plan-parser.ts` is
  small and well tested, including cycle detection.
- Contestation is a good idea and cleanly modelled: a builder saying "the plan is
  wrong" is C3's deviation signal in a cheaper form. It is the one piece of the
  PRD's telemetry thesis that survived, and it deserves to be named as such.
- The `phase is a skill` decision and the `#rules`-style portability argument are
  right; the current runner half-abandons them by inlining the skill body into the
  prompt (`prompts.ts:52`). That is fine for codex (design §7.2 says so) but it
  means the installed `.claude/skills/valtay-*` are only used if a human invokes
  them.
- `design.md §7.2`'s spike notes are excellent engineering writing and are the
  single most valuable thing in `docs/`. Point 1.3 exists because the code stopped
  reading them.

---

## 4. Recommended order

1. **Run it once for real.** Fix 1.3 (permission mode / allowlists; `codex exec`),
   then `valtay run` on a trivial spec against this repo. Everything after this is
   guesswork until one real run exists — the same lesson `IMPLEMENTED.md` recorded
   for the previous architecture.
2. **Fix the two state bugs** (1.1 approve, 1.2 retry) and add a `resume`/re-entrant
   `run` (1.5). Add assertions on `state.status` to the gate tests.
3. **Stop merging into the user's checkout** (1.4). Integration branch owned by the
   runner; record base commit; hand it to Verify (1.6).
4. **Delete or quarantine the dead modules** and make `tsc --noEmit` part of
   `bun test` (1.8). Unify host names (1.7).
5. **Reconcile the docs.** One paragraph in `PRD.md` on the pivot; rewrite
   `IMPLEMENTED.md` against `src/` as it is; either update `RUNSPEC.md` to the
   three-section format or delete it in favour of `valtay-compose/reference/format.md`.
   Decide whether `docs/` should be tracked.
6. **Then decide about the probe.** With a working three-phase loop and a few runs
   of contestation/drift data, you will know whether the LLM verifier catches what a
   trace would have, and whether a G3 stop before Build is worth the interruption.
   That is the experiment the PRD's M1 was supposed to be.
