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

import type { Sql } from 'postgres';
import { createHash } from 'node:crypto';
import type {
  PriceVariant,
  SubscriptionTierValue,
} from '@/lib/accounts/tier-config';
import { priceIdFor } from '@/lib/payments/price-tier-map';
import { computeOverageQuantity } from '@/lib/accounts/quota';
import { getStripe } from '@/lib/payments/stripe-client';
import { assertTierPurchasable } from '@/lib/payments/tier-purchasability';
import { stripeTaxEnabled } from './flags';

// ── Types ──────────────────────────────────────────────────────────────────

export interface CheckoutSessionResult {
  url: string;
  sessionId: string;
}

export interface CheckoutSessionOptions {
  /**
   * When true, the Checkout Session carries
   * `subscription_data.trial_period_days` so Stripe creates a card-up-front
   * trial ($0 charged now). The caller (the billing-checkout route) owns the
   * eligibility decision (TRIAL_ENABLED on AND the account is a self-serve
   * pending_payment account). WS8 fixes the commercial trial at 30 days.
   */
  trial?: boolean;
}

const TRIAL_PERIOD_DAYS = 30;

function checkoutSessionIdempotencyKey(
  accountId: string,
  tier: SubscriptionTierValue,
  variant: PriceVariant,
  params: {
    mode: 'subscription';
    line_items: Array<{ price: string; quantity: number }>;
    client_reference_id: string;
    customer_email: string;
    success_url: string;
    cancel_url: string;
    allow_promotion_codes: false;
    automatic_tax?: { enabled: true };
    billing_address_collection?: 'required';
    tax_id_collection?: { enabled: true };
    subscription_data?: { trial_period_days: number };
  },
): string {
  const material = JSON.stringify({ accountId, tier, variant, params });
  const digest = createHash('sha256').update(material).digest('hex');
  return `checkout-session:v1:${digest}`;
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
 *   - The selected tier's overage line item only when quantity is > 0
 *     (Stripe Checkout rejects zero-quantity line items).
 *
 * VAL-BILLING-005: mode=subscription, client_reference_id, customer_email,
 *   success_url, cancel_url, allow_promotion_codes
 * VAL-BILLING-031: This function does NOT reference STRIPE_PAYMENT_LINK_* env vars.
 *
 * @param sql  Postgres.js client (composition root supplies the singleton —
 *   this module never imports @/lib/db/server).
 */
export async function createCheckoutSession(
  sql: Sql,
  accountId: string,
  tier: SubscriptionTierValue,
  variant: PriceVariant,
  ownerEmail: string,
  options: CheckoutSessionOptions = {},
): Promise<CheckoutSessionResult> {
  // Resolve price IDs
  const basePriceId = priceIdFor(tier, variant, 'base');
  if (!basePriceId) {
    throw new CheckoutUnavailableError(
      `Missing base price ID for tier/variant: ${tier}/${variant}`,
    );
  }
  const overagePriceId = priceIdFor(tier, variant, 'overage');
  if (!overagePriceId) {
    throw new CheckoutUnavailableError(`Missing overage price ID for tier: ${tier}`);
  }

  // Build line_items
  const lineItems: Array<{ price: string; quantity: number }> = [
    { price: basePriceId, quantity: 1 },
  ];

  // Count active locations and use the pending account's stored included
  // quota. This provisional Stripe quantity is not persisted as confirmed
  // `locations_paid` until provider-current Checkout completion.
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
  const activeLocations = Number(locationRow.count);
  const locationsIncluded = Number(locationRow.locations_included);
  const overageQuantity = computeOverageQuantity(activeLocations, locationsIncluded);
  if (overageQuantity > 0) {
    lineItems.push({ price: overagePriceId, quantity: overageQuantity });
  }

  // Build URLs
  const baseUrl = process.env.NEXT_PUBLIC_APP_URL ?? 'http://localhost:3000';
  const successUrl = `${baseUrl}/onboarding/payment-success?session_id={CHECKOUT_SESSION_ID}`;
  const cancelUrl = `${baseUrl}/onboarding/pay?cancelled=true`;

  // Stripe Tax is gated by a server-only flag: enabling automatic_tax against a
  // Stripe account that has not turned on Tax (or whose Prices lack tax_behavior)
  // makes sessions.create throw. Flip STRIPE_TAX_ENABLED only after the dashboard
  // is configured (see the Launch-Gate Checklist). tax_id_collection is a
  // deliberate B2B choice — RepWorth's customers are businesses.
  const taxParams = stripeTaxEnabled()
    ? {
        automatic_tax: { enabled: true as const },
        billing_address_collection: 'required' as const,
        tax_id_collection: { enabled: true as const },
      }
    : {};

  // Card-up-front trial: Stripe charges $0 now and auto-charges the captured
  // card at trial end. The resulting subscription comes back status='trialing',
  // which the checkout webhook projects to the 'trialing' account status.
  const trialParams = options.trial
    ? { subscription_data: { trial_period_days: TRIAL_PERIOD_DAYS } }
    : {};

  // Recheck immediately before the external side effect. A stale/direct caller
  // cannot create an Autopilot Session after the launch/runtime gate closes.
  assertTierPurchasable(tier);

  const sessionParams = {
    mode: 'subscription',
    line_items: lineItems,
    client_reference_id: accountId,
    customer_email: ownerEmail,
    success_url: successUrl,
    cancel_url: cancelUrl,
    allow_promotion_codes: false,
    ...taxParams,
    ...trialParams,
  } as const;

  // Stripe retries the same logical Checkout attempt instead of creating a
  // second subscription. Any material input change receives a different key.
  const session = await getStripe().checkout.sessions.create(sessionParams, {
    idempotencyKey: checkoutSessionIdempotencyKey(
      accountId,
      tier,
      variant,
      sessionParams,
    ),
  });

  return { url: session.url!, sessionId: session.id };
}
