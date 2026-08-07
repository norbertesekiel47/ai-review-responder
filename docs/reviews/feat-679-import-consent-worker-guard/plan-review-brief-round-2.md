# Plan review round 2 — #679 — VERIFICATION ONLY

This is a **verification-only** round. Round 1 returned `REVISE` with 11 findings;
they were triaged and the plan revised. Your job is narrow.

## Scope — read this before anything else

You may ONLY:
1. Verify that each round-1 finding is genuinely addressed in the revised artifacts.
2. Flag a defect that one of the FIXES introduced.

You may NOT open new fronts against plan sections that did not change. If you spot
something unrelated, put it in a clearly-marked appendix at the end of your report;
it will be noted and deferred, not triaged.

## What changed

Commit `36134102` on `feat-679-import-consent-worker-guard`. Read the diff:

    git show 36134102 --stat
    git diff 4bef52d9..36134102

Artifacts:
- `docs/superpowers/plans/2026-08-07-import-consent-worker-guard.md` (revised plan)
- `docs/superpowers/plans/feat-679-import-consent-worker-guard-intake.json` (revised intake)
- `docs/reviews/feat-679-import-consent-worker-guard/plan-review-round-1.md` — your
  round-1 report, with an **Orchestrator triage** table appended at the end giving a
  per-finding verdict and where it was addressed.

Do NOT read any `*-deviations.md` file, and do not treat the triage table's prose as
evidence that a fix is correct — check the revised plan and intake text itself, and
check the source files they cite.

## Per-finding verification

For each of the 11 rows in the triage table, answer: **addressed / not addressed /
addressed but the fix is defective**, with the specific text or code that settles it.

Pay particular attention to these three, which are the substantive ones:

1. **The race fix (finding 1).** The plan now specifies `sql.begin` +
   `SELECT … FOR UPDATE` on `businesses` + `markOutboxCompleted` on the same `tx`,
   in business-before-outbox lock order. Verify this actually closes the
   interleaving you described, in BOTH orders (guard-first and acceptance-first).
   Verify it introduces no new deadlock against any other writer that takes these
   two locks — check `recordImportDecisionAndEnqueue`, `archive-location-tx.ts`,
   `worker/ingress/stripe/shared.ts`, and the OutboxPoller's claim path. A lock-order
   inversion introduced by this fix is exactly the kind of defect this round exists
   to catch.

2. **Findings 5 and M4, where a sub-proposal was REJECTED.** Judge whether the
   stated reasoning holds, not whether you'd have chosen differently. For 5: is it
   true that no import can occur on the malformed-tier path, so that only the outbox
   disposition differs? For M4: is the taxonomy genuinely unenforced by CI, making a
   new audit test out of scope?

3. **Finding 6's missing-business rewrite.** Confirm that with the guard first, the
   backfill `subscription_status=missing` branch in `guardZernioJobEligibility` is
   genuinely unreachable for the backfill worker, and that the plan's instruction to
   rewrite the test and both JSDoc blocks is sufficient — i.e. no other test or
   caller depends on that branch firing.

## Output

Write your full report to
`docs/reviews/feat-679-import-consent-worker-guard/plan-review-round-2.md`.

End with exactly one of:

    VERDICT: APPROVED
    VERDICT: REVISE

`REVISE` requires a numbered list of findings that are *unaddressed* or *defective
as fixed*. New unrelated observations do not justify `REVISE` — put them in the
appendix.
