# Handoff — feat/safety-review-auto-approval

Written at the step 3 boundary, plan round 1 returned **VERDICT: REVISE**.
A resumed session bootstraps from this file. It never needs the prior transcript.

## Where to pick up

**Step 3, mid-gate.** The plan exists and pre-validated clean, but round 1
rejected it. The next action is to apply the round-1 corrections, then ask
`contract-changed` whether a verification round is owed. No implementation has
started. No tracer has moved. `.feature/state.json` phase is `worktree_ready`.

## Paths — read these, never a restatement of them

| What | Path |
|---|---|
| Locked intake (signed off, then corrected once — see D1) | `docs/superpowers/plans/feat-safety-review-auto-approval-intake.json` |
| Arming copy (byte-identical, verified) | `.feature/intake.json` |
| The plan | `docs/superpowers/plans/feat-safety-review-auto-approval-plan.md` |
| Round-1 findings, 13 of them | `.feature/plan-round1-findings.md` |
| Round-1 raw transcript | `.feature/logs/plan-round1.jsonl` |
| The brief round 1 was given | `.feature/plan-round1-brief.md` |
| Deviations, D1–D3 | `docs/superpowers/plans/feat-safety-review-auto-approval-deviations.md` |
| Why the feature exists | `docs/runbooks/evidence/2026-09-17-provider-moderation-corpus.md` |
| Glossary owner for the new term | `docs/context/core-reviews-responses.md` |

## Codex session id — for the verification round ONLY

```
01a0b358-a8ec-7b52-9425-d534a7a24b2d
```

Rounds 2–3 RESUME this session (`codex exec resume <id> "<delta>"`). Never start
a verification round cold: it checks whether its OWN findings were addressed, so
round 1's context is exactly what it needs, and a cold start pays about 1M input
tokens to rebuild it.

## Base branch — do not rebase onto main

This branch is cut from `feat/provider-moderation-corpus` (PR #1309, CI green,
**not yet merged**). T7 extends `tests/llm-eval/moderation-*`, which exist only
there. If #1309 merges first, rebase onto `main` at that point and re-run the
gate — the fork point is not frozen until the step 7 wave dispatches.

## Baseline gate — RED on purpose, and why

`bash scripts/verify-gate.sh --baseline` was run at the step 3 boundary to prove
the tree, without advancing the phase. Result **RED**. All three red rows are
expected or environmental. None is a code defect — this branch has written zero
production lines.

| Row | State | Why |
|---|---|---|
| `promised-tests` | FAIL, all 20 missing | Correct before T1. T1 IS the task that creates them. This row goes green the moment T1 lands. |
| `rls-audit` | FAIL | Environmental. Static coverage PASSES (48 tenant tables enable RLS in migrations). The live check fails with "test DB provisioning incomplete or behind head". The parent checkout has no `TEST_DATABASE_POOL_URL` and so skips it and passes. **Fix at step 5: `pnpm test:db:setup`.** Not run at plan time because it drops schema `public` on the test DB and this feature is `db_touching: false`. |
| `reclassify` | WARN | **False trigger — do NOT re-run step 0 on it.** It reports 3,327 production lines against the 250 estimate, but it diffs against `origin/main` while this branch is cut from the unmerged `feat/provider-moderation-corpus`. It is counting PR #1309's 3,566 insertions. The number becomes honest once #1309 merges and this branch rebases onto `main`. Re-check the trigger then; it is a real signal on a correct fork point. |

## State of the run

- Round counter: `planReviewRounds=1`. Two rounds remain before the stop rule.
- Contract sha recorded: `9011914ff2a4`. Ask
  `bash scripts/feature-state.sh contract-changed <plan.md>` after the fixes —
  `UNCHANGED` skips the verification round, `CHANGED` owes one.
- Enforcement ARMED. No surface overlap with other worktrees.
- Tracers registered, 0/7 done.

## The two owner calls — ANSWERED 2026-09-18, already applied

Both contradicted signed-off intake fields, so they went to the owner rather
than being fixed. Both answers are applied to BOTH intake copies (validated,
byte-identical) and recorded as deviations **D4** and **D5** with ACCEPT
verdicts. A resumed session does not need to re-ask.

