# Plan — #1012, the `auto_post_revoked` Refusal write

Slice 5 of 7 on map #994. One write site, plus the one prerequisite no other
lane needs. Intake:
`docs/superpowers/plans/feat-1012-refusal-auto-post-revoked-intake.json`.

## §0 What is already decided, and what this plan may not re-open

Locked upstream. Do not re-litigate any of these; raise a map-level question
instead.

| Decision | Owner |
|---|---|
| The subject is the RESPONSE, not the `approval_audit_log` row | #1001, superseding #997 |
| `occurredAt` is the `'transaction_time'` sentinel | ticket #1012 |
| One helper owns the whole `refusal_events` statement | #1001 |
| `AUTO_POST_REVOKED_REFUSAL_CATEGORIES` — six codes, two categories | #994 harvest, landed by PR #1034 |
| This lane, `autonomy_suspended` and `policy_gate_held` are three distinct acts | #998 |

**Decided by the owner during this run's grill, and it supersedes the ticket
body.** The ticket proposes hoisting `resolveAccountIdFromBusiness`
(`src/lib/approval/audit.ts`) or "having the ledger writer take the same path",
and warns that the helper returns `''` on a missing business — "a safe failure,
but a failure inside a decision transaction, so handle it".

**We do neither.** The transaction ALREADY reads `businesses` under a row lock:

```
worker/jobs/publisher/auto-policy-downgrade.ts:91-96
    const [lockedBusiness] = await tx<{ id: string }[]>`
      SELECT id
      FROM businesses
      WHERE id = ${businessId}
      FOR UPDATE
    `;
    if (!lockedBusiness) { … return 'no-op'; }
```

Add `account_id` to that column list. No second read, no export from
`audit.ts`, and **the `''` case disappears**: the existing `!lockedBusiness`
guard already returns `'no-op'` before any decision is made, so a missing
business can never reach the ledger write. `audit.ts` is NOT in the edit
surface, deliberately.

## §0.1 Precedent — read these before the first edit

* `src/lib/auto-approval/suspension.ts` — the #1009 call-site precedent, and the
  only Refusal write site on `main`. Copy its SHAPE: the call sits after the
  guard that proves a decision was made, takes the deciding `tx`, and is NOT
  wrapped in `try/catch`.
* `src/lib/refusals/write.ts` — `writeRefusalEvent`, its per-lane input union,
  and the `occurredAtFragment` sentinel. Read its header in full; it states what
  a caller must know and what the helper deliberately does not do.
* `src/lib/refusals/vocabulary.ts` — `AUTO_POST_REVOKED_REFUSAL_CATEGORIES`.
* `src/lib/approval/audit.ts` — `insertAuditLogAutoPolicy`, the write the
  Refusal sits beside. Its `approval_audit_log.created_at` is `DEFAULT NOW()`,
  which is why the sentinel makes the two rows agree to the microsecond.

## §0.2 The shape of the write

Inside `downgradeAutoApprovedResponseForManualReviewInTx`, after the guarded
`UPDATE` returns a row (`worker/jobs/publisher/auto-policy-downgrade.ts:122`)
and beside `insertAuditLogAutoPolicy`:

```ts
await writeRefusalEvent(tx, {
  accountId: lockedBusiness.account_id,
  businessId,
  refusalSource: 'auto_post_revoked',
  refusalCode: reason,
  allRefusalCodes: null,
  refusalCategory: AUTO_POST_REVOKED_REFUSAL_CATEGORIES[reason],
  subjectType: 'response',
  subjectId: responseId,
  occurredAt: 'transaction_time',
});
```

`WriteRefusalEventInput`'s `auto_post_revoked` arm fixes every field's shape, so
this call site does not restate C1–C5.

## §1 T1 — the eval (RED phase, first task, nothing else lands before it)

Write **every** `tests_to_add` title as a FAILING test. **`.feature/intake.json`
is the authority for that list and this plan never restates its length** — an
earlier draft said "thirteen", round 2 grew it to nineteen, and the stale number
in this sentence is exactly how an implementer stops six tests early. Count the
array; do not trust prose. Titles are matched
VERBATIM by the gate's `promised-tests` row — a reworded title reads as an
unwritten test.

