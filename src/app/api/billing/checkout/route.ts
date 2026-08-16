// src/app/api/billing/checkout/route.ts
//
// POST /api/billing/checkout — Creates a Stripe Checkout Session with
// tier_base + location_overage line items, replacing the old Payment Link flow.
//
// Validation contract: VAL-BILLING-001 through VAL-BILLING-006,
//   VAL-BILLING-030 through VAL-BILLING-032.

import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { getOffboardingState, isCheckoutBlocked } from '@/lib/account-offboarding/gate';
import { sql } from '@/lib/db/server';
import { SubscriptionTier } from '@/lib/accounts/tier-config';
import { SubscriptionStatus } from '@/lib/shared/subscription-status';
import {
  CheckoutCouponConfigurationError,
  CheckoutOffboardingBlockedError,
  CheckoutUnavailableError,
  createCheckoutSession,
} from '@/lib/payments/create-checkout-session';
import {
  applyTierSnapshot,
  CheckoutAttemptConflictError,
  isTrialEligible,
  primaryOnboardedBySql,
  releaseCouponFaultedAttempt,
} from '@/lib/payments/plan-activation';
import { TierNotPurchasableError } from '@/lib/payments/tier-purchasability';
import { requireOwnerWithAccount, withSameOrigin } from '@/lib/auth/route-helpers';
import { reportCaughtError } from '@/lib/shared/report-caught-error';

export const dynamic = 'force-dynamic';

const NO_STORE = { 'Cache-Control': 'no-store, private' } as const;

// ── Request schema ─────────────────────────────────────────────────────────

// UUID format validation — accepts all versions (v4, v7, etc.) since
// the codebase uses uuidv7 from the `uuid` package. Zod's built-in .uuid()
// rejects non-RFC4122 version digits which breaks v7 and legacy v4 IDs.
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const CheckoutSchema = z.object({
  accountId: z.string().regex(UUID_RE, 'Invalid account ID format'),
  tier: z.enum([SubscriptionTier.COPILOT, SubscriptionTier.AUTOPILOT]),
});

// ── Handler ─────────────────────────────────────────────────────────────────

/**
 * POST /api/billing/checkout
 *
 * Creates a Stripe Checkout Session for the given account.
 * Delegates to the shared createCheckoutSession module which handles
 * line_items construction, price ID resolution, and Stripe API call.
 *
 * VAL-BILLING-031: This handler does NOT reference STRIPE_PAYMENT_LINK_* env vars.
 * Security: requires owner auth and validates body.accountId === owner.accountId.
 */
