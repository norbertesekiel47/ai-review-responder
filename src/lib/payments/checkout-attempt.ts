/** Shared database projection for the account-owned Checkout attempt lease. */
export interface CheckoutAttemptLeaseColumns {
  checkout_attempt_id: string | null;
  checkout_session_id: string | null;
  checkout_attempt_state: string | null;
  checkout_attempt_tier: string | null;
  checkout_attempt_price_variant: string | null;
  checkout_attempt_base_price_id: string | null;
  checkout_attempt_overage_price_id: string | null;
  checkout_attempt_base_price_cents: number | null;
  checkout_attempt_overage_price_cents: number | null;
  checkout_attempt_locations_included: number | null;
  checkout_attempt_locations_paid: number | null;
  checkout_attempt_overage_quantity: number | null;
  checkout_attempt_trial_period_days: number | null;
}

/**
 * Why the beta comp coupon decision has a vocabulary at all (admin-invite-funnel
 * plan step 11): the failure this observability exists to catch is SILENT
 * NON-APPLICATION — a beta tester reaching Stripe at full price because the
 * coupon was skipped. "No coupon" is the common, correct outcome for every
 * self-serve owner, so the fact alone is not actionable; only the REASON
 * separates "working as intended" from "the comp is misconfigured".
 *
 *   - `applied`      — the primary Business is admin-onboarded AND
 *                      BETA_COMP_COUPON_ID is set; the id was snapshotted.
 *   - `not_invited`  — the primary Business is self-serve (`onboarded_by IS
 *                      NULL`). Expected for every non-invitee.
 *   - `env_unset`    — the Account IS an admin invitee but the env var is unset
 *                      (the kill switch). This is the one that must be visible:
 *                      it means an invited beta tester is about to be charged.
 *
 * The reason is resolved once, inside applyTierSnapshot's transaction, and is
 * NOT persisted — only the resulting coupon id is (migration 105). It therefore
 * cannot be re-derived at Stripe session-creation time from the snapshot alone,
 * which is why the decision log and the analytics event are emitted where the
 * decision is taken.
 */
export const CHECKOUT_COUPON_DECISION_REASONS = [
  'applied',
  'not_invited',
  'env_unset',
] as const;

export type CheckoutCouponDecisionReason =
  (typeof CHECKOUT_COUPON_DECISION_REASONS)[number];

/**
 * The single log/telemetry label for a coupon decision. `applied` stands alone;
 * both skips are prefixed so a log search for `skipped:` finds every
 * non-application without enumerating reasons.
 */
export function checkoutCouponDecisionLabel(
  reason: CheckoutCouponDecisionReason,
): string {
  return reason === 'applied' ? 'applied' : `skipped:${reason}`;
}
