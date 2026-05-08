// src/lib/accounts/quota.ts
//
// Overage computation and billing snapshot helpers.
// Used by /api/billing/checkout (line item quantity), add-location flow,
// and billing snapshot API.
//
// Validation contract: VAL-BILLING-017 through VAL-BILLING-027.

import { sql } from '@/lib/db/server';
import type { AccountId } from '@/lib/shared/ids';
import {
  TIER_CONFIG,
  type SubscriptionTierValue,
  isSubscriptionTier,
} from './tier-config';

// ── computeOverageQuantity ─────────────────────────────────────────────────

/**
 * Computes the number of overage units for a given location count vs the
 * included quota. Returns `max(0, locationsCount - locationsIncluded)`.
 *
 * VAL-BILLING-017 through VAL-BILLING-023: boundary cases tested.
 */
export function computeOverageQuantity(
  locationsCount: number,
  locationsIncluded: number,
): number {
  return Math.max(0, locationsCount - locationsIncluded);
}

// ── BillingSnapshot ─────────────────────────────────────────────────────────

export interface BillingSnapshot {
  /** Monthly base price in cents. */
  basePriceCents: number;
  /** Per-location overage price in cents (0 for basic tier). */
  overagePriceCents: number;
  /** Number of overage units (max(0, activeLocations - included)). */
  overageUnits: number;
  /** Total monthly cost in cents = basePriceCents + overageUnits * overagePriceCents. */
  totalCents: number;
}

// ── currentBillingSnapshot ──────────────────────────────────────────────────

/**
 * Returns the current billing breakdown for an account.
 * Reads the account's subscription_tier, locations_included, locations_paid,
 * and the count of active (non-archived) locations to compute the snapshot.
 *
 * VAL-BILLING-024 through VAL-BILLING-027: per-tier snapshots tested.
 */
export async function currentBillingSnapshot(
  accountId: string,
): Promise<BillingSnapshot> {
  // Read account fields
  const [account] = await sql<{
    subscription_tier: string;
    locations_included: number;
    locations_paid: number;
  }[]>`
    SELECT subscription_tier, locations_included, locations_paid
    FROM accounts
    WHERE id = ${accountId}::uuid
  `;

  if (!account) {
    throw new Error(`Account not found: ${accountId}`);
  }

  const tier = account.subscription_tier;
  if (!isSubscriptionTier(tier)) {
    throw new Error(`Unknown subscription tier: ${tier}`);
  }

  const config = TIER_CONFIG[tier];

  // Basic tier: no overage at all
  if (!config.multiLocAllowed || config.overageCents === 0) {
    return {
      basePriceCents: config.baseCents,
      overagePriceCents: 0,
      overageUnits: 0,
      totalCents: config.baseCents,
    };
  }

  // Count active locations for the account
  const [locationRow] = await sql<{ count: number }[]>`
    SELECT COUNT(*) AS count
    FROM businesses
    WHERE account_id = ${accountId}::uuid
      AND archived_at IS NULL
  `;

  const activeLocations = Number(locationRow?.count ?? 0);
  const overageUnits = computeOverageQuantity(activeLocations, config.included);

  return {
    basePriceCents: config.baseCents,
    overagePriceCents: config.overageCents,
    overageUnits,
    totalCents: config.baseCents + overageUnits * config.overageCents,
  };
}
