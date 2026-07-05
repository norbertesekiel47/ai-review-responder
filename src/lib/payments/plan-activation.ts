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
// body parse, tierConfig lookup), maps each result to HTTP, and calls
// createCheckoutSession itself.
//
// Validation contract: VAL-BILLING-065, VAL-SCHEMA-037 (deprecated
// businesses.subscription_tier column, retained for backward compat).

import type { Sql } from 'postgres';
import { SubscriptionStatus } from '@/lib/shared/subscription-status';
import type { TierConfig } from '@/lib/accounts/tier-config';
import { trialEnabled } from './flags';

// ── applyTierSnapshot ────────────────────────────────────────────────────

export type TierSnapshotResult =
  | { kind: 'ok' }
  | { kind: 'not_found' }
  | { kind: 'wrong_status'; status: string }
  | { kind: 'race_lost' };

export interface ApplyTierSnapshotParams {
  businessId: string;
  tier: string;
  tierConfig: TierConfig;
}

/**
 * Locks the account, verifies `pending_payment`, and snapshots the tier's
 * quota/price columns onto `accounts` (VAL-BILLING-065) — the atomic write
 * that commits a self-serve signup's chosen tier before Stripe Checkout is
 * ever created.
 *
 * Lock-then-read pattern: takes the per-business `:activation` advisory lock
 * FIRST so any in-flight Stripe webhook taking the same key
 * (`worker/ingress/stripe.ts` `processCheckoutSessionCompleted`) commits
 * before this proceeds, THEN re-reads status under a `FOR UPDATE OF a` row
 * lock. `race_lost` is defense-in-depth: the UPDATE is re-guarded by
 * `subscription_status = pending_payment`, so a 0-row match after the
 * pending_payment check passed means the lock didn't actually serialize —
 * treat it as "already active" rather than silently doing nothing. Also
 * writes the deprecated `businesses.subscription_tier` column (VAL-SCHEMA-037
 * backward compat).
 *
 * @param sql  Postgres.js client (composition root supplies the singleton —
 *   this module never imports @/lib/db/server).
 */
export async function applyTierSnapshot(
  sql: Sql,
  { businessId, tier, tierConfig }: ApplyTierSnapshotParams,
): Promise<TierSnapshotResult> {
  return sql.begin(async (tx) => {
    // Lock first, THEN re-read state. Any pending Stripe webhook taking the
    // same key commits before we proceed.
    await tx`SELECT pg_advisory_xact_lock(hashtext(${businessId + ':activation'}))`;

    // Read subscription_status from accounts (source of truth after migration
    // 034). Also lock the accounts row FOR UPDATE to prevent concurrent writes.
    const [row] = await tx<{ subscription_status: string }[]>`
      SELECT a.subscription_status
      FROM accounts a
      JOIN businesses b ON b.account_id = a.id
      WHERE b.id = ${businessId}::uuid
      FOR UPDATE OF a
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

    // UPDATE accounts (source of truth) and businesses (deprecated column
    // retained for backward compat per VAL-SCHEMA-037). Verify count > 0
    // as defense-in-depth.
    // VAL-BILLING-065: Also snapshot locations_included,
    // locations_overage_price_cents, base_price_cents from TIER_CONFIG so the
    // account's billing snapshot is self-consistent from this point forward.
    const update = await tx`
      UPDATE accounts
      SET subscription_tier = ${tier},
          locations_included = ${tierConfig.included},
          locations_overage_price_cents = ${tierConfig.overageCents},
          base_price_cents = ${tierConfig.baseCents},
          updated_at = NOW()
      WHERE id = (SELECT account_id FROM businesses WHERE id = ${businessId}::uuid)
        AND subscription_status = ${SubscriptionStatus.PENDING_PAYMENT}
    `;
    if (update.count === 0) {
      return { kind: 'race_lost' as const };
    }
    // Also write to businesses.subscription_tier (deprecated, retained).
    await tx`
      UPDATE businesses
      SET subscription_tier = ${tier}, updated_at = NOW()
      WHERE id = ${businessId}::uuid
    `;
    return { kind: 'ok' as const };
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
