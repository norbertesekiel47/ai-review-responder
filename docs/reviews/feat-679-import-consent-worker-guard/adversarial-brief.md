# Adversarial approach review — #679, branch review round 1

Challenge the **approach, design choices, and assumptions**. Line-level defects
and spec conformance are owned by two other axes running in parallel — do not
duplicate them. A valid finding here may mean revisiting the plan, not patching
code.

Diff under review: `git diff 2f369582..HEAD` on
`feat-679-import-consent-worker-guard`. Read-only.

## What shipped

A fail-closed **Import consent** gate in `ZernioBackfillWorker`
(`guardImportConsent`, `worker/jobs/zernio/job-eligibility.ts`), plus migration
102 registering two **Import offer** analytics events and their emissions inside
`src/lib/reviews/import-consent.ts`.

Context: `docs/superpowers/specs/2026-08-05-consented-review-import-design.md`
§5.1/§5.3, `docs/adr/0015-consented-import-unflagged-replacement.md`,
`docs/superpowers/plans/2026-08-07-import-consent-worker-guard.md`.

## The assumptions most worth attacking

1. **That the worker is the right chokepoint at all.** The design argues the
   admin re-enqueue path is manual SQL, so no enqueue-time gate can cover it, so
   the worker must be the enforcement locus. Is that reasoning sound? What does
   it cost — e.g. every legitimate producer now pays a transaction and a row lock
   on a path that was previously lock-free.

2. **That a row lock in the worker guard is the right fix for the acceptance
   race.** The guard now opens `sql.begin`, takes `SELECT … FOR UPDATE` on the
   `businesses` row, and completes the outbox row in that same transaction.
   Alternatives that were NOT taken: making the acceptance path's `NOT EXISTS`
   predicate narrower; having the guard re-enqueue instead of skip; making the
   skip reversible. Is the chosen fix the best of these, or merely the first that
   worked? Consider throughput, lock duration under a slow guard, and what
   happens with a worker replica count above one (the repo is single-replica by
   invariant, DETECTED not enforced).

3. **That fail-closed on `pending` is right.** Anything other than `accepted` —
   including `pending` with a live, unexpired offer — no-op-completes the outbox
   row. The row is consumed and the job does not retry. If a legitimate producer
   ever enqueues slightly before the consent write commits, that import is
   silently dropped rather than retried. Is that acceptable, or should
   `pending` defer rather than consume?

4. **That emitting analytics inside the consent transaction is worth its
   coupling.** It makes the emission atomic with the fact it reports, but it also
   means the `analytics_events` CHECK constraint is now on the critical path of
   an owner's consent decision: a database whose migration lags the code rolls
   back a legitimate "yes". Is the atomicity worth that, versus a best-effort
   post-commit emission?

5. **That splitting the guard from `guardZernioJobEligibility` was right**, given
   both are called back-to-back by the same worker and the split costs a second
   `businesses` read.

## Also fair game

- Whether the 5:1 test-to-production line ratio indicates the design is harder to
  verify than it should be.
- Whether anything here should have been a migration/flag/ADR and was not.
- Whether the deploy-ordering hazard (migration before code, or an emission rolls
  back a real consent decision) is adequately controlled by a runbook step rather
  than by code.

## Output

Full report to
`docs/reviews/feat-679-import-consent-worker-guard/review-adversarial.md`.

Return only a findings table: `severity | file:line | one-line finding`. Confine
the table to findings you would stake ≥80% confidence on; put speculation in a
clearly-marked appendix in the report file. An empty table is a valid result —
do not manufacture findings, and do not restate the design back approvingly.
