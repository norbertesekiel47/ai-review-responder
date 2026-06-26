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

import type { SubscriptionTierValue } from '@/lib/accounts/tier-config';
import { basePriceIdForTier, overagePriceIdForTier } from '@/lib/payments/price-tier-map';
import { computeOverageQuantity } from '@/lib/accounts/quota';
import { sql } from '@/lib/db/server';
import { getStripe } from '@/lib/payments/stripe-client';
import { getServerConfig } from '@/lib/config/server';

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
   * pending_payment account). The trial length comes from TRIAL_PERIOD_DAYS
   * (default 30).
   */
  trial?: boolean;
}

const DEFAULT_TRIAL_PERIOD_DAYS = 30;

function resolveTrialPeriodDays(): number {
  // Migrated raw read (Stage-3 trial-period-days batch): rawOptionalVar keeps
  // ''/'   '/unset byte-for-byte (#7) so the `if (!raw)` default + parseInt guard
  // below stay identical to the old process.env.TRIAL_PERIOD_DAYS read.
  const raw = getServerConfig().TRIAL_PERIOD_DAYS;
  if (!raw) return DEFAULT_TRIAL_PERIOD_DAYS;
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_TRIAL_PERIOD_DAYS;
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
  options: CheckoutSessionOptions = {},
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

  // Stripe Tax is gated by a server-only flag: enabling automatic_tax against a
  // Stripe account that has not turned on Tax (or whose Prices lack tax_behavior)
  // makes sessions.create throw. Flip STRIPE_TAX_ENABLED only after the dashboard
  // is configured (see the Launch-Gate Checklist). tax_id_collection is a
  // deliberate B2B choice — RepWorth's customers are businesses.
  const taxParams = process.env.STRIPE_TAX_ENABLED === 'true'
    ? {
        automatic_tax: { enabled: true },
        billing_address_collection: 'required' as const,
        tax_id_collection: { enabled: true },
      }
    : {};

  // Card-up-front trial: Stripe charges $0 now and auto-charges the captured
  // card at trial end. The resulting subscription comes back status='trialing',
  // which the checkout webhook projects to the 'trialing' account status.
  const trialParams = options.trial
    ? { subscription_data: { trial_period_days: resolveTrialPeriodDays() } }
    : {};

  // Create the Checkout Session
  const session = await getStripe().checkout.sessions.create({
    mode: 'subscription',
    line_items: lineItems,
    client_reference_id: accountId,
    customer_email: ownerEmail,
    success_url: successUrl,
    cancel_url: cancelUrl,
    allow_promotion_codes: true,
    ...taxParams,
    ...trialParams,
  });

  return { url: session.url!, sessionId: session.id };
}