- **Finding 6 → correct the wording only.** No runtime readiness gate is added.
  `rollback_plan` now states that readiness is an EXPANSION control and that the
  runtime lever is `AUTO_APPROVAL_ENABLED=false` plus a worker redeploy.
- **Finding 7 → keep the Anthropic fallback.** The `safety_review` descriptor
  retains `fallback`; only an all-attempts failure yields not-cleared. The
  accepted consequence is that production may answer from Anthropic while the
  corpus measured OpenAI, so **T7 must record which provider answered each
  corpus row**. That mitigation is not yet written into the plan.

The original statements of both findings follow, for the reasoning.

**Finding 6 (P1) — the locked `rollback_plan` is factually wrong.** It says
unsetting `AUTO_APPROVAL_PROVIDER_MODERATION_READY` blocks the lane again. It
does not. That flag feeds `buildAutoApprovalReadiness`, which `settings.ts:328`
enforces when an owner **expands** a policy. The generation evaluator never
reads it, and the publisher's runtime check uses `AUTO_APPROVAL_ENABLED`
(`auto-policy-publish.ts:555`). So once customers have policies, unsetting
readiness stops new opt-ins while existing policies keep approving and
publishing. The real runtime rollback is `AUTO_APPROVAL_ENABLED=false` plus a
worker redeploy. This is a correction to an operational promise, not a code
change.

**Finding 7 (P2) — a locked edge case misdescribes the executor.** The intake
says "The LLM circuit breaker is open: not-cleared, with no call attempted."
`runLlmTask` does not behave that way: a blocked primary proceeds to the
Anthropic fallback (`run-task.ts:242`), and a healthy fallback returns normally.
Two ways out, and the choice is the owner's: drop `fallback` from the
`safety_review` task descriptor so the no-call contract holds literally, or
amend the edge case to permit a healthy fallback. Dropping the fallback makes
the check stricter and more predictable; keeping it makes the check more
available. Both are defensible.

## The finding that is fatal to the stated goal

**Finding 9 (P2, but load-bearing).** The plan cannot reach `VERDICT: PASS` as
written. Both G4-F1 corpus rows carry `expectProviderFlag: true`
(`moderation-corpus.jsonl` lines 46 and 50), so a safety-only catch scores
`provider_miss`, whose budget is 0. OR-ing the safety flag into `flagged` does
not change that. T7 must define safety-mode expected-layer semantics explicitly:
preserve raw provider attribution, keep the default mode byte-identical, and
distinguish a combined-lane catch from a provider classification. Without this,
step 8's flag flip can never be reached.

## The four P1s that are straight plan fixes

1. **Cost-finalization outage yields a clearance.** `onFinalizeError:
   'log-and-return-value'` returns the successful model value, and the outer
   catch never sees it. Fix inside the guarded callback.
2. **The schema permits `{cleared: true, concern: 'implied_threat'}`.** All 20
   proposed tests pass on a contradictory verdict. Reject the combination, or
   derive clearance from one authoritative field.
3. **A safety-review outage becomes corpus evidence.** `source: 'failed'` on an
   unsafe row would score as a true positive. This repeats the exact
   silent-failure class the original corpus lane was built to prevent. Needs an
   explicit invalid-evidence outcome with a zero budget.
4. **The direction-of-change property compares the new evaluator with itself**,
   so it cannot detect a pre-existing veto removed from both sides. It must
   compare against an independent pre-feature expectation, with flags and `now`
   held fixed — the evaluator is synchronous but NOT input-pure.

The remaining P2s (8, 10, 11, 12, 13) are in the findings file. Finding 13 is
the cheapest and most annoying: `promised-tests` searches only `src worker
scripts` (`verify-gate.sh:468`), so the three promised corpus titles under
`tests/llm-eval` report missing and the gate fails even when they exist.

## What round 1 confirmed as sound

Not everything was rejected. Round 1 checked and upheld: the transaction
placement (the LLM call outside `sql.begin`), the lock ordering, and the
no-migration claim for the new run-spine step key.
