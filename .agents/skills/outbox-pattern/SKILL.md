---
name: outbox-pattern
description: The transactional outbox pattern every async workflow in RepWorth must follow (state change + job_outbox row in ONE Postgres tx; OutboxPoller dispatches to BullMQ). Use before writing any code that changes Postgres state and enqueues follow-up work.
---

# Transactional Outbox Pattern

Every async workflow uses this pattern:

1. In a single Postgres transaction:
   - Write the state change (e.g., insert response)
   - Write a `job_outbox` row with topic, payload, and aggregate info

2. OutboxPoller (runs every 10s on Railway):
   - SELECT ... FOR UPDATE SKIP LOCKED from job_outbox WHERE status = 'pending'
   - Dispatch each entry to BullMQ using outbox entry ID as jobId (idempotent dedup)
   - If dispatch fails and attempts < max_attempts: reset to 'pending'
   - If attempts >= max_attempts: transition to 'failed' (terminal)
   - Watchdog: reset entries stuck in 'dispatched' for > 1 hour (check attempts vs max_attempts for terminal vs retry)

3. Worker processes the BullMQ job:
   - All workers are idempotent
   - On completion: UPDATE job_outbox SET status = 'completed'

## Outbox status lifecycle
```
pending     -> Created in transaction. Awaiting outbox poller pickup.
dispatching -> Poller has claimed the row and is handing it to BullMQ.
dispatched  -> Poller sent to BullMQ. Worker is processing.
completed   -> Worker confirmed success. Safe to archive after 7 days.
failed      -> Exceeded max_attempts. Terminal. Requires manual investigation.
```

## The in-flight set is a byte-for-byte contract

`('pending', 'dispatching', 'dispatched')` — every status a row can hold between
enqueue and completion. Owned by `src/lib/shared/job-outbox-status.ts`
(`OUTBOX_IN_FLIGHT_STATUSES`), guarded by `pnpm ci:outbox-status`.

It CANNOT be parameterized. Several sites use it inside an `ON CONFLICT … WHERE`
predicate, where Postgres infers the partial index by comparing that predicate to
the index definition byte-for-byte; a bind parameter defeats the inference and the
dedup guard silently stops working. So the literal is re-spelled by hand at ~26
SQL sites and ~19 migrations, and the audit checks **members and order** at each.

Omitting a member is not hypothetical: migration 018 exists solely to rebuild
`idx_jo_sync_reviews_inflight` because migration 004 shipped it missing
`'dispatching'` — in-flight rows were invisible to the dedup index.

Deliberate divergence carries a per-line `-- outbox-status-audit-ignore` (SQL) /
`// outbox-status-audit-ignore` (TS). Migrations are immutable once applied, so
theirs live in an allowlist inside `scripts/ci/outbox-status-audit.ts`.

## Enqueueing: helper vs. raw INSERT

> Enqueue via a typed helper for a NEW single-row topic. Raw
> `INSERT INTO job_outbox` is sanctioned for: set-based `INSERT … SELECT`
> fan-out; a dedup/payload variant the helper does not model; a topic with no
> helper (17 today — do not backfill on spec). The in-flight status set is
> guarded by `ci:outbox-status`.

Raw inserts are NOT a smell here — 17 of 20 raw-written topics have no helper at
all, and the three helper bypasses are each deliberate (a set-based
`INSERT … SELECT` a per-row helper cannot express; a site where the helper's
dedup guard is dead weight; a failover path needing its own payload field and
in-flight guard). There is no "no raw INSERT" audit, by decision (#568).

## Rules
- NEVER write to Postgres then separately enqueue to BullMQ outside a transaction.
- NEVER lose work: if Redis is down, outbox entries stay safe in Postgres and process when Redis recovers.
- Workers MUST complete the originating outbox entry on success.
- The `outbox_id` is passed through BullMQ job data so workers know which outbox row to complete.
