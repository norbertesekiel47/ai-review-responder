// src/app/api/billing/tier-change/route.ts
//
// POST /api/billing/tier-change — Changes the account's subscription tier.
// Uses Stripe's subscription item update to swap the base price and
// recalculate overage. Validates via validateTierChange before proceeding.
//
// VAL-BILLING-073: Tier change UI renders downgrade confirmation modal
// with new billing summary.

import { v7 as uuidv7 } from 'uuid';
import { createHash } from 'node:crypto';
import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { getOffboardingState, isBillingMutationBlocked } from '@/lib/account-offboarding/gate';
import { sql, jsonb } from '@/lib/db/server';
import { NO_STORE_HEADERS } from '@/lib/shared/constants';
import { validateTierChange } from '@/lib/accounts/tier-change';
import { isSubscriptionTier, type SubscriptionTierValue, TIER_CONFIG } from '@/lib/accounts/tier-config';
import { getAccountOwnerUserId } from '@/lib/accounts/repo';
import { getStripe } from '@/lib/payments/create-checkout-session';
import { basePriceIdForTier, overagePriceIdForTier, overagePriceIdSet } from '@/lib/payments/price-tier-map';
import { requireOwnerWithAccount, withSameOrigin } from '@/lib/auth/route-helpers';

export const dynamic = 'force-dynamic';

// ── Request schema ─────────────────────────────────────────────────────────

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const TierChangeSchema = z.object({
  accountId: z.string().regex(UUID_RE, 'Invalid account ID format'),
  newTier: z.string().refine(isSubscriptionTier, {
    message: 'Invalid subscription tier',
  }),
  preview: z.boolean().optional().default(false),
});

// ── Price ID reverse map ──────────────────────────────────────────────────

function configuredBasePriceIds(): Set<string> {
  return new Set(
    (Object.keys(TIER_CONFIG) as SubscriptionTierValue[])
      .map(basePriceIdForTier)
      .filter((priceId): priceId is string => Boolean(priceId)),
  );
}

function configuredOveragePriceIds(): Set<string> {
  return overagePriceIdSet();
}

function normalizeIdempotencyKey(raw: string | null): string {
  const source = raw && raw.trim().length > 0 ? raw.trim() : uuidv7();
  const safe = source.replace(/[^a-zA-Z0-9_-]/g, '-');
  if (safe.length > 0 && safe.length <= 96) return safe;
  return createHash('sha256').update(source).digest('hex');
}

// ── Handler ─────────────────────────────────────────────────────────────────

