# Meta-harness wins, and what they mean for Valtay: speed, evals, self-improvement

Researched 2026-09-17 at commit `1a43c94` (post-run-7 fixes). Follows
`research-comparison-2026-09-14.md`, which already covered Meta-Harness, ADIAS, ACE,
Misevolution and DGM. This document covers what that one did not: the six months of
follow-up work on automated harness optimization, what an eval framework for Valtay
should look like, where Valtay's wall-clock actually goes, and how to add a
self-improvement loop without breaking invariant 8. Source confidence is marked in §7.

---

## Bottom line

The Meta-Harness line went from one paper in March to roughly a dozen systems by
September, and they converge on five findings that are more useful than any single
headline number.

Raw traces beat summaries. Meta-Harness's own ablation: a proposer given scores only
reached a median 34.6, scores plus summaries 34.9, full filesystem access to source,
traces and scores 50.0. The proposer greps; it is not handed a digest.

The gate matters more than the proposer. AHE found an edit's self-declared prediction
of what it will *fix* is about 5× better than chance, and its prediction of what it
will *break* is near chance. AutoSaddler's largest ablation was removing held-out
selection (62.0 → 50.6 on GAIA2). Lin et al. found the evolver model barely matters:
the spread between best and worst evolver is at most 3.1 pp, and a 9B model matched
Opus 4.6.

Code edits transfer, prose edits do not. AHE's component ablation: evolved tools +3.3,
middleware +2.2, memory +5.6, system prompt −2.3. Left unconstrained, AutoSaddler's
optimizer collapsed to 91.5% prompt patches and scored 56.9 instead of 62.0; forcing
executable patches first is what fixed it.

Evolved harnesses rot. Adaptive Auto-Harness watched a single continuously evolved
harness grow from 2 KB to 68 KB and 12 to 34 skills, peak early, then decline on new
tasks. Rules need owners, evidence, and a retirement path.

Strong models benefit least. Harness evolution gave Opus 4.6 +2.6 pp on SWE-bench
against +19.3 pp for a mid-tier model. Valtay runs Opus. A self-improvement loop will
not buy Valtay much raw pass rate; it can buy reliability, cost, wall-clock, scope
control and verifier calibration, which are the numbers Valtay cares about anyway.

One caution on the headline result: Meta-Harness's 76.4% on Terminal-Bench 2 was
searched and scored on the same 89 tasks (the paper says so, and audits for string
leakage by regex). Its text and math results used real held-out sets. Treat the TB2
number as an upper bound, and note that its one concrete published discovery was
mundane: snapshot the environment into the first prompt, saving 2–5 exploration turns.

For Valtay the implication is an ordering. Valtay already has what the proposers need:
per-invocation manifests with cost and turns, full stream-json logs per phase, frozen
runspecs, a mechanical fence with denial counts, and phases that talk only through
artifacts. What it lacks is an evaluator that sits outside the loop. Build that first;
every self-improvement result above is a statement about the gate.

---

## 1. Where Valtay's time goes today

From the seven manifests under `.valtay/runs/`:

| Run | Plan | Build (critical path) | Verify | Wall ≈ | Plan+verify share | Cost |
|---|---|---|---|---|---|---|
| fileset-graph | 103 s | 333 s (2 units, serial) | 106 s | 542 s | 39% | $2.47 |
| worktree-setup | 152 s | 253 s (3 units, parallel) | 78 s | 483 s | 48% | $3.51 |
| stream-progress | 171 s | 343 s (2 units, parallel) | 105 s | 619 s | 45% | $4.23 |
| subagent-scope | 298 s | 547 s (3 units, serial) | 164 s | 1009 s | 46% | $5.66 |

Parallel waves work. The fixed phases are now the bottleneck: plan and verify are
40–48% of wall-clock on every run, and both are single Opus/high calls that spend
most of their turns reading. Builders take 15–48 turns and up to 2.75M cache-read
tokens per unit. Replaying one phase is cheap: verify alone is $0.37–0.62 and
80–165 s; plan alone is $0.25–0.76.

One data point worth keeping: in `subagent-scope`, verify noticed that `--to plan`
did not reset ledger units, called it `minor`, returned `clean`, and the run
auto-passed. Commit `1a43c94` then fixed exactly that by hand, along with four other
things. That commit is five labeled verifier misses. Nothing records it as such.

---

## 2. Moving faster without getting less correct

These are ordered by expected gain per unit of work. Each one is a hypothesis the eval
in §3 should confirm before it becomes a default.

