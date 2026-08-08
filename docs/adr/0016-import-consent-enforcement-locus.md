# ADR 0016 — Import consent enforcement stays in the worker, not at the job_outbox insertion boundary

## Status

Accepted — 2026-08-08 (issue #695, raised by the adversarial review axis on
#679). Supersedes nothing; re-affirms
`docs/superpowers/specs/2026-08-05-consented-review-import-design.md` §5.3
(locked #670, shipped #679).

## Context

**Import consent** gates the **Review import**: a location's reviews are stored
only after the owner answers the **Import offer** with `accepted`
(`businesses.import_decision`, migration 100). Spec §5.3 locked two coupled
decisions — expiry is *derived* on read by one predicate helper
(`importConsentStateSql`, `src/lib/reviews/import-consent.ts`), and the
enforcement locus is the worker, fail-closed. #679 shipped the second half as
`guardImportConsent` (`worker/jobs/zernio/job-eligibility.ts`), run by
`ZernioBackfillWorker` before the run row is inserted.

The adversarial review of #679
(`docs/reviews/feat-679-import-consent-worker-guard/review-adversarial.md`)
challenged the locus; #695 files the challenge rather than re-planning it. In the
reviewer's own terms, stated fairly: the `job_outbox` insertion boundary is *also*
a chokepoint every producer shares — product code, the admin manual-SQL
re-enqueue path (a runbook instruction, `src/app/admin/runbook/page.tsx`), and any
future producer — and unlike the worker guard it sits *before* dispatch rather
than after. A `CHECK` constraint or `BEFORE INSERT` trigger there would enforce
**Import consent** without a per-worker guard at all. §5.3's own sentence ("no
enqueue-time gate can ever cover [manual SQL]") was written about the four product
enqueue paths and, read literally, is answered by that proposal.

This ADR weighs the proposal and declines it.

## Decision

Enforcement of **Import consent** stays at `guardImportConsent` in
`ZernioBackfillWorker`. **No trigger, no constraint, no migration** on
`job_outbox`.

The observability half of the same review finding is answered instead: a refused
`zernio_initial_backfill` row is completed with
`job_outbox.completion_reason = 'import_consent_blocked'` (the
`OUTBOX_COMPLETION_REASON` vocabulary; the column has existed since migration
083), written by `markOutboxCompletedWithReason` on the guard's own transaction.
A policy refusal is now separable by SQL from a genuine completed import. ONE
marker covers all four refusal states — the per-state detail stays in the log
line (see Consequences).

## Alternatives considered

### A `job_outbox` insert-time gate (`CHECK` constraint or `BEFORE INSERT` trigger) — declined

**For**, as #695 states it, before it is answered:

- Covers manual SQL at insert time, so an unconsented row never becomes a queued
  job.
- One enforcement point instead of one per consuming worker.
- Removes the transaction + row lock #679 added to the worker's previously
  lock-free path.

**Against**, in descending weight:

1. **It forces a second spelling of the derived-expiry predicate, and nothing can
   check the two against each other.** A trigger must re-express
   `importConsentStateSql` — `pending AND import_offer_expires_at <= now()` — in
   PL/pgSQL, inside a migration. §5.3 exists to give that predicate exactly one
   owner (#670's rationale: derive it once, on read, in one place). The TypeScript
   owner is unit-tested; a trigger body lives in already-applied migration files,
   and a change to one is mechanically invisible to the other.

   Stated precisely, because overstating this is how an ADR loses its authority
   the first time someone checks it: a later migration *can* `CREATE OR REPLACE`
   the trigger function, so this is **not literal impossibility**. It is
   **unenforced drift plus a two-environment deploy coupling** — keeping the two
   spellings in sync becomes a deploy-ordering discipline across the staging and
   production Supabase projects rather than a property the code can enforce. On
   this predicate, that is decisive.

2. **`job_outbox` is topic-agnostic infrastructure**, shared by 32 topics. A
   topic-specific trigger couples the shared dispatch table to one domain, and
   every later reader of that table pays to understand why one topic is special.

3. **The marginal gain is small, and this ticket shrinks it further.** The
   difference is "the row is never created" versus "the row no-op-completes
   without importing anything" — in both cases nothing is stored and nothing
   reaches Google. The gap the reviewer actually named is that a refusal was
   indistinguishable from success in `job_outbox`; the durable marker above
   closes it.

4. **It would not remove the worker guard.** An insert-time gate cannot see
   consent that changes between enqueue and dispatch, so `guardImportConsent`
   survives either way — the proposal buys two enforcement points to keep in
   sync, not one. Its third "For" point falls with it: the worker's transaction
   and row lock are not removable by moving the locus (see Consequences).

## Consequences

- **The admin hand-insert path is covered at dispatch, not at insert.** An
  unconsented `zernio_initial_backfill` row *is* created and *is* dispatched;
  `guardImportConsent` then no-op-completes it. Nothing is stored, and no
  `zernio_backfill_runs` row is minted. D8's "admin path included" holds at the
  worker, one step later than a trigger would have caught it.
- **Refusals are durably queryable** via `completion_reason` (this same ticket),
  answering the observability half of #695 without a trigger.
- **The `sql.begin` + `SELECT … FOR UPDATE` cost #679 added stays, and is
  accepted.** It is what closes the accept-races-guard data-loss window (the
  guard reading `pending` while the owner accepts), which an insert-time gate
  would have had to re-derive at its own locus anyway.
- **Nothing reads the marker in code** — no poller, no alert, no Sentry capture,
  no PostHog event, no `/admin/jobs` rendering. A refusal is the guard working,
  not an incident.
- **Revisit if a future consumer genuinely needs refusal at insert time.** This
  records a weighing at a point in time, not a permanent ban on database-level
  enforcement.

### Operator query, and its limits

```sql
SELECT completion_reason, count(*)
FROM job_outbox
WHERE topic = 'zernio_initial_backfill'
  AND status = 'completed'
  AND created_at >= '<deploy timestamp>'   -- rows before this carry NULL either way
GROUP BY 1;
```

There is **no backfill of historical rows**, so refusals from before this change
also carry NULL: **NULL does not universally mean "genuine import."** Outside the
post-deployment window it means "genuine import OR pre-deployment refusal," and
the date bound is what makes the query trustworthy.

Two further limits on what the marker records:

- It records **that** a refusal happened, not current state. A row refused as
  `pending` whose location is later `accepted` keeps
  `completion_reason = 'import_consent_blocked'`, and the state at refusal time is
  not re-derivable from the `businesses` row afterwards.
- The per-state detail (`pending` | `declined` | `expired` | `missing`) lives only
  in the structured log line `import consent blocked — skipping backfill`,
  carrying `{ reason, business_id }` — the ONLY record of it in the `missing`
  case, where the `businesses` row is gone.