async function changeBillingTier(req: NextRequest): Promise<NextResponse> {
  const owner = await requireOwnerWithAccount(req);
  if (!owner.ok) return owner.response;

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: 'invalid_json' }, { status: 400, headers: NO_STORE_HEADERS });
  }

  const parsed = TierChangeSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: 'invalid_body', issues: parsed.error.issues },
      { status: 400, headers: NO_STORE_HEADERS },
    );
  }

  const { accountId, newTier, preview } = parsed.data;
  const tier = newTier as SubscriptionTierValue;

  // ── Ownership: body.accountId must match authenticated user ──────────────
  if (accountId !== owner.accountId) {
    return NextResponse.json(
      { error: 'Account ID mismatch' },
      { status: 403, headers: NO_STORE_HEADERS },
    );
  }

  const offboardingState = await getOffboardingState(accountId);
  if (isBillingMutationBlocked(offboardingState)) {
    return NextResponse.json(
      { error: 'account_offboarding_blocked' },
      { status: 403, headers: NO_STORE_HEADERS },
    );
  }

  // Validate the tier change
  const validation = await validateTierChange(accountId, tier);

  if (!validation.allowed) {
    return NextResponse.json(
      { error: validation.reason ?? 'tier_change_not_allowed' },
      { status: 409, headers: NO_STORE_HEADERS },
    );
  }

  if (preview) {
    return NextResponse.json(
      {
        success: true,
        preview: true,
        newTier: tier,
        newBilling: validation.newBillingPreview,
      },
      { status: 200, headers: NO_STORE_HEADERS },
    );
  }

  // Get the account's Stripe subscription ID
  const [account] = await sql<{
    stripe_subscription_id: string | null;
    subscription_tier: string;
  }[]>`
    SELECT stripe_subscription_id, subscription_tier
    FROM accounts
    WHERE id = ${accountId}::uuid
  `;

  if (!account?.stripe_subscription_id) {
    return NextResponse.json(
      { error: 'no_stripe_subscription', detail: 'Account has no active Stripe subscription' },
      { status: 400, headers: NO_STORE_HEADERS },
    );
  }

  const newBasePriceId = basePriceIdForTier(tier);
  if (!newBasePriceId) {
    return NextResponse.json(
      { error: 'missing_price_config', detail: `No Stripe price configured for tier: ${tier}` },
      { status: 500, headers: NO_STORE_HEADERS },
    );
  }

  const newConfig = TIER_CONFIG[tier];
  const newOverageUnits = validation.newBillingPreview?.overageUnits ?? 0;
  const actorUserId = await getAccountOwnerUserId(accountId);
  const operationKey = normalizeIdempotencyKey(req.headers.get('Idempotency-Key'));
  const stripeOptions = (step: string) => ({
    idempotencyKey: `tier-change:${accountId}:${operationKey}:${step}`,
  });

  try {
    const stripe = getStripe();

    // Retrieve the current subscription to find the base item ID
    const subscription = await stripe.subscriptions.retrieve(account.stripe_subscription_id);

    const basePriceIds = configuredBasePriceIds();
    const overagePriceIds = configuredOveragePriceIds();

    // Only configured base price IDs are safe to mutate. Quantity-based
    // fallbacks can match setup fees, credits, or legacy add-ons.
    const baseItem = subscription.items.data.find((item) => basePriceIds.has(item.price.id));
    if (!baseItem) {
      return NextResponse.json(
        { error: 'base_item_not_found', detail: 'Could not identify the base subscription item' },
        { status: 500, headers: NO_STORE_HEADERS },
      );
    }

    const overageItem = subscription.items.data.find(
      (item) => item.id !== baseItem.id && overagePriceIds.has(item.price.id),
    ) ?? subscription.items.data.find((item) => item.id !== baseItem.id);

    // Stripe is updated before the local DB row. If the DB transaction below
    // fails after these calls, the client receives a retryable 502 and Stripe
    // webhooks remain the reconciliation path back into accounts.subscription_tier.
    // Keep operationKey stable across retries so reruns can safely complete the
    // local DB/audit update without double-applying Stripe changes.
    // Stripe will prorate automatically.
    await stripe.subscriptionItems.update(baseItem.id, {
      price: newBasePriceId,
      proration_behavior: 'create_prorations',
    }, stripeOptions('base'));

    // Handle overage item:
    // - If overage units remain, update/create the overage item with quantity.
    // - If overage drops to zero or the tier has no overage, remove stale items.
    if (newConfig.overageCents > 0 && newConfig.multiLocAllowed && newOverageUnits > 0) {
      const overagePriceId = overagePriceIdForTier(tier);

      if (overageItem) {
        if (overagePriceId) {
          await stripe.subscriptionItems.update(overageItem.id, {
            price: overagePriceId,
            quantity: newOverageUnits,
            proration_behavior: 'create_prorations',
          }, stripeOptions('overage-update'));
        }
      } else if (overagePriceId) {
        // Create overage item
        await stripe.subscriptionItems.create({
          subscription: account.stripe_subscription_id,
          price: overagePriceId,
          quantity: newOverageUnits,
          proration_behavior: 'create_prorations',
        }, stripeOptions('overage-create'));
      }
    } else {
      if (overageItem) {
        await stripe.subscriptionItems.del(overageItem.id, {}, stripeOptions('overage-delete'));
      }
    }

    await sql.begin(async (tx) => {
      await tx`
        SELECT id
        FROM accounts
        WHERE id = ${accountId}::uuid
        FOR UPDATE
      `;

      // Update the accounts row immediately. This is the PRIMARY writer for a
      // tier change — it must snapshot ALL tier-derived billing columns from
      // TIER_CONFIG, not just tier + included. The Stripe webhook is only a
      // defense-in-depth confirmation, and it re-snapshots base_price_cents /
      // locations_included via `CASE WHEN tierChanged`; because this UPDATE
      // commits the new tier first, the webhook sees tierChanged=false and
      // skips that branch. So base_price_cents and locations_overage_price_cents
      // would never update unless we write them here, leaving e.g. a Premium
      // account billed against the Standard base price (snapshot/margin/invoice
      // reconciliation drift). Mirrors the snapshot written at select-plan/signup.
      await tx`
        UPDATE accounts
        SET subscription_tier = ${tier},
            locations_included = ${newConfig.included},
            locations_overage_price_cents = ${newConfig.overageCents},
            base_price_cents = ${newConfig.baseCents},
            updated_at = NOW()
        WHERE id = ${accountId}::uuid
      `;

      // Insert audit log
      await tx`
        INSERT INTO account_audit_log (
          id, account_id, event_type, actor_user_id, payload
        ) VALUES (
          ${uuidv7()}::uuid,
          ${accountId}::uuid,
          'tier_changed',
          ${actorUserId ?? null}::uuid,
          ${jsonb({
            old_tier: account.subscription_tier,
            new_tier: tier,
            new_base_price_cents: newConfig.baseCents,
            new_overage_price_cents: newConfig.overageCents,
            idempotency_key: operationKey,
          })}
        )
      `;
    });

    return NextResponse.json(
      {
        success: true,
        newTier: tier,
        newBilling: validation.newBillingPreview,
      },
      { status: 200, headers: NO_STORE_HEADERS },
    );
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`[billing/tier-change] Failed for account=${accountId}: ${message}`);
    return NextResponse.json(
      { error: 'tier_change_failed', detail: 'Unable to change subscription tier. Please try again later.' },
      { status: 502, headers: NO_STORE_HEADERS },
    );
  }
}

export const POST = withSameOrigin()(changeBillingTier);
