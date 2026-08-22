# Feature workflow comparison: RepWorth `$feature`, Matt Pocock Skills, and Superpowers

**Research date:** 2026-08-18  
**Question:** Is RepWorth's `$feature` the best workflow for correct, high-quality, low-hallucination delivery, and what should it borrow from `mattpocock/skills` and `obra/superpowers`?  
**Method:** Source-level comparison only. RepWorth's checked-in skill and scripts were compared with the two upstream repositories at their then-current `main` commits: [`mattpocock/skills@9c9f36c`](https://github.com/mattpocock/skills/tree/9c9f36ccd3995266cd675468af71639c8dde1ec5) and [`obra/superpowers@b36e082`](https://github.com/obra/superpowers/tree/b36e0829c6d0140e93cfef2ca599b1b07d4a7797). GitHub stars were not treated as evidence of correctness.

## Verdict

RepWorth should **keep `$feature` as its primary feature orchestrator**. Of the three, it is the best fit for safely changing RepWorth because it turns intent, scope, repository rules, exact-worktree verification, review, and authority boundaries into one guarded protocol. Neither generic upstream provides its combination of:

- a validated machine-readable intake and bounded edit surface;
- size and risk lanes, including an explicit "do not implement" epic lane;
- RepWorth's sibling-worktree setup and arming checks;
- a gate fingerprint covering HEAD, intake, staged and unstaged diffs, status, untracked contents, and lockfile;
- separate correctness, maintainability, and applicable risk reviews;
- root-agent reproduction and `ACCEPT`/`REJECT` triage of findings; and
- explicit refusal to commit, push, migrate, deploy, merge, or flip flags without authority.

That does **not** make it the best possible workflow. There is no comparative benchmark establishing that, and the workflow has two material improvement opportunities: finer-grained durable progress/review during execution, and sharper intent/test-quality discipline before execution. Superpowers is stronger on the first; Matt Pocock's skills are stronger on the second.

There is also a terminology correction: `$feature` produces a **review-ready change**, not a deployment. Its own [shipping boundaries](../../.agents/skills/feature/references/shipping-boundaries.md) deliberately stop before external mutations. Correct deployment additionally requires the authorized PR/CI, staging or runbook, migration/flag, post-deploy, and documentation steps applicable to the change.

## Comparative scorecard

| Dimension | RepWorth `$feature` | Matt Pocock Skills | Superpowers |
|---|---|---|---|
| Intent alignment | Strong, structured intake with sign-off for standard/high work | Strongest semantic approach: decision-tree grilling, domain vocabulary, ADRs, user-confirmed test seams | Strong collaborative design gate with alternatives, section-by-section approval, written-spec review |
| Scope control | Strongest: non-goals, allowed edit surface, estimates, reclassification thresholds | Good in specs/tickets; user-approved vertical slices and explicit out-of-scope section | Good design/plan gates and YAGNI, but no machine-enforced edit surface |
| Implementation isolation | RepWorth-native sibling worktree plus `ARMED` check | Not part of the main chain | Worktree and clean-baseline workflow, but generic setup currently says `npm install` for any Node project, which is wrong for RepWorth's `pnpm` contract |
| Test quality | Good tracer/TDD rules and exact promised tests; repository gate is authoritative | Strongest concise test-design language: public seams, independent expected values, anti-tautology, one vertical red/green slice | Strictest behavioral TDD enforcement, including verified RED and explicit test-quality references |
| Evidence freshness | Strongest: content fingerprint becomes stale after any relevant tree/intake change | Full suite once at end, but no durable freshness binding | Fresh-command rule and final full suite, but no fingerprint binding evidence to all working-tree content |
| Review | Independent axes, confidence threshold, RepWorth risk reviewers, accountable root triage | Independent Standards and Spec axes; no required fix/triage/reverification protocol | Strongest incremental loop: task review, up to five scoped fix/re-review rounds, then whole-branch review |
| Context/compaction control | Durable phase/intake/gate artifacts; root ownership limits handoff drift | Small composable skills, domain glossary, fresh-context-sized tickets; no run ledger in the main chain | Strongest execution recovery: per-plan workspace, progress ledger, task briefs, report files, review packages, and Git history as authority |
| Authority safety | Strongest and RepWorth-specific | `implement` commits to the current branch; no main-chain shipping boundary | Design and task workflows create commits; finishing asks before integration, but does not use RepWorth's authority vocabulary |
| Ceremony | Proportional lanes; still substantial for standard/high features | Leanest and most adaptable, but therefore least mechanically assured | Heaviest: design and review gates apply even to very small work |
| RepWorth suitability | Best | Excellent source of design/TDD techniques, not a replacement orchestrator | Excellent source of execution/review techniques, not safe to transplant verbatim |

