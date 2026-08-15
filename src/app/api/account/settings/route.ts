// src/app/api/account/settings/route.ts
//
// GET /api/account/settings — Returns account-level data for the Settings
// Billing tab: subscription summary, billing snapshot, quota usage,
// and owner profile information.
//
// Used by BillingPanel via the useAccountData hook.
//
// Validation contract: VAL-SETTINGS-003 through VAL-SETTINGS-007.

import { NextRequest, NextResponse } from 'next/server';
import { sql } from '@/lib/db/server';
import { jsonResponse, requireOwnerWithAccount } from '@/lib/auth/route-helpers';
import { currentBillingSnapshot } from '@/lib/accounts/quota';
import { getActiveLocationCount } from '@/lib/locations/repo';
import {
  SubscriptionTier,
  isPriceVariant,
  isSubscriptionTier,
} from '@/lib/accounts/tier-config';
import { buildPlanPresentation } from '@/lib/payments/plan-presentation';
import { autopilotPurchasable } from '@/lib/payments/tier-purchasability';
import { SubscriptionStatus } from '@/lib/shared/subscription-status';

export const dynamic = 'force-dynamic';

export async function GET(request: NextRequest): Promise<NextResponse> {
  const owner = await requireOwnerWithAccount(request);
  if (!owner.ok) return owner.response;

  // Fetch account data
  const [account] = await sql<{
    id: string;
    display_name: string;
    subscription_tier: string;
    price_variant: string;
    subscription_status: string;
    stripe_customer_id: string | null;
    subscription_activated_at: Date | null;
    locations_included: number;
    locations_paid: number;
    trial_ends_at: Date | null;
  }[]>`
    SELECT
      id,
      display_name,
      subscription_tier,
      price_variant,
      subscription_status,
      stripe_customer_id,
      subscription_activated_at,
      locations_included,
      locations_paid,
      trial_ends_at
    FROM accounts
    WHERE id = ${owner.accountId}::uuid
  `;

  if (!account) {
    return jsonResponse({ error: 'Account not found' }, 404);
  }
  if (!isSubscriptionTier(account.subscription_tier)) {
    return jsonResponse({ error: 'Account has an invalid subscription tier' }, 500);
  }
  if (!isPriceVariant(account.price_variant)) {
    return jsonResponse({ error: 'Account has an invalid price variant' }, 500);
  }

  // Fetch independent account metrics after the account existence check.
  // Fixed width 2 on a read path — deliberately NOT sequentialised (spec
  // docs/superpowers/specs/2026-08-15-portal-audit-remediation-design.md §3.6).
  // Unlike the competitors page, this width does not grow with the customer.
  const [activeLocations, billingSnapshot] = await Promise.all([
    getActiveLocationCount(sql, owner.accountId),
    currentBillingSnapshot(sql, owner.accountId),
  ]);

  // Format tier label for display
  const tierLabel = SubscriptionTier[
    account.subscription_tier.toUpperCase() as keyof typeof SubscriptionTier
  ] ?? account.subscription_tier;

  // Format subscription status for display
  const statusLabel = account.subscription_status
    .replace(/_/g, ' ')
    .replace(/\b\w/g, (c) => c.toUpperCase());

  return jsonResponse({
    accountId: account.id,
    displayName: account.display_name,
    subscription: {
      tier: account.subscription_tier,
      tierLabel,
      priceVariant: account.price_variant,
      status: account.subscription_status,
      statusLabel,
      stripeCustomerId: account.stripe_customer_id,
      activatedAt: account.subscription_activated_at?.toISOString() ?? null,
      trialEndsAt: account.trial_ends_at?.toISOString() ?? null,
    },
    quota: {
      activeLocations,
      included: account.locations_included,
      paid: account.locations_paid,
      overage: Math.max(0, activeLocations - account.locations_included),
    },
    billing: {
      basePriceCents: billingSnapshot.basePriceCents,
      overagePriceCents: billingSnapshot.overagePriceCents,
      overageUnits: billingSnapshot.overageUnits,
      totalCents: billingSnapshot.totalCents,
    },
    planPresentation: buildPlanPresentation({
      priceVariant: account.price_variant,
      autopilotPurchasable: autopilotPurchasable(),
      trialEnabled: account.subscription_status === SubscriptionStatus.TRIALING,
    }),
    // The current account schema has no persisted IANA timezone. Keep the
    // display timezone server-owned and explicit until a future schema adds it.
    timeZone: 'UTC',
  });
}
