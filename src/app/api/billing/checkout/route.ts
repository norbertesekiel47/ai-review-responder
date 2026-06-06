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
import { isSubscriptionTier, type SubscriptionTierValue } from '@/lib/accounts/tier-config';
import { SubscriptionStatus } from '@/lib/shared/subscription-status';
import { createCheckoutSession, CheckoutUnavailableError } from '@/lib/payments/create-checkout-session';
import { requireOwnerWithAccount, withSameOrigin } from '@/lib/auth/route-helpers';

export const dynamic = 'force-dynamic';

const NO_STORE = { 'Cache-Control': 'no-store, private' } as const;

// ── Request schema ─────────────────────────────────────────────────────────

// UUID format validation — accepts all versions (v4, v7, etc.) since
// the codebase uses uuidv7 from the `uuid` package. Zod's built-in .uuid()
// rejects non-RFC4122 version digits which breaks v7 and legacy v4 IDs.
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const CheckoutSchema = z.object({
  accountId: z.string().regex(UUID_RE, 'Invalid account ID format'),
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
  const { accountId } = parsed.data;

  // ── Ownership: body.accountId must match authenticated user ──────────────
  if (accountId !== owner.accountId) {
    return NextResponse.json(
      { error: 'Account ID mismatch' },
      { status: 403, headers: NO_STORE },
    );
  }

  // Look up the account
  const [account] = await sql<{
    id: string;
    subscription_tier: string;
    subscription_status: string;
    owner_email: string;
  }[]>`
    SELECT a.id, a.subscription_tier, a.subscription_status, u.email AS owner_email
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

  const offboardingState = await getOffboardingState(accountId);
  if (isCheckoutBlocked(offboardingState)) {
    return NextResponse.json(
      { error: 'account_offboarding_blocked' },
      { status: 403, headers: NO_STORE },
    );
  }

  // VAL-BILLING-006: reject already-active or past-due accounts.
  // Past-due recovery must use the billing portal, not a new checkout session.
  if (
    account.subscription_status === SubscriptionStatus.ACTIVE ||
    account.subscription_status === SubscriptionStatus.PAST_DUE
  ) {
    return NextResponse.json(
      { error: 'account_already_active', subscriptionStatus: account.subscription_status },
      { status: 409, headers: NO_STORE },
    );
  }

  // Validate tier
  if (!isSubscriptionTier(account.subscription_tier)) {
    return NextResponse.json(
      { error: 'invalid_tier', tier: account.subscription_tier },
      { status: 400, headers: NO_STORE },
    );
  }

  const tier = account.subscription_tier as SubscriptionTierValue;

  // Create the Checkout Session via the shared module
  // VAL-BILLING-066: Returns 502 with user-facing error when Stripe API fails
  // (network timeout, rate limit, invalid key, Stripe 500).
  try {
    const result = await createCheckoutSession(accountId, tier, account.owner_email);
    return NextResponse.json(
      { url: result.url, sessionId: result.sessionId },
      { headers: NO_STORE },
    );
  } catch (err) {
    if (err instanceof CheckoutUnavailableError) {
      return NextResponse.json(
        { error: 'checkout_unavailable', detail: err.message },
        { status: 502, headers: NO_STORE },
      );
    }
    const message = err instanceof Error ? err.message : String(err);
    console.error(`[billing/checkout] Stripe error for account=${accountId}: ${message}`);
    return NextResponse.json(
      { error: 'stripe_error', detail: 'Unable to connect to payment provider. Please try again later.' },
      { status: 502, headers: NO_STORE },
    );
  }
}

export const POST = withSameOrigin()(createBillingCheckout);
