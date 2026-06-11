// src/lib/accounts/tier-change.ts
//
// Tier change validation, downgrade billing preview, and execution.
// Single owner of the tier-change concept: validateTierChange (eligibility)
// and applyTierChange (Stripe + DB execution). Used by the billing portal
// route, which only parses input and maps outcomes to HTTP.
//
// Validation contract: VAL-BILLING-045, VAL-BILLING-046, VAL-BILLING-047.

import { v7 as uuidv7 } from 'uuid';
import { sql, jsonb } from '@/lib/db/server';
import {
  TIER_CONFIG,
  type SubscriptionTierValue,
  isSubscriptionTier,
} from './tier-config';
import { computeOverageQuantity, type BillingSnapshot } from './quota';
import { getAccountOwnerUserId } from './repo';
import { getStripe } from '@/lib/payments/stripe-client';
import { basePriceIdForTier, basePriceIdSet, overagePriceIdForTier } from '@/lib/payments/price-tier-map';
import { resolveOverageItem, overageItemMutationParams } from '@/lib/payments/overage-item';

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

// ── applyTierChange ──────────────────────────────────────────────────────────

export type TierChangeFailureCode =
  | 'no_stripe_subscription'
  | 'missing_price_config'
  | 'base_item_not_found'
  | 'ambiguous_overage_item'
  | 'tier_change_failed';

export type TierChangeOutcome =
  | { ok: true }
  | { ok: false; code: TierChangeFailureCode; detail: string };

export interface ApplyTierChangeInput {
  accountId: string;
  tier: SubscriptionTierValue;
  /** Overage units from the validated billing preview. */
  newOverageUnits: number;
  /** Normalized client idempotency key; stable across client retries. */
  operationKey: string;
}

/** Concrete overage mutation, fully resolved BEFORE any Stripe call. */
type OverageMutation =
  | { kind: 'update'; itemId: string; priceId: string; quantity: number }
  | { kind: 'create'; priceId: string; quantity: number }
  | { kind: 'delete'; itemId: string }
  | { kind: 'none' };

/**
 * Resolves the FULL overage mutation before the first Stripe call. If the
 * target tier requires overage but its env price is unconfigured, fail
 * closed — otherwise the base price would be swapped first and the overage
 * step silently no-op'd (under-billing or a stale line). Constructing
 * 'update'/'create' requires the price ID, so a missing price is
 * unrepresentable past this point. A tier change is a deliberate re-pricing
 * event, so re-pricing the overage item to the target tier's env price is
 * intentional here (unlike the recompute worker, which grandfathers legacy
 * prices). An untrusted (descriptor-only keyword) match is enough to flag an
 * item, never enough to delete or re-price it — fail closed; ops resolves by
 * stamping metadata.billing_role on the real item.
 */
function planOverageMutation(input: {
  items: Parameters<typeof resolveOverageItem>[0];
  storedOveragePriceCents: number;
  tier: SubscriptionTierValue;
  newOverageUnits: number;
}): { plan: OverageMutation } | { failure: TierChangeOutcome & { ok: false } } {
  const { items, storedOveragePriceCents, tier, newOverageUnits } = input;

  const resolution = resolveOverageItem(items, { storedOveragePriceCents });
  if (resolution.kind === 'untrusted') {
    return {
      failure: {
        ok: false,
        code: 'ambiguous_overage_item',
        detail: `Subscription item ${resolution.item.id} matched only by ${resolution.matchedBy}; refusing to modify it`,
      },
    };
  }
  const overageItem = resolution.kind === 'trusted' ? resolution.item : undefined;

  const newConfig = TIER_CONFIG[tier];
  const needsOverage =
    newConfig.overageCents > 0 && newConfig.multiLocAllowed && newOverageUnits > 0;
  if (!needsOverage) {
    return { plan: overageItem ? { kind: 'delete', itemId: overageItem.id } : { kind: 'none' } };
  }

  const overagePriceId = overagePriceIdForTier(tier);
  if (!overagePriceId) {
    return {
      failure: {
        ok: false,
        code: 'missing_price_config',
        detail: `No Stripe overage price configured for tier: ${tier}`,
      },
    };
  }
  return {
    plan: overageItem
      ? { kind: 'update', itemId: overageItem.id, priceId: overagePriceId, quantity: newOverageUnits }
      : { kind: 'create', priceId: overagePriceId, quantity: newOverageUnits },
  };
}

/**
 * Snapshots the tier-derived billing columns + audit row in one transaction.
 * This is the PRIMARY writer for a tier change — it must snapshot ALL
 * tier-derived billing columns from TIER_CONFIG, not just tier + included.
 * The Stripe webhook is only a defense-in-depth confirmation, and it
 * re-snapshots base_price_cents / locations_included via `CASE WHEN
 * tierChanged`; because this UPDATE commits the new tier first, the webhook
 * sees tierChanged=false and skips that branch. So base_price_cents and
 * locations_overage_price_cents would never update unless written here,
 * leaving e.g. a Premium account billed against the Standard base price
 * (snapshot/margin/invoice reconciliation drift). Mirrors the snapshot
 * written at select-plan/signup.
 */
