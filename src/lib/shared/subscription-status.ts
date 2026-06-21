// src/lib/shared/subscription-status.ts
//
// Central SubscriptionStatus type and const enum. Every piece of code that
// references subscription status values must use these — never bare string
// literals like 'active' or 'pending_payment'.
//
// The five canonical statuses match the `accounts.subscription_status` column
// defined in migration 034 (VARCHAR(20) NOT NULL DEFAULT 'pending_payment').
// `trialing` was added with the card-up-front free trial (Stripe-native): it is
// an explicit state treated like `active` for entitlement, with the one
// exception that recurring paid ranking (SerpAPI) is excluded from trials.
//
// Validation contract: VAL-AUTH-030 .. VAL-AUTH-032 (branded types),
// indirectly referenced by billing assertions that switch on status.

// ── Const object (enum-like) ────────────────────────────────────────────────

export const SubscriptionStatus = {
  PENDING_PAYMENT: 'pending_payment',
  ACTIVE: 'active',
  TRIALING: 'trialing',
  PAST_DUE: 'past_due',
  CANCELLED: 'cancelled',
} as const;

// ── Derived type ─────────────────────────────────────────────────────────────

export type SubscriptionStatusValue =
  (typeof SubscriptionStatus)[keyof typeof SubscriptionStatus];

// ── Type guard ───────────────────────────────────────────────────────────────

const ALL_STATUSES: readonly string[] = Object.values(SubscriptionStatus);

/** Returns true when `value` is one of the five canonical subscription statuses. */
export function isSubscriptionStatus(value: string): value is SubscriptionStatusValue {
  return ALL_STATUSES.includes(value);
}

// ── Dashboard / KPI read entitlement ─────────────────────────────────────────

/**
 * Whether an account's subscription status grants read access to customer
 * dashboard / KPI data. Mirrors the entitlement `/api/dashboard` enforces:
 * `active`, `trialing`, and `past_due` (features continue through the trial and
 * the past-due grace window) return data; `pending_payment` and `cancelled` do
 * not. Any owner read of customer KPI data must gate on this before returning
 * data.
 */
export function subscriptionAllowsDashboardRead(status: string): boolean {
  return (
    status === SubscriptionStatus.ACTIVE ||
    status === SubscriptionStatus.TRIALING ||
    status === SubscriptionStatus.PAST_DUE
  );
}
