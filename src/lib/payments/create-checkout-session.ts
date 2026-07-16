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
import type Stripe from 'stripe';
import type {
  PriceVariant,
  SubscriptionTierValue,
} from '@/lib/accounts/tier-config';
import { getStripe } from '@/lib/payments/stripe-client';
import { acquireTierBillingActivationLocks } from '@/lib/accounts/billing-locks';
import { SubscriptionStatus } from '@/lib/shared/subscription-status';
import { CheckoutAttemptConflictError } from './plan-activation';

// ── Types ──────────────────────────────────────────────────────────────────

export interface CheckoutSessionResult {
  url: string;
  sessionId: string;
}

export interface CheckoutSessionOptions {
  /** Durable, account-owned attempt identity created by applyTierSnapshot. */
  attemptId: string;
  /** Preserves the caller's established account/business activation identity. */
  activationLockId: string;
}

function checkoutSessionIdempotencyKey(attemptId: string): string {
  return `checkout-session-attempt:v1:${attemptId}`;
}

function checkoutSubscriptionId(
  value: string | Stripe.Subscription | null,
): string | null {
  if (typeof value === 'string') return value;
  return value?.id ?? null;
}

async function remediateUnboundProviderSession(sessionId: string): Promise<void> {
  const stripe = getStripe();
  let current = await stripe.checkout.sessions.retrieve(sessionId);

  if (current.status === 'open') {
    try {
      current = await stripe.checkout.sessions.expire(
        sessionId,
        {},
        {
          idempotencyKey: `checkout-attempt-compensate-expire:v1:${sessionId}`,
        },
      );
    } catch (error) {
      // Completion can race the compensation. Provider-current state decides
      // whether the Session was safely expired or its subscription now needs
      // cancellation; an unresolved open Session remains a hard failure.
      current = await stripe.checkout.sessions.retrieve(sessionId);
      if (current.status === 'open') throw error;
    }
  }

  if (current.status === 'expired') return;
  if (current.status !== 'complete') {
    throw new CheckoutAttemptConflictError(
      `Unbound Checkout Session has unresolved provider status (${current.status ?? 'unknown'})`,
    );
  }

  const subscriptionId = checkoutSubscriptionId(current.subscription);
  if (!subscriptionId) {
    throw new CheckoutAttemptConflictError(
      'Completed unbound Checkout Session has no subscription identity',
    );
  }
  const subscription = await stripe.subscriptions.retrieve(subscriptionId);
  if (
    subscription.status === 'canceled' ||
    subscription.status === 'incomplete_expired'
  ) {
    return;
  }
  await stripe.subscriptions.cancel(
    subscriptionId,
    { invoice_now: false, prorate: false },
    {
      idempotencyKey: `checkout-attempt-compensate-cancel:v1:${subscriptionId}`,
    },
  );
}

type FailedBindResolution =
  | { kind: 'bound_open'; result: CheckoutSessionResult }
  | { kind: 'bound_completed' }
  | { kind: 'remediated' };