## What each upstream does better

### Matt Pocock Skills: better thinking and test design

The main chain is deliberately composable rather than a single guarded runner:

`grill-with-docs → to-spec → to-tickets → implement → code-review`

Its strongest hallucination control is semantic. [`grill-with-docs`](https://github.com/mattpocock/skills/blob/9c9f36ccd3995266cd675468af71639c8dde1ec5/skills/engineering/grill-with-docs/SKILL.md) combines a one-question-at-a-time decision-tree interview with [`domain-modeling`](https://github.com/mattpocock/skills/blob/9c9f36ccd3995266cd675468af71639c8dde1ec5/skills/engineering/domain-modeling/SKILL.md): answer codebase-discoverable questions from source, challenge fuzzy terms and source contradictions, stress-test boundaries with concrete scenarios, persist canonical vocabulary in `CONTEXT.md`, and reserve ADRs for consequential trade-offs. This reduces the chance that an agent implements a coherent answer to the wrong problem.

[`to-spec`](https://github.com/mattpocock/skills/blob/9c9f36ccd3995266cd675468af71639c8dde1ec5/skills/engineering/to-spec/SKILL.md#L7-L75) prefers existing, high public test seams and confirms them with the user. [`to-tickets`](https://github.com/mattpocock/skills/blob/9c9f36ccd3995266cd675468af71639c8dde1ec5/skills/engineering/to-tickets/SKILL.md#L7-L105) produces complete, independently verifiable vertical slices sized for a fresh context, with explicit blocking edges; it handles wide refactors with expand–migrate–contract rather than forcing false verticality. [`tdd`](https://github.com/mattpocock/skills/blob/9c9f36ccd3995266cd675468af71639c8dde1ec5/skills/engineering/tdd/SKILL.md#L7-L38) explicitly rejects implementation-coupled tests, tautological expected values, horizontal batches, and speculative implementation.

Its two-axis [`code-review`](https://github.com/mattpocock/skills/blob/9c9f36ccd3995266cd675468af71639c8dde1ec5/skills/engineering/code-review/SKILL.md#L7-L87) is also well designed: Standards and Spec run in isolated contexts so code style cannot mask implementing the wrong behavior, or vice versa.

The trade-off is assurance. [`implement`](https://github.com/mattpocock/skills/blob/9c9f36ccd3995266cd675468af71639c8dde1ec5/skills/engineering/implement/SKILL.md#L7-L15) is only a short prompt: use TDD where possible, typecheck/test, review, and commit. It has no risk lane, worktree contract, durable phase state, bounded edit surface, content fingerprint, review-finding adjudication loop, or shipping authority boundary. As written, there is also an integration ambiguity: `implement` says review before committing, while `code-review` compares a fixed point to `HEAD`; unless work was already committed, that diff excludes working-tree changes. Finally, `to-spec` asks for an "extremely extensive" user-story list, which can generate specification bulk without adding equal decision value.

### Superpowers: better durable execution and incremental review

Superpowers is the strongest generic end-to-end methodology. Its [basic workflow](https://github.com/obra/superpowers/blob/b36e0829c6d0140e93cfef2ca599b1b07d4a7797/README.md#the-basic-workflow) requires collaborative design, isolated worktree setup, bite-sized planning, TDD, review, and an explicit branch-finishing decision. [`brainstorming`](https://github.com/obra/superpowers/blob/b36e0829c6d0140e93cfef2ca599b1b07d4a7797/skills/brainstorming/SKILL.md) is a hard gate: inspect project context, ask one question at a time, compare approaches, obtain incremental design approval, self-review the written spec, and obtain written-spec approval before planning.

Its current [`subagent-driven-development`](https://github.com/obra/superpowers/blob/b36e0829c6d0140e93cfef2ca599b1b07d4a7797/skills/subagent-driven-development/SKILL.md) is the most useful source for `$feature` improvements:

- one git-ignored workspace per plan;
- a durable progress ledger that survives compaction and is reconciled with Git;
- a preflight consistency matrix covering every task and every shared file/interface;
- task briefs, implementer reports, and fixed-range review packages passed as files rather than accumulated prompt history;
- sequential implementers, with spec-compliance and task-quality review after each task;
- scoped fix/re-review rounds, fresh-eyes/model escalation after repeated failure, and a five-round breaker with written adjudications; and
- one final whole-branch review that sees deferred and parked findings.

These controls directly target context loss, reviewer drift, silent finding discard, and early defects cascading into later tasks. [`test-driven-development`](https://github.com/obra/superpowers/blob/b36e0829c6d0140e93cfef2ca599b1b07d4a7797/skills/test-driven-development/SKILL.md) also requires observing the correct RED failure, minimal GREEN, and a clean rerun. [`verification-before-completion`](https://github.com/obra/superpowers/blob/b36e0829c6d0140e93cfef2ca599b1b07d4a7797/skills/verification-before-completion/SKILL.md) forbids success claims without a fresh full command and inspected output.

The trade-offs are ceremony and genericity. Every creative change takes the design path, including very small ones. The worktree skill's generic Node setup currently uses `npm install`, conflicting with RepWorth's required `pnpm` workflow ([source](https://github.com/obra/superpowers/blob/b36e0829c6d0140e93cfef2ca599b1b07d4a7797/skills/using-git-worktrees/SKILL.md)). Plans and task execution create commits as normal workflow state, which conflicts with RepWorth's explicit commit authority boundary. Task review accepts implementer test reports rather than independently rerunning the same tests, and the final evidence is not fingerprinted against staged, unstaged, and untracked contents. Review is broad but not automatically specialized for RepWorth's billing, tenancy, outbox, approval, migration, or operational invariants.

## Remaining weaknesses in `$feature`

1. **Progress is durable by phase, not by tracer.** `.feature/state.json` and the intake/gate artifacts recover the phase, but the protocol does not require a machine-readable record of each tracer's base/head, completion evidence, and review state. A long execution can therefore recover less precisely after compaction than Superpowers' per-plan ledger.
2. **Review is mostly branch-end, so defects can cascade.** Standard/high work gets strong independent branch review, but not necessarily a task-scoped independent review before a later tracer builds on an early interface. This is where Superpowers' incremental gate is materially stronger.
3. **Review-driven fixes are not guaranteed an independent scoped re-review.** `$feature` requires root verification, accepted fixes, and a fresh gate, but it does not as explicitly require a reviewer to check that each accepted finding was addressed without new breakage.
4. **A green fingerprint proves freshness, not test validity.** It prevents stale evidence but cannot prove a promised test is sensitive to the intended defect. Matt's independent-expectation/anti-tautology rules and Superpowers' observed-RED rule should be stated more directly in `$feature`.
5. **The meta-workflow remains fallible.** RepWorth's own process reviews have found gaps outside the core gate (for example the separate PR Fallow coverage gate and previously missed workflow bookkeeping). This is evidence that mechanical checks should continue replacing prose-only steps, not evidence that the core workflow should be discarded.

## Recommended hybrid, in priority order

1. **Keep `$feature` as the only RepWorth feature orchestrator.** Do not install either upstream methodology as a second competing end-to-end state machine.
2. **Add a lightweight per-tracer durable ledger.** Record tracer ID, dependency, allowed files, base/head or tree fingerprint, RED/GREEN evidence, completion status, and review status. Reconcile it with Git and `.feature/state.json` on resume.
3. **Add incremental review only where it buys down cascade risk.** Require a task-scoped correctness/quality review for high-risk tracers and for any standard tracer that establishes an interface consumed by later tracers. Keep small/trivial work proportional.
4. **Require scoped re-review of review-driven fixes.** The re-review should receive the original finding, the fix-only diff, and covering test evidence, and answer `ADDRESSED | NOT ADDRESSED | NEW BREAKAGE`. Cap the loop and surface residual disagreement.
5. **Sharpen the test rules.** Before writing a test, name the public seam and the production defect/change that would make it fail; derive expected values independently; observe the intended RED; reject tests that merely assert strings, mocks, constants, or duplicated implementation logic.
6. **Use a decision-frontier intake for standard/high work.** Ask one material question at a time, answer source-discoverable questions from the repo, and stress-test boundary cases. Persist only contract decisions—not an "extremely extensive" narrative.
7. **Keep shipping separate but make the handoff explicit.** A full delivery chain is `$feature` review-ready evidence → explicit ship authorization → PR/CI and applicable staging/runbook/migration/flag checks → merge/deploy → post-deploy evidence → documentation/staging realignment. The feature skill should point to that chain, not silently absorb deployment authority.

## Bottom line

For RepWorth, `$feature` is the best **base workflow** of the three because it combines repository-specific invariants with mechanically fresh evidence and explicit authority. Matt Pocock's system is the best source for reducing semantic hallucination and bad tests. Superpowers is the best source for surviving long executions and catching defects before they cascade. The strongest practical workflow is therefore not a replacement: it is `$feature` plus a selective import of those two strengths, while retaining proportional lanes and RepWorth's exact gate and shipping boundaries.
