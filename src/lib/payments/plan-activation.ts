// src/lib/payments/plan-activation.ts
//
// Self-serve plan-activation transaction + trial-eligibility policy for the
// select-plan checkout flow (A+ campaign PR 2c extraction from
// src/app/api/onboarding/select-plan/route.ts). Single owner of:
//   1. applyTierSnapshot — the lock-then-snapshot tier transaction that flips
//      a pending_payment account into the chosen tier (VAL-BILLING-065
//      quota/price snapshot), mirroring the tier-change snapshot in
//      src/lib/accounts/tier-change.ts.
//   2. resolveCheckoutContext — the self-serve trial-eligibility policy for
//      the Checkout Session the route creates immediately after.
// The route keeps its guard stack (feature flag, CSRF, auth, rate limits,
// body parse, tier validation), maps each result to HTTP, and calls
// createCheckoutSession itself.
//
// Validation contract: VAL-BILLING-065, VAL-SCHEMA-037 (deprecated
// businesses.subscription_tier column, retained for backward compat).

import type { Sql } from 'postgres';
import { SubscriptionStatus } from '@/lib/shared/subscription-status';
import {
  isPriceVariant,
  type PriceVariant,
  type Ws8SubscriptionTier,
} from '@/lib/accounts/tier-config';
import { acquireTierBillingActivationLocks } from '@/lib/accounts/billing-locks';
import { writeTierSnapshot } from '@/lib/accounts/tier-snapshot';
import { assertTierPurchasable } from '@/lib/payments/tier-purchasability';
import { trialEnabled } from './flags';

// ── applyTierSnapshot ────────────────────────────────────────────────────

export type TierSnapshotResult =
  | { kind: 'ok'; accountId: string; variant: PriceVariant }
  | { kind: 'not_found' }
  | { kind: 'wrong_status'; status: string };

export interface ApplyTierSnapshotParams {
  accountId: string;
  /** Preserves the caller's established `:activation` lock identity. */
  activationLockId: string;
  tier: Ws8SubscriptionTier;
  actorUserId?: string | null;
}

/**
 * Locks the account, verifies `pending_payment`, and snapshots the tier's
 * quota/price columns onto `accounts` (VAL-BILLING-065) — the atomic write
 * that commits a self-serve signup's chosen tier before Stripe Checkout is
 * ever created.
 *
 * Existing-account tier writers acquire the account-scoped entitlement,
 * billing, and activation advisory locks in that order before taking the
 * account row lock. The complete snapshot writer also keeps the deprecated
 * `businesses.subscription_tier` mirror synchronized.
 *
 * @param sql  Postgres.js client (composition root supplies the singleton —
 *   this module never imports @/lib/db/server).
 */
export async function applyTierSnapshot(
  sql: Sql,
  { accountId, activationLockId, tier, actorUserId }: ApplyTierSnapshotParams,
): Promise<TierSnapshotResult> {
  // This is an authoritative new tier selection. Reject a closed Autopilot
  // gate before entering a transaction or touching persistent state.
  assertTierPurchasable(tier);

  return sql.begin(async (tx) => {
    await acquireTierBillingActivationLocks(tx, accountId, activationLockId);

    const [row] = await tx<{
      subscription_status: string;
      price_variant: string;
    }[]>`
      SELECT a.subscription_status, a.price_variant
      FROM accounts a
      WHERE a.id = ${accountId}::uuid
      FOR UPDATE
    `;
    if (!row) {
      // The row vanished between the caller's lookup and now (e.g., cleanup
      // poller deleted it). Surface as account_incomplete.
      return { kind: 'not_found' as const };
    }
    if (row.subscription_status !== SubscriptionStatus.PENDING_PAYMENT) {
      return {
        kind: 'wrong_status' as const,
        status: row.subscription_status,
      };
    }
    if (!isPriceVariant(row.price_variant)) {
      throw new Error(`Account ${accountId} has invalid price_variant`);
    }

    await writeTierSnapshot(tx, {
      accountId,
      tier,
      variant: row.price_variant,
      locationsPaid: 0,
      audit: {
        eventType: 'tier_selected',
        actorUserId,
        payload: { source: 'checkout' },
      },
    });
    return { kind: 'ok' as const, accountId, variant: row.price_variant };
  });
}

// ── resolveCheckoutContext ───────────────────────────────────────────────

export interface CheckoutContext {
  accountId: string;
  trialEligible: boolean;
}

/**
 * Resolves the account + trial eligibility for the self-serve Checkout
 * Session that follows a successful applyTierSnapshot. Returns `null` when
 * the business row is missing (route maps that to 404 account_incomplete).
 *
 * Trial eligibility (PLAN.md §0.2): TRIAL_ENABLED on AND the business is
 * self-serve (`onboarded_by IS NULL`) — an admin/partner-onboarded business
 * must never receive a $0 trial via direct POST; it falls back to a normal
 * paid checkout.
 *
 * @param sql  Postgres.js client (composition root supplies the singleton —
 *   this module never imports @/lib/db/server).
 */
export async function resolveCheckoutContext(
  sql: Sql,
  businessId: string,
): Promise<CheckoutContext | null> {
  // Resolve the account_id for this owner, plus onboarded_by (the self-serve
  // discriminator: NULL = self-serve, non-null = admin/partner handoff).
  const [accountRow] = await sql<{ account_id: string; onboarded_by: string | null }[]>`
    SELECT account_id, onboarded_by FROM businesses WHERE id = ${businessId}::uuid
  `;
  if (!accountRow) {
    return null;
  }

  return {
    accountId: accountRow.account_id,
    trialEligible: trialEnabled() && accountRow.onboarded_by === null,
  };
}