async function resolveFailedSessionBind(
  sql: Sql,
  accountId: string,
  options: CheckoutSessionOptions,
  session: Stripe.Checkout.Session,
): Promise<FailedBindResolution> {
  return sql.begin(async (tx) => {
    await acquireTierBillingActivationLocks(
      tx,
      accountId,
      options.activationLockId,
    );
    const [lease] = await tx<{
      checkout_attempt_id: string | null;
      checkout_session_id: string | null;
      checkout_attempt_state: string | null;
    }[]>`
      SELECT checkout_attempt_id, checkout_session_id, checkout_attempt_state
      FROM accounts
      WHERE id = ${accountId}::uuid
    `;

    if (
      lease?.checkout_attempt_id === options.attemptId &&
      lease.checkout_session_id === session.id
    ) {
      if (lease.checkout_attempt_state === 'completed') {
        return { kind: 'bound_completed' as const };
      }
      if (lease.checkout_attempt_state === 'open' && session.url) {
        // The original COMMIT succeeded but its acknowledgement was lost.
        // The authoritative lease wins; never expire a successfully bound
        // Session during ambiguous-commit recovery.
        return {
          kind: 'bound_open' as const,
          result: { url: session.url, sessionId: session.id },
        };
      }
    }

    await remediateUnboundProviderSession(session.id);
    await tx`
      UPDATE accounts
      SET checkout_session_id = ${session.id},
          checkout_attempt_state = 'remediated',
          checkout_attempt_updated_at = NOW(),
          updated_at = NOW()
      WHERE id = ${accountId}::uuid
        AND checkout_attempt_id = ${options.attemptId}::uuid
        AND checkout_attempt_state = 'creating'
        AND checkout_session_id IS NULL
    `;
    return { kind: 'remediated' as const };
  });
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
  options: CheckoutSessionOptions,
): Promise<CheckoutSessionResult> {
  let createdSession: Stripe.Checkout.Session | null = null;
  try {
    return await sql.begin(async (tx) => {
      await acquireTierBillingActivationLocks(
        tx,
        accountId,
        options.activationLockId,
      );

      const [attempt] = await tx<{
        subscription_status: string;
        price_variant: string;
        checkout_attempt_id: string | null;
        checkout_session_id: string | null;
        checkout_attempt_state: string | null;
        checkout_attempt_tier: string | null;
        checkout_attempt_price_variant: string | null;
        checkout_attempt_base_price_id: string | null;
        checkout_attempt_overage_price_id: string | null;
        checkout_attempt_base_price_cents: number | null;
        checkout_attempt_overage_price_cents: number | null;
        checkout_attempt_locations_included: number | null;
        checkout_attempt_locations_paid: number | null;
        checkout_attempt_overage_quantity: number | null;
        checkout_attempt_trial_period_days: number | null;
        checkout_attempt_tax_enabled: boolean | null;
        checkout_attempt_customer_email: string | null;
        checkout_attempt_success_url: string | null;
        checkout_attempt_cancel_url: string | null;
      }[]>`
        SELECT
          subscription_status,
          price_variant,
          checkout_attempt_id,
          checkout_session_id,
          checkout_attempt_state,
          checkout_attempt_tier,
          checkout_attempt_price_variant,
          checkout_attempt_base_price_id,
          checkout_attempt_overage_price_id,
          checkout_attempt_base_price_cents,
          checkout_attempt_overage_price_cents,
          checkout_attempt_locations_included,
          checkout_attempt_locations_paid,
          checkout_attempt_overage_quantity,
          checkout_attempt_trial_period_days,
          checkout_attempt_tax_enabled,
          checkout_attempt_customer_email,
          checkout_attempt_success_url,
          checkout_attempt_cancel_url
        FROM accounts
        WHERE id = ${accountId}::uuid
      `;
      if (!attempt) {
        throw new CheckoutUnavailableError(`Account not found: ${accountId}`);
      }

      const attemptMatches =
        attempt.subscription_status === SubscriptionStatus.PENDING_PAYMENT &&
        attempt.checkout_attempt_id === options.attemptId &&
        attempt.checkout_attempt_tier === tier &&
        attempt.checkout_attempt_price_variant === variant &&
        attempt.price_variant === variant &&
        Boolean(attempt.checkout_attempt_base_price_id?.trim()) &&
        Boolean(attempt.checkout_attempt_overage_price_id?.trim()) &&
        Number(attempt.checkout_attempt_base_price_cents) > 0 &&
        Number(attempt.checkout_attempt_overage_price_cents) > 0 &&
        Number(attempt.checkout_attempt_locations_included) > 0 &&
        Number(attempt.checkout_attempt_locations_paid) === 0 &&
        Number.isSafeInteger(
          Number(attempt.checkout_attempt_overage_quantity),
        ) &&
        Number(attempt.checkout_attempt_overage_quantity) >= 0 &&
        (attempt.checkout_attempt_trial_period_days === null ||
          Number(attempt.checkout_attempt_trial_period_days) === 30) &&
        typeof attempt.checkout_attempt_tax_enabled === 'boolean' &&
        Boolean(attempt.checkout_attempt_customer_email?.trim()) &&
        Boolean(attempt.checkout_attempt_success_url?.trim()) &&
        Boolean(attempt.checkout_attempt_cancel_url?.trim());
      if (!attemptMatches) {
        throw new CheckoutAttemptConflictError(
          'Checkout attempt was superseded by a newer plan selection',
        );
      }

      if (attempt.checkout_attempt_state === 'open' && attempt.checkout_session_id) {
        const existing = await getStripe().checkout.sessions.retrieve(
          attempt.checkout_session_id,
          { expand: ['line_items'] },
        );
        if (existing.status === 'complete') {
          throw new CheckoutAttemptConflictError(
            'Checkout completed and is awaiting projection',
          );
        }
        if (existing.status !== 'open' || !existing.url) {
          throw new CheckoutAttemptConflictError(
            'Checkout attempt is no longer open; select the plan again',
          );
        }
        return { url: existing.url, sessionId: existing.id };
      }
      if (attempt.checkout_attempt_state !== 'creating') {
        throw new CheckoutAttemptConflictError(
          `Checkout attempt is not creatable (${attempt.checkout_attempt_state ?? 'missing'})`,
        );
      }

      const lineItems: Array<{ price: string; quantity: number }> = [
        { price: attempt.checkout_attempt_base_price_id!, quantity: 1 },
      ];
      const overageQuantity = Number(attempt.checkout_attempt_overage_quantity);
      if (overageQuantity > 0) {
        lineItems.push({
          price: attempt.checkout_attempt_overage_price_id!,
          quantity: overageQuantity,
        });
      }

      // The durable `creating` attempt was authorized at selection/freeze time
      // and may already own a provider Session under this idempotency key.
      // Retrying it must not consult a now-drifted live purchasability gate.
      const taxParams = attempt.checkout_attempt_tax_enabled
        ? {
            automatic_tax: { enabled: true as const },
            billing_address_collection: 'required' as const,
            tax_id_collection: { enabled: true as const },
          }
        : {};
      const subscriptionData =
        attempt.checkout_attempt_trial_period_days === null
          ? { metadata: { checkout_attempt_id: options.attemptId } }
          : {
              trial_period_days: attempt.checkout_attempt_trial_period_days,
              metadata: { checkout_attempt_id: options.attemptId },
            };
      const sessionParams = {
        mode: 'subscription',
        line_items: lineItems,
        client_reference_id: accountId,
        customer_email: attempt.checkout_attempt_customer_email!,
        success_url: attempt.checkout_attempt_success_url!,
        cancel_url: attempt.checkout_attempt_cancel_url!,
        allow_promotion_codes: false,
        metadata: { checkout_attempt_id: options.attemptId },
        subscription_data: subscriptionData,
        ...taxParams,
      } as const;
      const session = await getStripe().checkout.sessions.create(sessionParams, {
        idempotencyKey: checkoutSessionIdempotencyKey(options.attemptId),
      });
      createdSession = session;
      if (session.status !== 'open' || !session.url) {
        throw new CheckoutUnavailableError(
          `Provider returned a non-open Checkout Session (${session.status ?? 'unknown'})`,
        );
      }

      // The provider call is deliberately before the account row lock. The
      // advisory locks keep compliant tier/status writers serialized; this final
      // row lock pins the durable lease before the Session is exposed to the UI.
      const updated = await tx<{ id: string }[]>`
        UPDATE accounts
        SET checkout_session_id = ${session.id},
            checkout_attempt_state = 'open',
            checkout_attempt_updated_at = NOW(),
            updated_at = NOW()
        WHERE id = ${accountId}::uuid
          AND checkout_attempt_id = ${options.attemptId}::uuid
          AND checkout_attempt_state = 'creating'
          AND checkout_session_id IS NULL
        RETURNING id
      `;
      if (updated.length !== 1) {
        throw new CheckoutAttemptConflictError(
          'Checkout attempt changed before its Session could be leased',
        );
      }
      return { url: session.url, sessionId: session.id };
    });
  } catch (error) {
    if (!createdSession) throw error;
    const resolution = await resolveFailedSessionBind(
      sql,
      accountId,
      options,
      createdSession,
    );
    if (resolution.kind === 'bound_open') return resolution.result;
    if (resolution.kind === 'bound_completed') {
      throw new CheckoutAttemptConflictError(
        'Checkout completed while its Session lease was being confirmed',
      );
    }
    throw error;
  }
}
