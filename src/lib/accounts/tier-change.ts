// src/lib/accounts/tier-change.ts
//
// Tier change validation and downgrade billing preview.
// Used by the billing portal and account settings.
//
// Validation contract: VAL-BILLING-045, VAL-BILLING-046, VAL-BILLING-047.

import { sql } from '@/lib/db/server';
import {
  TIER_CONFIG,
  type SubscriptionTierValue,
  isSubscriptionTier,
} from './tier-config';
import { computeOverageQuantity, type BillingSnapshot } from './quota';

// ── Types ──────────────────────────────────────────────────────────────────

export interface TierChangeValidation {
  /** Whether the tier change is allowed. */
  allowed: boolean;
  /** Reason for rejection if not allowed. */
  reason?: 'basic_requires_single_location' | 'unknown_tier' | 'same_tier' | 'subscription_inactive';
  /** Preview of the new billing if the change proceeds. */
  newBillingPreview?: BillingSnapshot;
}

// ── validateTierChange ──────────────────────────────────────────────────

/**
 * Validates whether a tier change is allowed for the given account,
 * and provides a billing preview for the new tier.
 *
 * VAL-BILLING-045: Tier downgrade with excess locations is allowed —
 * confirmation shows new monthly total.
 * VAL-BILLING-046: Downgrade modal calculates overage correctly for each tier transition.
 * VAL-BILLING-047: Tier downgrade to basic with >1 active locations is blocked.
 */
export async function validateTierChange(
  accountId: string,
  newTier: string,
): Promise<TierChangeValidation> {
  // Validate the new tier
  if (!isSubscriptionTier(newTier)) {
    return { allowed: false, reason: 'unknown_tier' };
  }

  const tier = newTier as SubscriptionTierValue;

  // Read account and active location count
  const [account] = await sql<{
    subscription_tier: string;
    subscription_status: string;
  }[]>`
    SELECT subscription_tier, subscription_status
    FROM accounts
    WHERE id = ${accountId}::uuid
  `;

  if (!account) {
    return { allowed: false, reason: 'subscription_inactive' };
  }

  // Same tier — no change needed
  if (account.subscription_tier === newTier) {
    return { allowed: false, reason: 'same_tier' };
  }

  // Only active subscriptions can change tiers
  if (account.subscription_status !== 'active') {
    return { allowed: false, reason: 'subscription_inactive' };
  }

  const newConfig = TIER_CONFIG[tier];

  // Count active locations
  const [locationRow] = await sql<{ count: number }[]>`
    SELECT COUNT(*) AS count
    FROM businesses
    WHERE account_id = ${accountId}::uuid
      AND archived_at IS NULL
  `;
  const activeLocations = Number(locationRow?.count ?? 0);

  // VAL-BILLING-047: Block downgrade to basic with >1 active locations
  if (tier === 'basic' && activeLocations > 1) {
    return {
      allowed: false,
      reason: 'basic_requires_single_location',
    };
  }

  // Compute the new billing snapshot for the target tier
  const overageUnits = computeOverageQuantity(activeLocations, newConfig.included);

  const newBillingPreview: BillingSnapshot = {
    basePriceCents: newConfig.baseCents,
    includedLocations: newConfig.included,
    overagePriceCents: newConfig.overageCents,
    overageUnits,
    totalCents: newConfig.baseCents + overageUnits * newConfig.overageCents,
  };

  // VAL-BILLING-045: Downgrade with excess locations is allowed
  return {
    allowed: true,
    newBillingPreview,
  };
}
