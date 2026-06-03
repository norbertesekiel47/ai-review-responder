// src/app/api/billing/portal/route.ts
//
// POST /api/billing/portal — Creates a Stripe Customer Portal session
// for self-serve billing management (card updates, invoice viewing,
// subscription cancellation).
//
// Validation contract: VAL-BILLING-068, VAL-BILLING-069.

import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { sql } from '@/lib/db/server';
import { SubscriptionStatus } from '@/lib/shared/subscription-status';
import { getStripe } from '@/lib/payments/create-checkout-session';
import { requireOwnerWithAccount, withSameOrigin } from '@/lib/auth/route-helpers';

export const dynamic = 'force-dynamic';

const NO_STORE = { 'Cache-Control': 'no-store, private' } as const;

// ── Handler ─────────────────────────────────────────────────────────────────

/**
 * POST /api/billing/portal
 *
 * Creates a Stripe Customer Portal session for the authenticated owner's account.
 * The portal allows:
 *   - Card updates (payment method changes)
 *   - Invoice viewing
 *   - Subscription cancellation
 *
 * Security: requires owner auth; loads Stripe customer from session user's
 * accountId only. Body accountId is ignored (prevents cross-account access).
 *
 * VAL-BILLING-068: Portal session is configured to render both subscription
 * items (tier base and location overage) and allows payment method updates.
 * VAL-BILLING-069: If portal session creation fails, returns error with
 * user-facing message instead of navigating to broken URL.
 * VAL-BILLING-070: Cancellation via portal triggers
 * customer.subscription.deleted webhook (handled by existing webhook handler).
 */
async function createBillingPortal(req: NextRequest): Promise<NextResponse> {
  const owner = await requireOwnerWithAccount(req);
  if (!owner.ok) return owner.response;

  // Use the authenticated user's accountId — ignore any body accountId
  const accountId = owner.accountId;

  // Look up the account
  const [account] = await sql<{
    id: string;
    subscription_status: string;
    stripe_customer_id: string | null;
  }[]>`
    SELECT id, subscription_status, stripe_customer_id
    FROM accounts
    WHERE id = ${accountId}::uuid
  `;

  if (!account) {
    return NextResponse.json(
      { error: 'account_not_found' },
      { status: 404, headers: NO_STORE },
    );
  }

  if (account.subscription_status === SubscriptionStatus.PENDING_PAYMENT) {
    return NextResponse.json(
      { error: 'no_active_subscription', subscriptionStatus: account.subscription_status },
      { status: 409, headers: NO_STORE },
    );
  }

  if (!account.stripe_customer_id) {
    return NextResponse.json(
      { error: 'no_stripe_customer', detail: 'Account has no Stripe customer ID' },
      { status: 400, headers: NO_STORE },
    );
  }

  // Create the portal session
  const baseUrl = process.env.NEXT_PUBLIC_APP_URL ?? 'http://localhost:3000';

  try {
    const stripe = getStripe();

    // VAL-BILLING-068: Configure the portal to show both subscription items
    // (tier base + location overage) and allow payment method updates,
    // invoice viewing, and cancellation.
    const configuration = await stripe.billingPortal.configurations.list({
      active: true,
      limit: 1,
    });

    let configurationId: string;

    if (configuration.data.length > 0) {
      // Use the existing active portal configuration
      configurationId = configuration.data[0]!.id;
    } else {
      // Create a default portal configuration if none exists
      const newConfig = await stripe.billingPortal.configurations.create({
        features: {
          payment_method_update: {
            enabled: true,
          },
          invoice_history: {
            enabled: true,
          },
          subscription_cancel: {
            enabled: true,
            mode: 'at_period_end',
            cancellation_reason: {
              enabled: true,
              options: [
                'too_expensive',
                'missing_features',
                'switched_service',
                'unused',
                'other',
              ],
            },
          },
        },
        business_profile: {
          headline: 'RepWorth Billing Management',
        },
      });
      configurationId = newConfig.id;
    }

    const session = await stripe.billingPortal.sessions.create({
      customer: account.stripe_customer_id,
      configuration: configurationId,
      return_url: `${baseUrl}/settings`,
    });

    return NextResponse.json(
      { url: session.url },
      { headers: NO_STORE },
    );
  } catch (err) {
    // VAL-BILLING-069: Return user-facing error instead of broken URL
    const message = err instanceof Error ? err.message : String(err);
    console.error(`[billing/portal] Stripe portal session creation failed for account=${accountId}: ${message}`);
    return NextResponse.json(
      { error: 'portal_unavailable', detail: 'Unable to open billing portal. Please try again later.' },
      { status: 502, headers: NO_STORE },
    );
  }
}

export const POST = withSameOrigin()(createBillingPortal);
