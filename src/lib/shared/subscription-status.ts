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

// ── Entitlement predicates ───────────────────────────────────────────────────

/**
 * The full-access set as DATA, so a caller that cannot call the predicate can
 * still ask the same question of the same owner.
 *
 * It exists for exactly one caller today (#1329): the **Release cycle**'s
 * candidate scan binds it into SQL to keep an unentitled account out of the
 * oldest-first candidate window, because an excluded account never reaches
 * `subscriptionGrantsFullAccess` in TypeScript at all. A second SQL spelling of
 * the membership would be a second owner that can drift, and drift here is not
 * symmetric: a status the array omits but the predicate admits STARVES an
 * account that may send. Hence the array, not a literal list in the query, and
 * the predicate below is implemented OVER it rather than beside it.
 *
 * Order is `active` then `trialing` and is not meaningful. The lockstep pin in
 * `__tests__/subscription-status.test.ts` asserts membership against LITERALS,
 * deliberately not against the predicate below: deriving it from the predicate
 * made both sides of the comparison move together, and a red-team round proved
 * that shape passes while `TRIALING` is missing from this array.
 */
export const FULL_ACCESS_SUBSCRIPTION_STATUSES: readonly SubscriptionStatusValue[] = [
  SubscriptionStatus.ACTIVE,
  SubscriptionStatus.TRIALING,
];

/** Widened once, the way `ALL_STATUSES` is, so the predicate can take a `string`. */
const FULL_ACCESS_STATUSES: readonly string[] = FULL_ACCESS_SUBSCRIPTION_STATUSES;

/**
 * Whether a subscription status grants full product entitlement: AI drafts,
 * notifications, approval, posting, channel enrollment, multi-location, tier
 * changes, etc. This is the single owner of the rule "`trialing` is treated like
 * `active`" — the card-up-front trial gets the full product for 30 days, with
 * the one exception that recurring paid ranking (SerpAPI) is excluded (handled
 * by the ranking scheduler/worker keeping their own `active`-only gate).
 *
 * `past_due` is deliberately NOT full access: it gets a grace window with its
 * own recovery rules (see `computePastDueRecoveryState`), so call sites that
 * special-case `past_due` must branch on it BEFORE consulting this predicate.
 *
 * `undefined` — a status the caller could not read — is never full access, and
 * the membership test gives that for free.
 */
export function subscriptionGrantsFullAccess(
  status: string | undefined,
): boolean {
  return status !== undefined && FULL_ACCESS_STATUSES.includes(status);
}

/**
 * Whether an account's subscription status grants read access to customer
 * dashboard / KPI data. Mirrors the entitlement `/api/dashboard` enforces:
 * full-access statuses (`active`, `trialing`) plus `past_due` (features continue
 * through the past-due grace window); `pending_payment` and `cancelled` do not.
 * Any owner read of customer KPI data must gate on this before returning data.
 */
export function subscriptionAllowsDashboardRead(status: string): boolean {
  return (
    subscriptionGrantsFullAccess(status) ||
    status === SubscriptionStatus.PAST_DUE
  );
}

/**
 * Whether a scan of a location's Review QR may 302 to Google (docs/context/review-qr.md
 * "QR redirect"). `past_due` deliberately stays live so a card failure never
 * kills a printed counter code mid-grace; `pending_payment` and `cancelled`
 * render the scanner-facing unavailable page. Same membership as
 * `subscriptionAllowsDashboardRead` TODAY, deliberately a separate name —
 * the owner's dashboard entitlement and a customer-facing printed code have
 * no reason to move together (owner decision 2026-08-26).
 */
export function subscriptionAllowsQrRedirect(status: string): boolean {
  return (
    subscriptionGrantsFullAccess(status) ||
    status === SubscriptionStatus.PAST_DUE
  );
}
