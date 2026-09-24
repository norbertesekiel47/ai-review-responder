// src/lib/shared/cancellation-grace.ts
//
// Single owner of the 30-day cancellation grace period: the window between
// `accounts.cancelled_at` (Stripe webhook, migration 037) and the point a
// cancelled account's locations are soft-archived. Two independent
// consumers must agree on the exact day count (#1371) — the per-location/
// aggregate dashboard route (JS `Date` math, to serialize
// `gracePeriodEndDate` for the read-access banner) and
// CancellationGracePoller (an inline SQL `make_interval(days => ...)`
// predicate, to select accounts whose grace has expired) — so the day count
// lives here once. `CANCELLATION_GRACE_DAYS` is imported directly by both;
// unlike past-due-recovery.ts's PAST_DUE_GRACE_DAYS this constant has no
// separate SQL-fragment-builder twin — CancellationGracePoller is its only
// SQL caller, so the predicate stays inline there rather than behind a
// single-caller abstraction.
//
// `cancelled_at` is also the single owner of WHICH column is the clock
// (#1455). Before this fix the dashboard route fell back to
// `subscription_activated_at` when `cancelled_at IS NULL` (a legacy row
// predating migration 037) while CancellationGracePoller's SQL predicate
// required `cancelled_at IS NOT NULL` outright — two different rules for the
// same legacy row, so a route could show "grace expired" for an account the
// poller would never archive. Migration 125 backfilled every legacy row still
// missing `cancelled_at`, and `resolveCancellationGraceState` below is now
// the one place either side of that fallback lived — the route reads it
// directly, and the poller's "no `cancelled_at` -> never archive" SQL
// already agrees with the fail-safe branch here (see below).

const DAY_MS = 86_400_000;

export const CANCELLATION_GRACE_DAYS = 30;

/**
 * The instant a cancelled account's grace period ends: `CANCELLATION_GRACE_DAYS`
 * after `cancelledAt`. Pure day-count arithmetic only — callers resolve
 * WHICH date counts as the clock via `resolveCancellationGraceState` below,
 * not here.
 */
export function cancellationGraceDeadline(cancelledAt: Date): Date {
  return new Date(cancelledAt.getTime() + CANCELLATION_GRACE_DAYS * DAY_MS);
}

export interface CancellationGraceState {
  /** `null` when there is no clock to compute a deadline from (indefinite grace). */
  gracePeriodEnd: Date | null;
  readAccess: boolean;
}

/**
 * Resolves a cancelled account's grace-period state from `accounts.cancelled_at`
 * — the ONLY clock (#1455). There is no fallback to `subscription_activated_at`:
 * every account that reaches `subscription_status = 'cancelled'` gets
 * `cancelled_at` stamped in the SAME UPDATE as the status write
 * (`persistStatusTransition` in `worker/ingress/stripe/apply-subscription-state.ts`
 * — the only writer of `subscription_status = 'cancelled'`), and migration 125
 * backfilled every legacy row that predated that invariant (pre-migration-037
 * cancellations). A `cancelledAt` of `null` is therefore not an expected
 * legacy case anymore — it is unrepresentable by the current write path — so
 * the fail-safe is indefinite grace (`readAccess: true`, no countdown shown),
 * the same "do nothing" CancellationGracePoller already gives an unknown
 * clock (its `WHERE cancelled_at IS NOT NULL` predicate never selects such a
 * row for archival), rather than guessing a deadline from an unrelated date.
 */
export function resolveCancellationGraceState(cancelledAt: Date | null): CancellationGraceState {
  if (!cancelledAt) {
    return { gracePeriodEnd: null, readAccess: true };
  }
  const gracePeriodEnd = cancellationGraceDeadline(cancelledAt);
  return { gracePeriodEnd, readAccess: gracePeriodEnd > new Date() };
}
