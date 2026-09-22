// src/lib/shared/cancellation-grace.ts
//
// Single owner of the 30-day cancellation grace period: the window between
// `accounts.cancelled_at` (Stripe webhook, migration 037) and the point a
// cancelled account's locations are soft-archived. Two independent
// consumers must agree on the exact day count (#1371) — the per-location/
// aggregate dashboard route (JS `Date` math, to serialize
// `gracePeriodEndDate` for the read-access banner) and
// CancellationGracePoller (SQL `WHERE` predicate, to select accounts whose
// grace has expired) — so the day count lives here once. Shape mirrors
// past-due-recovery.ts's `PAST_DUE_GRACE_DAYS` constant and its SQL twin
// `subscription-eligibility-sql.ts`, which owns `cancellationGraceExpiredSql`.

const DAY_MS = 86_400_000;

export const CANCELLATION_GRACE_DAYS = 30;

/**
 * The instant a cancelled account's grace period ends: `CANCELLATION_GRACE_DAYS`
 * after `cancelledAt`. `cancelledAt` is whichever date the caller has already
 * resolved as the grace clock — `accounts.cancelled_at`, or its fallback
 * `subscription_activated_at` for legacy rows predating migration 037 — this
 * function only owns the day-count arithmetic, not which column feeds it.
 */
export function cancellationGraceDeadline(cancelledAt: Date): Date {
  return new Date(cancelledAt.getTime() + CANCELLATION_GRACE_DAYS * DAY_MS);
}
