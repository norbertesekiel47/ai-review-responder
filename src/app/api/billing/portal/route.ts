// src/app/api/billing/portal/route.ts
//
// POST /api/billing/portal — Creates a Stripe Customer Portal session
// for self-serve billing management (card updates and invoice viewing).
//
// Validation contract: VAL-BILLING-068, VAL-BILLING-069.

import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { getOffboardingState, isBillingManagementBlocked } from '@/lib/account-offboarding/gate';
import { sql } from '@/lib/db/server';
import { SubscriptionStatus } from '@/lib/shared/subscription-status';
import { getStripe } from '@/lib/payments/stripe-client';
import { requireOwnerWithAccount, withSameOrigin } from '@/lib/auth/route-helpers';
import { reportCaughtError } from '@/lib/shared/report-caught-error';

export const dynamic = 'force-dynamic';

const NO_STORE = { 'Cache-Control': 'no-store, private' } as const;

type PortalConfigurationCandidate = {
  id: string;
  features?: {
    payment_method_update?: { enabled?: boolean };
    invoice_history?: { enabled?: boolean };
    subscription_cancel?: { enabled?: boolean };
  };
};

// ── Handler ─────────────────────────────────────────────────────────────────

/**
 * POST /api/billing/portal
 *
 * Creates a Stripe Customer Portal session for the authenticated owner's account.
 * The portal allows:
 *   - Card updates (payment method changes)
 *   - Invoice viewing
 *
 * Security: requires owner auth; loads Stripe customer from session user's
 * accountId only. Body accountId is ignored (prevents cross-account access).
 *
 * VAL-BILLING-068: Portal session is configured to render both subscription
 * items (tier base and location overage) and allows payment method updates.
 * VAL-BILLING-069: If portal session creation fails, returns error with
 * user-facing message instead of navigating to broken URL.
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

  const offboardingState = await getOffboardingState(accountId);
  if (isBillingManagementBlocked(offboardingState)) {
    return NextResponse.json(
      { error: 'account_offboarding_blocked' },
      { status: 403, headers: NO_STORE },
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

    // VAL-BILLING-068: Configure the portal for payment method updates and
    // invoice viewing. Owner cancellation stays in RepWorth offboarding so the
    // lifecycle record, paid-through access, and reactivation path stay durable.
    const configuration = await stripe.billingPortal.configurations.list({
      active: true,
      limit: 100,
    });

    let configurationId: string;
    const safeExistingConfiguration = configuration.data.find(isCancellationSafePortalConfiguration);

    if (safeExistingConfiguration) {
      configurationId = safeExistingConfiguration.id;
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
            enabled: false,
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
      return_url: `${baseUrl}/settings/billing`,
    });

    return NextResponse.json(
      { url: session.url },
      { headers: NO_STORE },
    );
  } catch (err) {
    // VAL-BILLING-069: Return user-facing error instead of broken URL
    reportCaughtError('billing/portal', err, { reason: 'portal_session_creation_failed', accountId });
    return NextResponse.json(
      { error: 'portal_unavailable', detail: 'Unable to open billing portal. Please try again later.' },
      { status: 502, headers: NO_STORE },
    );
  }
}

export const POST = withSameOrigin()(createBillingPortal);

function isCancellationSafePortalConfiguration(
  configuration: PortalConfigurationCandidate,
): boolean {
  return configuration.features?.payment_method_update?.enabled === true
    && configuration.features.invoice_history?.enabled === true
    && configuration.features.subscription_cancel?.enabled !== true;
}
