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

import type { Sql, TransactionSql } from 'postgres';
import type Stripe from 'stripe';
import type {
  PriceVariant,
  SubscriptionTierValue,
} from '@/lib/accounts/tier-config';
import { getStripe } from '@/lib/payments/stripe-client';
import { acquireTierBillingActivationLocks } from '@/lib/accounts/billing-locks';
import {
  activeOffboardingStateFromProjection,
  isCheckoutBlocked,
  lockAccountBeforeOffboardingProjection,
  type ActiveOffboardingProjection,
} from '@/lib/account-offboarding/gate';
import { SubscriptionStatus } from '@/lib/shared/subscription-status';
import { createWorkerLogger } from '@/lib/shared/logger';
import { reportCaughtError } from '@/lib/shared/report-caught-error';
import type { CheckoutAttemptLeaseColumns } from './checkout-attempt';
import { isStripeCouponError } from './stripe-error-inspect';
import { CheckoutAttemptConflictError } from './plan-activation';

const LOG_PREFIX = '[checkout-session]';

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

interface CheckoutSessionAttemptRow
  extends CheckoutAttemptLeaseColumns, ActiveOffboardingProjection {
  subscription_status: string;
  price_variant: string;
  checkout_attempt_tax_enabled: boolean | null;
  checkout_attempt_customer_email: string | null;
  checkout_attempt_success_url: string | null;
  checkout_attempt_cancel_url: string | null;
  /**
   * The beta comp Stripe Coupon ID frozen into this attempt, or NULL for the
   * explicit no-coupon decision (migration 105). Never re-derived from the
   * environment here: that live read is exactly what the snapshot exists to
   * prevent under a per-attempt idempotency key.
   */
  checkout_attempt_coupon_id: string | null;
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

/**
 * The coupon snapshot has no request-side counterpart to compare against — it
 * is a pure snapshot, which is the whole point of resolving it under the
 * activation lock. What CAN be enforced, in the same spirit as the sibling
 * `Boolean(...?.trim())` checks, is WELL-FORMEDNESS: exactly NULL (the recorded
 * no-coupon decision) or a non-blank string. A blank or whitespace-only id
 * would otherwise reach Stripe as `discounts[0][coupon]` and fail session
 * creation; `undefined` means the column was not projected at all, which is a
 * malformed row, not a decision.
 */
function isWellFormedCouponSnapshot(value: string | null): boolean {
  if (value === null) return true;
  return typeof value === 'string' && value.trim().length > 0;
}

function checkoutAttemptMatchesRequest(
  attempt: CheckoutSessionAttemptRow,
  tier: SubscriptionTierValue,
  variant: PriceVariant,
  attemptId: string,
): boolean {
  return (
    attempt.subscription_status === SubscriptionStatus.PENDING_PAYMENT &&
    attempt.checkout_attempt_id === attemptId &&
    attempt.checkout_attempt_tier === tier &&
    attempt.checkout_attempt_price_variant === variant &&
    attempt.price_variant === variant &&
    Boolean(attempt.checkout_attempt_base_price_id?.trim()) &&
    Boolean(attempt.checkout_attempt_overage_price_id?.trim()) &&
    Number(attempt.checkout_attempt_base_price_cents) > 0 &&
    Number(attempt.checkout_attempt_overage_price_cents) > 0 &&
    Number(attempt.checkout_attempt_locations_included) > 0 &&
    Number(attempt.checkout_attempt_locations_paid) === 0 &&
    Number.isSafeInteger(Number(attempt.checkout_attempt_overage_quantity)) &&
    Number(attempt.checkout_attempt_overage_quantity) >= 0 &&
    (attempt.checkout_attempt_trial_period_days === null ||
      Number(attempt.checkout_attempt_trial_period_days) === 30) &&
    typeof attempt.checkout_attempt_tax_enabled === 'boolean' &&
    Boolean(attempt.checkout_attempt_customer_email?.trim()) &&
    Boolean(attempt.checkout_attempt_success_url?.trim()) &&
    Boolean(attempt.checkout_attempt_cancel_url?.trim()) &&
    isWellFormedCouponSnapshot(attempt.checkout_attempt_coupon_id)
  );
}

async function reuseOpenCheckoutSession(
  attempt: CheckoutSessionAttemptRow,
): Promise<CheckoutSessionResult | null> {
  if (attempt.checkout_attempt_state !== 'open' || !attempt.checkout_session_id) {
    return null;
  }
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

function buildCheckoutSessionParams(
  attempt: CheckoutSessionAttemptRow,
  accountId: string,
  attemptId: string,
): Stripe.Checkout.SessionCreateParams {
  const lineItems: Stripe.Checkout.SessionCreateParams.LineItem[] = [
    { price: attempt.checkout_attempt_base_price_id!, quantity: 1 },
  ];
  const overageQuantity = Number(attempt.checkout_attempt_overage_quantity);
  if (overageQuantity > 0) {
    lineItems.push({
      price: attempt.checkout_attempt_overage_price_id!,
      quantity: overageQuantity,
    });
  }

  const taxParams = attempt.checkout_attempt_tax_enabled
    ? {
        automatic_tax: { enabled: true as const },
        billing_address_collection: 'required' as const,
        tax_id_collection: { enabled: true as const },
      }
    : {};
  const subscriptionData =
    attempt.checkout_attempt_trial_period_days === null
      ? { metadata: { checkout_attempt_id: attemptId } }
      : {
          trial_period_days: attempt.checkout_attempt_trial_period_days,
          metadata: { checkout_attempt_id: attemptId },
        };
  // `payment_method_collection: 'always'` is NOT decoration. A 100%-off
  // subscription Session has nothing due today, and Stripe's subscription-mode
  // default does not guarantee a card is captured — which would silently break
  // the beta's card-up-front promise and surface as a failed charge in month 4
  // (admin-invite-funnel review-log round 1 finding 3). Both keys are emitted
  // ONLY alongside a coupon, so a full-price attempt's params stay byte-identical
  // to what this function produced before the comp existed.
  // `allow_promotion_codes` is already false, so there is no Stripe mutual
  // exclusion with `discounts` to resolve.
  const couponParams = attempt.checkout_attempt_coupon_id
    ? {
        discounts: [{ coupon: attempt.checkout_attempt_coupon_id }],
        payment_method_collection: 'always' as const,
      }
    : {};
  return {
    mode: 'subscription',
    line_items: lineItems,
    client_reference_id: accountId,
    customer_email: attempt.checkout_attempt_customer_email!,
    success_url: attempt.checkout_attempt_success_url!,
    cancel_url: attempt.checkout_attempt_cancel_url!,
    allow_promotion_codes: false,
    metadata: { checkout_attempt_id: attemptId },
    subscription_data: subscriptionData,
    ...taxParams,
    ...couponParams,
  };
}

async function bindCheckoutSessionLease(
  tx: TransactionSql,
  accountId: string,
  attemptId: string,
  sessionId: string,
): Promise<void> {
  const updated = await tx<{ id: string }[]>`
    UPDATE accounts
    SET checkout_session_id = ${sessionId},
        checkout_attempt_state = 'open',
        checkout_attempt_updated_at = NOW(),
        updated_at = NOW()
    WHERE id = ${accountId}::uuid
      AND checkout_attempt_id = ${attemptId}::uuid
      AND checkout_attempt_state = 'creating'
      AND checkout_session_id IS NULL
    RETURNING id
  `;
  if (updated.length !== 1) {
    throw new CheckoutAttemptConflictError(
      'Checkout attempt changed before its Session could be leased',
    );
  }
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

export class CheckoutOffboardingBlockedError extends Error {
  constructor() {
    super('Checkout is blocked while account offboarding is active');
    this.name = 'CheckoutOffboardingBlockedError';
  }
}

/**
 * Stripe rejected the Session because of its coupon — a MISCONFIGURATION, not a
 * transient provider fault and not a generic checkout failure.
 *
 * A wrong or deleted `BETA_COMP_COUPON_ID` (test-mode id deployed to live, an
 * expired coupon, a typo) fails every invited tester's checkout identically,
 * and a generic 500 hides which of the two it is. The message names the coupon
 * id on purpose: it is the one fact that makes the Sentry issue actionable
 * without a database round-trip. A Stripe Coupon ID is a configuration
 * identifier, not a credential — it is not customer-redeemable (redemption
 * needs a Promotion Code, and `allow_promotion_codes` is false) — so it is
 * safe here in a way an API key never would be. It is deliberately the ONLY
 * place the raw id is written out; the routine decision log omits it.
 */
export class CheckoutCouponConfigurationError extends Error {
  constructor(couponId: string, cause: string) {
    super(
      `Stripe rejected the beta comp coupon "${couponId}" for this Checkout Session ` +
        `(${cause}). Verify BETA_COMP_COUPON_ID names a live, unexpired coupon in ` +
        `THIS Stripe mode, or unset it to sell at full price.`,
    );
    this.name = 'CheckoutCouponConfigurationError';
  }
}

/**
 * Translates a coupon-caused Stripe rejection into
 * `CheckoutCouponConfigurationError` and reports it; every other failure is
 * returned untouched so the existing compensation path keeps owning it.
 *
 * Never swallowed: a wrong coupon id must fail LOUDLY. Silent non-application
 * is the failure this whole seam exists to make visible before a beta tester is
 * charged, so the alternative — dropping `discounts` and proceeding at full
 * price — is exactly the outcome that must not happen.
 */
function mapCouponRejection(
  error: unknown,
  couponId: string | null,
  accountId: string,
  attemptId: string,
): unknown {
  if (couponId === null || !isStripeCouponError(error)) return error;
  reportCaughtError('checkout-session', error, {
    reason: 'stripe_rejected_beta_comp_coupon',
    accountId,
    attemptId,
  });
  return new CheckoutCouponConfigurationError(
    couponId,
    error instanceof Error ? error.message : String(error),
  );
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

      const accountLocked = await lockAccountBeforeOffboardingProjection(
        tx,
        accountId,
      );
      if (!accountLocked) {
        throw new CheckoutUnavailableError(`Account not found: ${accountId}`);
      }

      const [attempt] = await tx<CheckoutSessionAttemptRow[]>`
        SELECT
          a.subscription_status,
          a.price_variant,
          a.checkout_attempt_id,
          a.checkout_session_id,
          a.checkout_attempt_state,
          a.checkout_attempt_tier,
          a.checkout_attempt_price_variant,
          a.checkout_attempt_base_price_id,
          a.checkout_attempt_overage_price_id,
          a.checkout_attempt_base_price_cents,
          a.checkout_attempt_overage_price_cents,
          a.checkout_attempt_locations_included,
          a.checkout_attempt_locations_paid,
          a.checkout_attempt_overage_quantity,
          a.checkout_attempt_trial_period_days,
          a.checkout_attempt_tax_enabled,
          a.checkout_attempt_customer_email,
          a.checkout_attempt_success_url,
          a.checkout_attempt_cancel_url,
          a.checkout_attempt_coupon_id,
          ao.id AS offboarding_id,
          ao.account_id AS offboarding_account_id,
          ao.mode AS offboarding_mode,
          ao.status AS offboarding_status,
          ao.failed_step AS offboarding_failed_step,
          ao.access_ends_at AS offboarding_access_ends_at,
          ao.teardown_started_at AS offboarding_teardown_started_at,
          ao.purge_after AS offboarding_purge_after,
          ao.purge_started_at AS offboarding_purge_started_at,
          ao.purge_cancelled_at AS offboarding_purge_cancelled_at
        FROM accounts a
        LEFT JOIN account_offboardings ao
          ON ao.account_id = a.id
          AND ao.account_id = ${accountId}::uuid
          AND ao.terminal_at IS NULL
        WHERE a.id = ${accountId}::uuid
        ORDER BY ao.created_at DESC NULLS LAST
        LIMIT 1
      `;
      if (!attempt) {
        throw new CheckoutUnavailableError(`Account not found: ${accountId}`);
      }
      if (isCheckoutBlocked(activeOffboardingStateFromProjection(attempt))) {
        throw new CheckoutOffboardingBlockedError();
      }

      if (!checkoutAttemptMatchesRequest(attempt, tier, variant, options.attemptId)) {
        throw new CheckoutAttemptConflictError(
          'Checkout attempt was superseded by a newer plan selection',
        );
      }

      const reusableSession = await reuseOpenCheckoutSession(attempt);
      if (reusableSession) return reusableSession;
      if (attempt.checkout_attempt_state !== 'creating') {
        throw new CheckoutAttemptConflictError(
          `Checkout attempt is not creatable (${attempt.checkout_attempt_state ?? 'missing'})`,
        );
      }

      // The durable `creating` attempt was authorized at selection/freeze time
      // and may already own a provider Session under this idempotency key.
      // Retrying it must not consult a now-drifted live purchasability gate.
      const sessionParams = buildCheckoutSessionParams(
        attempt,
        accountId,
        options.attemptId,
      );
      // Second half of the coupon audit trail (plan step 11). The DECISION and
      // its reason are logged where they are taken, in applyTierSnapshot; this
      // line records what actually reached Stripe for THIS creation, including
      // retries that reuse an older attempt. The reason is deliberately not
      // repeated: it is not in the snapshot, and re-deriving it from a live env
      // read could report a reason the attempt was never given.
      createWorkerLogger(LOG_PREFIX).log('Creating Checkout Session', {
        account_id: accountId,
        attempt_id: options.attemptId,
        coupon_applied: attempt.checkout_attempt_coupon_id !== null,
        payment_method_collection:
          sessionParams.payment_method_collection ?? 'stripe_default',
      });
      const session = await getStripe()
        .checkout.sessions.create(sessionParams, {
          idempotencyKey: checkoutSessionIdempotencyKey(options.attemptId),
        })
        .catch((error: unknown) => {
          throw mapCouponRejection(
            error,
            attempt.checkout_attempt_coupon_id,
            accountId,
            options.attemptId,
          );
        });
      createdSession = session;
      if (session.status !== 'open' || !session.url) {
        throw new CheckoutUnavailableError(
          `Provider returned a non-open Checkout Session (${session.status ?? 'unknown'})`,
        );
      }

      // The account row remains locked from the authoritative attempt and
      // offboarding projection through lease binding, so offboarding cannot
      // freeze a null subscription snapshot beside a newly created Session.
      await bindCheckoutSessionLease(
        tx,
        accountId,
        options.attemptId,
        session.id,
      );
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
