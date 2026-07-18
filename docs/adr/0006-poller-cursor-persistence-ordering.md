# ADR 0006: Poller cursor persistence — write-sequence CAS over serialized/epoch alternatives

## Status

Accepted — 2026-07-17 (ticket #479, map #472)

## Context

`StripeLocationsReconcilePoller` sweeps paid accounts hourly for Stripe overage
drift under a hard `CYCLE_TIMEOUT_MS = 240_000` deadline. #487 added an in-memory
keyset resume **cursor** (the id of the last account claimed) + bounded fan-out so
a deadline-**truncated** sweep resumes next cycle instead of re-walking the head.
The cursor was module-level in-memory, so a worker restart restarted the
**rotation** (one full pass over the account set) from the top.

#479 persists the cursor across restarts. Persisting an async-updated cursor from
a poller that (a) runs under a non-cancelling deadline and (b) can have a
**detached** cycle tail still executing after a timeout raised a hard ordering
question, surfaced over four adversarial (Codex) review rounds:

- **`withTimeout` races, it does not cancel** (`src/lib/shared/with-timeout.ts`).
  A timed-out `saveCursor` keeps running detached and can land *after* a later
  save — an ABA/reorder that `inProgress` single-flight + `withTimeout` cannot
  prevent (proven false in review round 4).
- A monotonic guard keyed on the **cursor value** (`EXCLUDED.cursor > current`)
  has a **rotation ABA**: a delayed high-id save from rotation N overwrites early
  progress in rotation N+1 (UUIDv7 time-ordering can't distinguish rotations).
- Per-account reconcile is *itself* `withTimeout(..., ACCOUNT_TIMEOUT_MS)`, so a
  claimed account is **attempted, not guaranteed processed**.

## Decision

1. **Persist ordering with a write-sequence CAS, not value/epoch/serialization.**
   `poller_cursors` carries `write_seq bigint`. The poller holds an in-memory
   `writeSeq` **seeded at boot from the persisted value**; each save assigns a
   fresh seq synchronously (submission order) and the UPSERT applies only
   `WHERE EXCLUDED.write_seq > poller_cursors.write_seq`. A stale/detached/reordered
   save carries a lower seq → no-op. This is cadence-, rotation-, and
   cancellation-independent — the only scheme that holds given non-cancellable
   promises. One serialized write lives in `runOnce.finally`, `withTimeout`-bounded
   so it can never wedge `inProgress`.

2. **Corrected never-skip invariant (weaker than "fully processed", still safe).**
   The cursor tracks *claimed* accounts. On restart we resume after the persisted
   id; a claimed-but-timed-out account is re-checked on the **next rotation**, so
   drift detection defers at most one rotation and **never permanently skips**.
   Drift is durable and idempotent to re-check, so bounded re-work is harmless.

## Alternatives rejected

- **Serialized `finally` save (no column).** Relied on `inProgress` to serialize
  writes; false because `withTimeout` detaches a timed-out save. Rejected round 4.
- **Value-monotonic UPSERT guard (`cursor >`).** Rotation ABA. Rejected round 3.
- **Rotation epoch on the cursor row.** Also closes ordering, but the write-seq CAS
  is simpler (one counter, no rotation-identity bookkeeping) and equally provable.

## Consequences

- One extra `bigint` column + an in-memory counter + a boot-seed load. ~15 lines.
- The safety story is provable rather than "benign at current scale" — appropriate
  for a billing-adjacent RISK=high worker path.
- Truncation itself is a near-never event at the capacity target (map #474: a full
  rotation drains in one cycle); persistence + the sustained-truncation alert are
  forward-looking insurance, now correct regardless of scale.
