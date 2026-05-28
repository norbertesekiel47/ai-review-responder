# Design: AnalyticsDispatchPoller stale-row reclaim should not burn the retry budget

- **Issue:** [#89](https://github.com/RepWorth/ai-review-responder/issues/89) — "AnalyticsDispatchPoller: stale-row reclaim doesn't decrement attempts"
- **Date:** 2026-05-28
- **Branch / worktree:** `fix/89-analytics-reclaim-attempts` at `../RepWorth-issue89` (sibling dir, not nested — avoids the documented module-resolution leak)
- **Severity:** IMPORTANT, non-blocking (rare edge case)

## Problem

`worker/background/pollers/AnalyticsDispatchPoller.ts` drives analytics dispatch with a
claim → send → mark lifecycle:

1. **Claim** (top of `dispatchOnce`): rows move `pending → dispatching` and
   `attempts = attempts + 1` is incremented *at claim time*.
2. **Mark**: `markDispatchCompleted` (sent), `markDispatchFailed` (real PostHog error —
   keeps the incremented attempt, schedules backoff, walks toward `failed`), or
   `markDispatchDeferred` (infra fault — **decrements** `attempts = attempts - 1` so the
   fault never consumes the retry budget).

The established philosophy, already encoded in `markDispatchDeferred`, is: **infra faults
must not consume an event's retry budget.** Only a genuine provider failure should.

There is one infra-fault path that was missed. If a worker dies *between* claiming a row
and marking it, the row is stranded in `dispatching` with `attempts` already incremented.
A separate stale-reclaim UPDATE at the top of `dispatchOnce` rescues such rows after 10
minutes:

```sql
UPDATE analytics_events
SET status = 'pending', locked_at = NULL, available_at = NOW()
WHERE status = 'dispatching'
  AND locked_at IS NOT NULL
  AND locked_at < NOW() - INTERVAL '10 minutes'
```

It returns the row to `pending` but does **not** give back the attempt. Over repeated
crashes inside the dispatch window, a legitimate event can be pushed toward `max_attempts`
/ `failed` without PostHog ever being the cause — an infra fault silently burns the budget.

`$insert_id` dedup at PostHog protects against duplicate *delivery* regardless, so this is
a **premature-failure** risk, not a double-send risk.

## Decision

**Approach A — fix the reclaim UPDATE in place** (chosen over extracting a helper or adding
an aggregate metric; see Alternatives). Make the reclaim obey the same budget rule as
`markDispatchDeferred`, and — per review decision — stamp a diagnostic marker so a recovered
crash is visible, consistent with the other two `markDispatch*` helpers that already set
`last_error`.

### The change

`worker/background/pollers/AnalyticsDispatchPoller.ts`, the stale-reclaim UPDATE:

```sql
UPDATE analytics_events
SET status = 'pending',
    locked_at = NULL,
    attempts = GREATEST(attempts - 1, 0),     -- give back the attempt the crash stranded
    last_error = ${RECLAIMED_STALE_DISPATCH_ERROR},
    available_at = NOW()
WHERE status = 'dispatching'
  AND locked_at IS NOT NULL
  AND locked_at < NOW() - INTERVAL '10 minutes'
```

A module-level constant owns the marker string so the test asserts against the same source:

```ts
const RECLAIMED_STALE_DISPATCH_ERROR = 'reclaimed_stale_dispatch';
```

The marker is bound as a parameter (`${...}`), matching the file's existing
`last_error = ${message}` style.

## Semantics and safety

- **`GREATEST(attempts - 1, 0)` floor.** The single-row `markDispatch*` helpers can use
  `attempts = attempts - 1` unguarded because they run with `AND attempts = ${row.attempts}`
  optimistic concurrency on a row they just claimed (so `attempts ≥ 1`). The reclaim is a
  *bulk* UPDATE over rows it did **not** claim, so it has no such per-row guard; the floor
  makes the decrement safe unconditionally. In practice `status = 'dispatching'` implies the
  row was claimed, so `attempts ≥ 1` and the floor is a defensive net, not a routine path.
- **False-positive reclaim** (a worker that is slow but still alive, exceeding the 10-minute
  window) is already possible today and is unchanged by this fix. Returning the row to
  `pending` lets it be re-dispatched; `$insert_id` dedup means the worst case is one harmless
  reprocess, never a double-send. The decrement does not worsen this: the still-alive worker's
  later `markDispatch*` is gated by `AND attempts = ${row.attempts}` and simply no-ops.
- **No new failure paths.** The reclaim stays a single unguarded bulk UPDATE at the top of
  `dispatchOnce`; any DB error propagates exactly as before.
- **No schema change.** All columns (`attempts`, `last_error`, `locked_at`, `available_at`,
  `status`) already exist and are written by sibling UPDATEs. No migration.

## Out of scope (YAGNI)

- **Extracting a `reclaimStaleDispatches()` helper.** Single-caller extraction; `design.md`
  and the repworth rules advise against it, and the existing tests already exercise the
  reclaim through `runAnalyticsDispatchOnce` via the `sql` mock.
- **Aggregate reclaim log/metric** for repeated-crash alerting. The per-row `last_error`
  marker already gives the needed visibility; add a metric only if reclaim volume warrants it.

## Testing

Mirror the existing harness in `worker/background/pollers/__tests__/AnalyticsDispatchPoller.test.ts`,
which captures executed SQL via the `sql` mock and inspects it with `sqlText` / `sqlValues`.

- **Add a regression test** asserting the stale-reclaim UPDATE text contains
  `GREATEST(attempts - 1, 0)` and that the marker (`reclaimed_stale_dispatch`) is bound.
- **Audit existing assertions:** the reclaim UPDATE runs on every `dispatchOnce` when
  analytics is configured. If any current test asserts the reclaim SQL verbatim (snapshot or
  exact-string), update it to reflect the two added columns.

## Verification

Run from the sibling worktree (not nested, so local lint/test are not poisoned):

- `pnpm lint`
- `pnpm typecheck`
- `pnpm test` (at minimum the `AnalyticsDispatchPoller` suite)
- `pnpm ci:tenant-scope` and `pnpm ci:rls-audit` — the reclaim is a system-level
  (non-tenant-scoped) queue UPDATE and was already unscoped before this change; confirm no
  new audit findings are introduced.

Land via PR against protected `main` with the four CI checks green.
