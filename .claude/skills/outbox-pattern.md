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
pending    -> Created in transaction. Awaiting outbox poller pickup.
dispatched -> Poller sent to BullMQ. Worker is processing.
completed  -> Worker confirmed success. Safe to archive after 7 days.
failed     -> Exceeded max_attempts. Terminal. Requires manual investigation.
```

## Rules
- NEVER write to Postgres then separately enqueue to BullMQ outside a transaction.
- NEVER lose work: if Redis is down, outbox entries stay safe in Postgres and process when Redis recovers.
- Workers MUST complete the originating outbox entry on success.
- The `outbox_id` is passed through BullMQ job data so workers know which outbox row to complete.
