# Branch review round 2 — verification-only brief (#679)

**Round 2 of a max 3.** Counter is recorded in `.feature/state.json`
(`branchReviewRounds: 2`). Round 1 produced 13 findings across three axes;
**all 13 were accepted**, 10 fixed on this branch, 3 filed as separate tickets.

## The one rule that defines this round

You are **verifying fixes, not re-reviewing the branch.** Concretely:

- For each finding in YOUR axis's round-1 findings table, decide: **LANDED**
  (the fix is present and actually does what it claims), **NOT LANDED**, or
  **REGRESSED** (the fix introduced a new defect).
- You MAY flag a defect that a **fix commit** introduced. That is the primary
  value of this round.
- You may **NOT** open new fronts against code the fix commits did not touch.
  If you notice something unrelated and real, put it in an **Appendix —
  new, untriaged** section at the bottom of your report. It will not be triaged
  this round.
- Confidence filter still applies: findings table holds only ≥80%-confidence
  items with `file:line` and a concrete failure scenario or named standard.

## Priority target — the savepoint

`bfac89d4` is a **non-trivial change to the highest-risk path that no reviewer
has seen**. Round 1's spec axis (Medium) and adversarial axis (High) converged
independently on the same defect: the two Import offer analytics emissions were
plain inserts inside the caller's transaction, so an unapplied migration 102
raised `23514` inside `finalizeConnectionTx` (`finalize-tx.ts:208`), and
`select-location/route.ts:97-108` rethrows non-`23505` — meaning a missing
migration broke **GBP connect entirely**, not merely a consent decision.

The owner chose the **savepoint** remedy: each emission is wrapped so a failed
insert rolls back only itself; success-path atomicity is unchanged.

Verify that claim on its own terms. Specifically worth proving rather than
reading:

1. A failed emission really does leave the enclosing transaction usable (the
   caller's own writes still commit).
2. A **successful** emission still dies with the caller's transaction on
   rollback — the savepoint must not have quietly turned the emission into an
   independent write. (`src/lib/solicitation/__tests__/suppression.integration.test.ts:365-406`
   is the precedent for that pinning.)
3. The savepoint's own failure handling cannot itself poison the transaction
   (release/rollback ordering; a `RELEASE` on an already-aborted savepoint).
4. The logged fallback is a `warn`, not a swallow-and-continue that hides a
   real schema drift forever.

Note for anyone writing a demonstration: **a JS throw does not poison a
Postgres transaction.** Two agents shipped invalid demos on this in round 1.
Any abort injection must be Postgres-side — the pattern in use is a `23503`
FK violation.

## The fix commits (this is the whole diff you are verifying)

| Commit | What it claims to fix |
|---|---|
| `fa84bc1c` | Three tests that passed whether or not the bug existed (runbook A5, job-eligibility) |
| `bfac89d4` | The savepoint remedy in `src/lib/reviews/import-consent.ts` |
| `6b312edb` | Non-DDL abort injection; split the analytics slice into its own suite; migration-102 precondition in the route integration test; new `schema-ready.ts` helper |
| `a2f2ac09` | Rename of the extracted suite to dodge the verify-gate's 40-char slug collision (workaround for filed ticket #696) |

Base for the whole branch: `main@2f369582`. Round-1 review commit: `07f57148`.

## Filed, NOT fixed here — do not reopen

- **#694** — `ci:live-db-suites` R2 DDL detector keys on an incidental marker
  and misses 2 pre-existing sites. `scripts/**` is out of the edit surface.
- **#695** — enforce consent at the `job_outbox` insertion boundary instead of
  per-worker, plus a durable policy-block reason. Both challenge decisions
  locked at #670.
- **#696** — `verify-gate.sh:193` truncates row slugs to 40 chars; colliding
  rows share a status file and can report PASS for a failed suite.

Re-arguing any of these three is out of scope for round 2.

## Facts already established — do not re-derive

- The race fix is load-bearing and mutation-verified. `guardImportConsent` must
  keep `sql.begin` + `SELECT … FOR UPDATE` + `markOutboxCompleted(tx, …)`.
  Removing `FOR UPDATE`, or splitting the transaction, turns
  `worker/jobs/zernio/__tests__/job-eligibility.integration.test.ts` RED. Lock
  order is business-before-outbox, matching all four other writers.
- `add-location-tx.ts` is NOT a `createImportOffer` producer. The three real
  producers are `finalize-tx.ts:208`, `worker/ingress/stripe/shared.ts:159`,
  and the GET self-heal in `src/app/api/dashboard/import-offer/route.ts`.
- The post-savepoint **documentation rewrite is deliberately not done yet** —
  migration 102's header, `.claude/reference/migrations-log.md`, plan §6, and
  `docs/analytics/events.md` still describe the pre-savepoint hazard. That is
  known and scheduled; **do not file it as a finding.**
- `reclassify` WARN in the gate is expected and was re-run twice; the lane did
  not change. Not a finding.

## Inputs

| What | Path (worktree-relative) |
|---|---|
| Intake contract (locked) | `.feature/intake.json` |
| Your axis's round-1 report + triage | `docs/reviews/feat-679-import-consent-worker-guard/review-<axis>.md` |
| Triaged deviations (D9–D30) | `docs/superpowers/plans/feat-679-import-consent-worker-guard-deviations.md` |
| Plan | `docs/superpowers/plans/2026-08-07-import-consent-worker-guard.md` |
| Blast radius | `docs/reviews/feat-679-import-consent-worker-guard/blast-radius.md` |
| Spec | `docs/superpowers/specs/2026-08-05-consented-review-import-design.md` §5.1, §5.3 |
| ADR | `docs/adr/0015-consented-import-unflagged-replacement.md` §2, §3 |

## Output contract

Write your full report to
`docs/reviews/feat-679-import-consent-worker-guard/review-<axis>-round-2.md`
and return ONLY:

1. A verification table: `finding id | LANDED / NOT LANDED / REGRESSED | one line of evidence (file:line)`.
2. A findings table for anything a fix commit broke: `severity | file:line | one-line finding`.
3. `VERDICT: APPROVED` or `VERDICT: REVISE`.

Do not return prose beyond that. The full reasoning belongs in the file.