async function persistTierChangeTx(input: {
  accountId: string;
  tier: SubscriptionTierValue;
  oldTier: string;
  actorUserId: string | null;
  operationKey: string;
}): Promise<void> {
  const { accountId, tier, oldTier, actorUserId, operationKey } = input;
  const newConfig = TIER_CONFIG[tier];

  await sql.begin(async (tx) => {
    // react-doctor-disable-next-line react-doctor/async-parallel -- ordered writes inside one Postgres.js transaction (single connection): the FOR UPDATE row lock must precede the UPDATE and audit INSERT
    await tx`
      SELECT id
      FROM accounts
      WHERE id = ${accountId}::uuid
      FOR UPDATE
    `;

    await tx`
      UPDATE accounts
      SET subscription_tier = ${tier},
          locations_included = ${newConfig.included},
          locations_overage_price_cents = ${newConfig.overageCents},
          base_price_cents = ${newConfig.baseCents},
          updated_at = NOW()
      WHERE id = ${accountId}::uuid
    `;

    await tx`
      INSERT INTO account_audit_log (
        id, account_id, event_type, actor_user_id, payload
      ) VALUES (
        ${uuidv7()}::uuid,
        ${accountId}::uuid,
        'tier_changed',
        ${actorUserId ?? null}::uuid,
        ${jsonb({
          old_tier: oldTier,
          new_tier: tier,
          new_base_price_cents: newConfig.baseCents,
          new_overage_price_cents: newConfig.overageCents,
          idempotency_key: operationKey,
        })}
      )
    `;
  });
}

/**
 * Executes a validated tier change: swaps the base item's price, applies the
 * overage mutation, then snapshots the tier-derived billing columns + audit
 * row in one DB transaction. Owner of the tier-change execution semantics
 * (the validator above owns eligibility); the route only maps the outcome
 * to HTTP.
 *
 * Stripe is updated before the local DB row. If the DB transaction fails
 * after the Stripe calls, the caller surfaces a retryable failure and Stripe
 * webhooks remain the reconciliation path back into accounts.subscription_tier.
 * The operationKey is stable across client retries so reruns can safely
 * complete the local DB/audit update without double-applying Stripe changes.
 */
export async function applyTierChange(input: ApplyTierChangeInput): Promise<TierChangeOutcome> {
  const { accountId, tier, newOverageUnits, operationKey } = input;

  const [account] = await sql<{
    stripe_subscription_id: string | null;
    subscription_tier: string;
    locations_overage_price_cents: number;
  }[]>`
    SELECT stripe_subscription_id, subscription_tier, locations_overage_price_cents
    FROM accounts
    WHERE id = ${accountId}::uuid
  `;

  if (!account?.stripe_subscription_id) {
    return {
      ok: false,
      code: 'no_stripe_subscription',
      detail: 'Account has no active Stripe subscription',
    };
  }

  const newBasePriceId = basePriceIdForTier(tier);
  if (!newBasePriceId) {
    return {
      ok: false,
      code: 'missing_price_config',
      detail: `No Stripe price configured for tier: ${tier}`,
    };
  }

  const actorUserId = await getAccountOwnerUserId(accountId);
  const stripeOptions = (step: string) => ({
    idempotencyKey: `tier-change:${accountId}:${operationKey}:${step}`,
  });

  try {
    const stripe = getStripe();
    const subscription = await stripe.subscriptions.retrieve(account.stripe_subscription_id);

    // Only configured base price IDs are safe to mutate. Quantity-based
    // fallbacks can match setup fees, credits, or legacy add-ons.
    const baseItem = subscription.items.data.find((item) => basePriceIdSet().has(item.price.id));
    if (!baseItem) {
      return {
        ok: false,
        code: 'base_item_not_found',
        detail: 'Could not identify the base subscription item',
      };
    }

    const planned = planOverageMutation({
      items: subscription.items.data,
      storedOveragePriceCents: account.locations_overage_price_cents,
      tier,
      newOverageUnits,
    });
    if ('failure' in planned) return planned.failure;
    const overageMutation = planned.plan;

    // Stripe will prorate automatically.
    await stripe.subscriptionItems.update(baseItem.id, {
      price: newBasePriceId,
      proration_behavior: 'create_prorations',
    }, stripeOptions('base'));

    // The billing_role stamp (overageItemMutationParams) makes the item exactly
    // matchable forever, independent of price rotations and descriptors — and
    // migrates legacy (pre-stamp) items to the authoritative marker.
    switch (overageMutation.kind) {
      case 'update':
        await stripe.subscriptionItems.update(overageMutation.itemId, {
          price: overageMutation.priceId,
          ...overageItemMutationParams(overageMutation.quantity),
        }, stripeOptions('overage-update'));
        break;
      case 'create':
        await stripe.subscriptionItems.create({
          subscription: account.stripe_subscription_id,
          price: overageMutation.priceId,
          ...overageItemMutationParams(overageMutation.quantity),
        }, stripeOptions('overage-create'));
        break;
      case 'delete':
        await stripe.subscriptionItems.del(overageMutation.itemId, {}, stripeOptions('overage-delete'));
        break;
      case 'none':
        break;
    }

    await persistTierChangeTx({
      accountId,
      tier,
      oldTier: account.subscription_tier,
      actorUserId,
      operationKey,
    });

    return { ok: true };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`[billing/tier-change] Failed for account=${accountId}: ${message}`);
    return {
      ok: false,
      code: 'tier_change_failed',
      detail: 'Unable to change subscription tier. Please try again later.',
    };
  }
}
