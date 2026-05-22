// src/lib/payments/create-checkout-session.ts
//
// Shared Checkout Session creation logic. Used by:
//   - /api/billing/checkout (direct API endpoint)
//   - /api/onboarding/select-plan (internal call after tier write)
//
// Creates a Stripe Checkout Session with tier_base + location_overage
// line items, replacing the old Payment Link flow.
//
// Validation contract: VAL-BILLING-001 through VAL-BILLING-006,
//   VAL-BILLING-030 through VAL-BILLING-032.

import Stripe from 'stripe';
import { TIER_CONFIG, type SubscriptionTierValue } from '@/lib/accounts/tier-config';
import { computeOverageQuantity } from '@/lib/accounts/quota';
import { sql } from '@/lib/db/server';

// ── Stripe singleton ────────────────────────────────────────────────────────

let stripeInstance: Stripe | null = null;
export function getStripe(): Stripe {
  if (!stripeInstance) {
    const key = process.env.STRIPE_SECRET_KEY;
    if (!key) throw new Error('STRIPE_SECRET_KEY is not set');
    stripeInstance = new Stripe(key);
  }
  return stripeInstance;
}

// ── Price ID resolution ─────────────────────────────────────────────────────

/**
 * Maps a SubscriptionTierValue to its base price ID from env vars.
 * VAL-BILLING-030: all 7 price env vars read by this code path.
 * VAL-BILLING-032: STRIPE_PRICE_BASIC read, no STRIPE_PRICE_BASIC_OVERAGE.
 */
function getBasePriceId(tier: SubscriptionTierValue): string | null {
  const map: Record<SubscriptionTierValue, string | undefined> = {
    basic: process.env.STRIPE_PRICE_BASIC,
    standard: process.env.STRIPE_PRICE_STANDARD,
    premium: process.env.STRIPE_PRICE_PREMIUM,
    founders: process.env.STRIPE_PRICE_FOUNDING,
  };
  return map[tier] ?? null;
}

/**
 * Maps a SubscriptionTierValue to its overage price ID from env vars.
 * Basic tier has no overage (returns null). VAL-BILLING-032: no BASIC_OVERAGE.
 */
function getOveragePriceId(tier: SubscriptionTierValue): string | null {
  if (tier === 'basic') return null;
  const map: Record<SubscriptionTierValue, string | undefined> = {
    basic: undefined,
    standard: process.env.STRIPE_PRICE_STANDARD_OVERAGE,
    premium: process.env.STRIPE_PRICE_PREMIUM_OVERAGE,
    founders: process.env.STRIPE_PRICE_FOUNDERS_OVERAGE,
  };
  return map[tier] ?? null;
}

// ── Types ──────────────────────────────────────────────────────────────────

export interface CheckoutSessionResult {
  url: string;
  sessionId: string;
}

export class CheckoutUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CheckoutUnavailableError';
  }
}

// ── createCheckoutSession ──────────────────────────────────────────────────

/**
 * Creates a Stripe Checkout Session for the given account and tier.
 *
 * The session includes:
 *   - A base price line item (1x tier base price)
 *   - An overage line item for non-basic tiers only when quantity is > 0
 *     (Stripe Checkout rejects zero-quantity line items).
 *   - Basic tier: single base item only (no overage line item) — VAL-BILLING-004
 *
 * VAL-BILLING-005: mode=subscription, client_reference_id, customer_email,
 *   success_url, cancel_url, allow_promotion_codes
 * VAL-BILLING-031: This function does NOT reference STRIPE_PAYMENT_LINK_* env vars.
 */
export async function createCheckoutSession(
  accountId: string,
  tier: SubscriptionTierValue,
  ownerEmail: string,
): Promise<CheckoutSessionResult> {
  const config = TIER_CONFIG[tier];

  // Resolve price IDs
  const basePriceId = getBasePriceId(tier);
  if (!basePriceId) {
    throw new CheckoutUnavailableError(`Missing base price ID for tier: ${tier}`);
  }

  // Build line_items
  const lineItems: Array<{ price: string; quantity: number }> = [
    { price: basePriceId, quantity: 1 },
  ];

  // VAL-BILLING-004: basic tier omits overage line item
  if (tier !== 'basic') {
    const overagePriceId = getOveragePriceId(tier);
    if (!overagePriceId) {
      throw new CheckoutUnavailableError(`Missing overage price ID for tier: ${tier}`);
    }

    // Count active locations
    const [locationRow] = await sql<{ count: number }[]>`
      SELECT COUNT(*) AS count
      FROM businesses
      WHERE account_id = ${accountId}::uuid
        AND archived_at IS NULL
    `;
    const activeLocations = Number(locationRow?.count ?? 0);
    const overageQuantity = computeOverageQuantity(activeLocations, config.included);
    if (overageQuantity > 0) {
      lineItems.push({ price: overagePriceId, quantity: overageQuantity });
    }
  }

  // Build URLs
  const baseUrl = process.env.NEXT_PUBLIC_APP_URL ?? 'http://localhost:3000';
  const successUrl = `${baseUrl}/onboarding/payment-success?session_id={CHECKOUT_SESSION_ID}`;
  const cancelUrl = `${baseUrl}/onboarding/pay?cancelled=true`;

  // Create the Checkout Session
  const session = await getStripe().checkout.sessions.create({
    mode: 'subscription',
    line_items: lineItems,
    client_reference_id: accountId,
    customer_email: ownerEmail,
    success_url: successUrl,
    cancel_url: cancelUrl,
    allow_promotion_codes: true,
  });

  return { url: session.url!, sessionId: session.id };
}
