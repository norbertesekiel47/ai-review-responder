/**
 * Single authoritative owner of "where in the funnel does this owner belong?".
 *
 * Before this module the decision lived in three places that disagreed:
 *   - `src/components/auth/shared/loginDestination.ts` — `applySubscriptionGuard`
 *     sent EVERY `pending_payment` owner to `/onboarding/pay`, demo-blind, so an
 *     invitee skipped the demo entirely.
 *   - `src/app/api/auth/verify-otp/route.ts` — its own private
 *     `onboardingDemoEnabled() ? '/onboarding/start' : '/onboarding/pay'` branch,
 *     which knew about the flag but not about a captured place.
 *   - `src/app/api/dashboard/route.ts` — a hardcoded `paymentUrl` of
 *     `/onboarding/pay` handed to `PendingPaymentScreen`.
 * Those three branches are replaced by `resolveFunnelEntry`; consumers pass the
 * owner state they already read and render/redirect to whatever comes back.
 *
 * PURE by construction: no DB handle, no `process.env`, no flag read inside. The
 * caller passes `onboardingDemoEnabled()` in as `demoEnabled`, which (a) makes
 * the whole matrix trivially table-testable, (b) keeps flag state
 * server-authoritative (invariant #13 — the browser learns the destination as a
 * server-computed URL in an API response, never from a `NEXT_PUBLIC_*`
 * companion), and (c) keeps this module out of composition-root territory
 * (invariant #15 — it imports no DB client because it needs none).
 */

import {
  SubscriptionStatus,
  subscriptionGrantsFullAccess,
} from '@/lib/shared/subscription-status';

/**
 * The closed set of funnel destinations `resolveFunnelEntry` can return.
 * Deliberately a union rather than `string` so consumers type-check against the
 * reachable destinations instead of accepting any path.
 */
export type FunnelEntryUrl =
  | '/onboarding/start'
  | '/onboarding/demo'
  | '/onboarding/pay'
  | '/onboarding/business'
  | '/dashboard';

/**
 * Everything the funnel decision depends on, as ONE explicit object. The caller
 * derives each field from state it has already read:
 *   - `subscriptionStatus` — `accounts.subscription_status`.
 *   - `demoEnabled` — `onboardingDemoEnabled()` (see the purity note above).
 *   - `hasPlace` — `place_id_verified || google_maps_url !== null` on the primary
 *     business. That is the repo's existing "location captured" predicate; see
 *     `shouldUseDemoWizard` in `src/app/onboarding/business/guard.ts` and
 *     `src/app/api/auth/signup-status/route.ts`.
 *   - `wizardCompleted` — `accounts.onboarding_wizard_completed_at !== null`.
 */
export interface FunnelOwnerState {
  subscriptionStatus: string;
  demoEnabled: boolean;
  hasPlace: boolean;
  wizardCompleted: boolean;
}

/**
 * Resolve the funnel entry point for an owner. Precedence is load-bearing —
 * earlier rows preempt later ones:
 *
 *   1. pending_payment + demo on + NO place  → /onboarding/start
 *   2. pending_payment + demo on + place     → /onboarding/demo
 *   3. pending_payment (demo off)            → /onboarding/pay
 *   4. full access + wizard incomplete       → /onboarding/business
 *   5. anything else                         → /dashboard
 *
 * Row 2 is the DROP-OFF RETURN POINT and is deliberately NOT folded into row 1:
 * an owner who captured a place at /onboarding/start and then abandoned must land
 * back on the demo they were promised, not be sent to re-capture the location and
 * not skip the demo into /onboarding/pay. (`/onboarding/demo` already handles its
 * own cost-blocked sentinel.)
 *
 * Row 4 gates on `subscriptionGrantsFullAccess`, never a raw `=== 'active'`
 * (invariant #11): a `trialing` account is post-payment and must be routed
 * identically to `active`. Non-entitled leftovers (`past_due`, `cancelled`) fall
 * through to /dashboard, which owns their own account-state screens.
 */
export function resolveFunnelEntry(state: FunnelOwnerState): FunnelEntryUrl {
  if (state.subscriptionStatus === SubscriptionStatus.PENDING_PAYMENT) {
    if (!state.demoEnabled) return '/onboarding/pay';
    return state.hasPlace ? '/onboarding/demo' : '/onboarding/start';
  }

  if (subscriptionGrantsFullAccess(state.subscriptionStatus) && !state.wizardCompleted) {
    return '/onboarding/business';
  }

  return '/dashboard';
}
