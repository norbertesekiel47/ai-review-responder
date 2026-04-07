# LLM Cost Guard Pattern

All LLM calls MUST follow this two-phase cost accounting pattern. Use `import { createHash } from 'node:crypto'` and the cache Redis instance (NOT the queue Redis).

## Phase 1: Pessimistic Reservation (BEFORE LLM call)

1. Check idempotent cache FIRST: `gen:{reviewId}:v{version}` — if cached, return immediately (no resources acquired).
2. Reserve worst-case cost via Redis INCRBY:
   - `cost:daily:{businessId}:{date}` — per-business daily budget
   - `cost:global:{date}` — platform-wide daily budget
   - Pessimistic estimate: 15 cents (covers long review + fallback provider + guardrail retry)
3. If per-business limit exceeded: DECRBY to release, throw CostLimitExceeded.
4. If global limit exceeded: DECRBY both keys to release, throw GlobalCostLimitExceeded.
5. Acquire concurrency slot: INCR `gen:active:{businessId}`, max 3 per business.
6. If concurrency exceeded: DECR slot, DECRBY both cost keys, throw ConcurrencyLimitExceeded.

## Phase 2: Finalization (AFTER LLM call)

1. Calculate actual cost from token usage.
2. Adjust Redis counters: INCRBY(actual - estimated) — can be negative.
3. Mark as finalized — NEVER refund after finalization.
4. Write to `api_costs` table as audit trail (retryable; Redis is source of truth for budget).

## On Failure (before finalization)

1. DECRBY to release the reservation.
2. DECR concurrency slot in finally block.

## Tier-aware limits
- founding ($99/mo): 500 cents/day
- standard ($149/mo): 1000 cents/day
- premium ($199/mo): 2000 cents/day

## Global circuit breaker
- Redis key `cost:global:{date}` tracks total platform spend.
- If it exceeds hard cap (configurable via `GLOBAL_DAILY_COST_LIMIT_CENTS`), ALL generation halts and admin is alerted.

## Regeneration budget
- Redis counter `regen:{reviewId}:{date}` with 86400s TTL.
- Max 3 regenerations per review per day.
- Enforced in worker (not just API rate limiter) to prevent outbox replay bypass.

## Rules
- Redis atomic operations eliminate TOCTOU race conditions that DB-based checks have.
- Cost accumulates across retries (guardrail retry counts toward total).
- Once finalized, NEVER refund — even if later steps fail. Those are retryable.
- The `api_costs` DB table is the audit trail, reconciled hourly.