**Deterministic sensors before the LLM verifier.** The most common drift class in the
runspecs so far is structural: a type, a signature, a file that should exist. The
runspec's fenced TypeScript blocks are machine-readable. A ts-morph pass that extracts
declared interfaces and exports from `## Design` and compares them structurally to the
built code turns the largest drift class into a deterministic millisecond check, and
leaves the LLM verifier the behavioural prose. R2E-Gym's result is the
reason to expect this to be more correct and not only faster: execution-only and
LLM-only verifiers each saturate around 42%, the hybrid reaches 51%.

**Environment snapshot in every brief.** This is Meta-Harness's actual TB2 discovery.
The runner computes once per run: repo tree, package scripts, the checkpoint command,
tool versions, the import neighbourhood of each unit's file set. It goes into the
brief. Expect fewer of those 15–48 builder turns.

**Plan lints, then a cheaper planner.** Most of what makes a plan correct is
mechanically checkable: the design slice is verbatim (string diff against the
runspec), file sets don't overlap within a wave (already built), the DAG is acyclic
(already built), the checkpoint is the project's test script, every file named in the
design appears in some layer. With those lints in place, plan on sonnet/medium becomes
a safe experiment. Liu et al. (a bad plan is worse than none) is the reason to run it
as an experiment and not as a config change. For single-unit specs where the runspec
already names the files, a deterministic trivial plan skips the phase entirely.

**Pipeline verify; drop the global barrier.** Verify each unit as it merges to the
integration branch, then run one short integration pass. Co-Coder's list scheduling
(start a unit when its own dependencies finish, not when the wave finishes) is the
build-side version of the same change.

**Acceptance tests from the spec, written outside the builder's context.** Google's
90-production-bug study (Aug 2026): tests generated from a semi-formal contract caught
63.2% of bugs against 53.4% for tests generated from code, and when the contract
covered the violated behaviour, 54.9% against 19.4%. A Valtay runspec already is that
contract. A wave-0 unit that writes acceptance tests from `## Design`, without seeing
the implementation, gives the checkpoint real teeth, gives verify an execution signal,
and produces hidden tests for the eval for free. Anthropic's "decompose by context,
not role" advice cuts the other way, so this one needs the A/B.

**Retries that carry the failure.** `retries: 1` re-dispatches blind. Pass the
checkpoint tail, as setup failures already do.

Not recommended: best-of-N builds or a verifier panel. The earlier document's evidence
stands (nine judges ≈ 2.18 effective votes). CR-Bench adds the cost side: pushing a
reviewer for more recall took it from 27.0% to 32.8% and collapsed signal-to-noise
from 5.11 to 1.95. If a second signal is added, make it execution.

---

## 3. The eval framework

Anthropic's January guide supplies the vocabulary (task, trial, grader, transcript,
outcome; capability evals that start low, regression evals that sit near 100%;
pass@k for "one success is enough", pass^k for reliability). Google's September post
supplies the cheap tier (behavioural evals: one observable action per test, tracked as
a pass rate over time, not as a blocking check). Valtay's artifact-only phase boundary
supplies the thing neither has: any phase can be replayed from a frozen run directory
without re-running the others. That makes a four-tier design affordable.

| Tier | What it measures | Unit cost | Grader |
|---|---|---|---|
| 0. Harness unit tests | Runner, store, parser, hook logic with a fake provider | free | `bun run test` (exists) |
| 1. Behavioural micro-evals | One behaviour of one skill: planner never prefixes install; builder contests the ConfigCache probe; builder never `git add -A`; verifier never reads `reports/`; compose refuses a spec with no interfaces | cents | transcript and file checks; `claude plugin eval` fits this tier |
| 2. Phase replay with seeded faults | Verify recall and false-drift; planner cut quality; contestation precision | $0.25–0.76 per case | known label from the seed |
| 3. End-to-end tasks | runspec → merged branch that passes hidden tests, with cost and wall-clock | $2.5–5.7 per trial | hidden tests plus manifest metrics |

**Tier 1.** `claude plugin eval` shipped on 11 Sep (Claude Code 2.1.269). Cases are
directories with `prompt.md` and `graders/`; four grader types are free (`regex`,
`tool_used`, `tool_order`, `file_exists`), two call a judge; each case runs three
times by default with and without the plugin and reports the delta; a
`scaffold_script` seeds a fixture repo; `--json`, `--threshold` and `--max-cost-usd`
make it a CI gate. It runs with nothing else loaded, which is the isolation you want.
Valtay's skills would need a plugin manifest around `assets/`. Dogfood Experiment B
(the ConfigCache contest probe) is a Tier-1 case; make it permanent instead of
running it once.

