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
 * Server-authoritative (invariant #13): never expose via a `NEXT_PUBLIC_*`
 * companion; the browser learns the state through API responses / props.
 */
import { readFlag } from '@/lib/config/flags';

export function trialEnabled(): boolean {
  return readFlag('TRIAL_ENABLED');
}

export function stripeTaxEnabled(): boolean {
  return readFlag('STRIPE_TAX_ENABLED');
}

export function stripeLocationsReconcileDisabled(): boolean {
  return readFlag('STRIPE_LOCATIONS_RECONCILE_DISABLED');
}
