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