**No `.todo`, no `.skip`, no `.fails`.** The gate greps titles only, so an inert
eval passes it while measuring nothing (#1009 learned this the hard way and made
it an intake invariant).

* Unit seam: `worker/jobs/publisher/__tests__/` — the existing
  `auto-policy-downgrade` unit suite. Mock `sql` the way that suite already does.
* Live-DB seam: a `*.integration.test.ts` in the same directory, seeding a real
  account, business, review and auto-approved response. **The file name selects
  vitest's serialized `integration` project — this is not optional.** No run-time
  DDL (`ci:live-db-suites` enforces it).

Evidence: every title in `tests_to_add` present and RED — the gate's
`promised-tests` row is what checks this, and it reads the intake, not this plan.

**Tracer-to-title mapping.** §§2–6 name the titles each tracer turns green, but
the intake remains the authority. Round 2's additions belong as follows: the two
new no-op titles and the caller-transaction title to **T4** (no-op paths) and
**T3** respectively; the outbox-CAS rollback, the strengthened kill-switch title
and the first-write-wins duplicate to **T5**; the production-gate routing title
to **T3**.

## §2 T2 — `account_id` reaches the write site

**Behavior:** the transaction that downgrades a response knows its account.

Widen the `businesses` lock SELECT to `SELECT id, account_id`, and type the row
`{ id: string; account_id: string }`. Nothing else changes: the `!lockedBusiness`
guard, the lock order (reviews → businesses → responses) and every existing
branch stay byte-identical.

* **Test seam:** the existing unit suite's assertions on the emitted SQL.
* **Turns green:** `a downgrade's refusal_events row carries the account_id read
  by the transaction's existing business lock` (once T3 lands the write).
* **Blocking edges:** none. Precedes T3.
* **Precedent:** the `SELECT status, approval_method … FOR UPDATE` immediately
  below it already selects the columns its caller needs.
* **Evidence:** no new query in the emitted SQL — assert the statement COUNT is
  unchanged, not merely that the new column appears. A second `businesses` read
  would pass a column assertion and fail the point of this tracer.

## §3 T3 — the downgrade records one Refusal

**Behavior:** a response taken back from auto-posting is recorded as a Refusal
against that response, in the same transaction as the `UPDATE`, the audit row
and the notification enqueue.

Place the call AFTER `if (!downgraded) return 'no-op';` and beside
`insertAuditLogAutoPolicy`. Order within the transaction is not load-bearing for
correctness, but keep it adjacent to the audit write so the two facts read as
one act.

* **Test seam:** `downgradeAutoApprovedResponseForManualReview` and its `InTx`
  form.
* **Turns green:** `a downgrade writes exactly one refusal_events row against
  the response id` · `a downgrade's refusal_events row carries subject_type
  response, never the approval audit row id` · `a downgrade's refusal_events row
  carries the account_id read by the transaction's existing business lock` · `a
  downgrade's refusal_events row carries occurred_at equal to the
  approval_audit_log created_at written by the same transaction` · `a downgrade
  records the AutoPolicyDowngradeReason verbatim, so judge_disabled and
  judge_unhealthy stay two codes` · `every AutoPolicyDowngradeReason maps to a
  Refusal category and the downgrade writes it` · `the standalone wrapper and
  the in-transaction caller each write exactly one refusal_events row`.
