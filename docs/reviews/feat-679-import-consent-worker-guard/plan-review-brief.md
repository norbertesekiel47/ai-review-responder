# Adversarial plan review brief — #679 (round 1)

You are reviewing an **implementation plan and its eval task**, not code. Nothing
has been implemented on this branch yet.

## Artifacts under review (read these, in this order)

1. `docs/superpowers/plans/feat-679-import-consent-worker-guard-intake.json` — the
   locked intake contract.
2. `docs/superpowers/plans/2026-08-07-import-consent-worker-guard.md` — the plan.
3. `docs/superpowers/specs/2026-08-05-consented-review-import-design.md` §5.1, §5.3
   — the design of record.

Read the real code the plan cites. Do NOT read any `*-deviations.md` file on this
branch and do NOT treat any prose written by the plan author as evidence for the
plan's own correctness — verify against source, spec, and the database schema only.

## Your primary question, ahead of everything else

**Can the eval described in the plan's T0 pass while the feature is still wrong?**

Every failure mode you can name must be reported as a **missing failing test**,
naming the file it belongs in and what it would assert — not as a prose objection.
The intake's `tests_to_add` array is the definition of done; attack it as a spec.

Concretely, hunt for:
- A consent state, `backfill_reason`, or ordering the guard would let through that
  the tests never exercise.
- A path that reaches `handleZernioBackfill` without passing the new guard.
- An analytics emission that could fire on a path the plan says emits nothing, or
  fail to fire where it must, without any test going red.
- Anything about the `zernio_backfill_runs` INSERT moving *after* the guard that
  the tests do not pin.
- Transaction-boundary errors: an emission that can roll back a legitimate consent
  decision, or commit when the decision did not.

## Secondary: plan-level findings

Assumptions that do not hold, simpler alternatives, wrong sequencing, invariant
violations (the repo's numbered invariants are in `.claude/CLAUDE.md`).

## Mandatory: cited-artifact check

Verify that **every file path, line reference, symbol name, section number, and
migration number the plan cites actually exists on disk with the content claimed**.
Report each miss individually. Three plan-review rounds on a sibling ticket each
re-reviewed plan-internal consistency and all missed that a cited section had never
been written. Specifically confirm, by reading them:
- `importConsentStateSql`, `createImportOffer`, `recordImportDecisionAndEnqueue`,
  `enqueueInitialImport` exist in `src/lib/reviews/import-consent.ts` with the
  signatures the plan assumes.
- `guardZernioJobEligibility` in `worker/jobs/zernio/job-eligibility.ts` and the
  line numbers the plan quotes.
- `pushImportSqlSetup` at `worker/jobs/zernio/__tests__/ZernioBackfillWorker.test.ts`
  queues results in the order the plan claims, and the count of existing tests that
  depend on it.
- `archive-location-tx.ts` really does gate the reactivation enqueue on `accepted`.
- Migration head really is 101 and 102 is free.
- The 097 → 094 → 089 drift-guard handoff pattern is what the plan says it is.
- `ci:analytics-events` parses the doc format the plan proposes to write.

## Output

Write your full report to
`docs/reviews/feat-679-import-consent-worker-guard/plan-review-round-1.md`.

End the report with an explicit line, exactly one of:

    VERDICT: APPROVED
    VERDICT: REVISE

`REVISE` must be accompanied by numbered reasons, each with the file it concerns
and, where it is a coverage gap, the missing test title and target file.