async function createBillingCheckout(req: NextRequest): Promise<NextResponse> {
  const owner = await requireOwnerWithAccount(req);
  if (!owner.ok) return owner.response;

  // Parse request body
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json(
      { error: 'invalid_json' },
      { status: 400, headers: NO_STORE },
    );
  }

  const parsed = CheckoutSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: 'invalid_body', issues: parsed.error.issues },
      { status: 400, headers: NO_STORE },
    );
  }
  const { accountId, tier } = parsed.data;

  // ── Ownership: body.accountId must match authenticated user ──────────────
  if (accountId !== owner.accountId) {
    return NextResponse.json(
      { error: 'Account ID mismatch' },
      { status: 403, headers: NO_STORE },
    );
  }

  // Look up the account. `onboarded_by` of the PRIMARY business is the
  // self-serve discriminator (FIX 2): NULL = self-serve, non-null =
  // admin/partner handoff. The scoping is not spelled here — `primaryOnboardedBySql`
  // owns it, because reading the field off an arbitrary location is the mistake
  // it exists to prevent.
  const [account] = await sql<{
    id: string;
    subscription_status: string;
    owner_email: string;
    primary_onboarded_by: string | null;
  }[]>`
    SELECT a.id, a.subscription_status, u.email AS owner_email,
      (${primaryOnboardedBySql(sql, accountId)}) AS primary_onboarded_by
    FROM accounts a
    JOIN users u ON u.id = a.owner_user_id
    WHERE a.id = ${accountId}::uuid
  `;

  if (!account) {
    return NextResponse.json(
      { error: 'account_not_found' },
      { status: 404, headers: NO_STORE },
    );
  }

  const offboardingState = await getOffboardingState(accountId, sql);
  if (isCheckoutBlocked(offboardingState)) {
    return NextResponse.json(
      { error: 'account_offboarding_blocked' },
      { status: 403, headers: NO_STORE },
    );
  }

  // VAL-BILLING-006: reject accounts that ALREADY have a subscription — only a
  // pending_payment account may create a new Checkout Session. A trialing
  // account already has a (trialing) subscription, so a second checkout would
  // create a duplicate subscription (PLAN.md §18a). Past-due recovery + trial
  // card updates go through the billing portal, not a new checkout session.
  if (
    account.subscription_status === SubscriptionStatus.ACTIVE ||
    account.subscription_status === SubscriptionStatus.TRIALING ||
    account.subscription_status === SubscriptionStatus.PAST_DUE
  ) {
    return NextResponse.json(
      { error: 'account_already_active', subscriptionStatus: account.subscription_status },
      { status: 409, headers: NO_STORE },
    );
  }

  // Trial eligibility (PLAN.md §0.2). The four terms and the reasoning for each
  // live at their single owner, `isTrialEligible` — this route spelled its own
  // stricter copy and `resolveCheckoutContext` spelled a laxer one, so the two
  // checkout entry points answered the same question differently. The status
  // reject above does NOT make the `pending_payment` term redundant: it leaves
  // `cancelled` standing, which is exactly the state a reactivating owner
  // arrives in (account-offboarding/reactivate.ts posts here).
  const trialEligible = isTrialEligible({
    subscriptionStatus: account.subscription_status,
    primaryOnboardedBy: account.primary_onboarded_by,
  });

  // Create the Checkout Session via the shared module
  // VAL-BILLING-066: Returns 502 with user-facing error when Stripe API fails
  // (network timeout, rate limit, invalid key, Stripe 500).
  //
  // Hoisted out of the try because the coupon-fault branch of the catch has to
  // release the attempt this snapshot COMMITTED, and a `const` inside the try
  // is not in scope there.
  let committedAttemptId: string | null = null;
  try {
    const snapshotResult = await applyTierSnapshot(sql, {
      accountId,
      activationLockId: accountId,
      tier,
      ownerEmail: account.owner_email,
      trial: trialEligible,
    });
    if (snapshotResult.kind === 'not_found') {
      return NextResponse.json(
        { error: 'account_not_found' },
        { status: 404, headers: NO_STORE },
      );
    }
    if (snapshotResult.kind === 'wrong_status') {
      return NextResponse.json(
        {
          error: 'subscription_not_pending',
          subscriptionStatus: snapshotResult.status,
        },
        { status: 409, headers: NO_STORE },
      );
    }
    if (snapshotResult.kind === 'offboarding_blocked') {
      return NextResponse.json(
        { error: 'account_offboarding_blocked' },
        { status: 403, headers: NO_STORE },
      );
    }

    committedAttemptId = snapshotResult.attemptId;

    const result = await createCheckoutSession(
      sql,
      accountId,
      tier,
      snapshotResult.variant,
      {
        attemptId: snapshotResult.attemptId,
        activationLockId: accountId,
      },
    );
    return NextResponse.json(
      { url: result.url, sessionId: result.sessionId },
      { headers: NO_STORE },
    );
  } catch (err) {
    if (err instanceof TierNotPurchasableError) {
      return NextResponse.json(
        { error: 'tier_unavailable' },
        { status: 409, headers: NO_STORE },
      );
    }
    if (err instanceof CheckoutUnavailableError) {
      return NextResponse.json(
        { error: 'checkout_unavailable', detail: err.message },
        { status: 502, headers: NO_STORE },
      );
    }
    if (err instanceof CheckoutOffboardingBlockedError) {
      return NextResponse.json(
        { error: 'account_offboarding_blocked' },
        { status: 403, headers: NO_STORE },
      );
    }
    if (err instanceof CheckoutAttemptConflictError) {
      return NextResponse.json(
        { error: 'checkout_attempt_conflict' },
        { status: 409, headers: NO_STORE },
      );
    }
    if (err instanceof CheckoutCouponConfigurationError) {
      // The SECOND createCheckoutSession consumer. `select-plan` maps this
      // and this route did not, so a Beta comp coupon fault here still
      // reached the owner as "Unable to connect to payment provider" and
      // filed Sentry under `reason: 'stripe_error'` — advice wrong in both
      // halves (nothing is unreachable; retrying cannot help) and the
      // misfiled reason is what made D-16's staging failure opaque.
      // `intake.observability[3]` asks for this mapping on the coupon path,
      // not on one of its two routes.
      reportCaughtError('billing/checkout', err, {
        reason: 'checkout_coupon_misconfigured',
        accountId,
      });
      // Release the committed `creating` lease, or the owner's every retry
      // reuses this same rejected snapshot and 502s forever.
      if (committedAttemptId !== null) {
        await releaseCouponFaultedAttempt(sql, accountId, committedAttemptId);
      }
      return NextResponse.json(
        { error: 'checkout_coupon_misconfigured', detail: err.message },
        { status: 502, headers: NO_STORE },
      );
    }
    reportCaughtError('billing/checkout', err, { reason: 'stripe_error', accountId });
    return NextResponse.json(
      { error: 'stripe_error', detail: 'Unable to connect to payment provider. Please try again later.' },
      { status: 502, headers: NO_STORE },
    );
  }
}

export const POST = withSameOrigin()(createBillingCheckout);