* **Blocking edges:** T2.
* **Evidence:** the `occurred_at` equality case is live-DB and compares against
  the `approval_audit_log` row from the SAME transaction. Read both as `::text`
  or compare in SQL — postgres.js truncates microseconds on decode (#520), and
  the microseconds are the whole point of the sentinel.

## §4 T4 — every no-op path writes nothing

**Behavior:** a Refusal records a DECISION. Where the function returns `'no-op'`,
no decision was made and no row may exist.

There are four such exits, and all four precede the `UPDATE`: absent review
anchor, missing business, non-downgradeable response, lost outbox-attempt CAS.
A fifth is the `UPDATE` itself matching no row.

* **Test seam:** the same two suites.
* **Turns green:** `a no-op downgrade on a response that is not downgradeable
  writes no refusal_events row` · `a no-op downgrade on a missing business writes
  no refusal_events row` · `a downgrade that loses the outbox attempt CAS writes
  no refusal_events row`.
* **Blocking edges:** T3.
* **Evidence:** assert the row COUNT is zero, not that the helper was not called.
  A count survives a refactor that moves the call.

## §5 T5 — failure, idempotency and the kill switch

**Behavior:** the ledger never breaks the thing it records, and turning it off
changes nothing else.

Three cases, and each one names a rule rather than a preference:

1. **A ledger failure aborts the decision.** No `try/catch` at the call site.
   The `UPDATE`, the audit row and the `send_notification` outbox row roll back
   with it. This is the invariant #1009 stated: the lever against a writer bug is
   the kill switch, not a catch.
2. **A duplicate leaves one row and COMMITS.** The partial unique index is
   `(refusal_source, subject_id) WHERE subject_id IS NOT NULL`, and the helper's
   `ON CONFLICT … DO NOTHING` is what stops a second downgrade of one response
   aborting its own transaction.
3. **`REFUSAL_LEDGER_ENABLED=false` leaves the downgrade byte-identical.**

* **Turns green:** `downgrading the same response twice leaves one
  refusal_events row and lets the second transaction commit` · `downgrading the
  same response for two different reasons keeps the first refusal code and
  category` · `a ledger failure rolls back the downgrade, the approval audit row
  and the notification enqueue together` · `a ledger failure rolls back
  completion of the claimed outbox attempt so the publisher can retry` ·
  `REFUSAL_LEDGER_ENABLED=false changes only the refusal row and preserves the
  response downgrade, approval audit, notification enqueue, and outbox
  completion`.
* **Blocking edges:** T3.
* **Evidence:** force the failure through a real constraint violation, never a
  mock that throws — a mocked rejection proves the call site propagates, not that
  Postgres aborts the transaction. **Precedent:
  `src/lib/auto-approval/__tests__/suspension.integration.test.ts`** — its
  forced constraint-violation rollback case, and the success-then-rollback twin
  beside it, which is what proves a SUCCESSFUL ledger row shares the caller's
  transaction. (An earlier draft cited `src/lib/refusals/__tests__/write.integration.test.ts`;
  that file carries no forced-`23514` case, and round 1 caught the misdirection.)

## §6 T6 — the documentation sweep

`docs/directory.md`'s `auto-policy-downgrade.ts` row gains the write site and the
widened lock. One row, and no new PRODUCTION file — `ci:directory-map` covers
`worker/` and `src/lib/` production files only, so the new live-DB test suite in
§7 needs no row.

* **Evidence:** `pnpm ci:directory-map` green, and the row's claims re-read
  against the file after the last code change — not before it.

## §7 What this plan deliberately does not do

* No `try/catch` anywhere near the ledger write.
* No change to WHICH responses downgrade, when, or why.
* No edit to `src/lib/approval/audit.ts`.
* No re-test of migration 116's CHECKs or its partial index — #1008 owns both.
* **ONE new file: the live-DB suite.** Round 1 corrected an earlier claim that
  both test files existed. Justification in §8 R1-7; the intake's
  `worker/jobs/publisher/__tests__/**` glob already covers it.

## §8 Review appendix — round 1 (plan-skeptic, codex, read-only)

**VERDICT: REVISE.** Eight findings, three HIGH. All eight accepted; the plan and
the intake's `tests_to_add` are amended below. The skeptic independently
confirmed the `account_id` override (`businesses.account_id` is `NOT NULL` with
a restrictive FK to `accounts`, so a locked business cannot carry a null or a
dangling account), the `occurred_at` equality mechanism, and that the six-code
vocabulary keeps `judge_disabled` and `judge_unhealthy` distinct.

### R1-1 HIGH — the absent review anchor is an untested no-op

`anchorReviewLockOrder` returning nothing is the FIRST exit, and no promised
title covered it. An implementation writing the Refusal before that guard passes
every other no-op test.

**Added:** `a no-op downgrade with no review anchor writes no refusal_events row`

### R1-2 MEDIUM — the guarded UPDATE matching no row is an untested no-op

The fifth exit. A write placed before `if (!downgraded)` passes all three
promised no-op tests. The branch is defensive and hard to reach against live
Postgres because the response row is locked, so the case may be unit-level.

**Added:** `a downgrade whose guarded response UPDATE matches no row writes no refusal_events row`

### R1-3 HIGH — "exactly one row" does not prove the caller's transaction

The sharpest finding on this plan. A wrong implementation can open a SECOND
transaction for the ledger write: both count assertions still pass, the row
survives an outer rollback, and its `NOW()` comes from a different transaction.
That is invariant #15 escaping the eval.

**Added:** `the in-transaction downgrade writes the refusal on the caller transaction and an outer rollback removes it`

### R1-4 HIGH — the rollback test omits the outbox attempt

`markOutboxCompletedIfOwned` claims the exact dispatched attempt BEFORE the
downgrade. If a ledger failure left that completion committed, the publisher
could never retry — the intake promises it can.

**Added:** `a ledger failure rolls back completion of the claimed outbox attempt so the publisher can retry`

### R1-5 MEDIUM — "still completes" is too weak for the kill switch

The locked behaviour is stronger than the title: disabling the ledger must leave
EVERY pre-existing effect unchanged, not merely let the function return.

**Replaces** `a downgrade still completes when REFUSAL_LEDGER_ENABLED is false`
**with:** `REFUSAL_LEDGER_ENABLED=false changes only the refusal row and preserves the response downgrade, approval audit, notification enqueue, and outbox completion`

### R1-6 MEDIUM — the duplicate test does not pin first-write-wins

Using the same reason twice cannot tell `DO NOTHING` from an `UPDATE` to the
latest reason. **The semantics are decided and are not a new question:** #1001's
partial unique index is `(refusal_source, subject_id)`, the subject here is the
response, and `ON CONFLICT DO NOTHING` means the FIRST Refusal for a response
stands. The skeptic notes there is no legitimate re-auto-approval path for one
response today, so the case is defensive — but it must be pinned, not assumed.

**Added:** `downgrading the same response for two different reasons keeps the first refusal code and category`

### R1-7 MEDIUM — a cited artifact does not exist

§7 claimed "both test files already exist". There is no
`worker/jobs/publisher/__tests__/auto-policy-downgrade.integration.test.ts` at
HEAD — only the unit and lock-order suites. **T1 therefore creates one new test
file**, and `working-rules.md` § Anti-slop requires the justification: no
existing suite in that directory is a live-DB suite for this module, and the
`*.integration.test.ts` name is what selects vitest's serialized project. A unit
suite cannot carry the `occurred_at` equality, the rollback cases or the
partial-index behaviour, all of which need real Postgres. The intake's
`worker/jobs/publisher/__tests__/**` glob already covers it.

### R1-8 LOW — the caller inventory reversed reasons and sites

The intake said "four through `judge-gate.ts` and two through
`auto-policy-publish.ts`". That is the SITE count, not the reason count:
`judge-gate.ts` has four call sites carrying two reasons, and the other four
reasons arrive elsewhere. Corrected in the intake.

**Added:** `each production gate routes every AutoPolicyDowngradeReason verbatim to the shared downgrade`

### Round 2 — verification-only, resumed session

**VERDICT: REVISE.** Four findings, all one class: **amendment drift** — a fact
corrected in this appendix and left contradicting an instruction elsewhere. One
HIGH (T1 still commanded "all thirteen" titles while the intake held 19, and
§§3–5's "turns green" lists omitted the additions), one MEDIUM (the corrected
caller inventory did not replace the stale `edge_cases` wording), two LOW (§6 said
"no new file" against §7's one new live-DB suite; this appendix said seven
findings while enumerating eight).

All four accepted and fixed. The counts were then removed from the prose
entirely: **`.feature/intake.json` is the authority for the title list and this
plan does not restate its length**, because a stale number here is precisely how
an implementer stops short.

### Round 3 — final, and the cap

**VERDICT: APPROVED.** No surviving contradictions. All 19 titles map to tracers,
no tracer names a title the intake lacks, and both intake copies are
byte-identical. The one stale phrase found was quoted historical context in this
appendix, not an active instruction.

Round 3 is the cap. Nothing followed it; the branch went to implementation.

### Correction the skeptic did not raise, found while applying its findings

§5's forced-failure precedent cited
`src/lib/refusals/__tests__/write.integration.test.ts`. That file has no forced
`23514` rollback case. **The real precedent is
`src/lib/auto-approval/__tests__/suspension.integration.test.ts`** — its
constraint-violation rollback case and its success-then-rollback twin. Corrected
in §5 and carried to the other two slices, which cited the same wrong file.
