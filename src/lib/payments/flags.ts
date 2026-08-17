/**
 * Single authoritative owner for the payments / billing feature flags.
 * Mirrors the `<feature>/flags.ts` convention (see `auto-approval/flags.ts`),
 * each a one-line wrapper over the shared `readFlag` primitive (byte-for-byte
 * `process.env[name] === 'true'`).
 *
 *   - trialEnabled(): card-up-front trial eligibility is on (one half of the
 *     eligibility decision; the call site still ANDs it with the self-serve
 *     account check).
 *   - stripeTaxEnabled(): attach Stripe `automatic_tax` to checkout sessions.
 *   - stripeLocationsReconcileDisabled(): the STRIPE_LOCATIONS_RECONCILE_DISABLED
 *     kill-switch — its `*_DISABLED` name encodes the meaning; the call site
 *     still reads it as `=== 'true'` (true ⇒ the reconcile poller does not start).
 *
 * ONE non-boolean value also lives here (admin-invite-funnel step 1):
 *
 *   - betaCompCouponId(): the Stripe Coupon ID comped onto an admin-invited
 *     beta tester's Checkout Session, or null when unset.
 *   - trialPeriodDays(): the trial length the marketing CTAs print ("Start your
 *     N-day free trial"), read from `TRIAL_PERIOD_DAYS` with the same ≥1-else-30
 *     fallback the landing page used inline before it had three callers
 *     (landing, /how-it-works, /features). Same getServerConfig() rationale as
 *     the coupon id; no effect unless `trialEnabled()`.
 *
 * Why here and not a module of its own: `BETA_COMP_COUPON_ID` is read for
 * exactly one purpose — deciding whether the beta comp applies — and "unset"
 * is its OFF position, so it behaves as a flag whose ON value happens to carry
 * the coupon id. Its sole consumer is `resolveCheckoutCreateShape`
 * (plan-activation.ts), the same call site that already reads `trialEnabled()`
 * and `stripeTaxEnabled()` from this module while resolving the durable
 * Checkout attempt snapshot. A separate one-function module would put the
 * third input of one decision in a fourth file, and CLAUDE.md's "no
 * abstractions for a single caller" applies. It is therefore NOT a `readFlag`
 * wrapper: it reads the value through `getServerConfig()` (never a raw
 * `process.env` read — `ci:process-env` owns that boundary), INSIDE the
 * function so nothing is captured at import time.
 *
 * Server-authoritative (invariant #13): never expose via a `NEXT_PUBLIC_*`
 * companion; the browser learns the state through API responses / props.
 */
import { readFlag } from '@/lib/config/flags';
import { getServerConfig } from '@/lib/config/server';

export function trialEnabled(): boolean {
  return readFlag('TRIAL_ENABLED');
}

export function stripeTaxEnabled(): boolean {
  return readFlag('STRIPE_TAX_ENABLED');
}

export function stripeLocationsReconcileDisabled(): boolean {
  return readFlag('STRIPE_LOCATIONS_RECONCILE_DISABLED');
}

/**
 * The configured beta comp Stripe Coupon ID, or `null` when the comp is off.
 *
 * The collapsing `optionalVar` in the server schema already maps `''` and
 * whitespace-only to undefined; the extra `.trim()` here covers a PADDED value
 * (`' beta3mo '`), which the schema passes through verbatim and Stripe would
 * reject at `sessions.create`. A coupon id is only ever consumed as an exact
 * provider identifier, so trimming cannot lose information.
 */
export function betaCompCouponId(): string | null {
  const configured = getServerConfig().BETA_COMP_COUPON_ID?.trim();
  return configured ? configured : null;
}

/** Trial length in days for CTA copy: `TRIAL_PERIOD_DAYS`, non-numeric or ≤0 → 30. */
export function trialPeriodDays(): number {
  const parsed = Number.parseInt(getServerConfig().TRIAL_PERIOD_DAYS ?? '', 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 30;
}
