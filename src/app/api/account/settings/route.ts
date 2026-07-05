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
import { SubscriptionTier } from '@/lib/accounts/tier-config';
import { isSubscriptionTier } from '@/lib/accounts/tier-config';

export const dynamic = 'force-dynamic';

export async function GET(request: NextRequest): Promise<NextResponse> {
  const owner = await requireOwnerWithAccount(request);
  if (!owner.ok) return owner.response;

  // Fetch account data
  const [account] = await sql<{
    id: string;
    display_name: string;
    subscription_tier: string;
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

  // Fetch independent account metrics after the account existence check.
  const [activeLocations, billingSnapshot] = await Promise.all([
    getActiveLocationCount(owner.accountId),
    currentBillingSnapshot(sql, owner.accountId),
  ]);

  // Format tier label for display
  const tierLabel = isSubscriptionTier(account.subscription_tier)
    ? SubscriptionTier[account.subscription_tier.toUpperCase() as keyof typeof SubscriptionTier]
      ?? account.subscription_tier
    : account.subscription_tier;

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
    // The current account schema has no persisted IANA timezone. Keep the
    // display timezone server-owned and explicit until a future schema adds it.
    timeZone: 'UTC',
  });
}