**Tier 2 is the workhorse and should be built first.** Take each completed run's
integration diff, which a human has already read, as a clean negative. Apply mutation
operators to produce labeled positives: rename a specified field, change a signature,
drop a specified test, flip a default, add an out-of-scope file, invert a branch the
design describes in prose. Replay verify only. Seven runs and six operators is about
fifty cases and about $25 a sweep. The outputs are the two numbers the 14 Sep document
said Valtay cannot measure: false-clean and false-drift rate, plus severity
calibration (the `--to plan` miss was a severity error, not a detection error) and
CR-Bench's signal-to-noise. Dogfood Experiment A is one row of this table. The same
replay primitive evaluates planner variants against frozen runspecs with the plan
lints as graders.

**Tier 3.** A task is a runspec, a base commit, and hidden acceptance tests the
builder never sees (RepoTrials calls this a sealed task: future git objects and the
reference patch are removed from the agent's view). Three sources, in order of value.
First, Valtay's own completed runs replayed from their recorded base commits, graded
by the tests that landed plus a test for every post-run hand fix. Second, a repo that
is not Valtay and not TypeScript, because a suite made only of Valtay-on-Valtay will
overfit to one codebase's conventions; one of your C# projects would do. Third, mined
bug-fix commits in the RepoTrials style. Harbor is the standard container format if
this ever needs cloud parallelism, but rmoff's hands-on report is that it is awkward
for prompt iteration because each variant duplicates the verifier; keep Valtay's own
runner for iteration and export later.

**Metrics per trial**, nearly all already in the manifest: outcome; hidden-test pass;
verify verdict against truth; contestations and how they resolved; hook denials;
critical-path seconds; cost; turns; and post-merge fix commits touching the run's
files within N days, which is Valtay's version of ARCTIC's revert rate and the only
metric that measures what the human actually experienced. Record `claude --version`
and `codex --version` in `run.json`; the model-harness-fit evidence says scaffolding
goes stale across model releases, and without the version a regression cannot be
attributed.

**Statistics.** At 20–40 tasks the confidence interval on a pass rate is about ±15
points; the Era benchmark write-up found only 3 of 36 model gaps survived correction
at n=33. So: always compare variants paired on identical tasks (roughly a third less
variance); add tasks before adding trials; one trial on the search split, three on
held-out and regression; report pass^3 on the regression tier and mean pass@1 on the
capability tier; report by task type (mechanical, semantic, multi-unit, cross-vendor)
because a blended average hides sign changes. Write the adoption rule down before
running: a variant ships only if the paired delta on held-out is positive, the
regression tier shows no new failures, and cost and wall-clock are not worse by more
than a stated margin. Overlapping intervals mean no decision. An e2e sweep of 20
tasks × 3 trials × 2 arms is 120 runs and $300–700, so it is a release-candidate
check; Tiers 1 and 2 are the daily loop.

**Integrity.** Weng's survey and AHE agree on the rule: the evaluator, hidden tests,
run logs and model configuration are read-only to anything that proposes changes.
Hidden tests live outside the repo the builder can see. Split tasks into search,
selection and test (AHE uses 4:1:5) and rotate the held-out set as tasks saturate;
a task is only useful for selection where variants disagree, so saturated capability
tasks graduate to the regression tier.

---

## 4. Self-improvement that keeps invariant 8

Every system surveyed applies its own edits automatically. Misevolution, DGM's faked
test log, and STOP's sandbox escape are the reasons Valtay does not, and nothing
published since changes that. What the 2026 systems add is a much better description
of what a *proposal* should contain and how it should be tested before a human sees
it. The shape that fits Valtay:

**Evidence.** The proposer reads the run directories directly. On top of them,
`valtay digest <run>` writes a short per-run failure report (AHE's "experience
observability"; HarnessFix compiles ~10M tokens of trace to ~10K) so the common path
is cheap and the raw jsonl is there when the digest is not enough.

**Signatures by mechanism, not file.** `ledger-v1` keys recurrence on `kind:file`.
That is right for the project ledger. Harness defects recur by mechanism across files:
"verify under-rates spec ambiguity", "planner prefixes install", "builder reads the
user's checkout". Self-Harness clusters on a deterministic triple: verifier-level
cause, whether the agent's behaviour was causal, and the abstract mechanism.
HarnessFix attributes each failure to one harness layer before editing and credits
that step with most of its gain. Add `mechanism` and `layer` (skill text, hook or
permissions, runner, config, spec lint) to the entry, and keep the second ledger
design §16.1 planned for harness-level patterns.

**Bounded edit surfaces, in order.** Hook, lint or runner code first; `valtay check`
rules second; skill prose last and within the 40-instruction budget. This is the
earlier document's "promote to lints, not prose" with AHE's and AutoSaddler's
ablations now behind it.

**A proposal is a falsifiable contract.** Evidence (run ids and log lines), inferred
root cause, the diff, the eval cases it predicts will flip to pass, and the cases it
considers at risk. The next eval run scores the prediction. Because regression
predictions are near chance, the at-risk list is advisory and the regression tier is
the authority.

**The gate.** Self-Harness's acceptance rule is the simplest that works: non-negative
on both held-in and held-out, strictly positive on at least one. HarnessFix adds a
bound on newly broken tasks. Rejected proposals stay in the log with their results;
failed attempts are what stop the proposer from trying the same thing again.

**The human applies, through Valtay.** The proposal is emitted as a runspec against
the Valtay repo, with the eval delta report attached. Approving it means
`valtay run`. The self-improvement loop's output is then the same artifact the human
already reviews, built behind the same fence, verified the same way, and bound by the
same hashes. Invariant 8 holds without a special case.

**Demonstrations.** DemoEvolve's finding is that when outcome feedback is sparse,
human demonstrations let the proposer localize edits (12/15 completions against 6/15
for Meta-Harness on its task). Valtay's demonstrations are the commits you make after
a run to fix what it got wrong. `valtay retro <run>` should find commits touching the
run's files after merge, attach them to the run as false-clean labels, and turn each
into a Tier-3 hidden test. `1a43c94` is the first five.

**Retirement.** Every promoted rule records the eval cases that justified it. A
periodic leave-one-out pass over the regression tier finds rules that no longer earn
their place, and every model upgrade triggers the same pass, since context resets
were load-bearing for Sonnet 4.5 and dead weight for Opus 4.6.

**What not to adopt.** RHO improves a harness from unlabeled past trajectories by
letting the agent pick among candidate edits with its own pairwise preference, and
reports SWE-bench Pro 59% → 78% in one cycle. It is attractive because Valtay has
trajectories and few labels. Its selector is exactly what invariant 9 exists to
prevent, and the self-preference evidence in the earlier document applies directly.
Its task-selection idea is worth taking: re-run past hard tasks several times and use
disagreement between runs to find the unstable ones, which are the discriminative
eval tasks. Only the abstract was read for this one.

---

## 5. Order of work

Each row is sized to be one Valtay run.

| # | Run | What it delivers | Depends on |
|---|---|---|---|
| 1 | `replay` | `valtay replay <run> --phase plan\|verify [--assets <dir>]` against a frozen run directory. The primitive under everything else. | — |
| 2 | `eval-verify-seeded` | Mutation operators, labeled cases from the seven completed runs, confusion matrix and severity calibration for verify. First real numbers. | 1 |
| 3 | `retro-capture` | Post-merge fix commits linked to runs as false-clean labels and hidden tests. Record CLI versions in `run.json`. | — |
| 4 | `design-conformance` | ts-morph structural diff of runspec code blocks against built code, run before verify; plan lints. | — |
| 5 | `env-snapshot` | Runner-computed repo snapshot in every brief. | — |
| 6 | `ledger-v1` | As planned in dogfood round 2, with `mechanism` and `layer` fields and the harness ledger. | — |
| 7 | `eval-e2e` | Task manifest (runspec, base commit, hidden tests), paired A/B runner, splits, report with paired deltas and intervals. Tier-1 cases under `claude plugin eval` in CI. | 1, 3 |
| 8 | `propose` | digest → cluster → proposal runspec with predictions → automatic Tier-2 evaluation → report. Human runs it. | 2, 6, 7 |
| 9 | `rule-ablation` | Leave-one-out over promoted rules; retirement proposals. | 7, 8 |

The first three experiments to run once row 7 exists: planner on sonnet/medium against
opus/high with plan lints on; environment snapshot on against off; spec-derived
acceptance tests in wave 0 against none. Rows 4 and 5 can land earlier on judgment,
but their effect size should be measured retroactively rather than assumed.

---

## 6. What changed since the 14 Sep document

That document placed Valtay's "propose, human applies" stance between Meta-Harness and
Misevolution and said the manifest was the asset. Both hold. Three refinements. The
expectation that self-improvement raises capability should be dropped for an
Opus-class builder; the target is reliability and cost. The ledger's recurrence key
needs a mechanism dimension for harness-level patterns. And the order in its §6 is
missing a step zero: none of the promotion machinery can be trusted until a held-out
gate exists, because in every 2026 system the gate, not the proposer, is what
produced the gain.

---

## 7. Sources and confidence

Read at the primary source: Meta-Harness (project page and arXiv HTML, including the
TB2 same-task statement and the trace ablation), AHE, Self-Harness, AutoSaddler,
HarnessFix, Adaptive Auto-Harness, Lin et al., DemoEvolve, CR-Bench, the Google
spec-driven test study, Anthropic's eval guide, Google's harness post, and the
official `claude plugin eval` documentation. Pages were summarized by a small model
during fetch, so exact figures should be re-checked before they are cited in the PRD.
Read only at second hand: HarnessX, SkillOpt, Socratic-SWE and GEPA's Pareto figure
(via Jiaxin Zhang's survey); the Era benchmark statistics (via a news write-up);
Terminal-Bench harness spreads (via Bustamante's post); RepoTrials (the vendor's own
announcement, v0.1.0, Python-centric); RHO (abstract only). Self-Harness was
evaluated on a 64-task subset of TB2 with open-weight models, not frontier ones.

**Harness optimization**
- Lee, Nair, Zhang, Lee, Khattab, Finn. *Meta-Harness.* COLM 2026. https://arxiv.org/abs/2603.28052 · https://yoonholee.com/meta-harness/ · https://github.com/stanford-iris-lab/meta-harness · https://github.com/stanford-iris-lab/meta-harness-tbench2-artifact
- Lin et al. *Agentic Harness Engineering.* arXiv 2604.25850. https://arxiv.org/abs/2604.25850
- Zhang et al. *Self-Harness: Harnesses That Improve Themselves.* arXiv 2606.09498. https://arxiv.org/abs/2606.09498
- *AutoSaddler: Automatic Harness Optimization with Durable Updates from Agent Execution Traces.* arXiv 2608.23041. https://arxiv.org/abs/2608.23041
- *From Failed Trajectories to Reliable LLM Agents: Diagnosing and Repairing Harness Flaws (HarnessFix).* arXiv 2606.06324. https://arxiv.org/abs/2606.06324
- *Adaptive Auto-Harness.* arXiv 2606.01770. https://arxiv.org/abs/2606.01770
- Lin et al. *Harness Updating Is Not Harness Benefit.* arXiv 2605.30621. https://arxiv.org/abs/2605.30621
- Che et al. *DemoEvolve.* arXiv 2605.24539. https://arxiv.org/abs/2605.24539
- *Evolving Agents in the Dark: Retrospective Harness Optimization via Self-Preference (RHO).* arXiv 2606.05922. https://arxiv.org/abs/2606.05922
- Hebbar et al. *SIA.* arXiv 2605.27276. · Karten et al. *Continual Harness.* arXiv 2605.09998.
- Weng. *Harness Engineering for Self-Improvement.* Jul 2026. https://lilianweng.github.io/posts/2026-07-04-harness/
- Zhang. *Self-Evolving Agentic Harnesses.* Jun 2026. https://jxzhangjhu.github.io/blog/2026/self-evolving-agentic-harnesses/
- Bustamante. *Model-Harness-Fit.* May 2026. https://nicolasbustamante.com/blog/model-harness-fit

**Evaluation**
- Anthropic. *Demystifying evals for AI agents.* Jan 2026. https://anthropic.com/engineering/demystifying-evals-for-ai-agents
- Google. *The Anatomy of Harness Engineering: How to Evaluate, Iterate, and Guard AI Coding Agents.* 9 Sep 2026. https://developers.googleblog.com/the-anatomy-of-harness-engineering-how-to-evaluate-iterate-and-guard-ai-coding-agents/
- Anthropic. *Test plugins with evals* (`claude plugin eval`). https://code.claude.com/docs/en/plugin-evals
- Harbor. https://github.com/harbor-framework/harbor · Moffatt. *Kicking the Tyres on Harbor for Agent Evals.* Apr 2026. https://rmoff.net/2026/04/09/kicking-the-tyres-on-harbor-for-agent-evals/
- RepoTrials. https://dev.to/repotrials/repotrials-turn-your-git-history-into-private-coding-agent-benchmarks-4462
- *CR-Bench: Evaluating the Real-World Utility of AI Code Review Agents.* arXiv 2603.11078. https://arxiv.org/abs/2603.11078
- *Grounding AI Agents in Contracts: An Empirical Evaluation of Spec-Driven Test Generation.* arXiv 2608.17177. https://arxiv.org/abs/2608.17177
- *Only 3 of 36 Model Gaps Were Real* (Era benchmark write-up). https://www.beri.net/article/llm-agent-benchmark-confidence-interval-sample-size-model-selection
- Miller. *Adding Error Bars to Evals.* arXiv 2411.00640. https://arxiv.org/abs/2411.00640
