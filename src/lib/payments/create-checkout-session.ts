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
import type { SubscriptionTierValue } from '@/lib/accounts/tier-config';
import { basePriceIdForTier, overagePriceIdForTier } from '@/lib/payments/price-tier-map';
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
  // Resolve price IDs
  const basePriceId = basePriceIdForTier(tier);
  if (!basePriceId) {
    throw new CheckoutUnavailableError(`Missing base price ID for tier: ${tier}`);
  }

  // Build line_items
  const lineItems: Array<{ price: string; quantity: number }> = [
    { price: basePriceId, quantity: 1 },
  ];

  // VAL-BILLING-004: basic tier omits overage line item
  if (tier !== 'basic') {
    const overagePriceId = overagePriceIdForTier(tier);
    if (!overagePriceId) {
      throw new CheckoutUnavailableError(`Missing overage price ID for tier: ${tier}`);
    }

    // Count active locations and use the account's stored included quota.
    const [locationRow] = await sql<{ count: number; locations_included: number }[]>`
      SELECT a.locations_included, COUNT(b.id) AS count
      FROM accounts a
      LEFT JOIN businesses b
        ON b.account_id = a.id
       AND b.archived_at IS NULL
      WHERE a.id = ${accountId}::uuid
      GROUP BY a.locations_included
    `;
    if (!locationRow) {
      throw new CheckoutUnavailableError(`Account not found: ${accountId}`);
    }
    const activeLocations = Number(locationRow?.count ?? 0);
    const locationsIncluded = Number(locationRow.locations_included);
    const overageQuantity = computeOverageQuantity(activeLocations, locationsIncluded);
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
