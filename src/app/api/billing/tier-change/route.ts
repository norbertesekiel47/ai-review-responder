// src/app/api/billing/tier-change/route.ts
//
// POST /api/billing/tier-change — Changes the account's subscription tier.
// Uses Stripe's subscription item update to swap the base price and
// recalculate overage. Validates via validateTierChange before proceeding.
//
// VAL-BILLING-073: Tier change UI renders downgrade confirmation modal
// with new billing summary.

import { v7 as uuidv7 } from 'uuid';
import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { sql, jsonb } from '@/lib/db/server';
import { requireRole, AuthError } from '@/lib/db/auth';
import { NO_STORE_HEADERS } from '@/lib/shared/constants';
import { validateTierChange } from '@/lib/accounts/tier-change';
import { isSubscriptionTier, type SubscriptionTierValue, TIER_CONFIG } from '@/lib/accounts/tier-config';
import { getAccountOwnerUserId } from '@/lib/accounts/repo';
import { getStripe } from '@/lib/payments/create-checkout-session';

export const dynamic = 'force-dynamic';

// ── Request schema ─────────────────────────────────────────────────────────

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const TierChangeSchema = z.object({
  accountId: z.string().regex(UUID_RE, 'Invalid account ID format'),
  newTier: z.string().refine(isSubscriptionTier, {
    message: 'Invalid subscription tier',
  }),
});

// ── Price ID reverse map ──────────────────────────────────────────────────

function getBasePriceId(tier: SubscriptionTierValue): string | null {
  const envMap: Record<SubscriptionTierValue, string | undefined> = {
    basic: process.env.STRIPE_PRICE_BASIC,
    standard: process.env.STRIPE_PRICE_STANDARD,
    premium: process.env.STRIPE_PRICE_PREMIUM,
    founders: process.env.STRIPE_PRICE_FOUNDING,
  };
  return envMap[tier] ?? null;
}

function getOveragePriceId(tier: SubscriptionTierValue): string | null {
  const envMap: Record<SubscriptionTierValue, string | undefined> = {
    basic: undefined, // basic has no overage
    standard: process.env.STRIPE_PRICE_STANDARD_OVERAGE,
    premium: process.env.STRIPE_PRICE_PREMIUM_OVERAGE,
    founders: process.env.STRIPE_PRICE_FOUNDERS_OVERAGE,
  };
  return envMap[tier] ?? null;
}

// ── Handler ─────────────────────────────────────────────────────────────────

export async function POST(req: NextRequest): Promise<NextResponse> {
  let user;
  try {
    user = await requireRole(req, 'owner');
  } catch (err) {
    if (err instanceof AuthError) {
      return NextResponse.json({ error: err.message }, { status: err.statusCode, headers: NO_STORE_HEADERS });
    }
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401, headers: NO_STORE_HEADERS });
  }

  if (!user.accountId) {
    return NextResponse.json({ error: 'No account associated with this user' }, { status: 403, headers: NO_STORE_HEADERS });
  }

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

  const { accountId, newTier } = parsed.data;
  const tier = newTier as SubscriptionTierValue;

  // ── Ownership: body.accountId must match authenticated user ──────────────
  if (accountId !== user.accountId) {
    return NextResponse.json(
      { error: 'Account ID mismatch' },
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

  const newBasePriceId = getBasePriceId(tier);
  if (!newBasePriceId) {
    return NextResponse.json(
      { error: 'missing_price_config', detail: `No Stripe price configured for tier: ${tier}` },
      { status: 500, headers: NO_STORE_HEADERS },
    );
  }

  const newConfig = TIER_CONFIG[tier];
  const actorUserId = await getAccountOwnerUserId(accountId);

  try {
    const stripe = getStripe();

    // Retrieve the current subscription to find the base item ID
    const subscription = await stripe.subscriptions.retrieve(account.stripe_subscription_id);

    // Find the base price item (quantity=1, not the overage item)
    const baseItem = subscription.items.data.find((item) => item.quantity === 1);
    if (!baseItem) {
      return NextResponse.json(
        { error: 'base_item_not_found', detail: 'Could not identify the base subscription item' },
        { status: 500, headers: NO_STORE_HEADERS },
      );
    }

    // Update the base item to the new tier price
    // Stripe will prorate automatically
    await stripe.subscriptionItems.update(baseItem.id, {
      price: newBasePriceId,
      proration_behavior: 'create_prorations',
    });

    // Handle overage item:
    // - If new tier supports overage and an overage item exists, update its price
    // - If new tier supports overage but no item exists, create one
    // - If new tier is basic (no overage), remove the overage item if it exists
    if (newConfig.overageCents > 0 && newConfig.multiLocAllowed) {
      const overagePriceId = getOveragePriceId(tier);
      const overageItem = subscription.items.data.find(
        (item) => item.id !== baseItem.id,
      );

      if (overageItem) {
        // Update existing overage item price
        if (overagePriceId) {
          await stripe.subscriptionItems.update(overageItem.id, {
            price: overagePriceId,
            proration_behavior: 'create_prorations',
          });
        }
      } else if (overagePriceId) {
        // Create overage item
        await stripe.subscriptionItems.create({
          subscription: account.stripe_subscription_id,
          price: overagePriceId,
          quantity: 0,
          proration_behavior: 'create_prorations',
        });
      }
    } else {
      // Basic tier: remove overage item if it exists
      const overageItem = subscription.items.data.find(
        (item) => item.id !== baseItem.id,
      );
      if (overageItem) {
        await stripe.subscriptionItems.del(overageItem.id);
      }
    }

    // Update the accounts row immediately (webhook will confirm)
    await sql`
      UPDATE accounts
      SET subscription_tier = ${tier},
          locations_included = ${newConfig.included},
          updated_at = NOW()
      WHERE id = ${accountId}::uuid
    `;

    // Insert audit log
    await sql`
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
        })}
      )
    `;

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
