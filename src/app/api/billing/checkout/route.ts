// src/app/api/billing/checkout/route.ts
//
// POST /api/billing/checkout — Creates a Stripe Checkout Session with
// tier_base + location_overage line items, replacing the old Payment Link flow.
//
// Validation contract: VAL-BILLING-001 through VAL-BILLING-006,
//   VAL-BILLING-030 through VAL-BILLING-032.

import { NextRequest, NextResponse } from 'next/server';
import { selfServeSignupEnabled } from '@/lib/auth/flags';
import { z } from 'zod';
import { getOffboardingState, isCheckoutBlocked } from '@/lib/account-offboarding/gate';
import { sql } from '@/lib/db/server';
import { SubscriptionTier } from '@/lib/accounts/tier-config';
import { SubscriptionStatus } from '@/lib/shared/subscription-status';
import {
  CheckoutOffboardingBlockedError,
  CheckoutUnavailableError,
  createCheckoutSession,
} from '@/lib/payments/create-checkout-session';
import {
  applyTierSnapshot,
  CheckoutAttemptConflictError,
} from '@/lib/payments/plan-activation';
import { trialEnabled } from '@/lib/payments/flags';
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

  // Look up the account. onboarded_by from the primary business is the self-serve
  // discriminator (FIX 2): NULL = self-serve, non-null = admin/partner handoff —
  // same discriminator dashboard/route.ts uses to suppress the self-serve CTA.
  const [account] = await sql<{
    id: string;
    subscription_status: string;
    owner_email: string;
    onboarded_by: string | null;
  }[]>`
    SELECT a.id, a.subscription_status, u.email AS owner_email,
      (SELECT b.onboarded_by FROM businesses b
        WHERE b.account_id = ${accountId}::uuid
          AND b.account_id = a.id
          AND b.is_primary = TRUE
          AND b.archived_at IS NULL
        LIMIT 1) AS onboarded_by
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

  // Trial eligibility (PLAN.md §0.2): trials are the SELF-SERVE pending_payment
  // onboarding path only. The status reject above eliminates active/trialing/
  // past_due, but NOT cancelled — so check pending_payment explicitly here
  // rather than rely on "everything else was rejected". Also require
  // SELF_SERVE_SIGNUP_ENABLED so an admin-onboarded pending_payment account
  // (not part of the self-serve trial funnel) gets a normal paid checkout, not
  // a free trial. Both flags are server-authoritative; no NEXT_PUBLIC_* companion.
  //
  // FIX 2: per-account self-serve gate. Even with both flags on, an
  // admin/partner-onboarded account (onboarded_by non-null) must fall back to a
  // NORMAL paid checkout — never a $0 trial it could obtain by direct POST. Only
  // self-serve accounts (onboarded_by IS NULL) are trial-eligible.
  const trialEligible =
    trialEnabled() &&
    selfServeSignupEnabled() &&
    account.subscription_status === SubscriptionStatus.PENDING_PAYMENT &&
    account.onboarded_by === null;

  // Create the Checkout Session via the shared module
  // VAL-BILLING-066: Returns 502 with user-facing error when Stripe API fails
  // (network timeout, rate limit, invalid key, Stripe 500).
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
    reportCaughtError('billing/checkout', err, { reason: 'stripe_error', accountId });
    return NextResponse.json(
      { error: 'stripe_error', detail: 'Unable to connect to payment provider. Please try again later.' },
      { status: 502, headers: NO_STORE },
    );
  }
}

export const POST = withSameOrigin()(createBillingCheckout);
