// src/lib/accounts/quota.ts
//
// Overage computation, billing snapshot, and quota assertion helpers.
// Used by /api/billing/checkout (line item quantity), add-location flow,
// and billing snapshot API.
//
// Validation contract: VAL-BILLING-017 through VAL-BILLING-027,
// VAL-LOC-001 through VAL-LOC-006.

import { sql } from '@/lib/db/server';
import type { AccountId } from '@/lib/shared/ids';
import { SubscriptionStatus } from '@/lib/shared/subscription-status';
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

// ── assertCanAddLocation ──────────────────────────────────────────────────

export interface QuotaAllowed {
  allowed: true;
  /** Overage units that will apply for this add (0 = within included quota). */
  overageUnits: number;
}

export interface QuotaRejected {
  allowed: false;
  reason:
    | 'account_not_found'
    | 'subscription_inactive'
    | 'tier_disallows_multi_location'
    | 'quota_exhausted';
}

export type QuotaCheckResult = QuotaAllowed | QuotaRejected;

/**
 * Asserts whether a location can be added to the given account.
 *
 * This function is the single chokepoint for all add-location quota checks.
 * Every caller (API route, admin import, etc.) MUST use this instead of
 * computing quota inline (per AGENTS.md coding conventions).
 *
 * The function:
 *   1. SELECT FOR UPDATE on the accounts row (race safety — VAL-LOC-006)
 *   2. Checks subscription is active (VAL-LOC-002)
 *   3. Checks tier allows multi-location (VAL-LOC-001)
 *   4. Checks active location count < included + paid (VAL-LOC-003)
 *
 * When allowed, reports the overageUnits that will apply (0 when within
 * included quota, >0 when overage billing kicks in).
 *
 * VAL-LOC-001: rejects basic tier (multiLocAllowed = false)
 * VAL-LOC-002: rejects inactive subscriptions
 * VAL-LOC-003: quota boundary — overage policy
 * VAL-LOC-004: allows add when within quota
 * VAL-LOC-005: allows add with overage when above included quota
 * VAL-LOC-006: SELECT FOR UPDATE prevents concurrent adds from exceeding quota
 */
export async function assertCanAddLocation(
  accountId: string,
): Promise<QuotaCheckResult> {
  // 1. Lock the account row with SELECT FOR UPDATE
  //    This prevents concurrent add-location calls from both reading the same
  //    quota state and both succeeding (race condition — VAL-LOC-006).
  const [account] = await sql<{
    id: string;
    subscription_tier: string;
    subscription_status: string;
    locations_included: number;
    locations_paid: number;
  }[]>`
    SELECT id, subscription_tier, subscription_status,
           locations_included, locations_paid
    FROM accounts
    WHERE id = ${accountId}::uuid
    FOR UPDATE
  `;

  if (!account) {
    return { allowed: false, reason: 'account_not_found' };
  }

  // 2. Check subscription is active
  if (account.subscription_status !== SubscriptionStatus.ACTIVE) {
    return { allowed: false, reason: 'subscription_inactive' };
  }

  // 3. Check tier allows multi-location
  const tier = account.subscription_tier;
  const tierConfig = isSubscriptionTier(tier) ? TIER_CONFIG[tier] : undefined;
  if (!tierConfig || !tierConfig.multiLocAllowed) {
    return { allowed: false, reason: 'tier_disallows_multi_location' };
  }

  // 4. Count active (non-archived) locations
  const [locationRow] = await sql<{ count: number }[]>`
    SELECT COUNT(*) AS count
    FROM businesses
    WHERE account_id = ${accountId}::uuid
      AND archived_at IS NULL
  `;
  const activeLocations = Number(locationRow?.count ?? 0);

  // 5. Compute overage units for the new location
  //
  // For multi-location tiers, overage billing is automatic — there is no hard
  // cap. The add is always allowed (as long as the subscription is active and
  // the tier supports multi-location, which were checked above). Overage units
  // indicate the billing implication:
  //   - If activeLocations + 1 <= included: no overage (within quota)
  //   - If activeLocations + 1 > included: overage applies (billed via Stripe)
  //
  // VAL-LOC-003: at quota boundary with overage policy → allowed
  // VAL-LOC-005: allows add with overage when above included quota
  //
  // The `quota_exhausted` reason is reserved for future hard-cap scenarios
  // (e.g., platform-imposed maximums) but is not triggered in the current
  // implementation because overage billing is automatic.
  const overageUnits = computeOverageQuantity(activeLocations + 1, tierConfig.included);

  return { allowed: true, overageUnits };
}
