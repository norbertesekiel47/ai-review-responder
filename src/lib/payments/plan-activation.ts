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
// body parse, tier validation), maps each result to HTTP, and calls
// createCheckoutSession itself.
//
// Validation contract: VAL-BILLING-065, VAL-SCHEMA-037 (deprecated
// businesses.subscription_tier column, retained for backward compat).

import type { Sql } from 'postgres';
import { randomUUID } from 'node:crypto';
import { SubscriptionStatus } from '@/lib/shared/subscription-status';
import {
  isPriceVariant,
  resolveTierSnapshot,
  type PriceVariant,
  type SubscriptionTierValue,
} from '@/lib/accounts/tier-config';
import { acquireTierBillingActivationLocks } from '@/lib/accounts/billing-locks';
import { computeOverageQuantity } from '@/lib/accounts/quota';
import {
  activeOffboardingStateFromProjection,
  isCheckoutBlocked,
  lockAccountBeforeOffboardingProjection,
  type ActiveOffboardingProjection,
} from '@/lib/account-offboarding/gate';
import {
  synchronizeBusinessTierMirror,
  writeTierSnapshot,
} from '@/lib/accounts/tier-snapshot';
import { assertTierPurchasable } from '@/lib/payments/tier-purchasability';
import { priceIdFor } from '@/lib/payments/price-tier-map';
import { getStripe } from '@/lib/payments/stripe-client';
import { enqueueAnalyticsEvent } from '@/lib/analytics/enqueue';
import { makeAnalyticsEventKey } from '@/lib/analytics/events';
import { createWorkerLogger } from '@/lib/shared/logger';
import { reportCaughtError } from '@/lib/shared/report-caught-error';
import {
  checkoutCouponDecisionLabel,
  type CheckoutAttemptLeaseColumns,
  type CheckoutCouponDecisionReason,
} from './checkout-attempt';
import { betaCompCouponId, stripeTaxEnabled, trialEnabled } from './flags';

const LOG_PREFIX = '[checkout-attempt]';

// ── applyTierSnapshot ────────────────────────────────────────────────────

export type TierSnapshotResult =
  | {
      kind: 'ok';
      accountId: string;
      variant: PriceVariant;
      attemptId: string;
    }
  | { kind: 'not_found' }
  | { kind: 'offboarding_blocked' }
  | { kind: 'wrong_status'; status: string };

export class CheckoutAttemptConflictError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CheckoutAttemptConflictError';
  }
}

interface SelectionAccountRow
  extends CheckoutAttemptLeaseColumns, ActiveOffboardingProjection {
  subscription_status: string;
  price_variant: string;
  active_locations: number;
  /**
   * `onboarded_by` of the Account's PRIMARY Business — the beta comp's
   * eligibility marker (non-null = admin/partner invitee). Read as a scalar
   * subquery, never through the `active_locations` join: see the SELECT.
   */
  primary_onboarded_by: string | null;
}

function isSameAttemptSelection(
  row: SelectionAccountRow,
  tier: SubscriptionTierValue,
  variant: PriceVariant,
): boolean {
  return (
    row.checkout_attempt_tier === tier &&
    row.checkout_attempt_price_variant === variant
  );
}

function resolveNewAttemptPricing(
  tier: SubscriptionTierValue,
  variant: PriceVariant,
) {
  const snapshot = resolveTierSnapshot(tier, variant);
  const basePriceId = priceIdFor(tier, variant, 'base');
  const overagePriceId = priceIdFor(tier, variant, 'overage');
  if (!basePriceId || !overagePriceId) {
    throw new Error(`Checkout Price configuration missing for ${tier}/${variant}`);
  }
  return { snapshot, basePriceId, overagePriceId };
}

async function resolvePriorOpenSession(
  sessionId: string,
  reuseWhenOpen: boolean,
): Promise<'reuse' | 'replace'> {
  const stripe = getStripe();
  const prior = await stripe.checkout.sessions.retrieve(sessionId);
  if (prior.status === 'complete') {
    throw new CheckoutAttemptConflictError(
      'The previous Checkout Session completed and is awaiting projection',
    );
  }
  if (prior.status === 'expired') return 'replace';
  if (prior.status !== 'open') {
    throw new CheckoutAttemptConflictError(
      `The previous Checkout Session is not replaceable (${prior.status ?? 'unknown'})`,
    );
  }
  if (reuseWhenOpen) return 'reuse';

  try {
    const expired = await stripe.checkout.sessions.expire(
      sessionId,
      {},
      { idempotencyKey: `checkout-attempt-expire:v1:${sessionId}` },
    );
    if (expired.status === 'expired') return 'replace';
  } catch (error) {
    // Completion can win the provider race after the first retrieve but before
    // expire. Resolve provider-current state before deciding whether a new
    // attempt is safe; never create a replacement beside a completed Session.
    const current = await stripe.checkout.sessions.retrieve(sessionId);
    if (current.status === 'complete') {
      throw new CheckoutAttemptConflictError(
        'The previous Checkout Session completed while replacement was requested',
      );
    }
    if (current.status === 'expired') return 'replace';
    throw error;
  }

  const current = await stripe.checkout.sessions.retrieve(sessionId);
  if (current.status === 'complete') {
    throw new CheckoutAttemptConflictError(
      'The previous Checkout Session completed while replacement was requested',
    );
  }
  if (current.status === 'expired') return 'replace';
  throw new CheckoutAttemptConflictError(
    `The previous Checkout Session could not be expired (${current.status ?? 'unknown'})`,
  );
}

export interface ApplyTierSnapshotParams {
  accountId: string;
  /** Preserves the caller's established `:activation` lock identity. */
  activationLockId: string;
  tier: SubscriptionTierValue;
  ownerEmail: string;
  trial: boolean;
  actorUserId?: string | null;
}

interface CheckoutCreateShape {
  customerEmail: string;
  successUrl: string;
  cancelUrl: string;
  trialPeriodDays: 30 | null;
  taxEnabled: boolean;
  /**
   * The beta comp Stripe Coupon ID, or `null` for an explicit NO-COUPON
   * decision. Persisted either way (migration 105).
   */
  couponId: string | null;
  /**
   * Why `couponId` came out the way it did. Log/telemetry only — deliberately
   * NOT persisted, because the attempt snapshot exists to reproduce Stripe
   * PARAMETERS byte-for-byte and the reason is not one.
   */
  couponReason: CheckoutCouponDecisionReason;
}

/**
 * Resolves every caller/environment-dependent Stripe Session parameter once,
 * before the durable attempt is written. Retries always use this stored shape
 * rather than re-reading flags, email, or deployment URL under the same Stripe
 * idempotency key.
 *
 * The beta comp coupon is resolved HERE, not at session-creation time, for
 * exactly that reason: `BETA_COMP_COUPON_ID` could be flipped between an
 * attempt's creation and a retry, and a live read would then produce different
 * Stripe params under the SAME per-attempt idempotency key (plan step 2 /
 * review-log round 1 finding 4). Eligibility comes from the caller-supplied
 * `primaryOnboardedBy` — the Account's PRIMARY Business — never from an
 * arbitrary location on a multi-location Account (round 3 finding 3).
 */
function resolveCheckoutCreateShape(
  ownerEmail: string,
  trial: boolean,
  primaryOnboardedBy: string | null,
): CheckoutCreateShape {
  const customerEmail = ownerEmail.trim();
  if (!customerEmail) {
    throw new Error('Checkout owner email is required');
  }
  const baseUrl = process.env.NEXT_PUBLIC_APP_URL ?? 'http://localhost:3000';
  const configuredCoupon = primaryOnboardedBy !== null ? betaCompCouponId() : null;
  const couponId = primaryOnboardedBy !== null ? (configuredCoupon ?? null) : null;
  const couponReason: CheckoutCouponDecisionReason =
    primaryOnboardedBy === null
      ? 'not_invited'
      : couponId === null
        ? 'env_unset'
        : 'applied';
  return {
    customerEmail,
    successUrl: `${baseUrl}/onboarding/payment-success?session_id={CHECKOUT_SESSION_ID}`,
    cancelUrl: `${baseUrl}/onboarding/pay?cancelled=true`,
    trialPeriodDays: trial ? 30 : null,
    taxEnabled: stripeTaxEnabled(),
    couponId,
    couponReason,
  };
}

type AttemptPreparation =
  | { kind: 'reuse'; result: Extract<TierSnapshotResult, { kind: 'ok' }> }
  | {
      kind: 'create';
      checkoutCreateShape: CheckoutCreateShape;
      newAttemptPricing: ReturnType<typeof resolveNewAttemptPricing>;
    };

async function prepareCheckoutAttempt(
  row: SelectionAccountRow,
  input: {
    accountId: string;
    tier: SubscriptionTierValue;
    variant: PriceVariant;
    ownerEmail: string;
    trial: boolean;
  },
): Promise<AttemptPreparation> {
  if (
    row.checkout_attempt_id &&
    row.checkout_attempt_state === 'creating' &&
    isSameAttemptSelection(row, input.tier, input.variant)
  ) {
    return {
      kind: 'reuse',
      result: {
        kind: 'ok',
        accountId: input.accountId,
        variant: input.variant,
        attemptId: row.checkout_attempt_id,
      },
    };
  }

  if (row.checkout_attempt_state === 'creating') {
    throw new CheckoutAttemptConflictError(
      'The previous Checkout attempt is still being created; retry that selection',
    );
  }

  let checkoutCreateShape: CheckoutCreateShape | null = null;
  let newAttemptPricing: ReturnType<typeof resolveNewAttemptPricing> | null = null;
  if (row.checkout_attempt_state === 'open' && row.checkout_session_id) {
    const sameSelection = isSameAttemptSelection(row, input.tier, input.variant);
    if (!sameSelection) {
      assertTierPurchasable(input.tier);
      checkoutCreateShape = resolveCheckoutCreateShape(
        input.ownerEmail,
        input.trial,
        row.primary_onboarded_by,
      );
      newAttemptPricing = resolveNewAttemptPricing(input.tier, input.variant);
    }
    const priorResolution = await resolvePriorOpenSession(
      row.checkout_session_id,
      sameSelection,
    );
    if (priorResolution === 'reuse') {
      return {
        kind: 'reuse',
        result: {
          kind: 'ok',
          accountId: input.accountId,
          variant: input.variant,
          attemptId: row.checkout_attempt_id!,
        },
      };
    }
  } else if (row.checkout_attempt_state === 'open') {
    throw new CheckoutAttemptConflictError(
      'The previous Checkout attempt has no provider Session identity',
    );
  } else if (row.checkout_attempt_state === 'completed') {
    throw new CheckoutAttemptConflictError(
      'The previous Checkout Session completed and is awaiting projection',
    );
  }

  assertTierPurchasable(input.tier);
  return {
    kind: 'create',
    checkoutCreateShape:
      checkoutCreateShape ??
      resolveCheckoutCreateShape(
        input.ownerEmail,
        input.trial,
        row.primary_onboarded_by,
      ),
    newAttemptPricing:
      newAttemptPricing ?? resolveNewAttemptPricing(input.tier, input.variant),
  };
}

/**
 * Locks the account, verifies `pending_payment`, and snapshots the tier's
 * quota/price columns onto `accounts` (VAL-BILLING-065) — the atomic write
 * that commits a self-serve signup's chosen tier before Stripe Checkout is
 * ever created.
 *
 * Existing-account tier writers acquire the account-scoped entitlement,
 * billing, and activation advisory locks in that order before taking the
 * account row lock. After the canonical transaction commits, the deprecated
 * business billing mirror is converged in the publisher-compatible
 * business -> entitlement lock order.
 *
 * @param sql  Postgres.js client (composition root supplies the singleton —
 *   this module never imports @/lib/db/server).
 */
export async function applyTierSnapshot(
  sql: Sql,
  {
    accountId,
    activationLockId,
    tier,
    ownerEmail,
    trial,
    actorUserId,
  }: ApplyTierSnapshotParams,
): Promise<TierSnapshotResult> {
  const result = await sql.begin(async (tx) => {
    await acquireTierBillingActivationLocks(tx, accountId, activationLockId);

    // This must be its own SQL command. If an offboarding confirmer currently
    // owns the row, the later projection receives a fresh READ COMMITTED
    // snapshot after that confirmer inserts its active lifecycle row.
    const accountLocked = await lockAccountBeforeOffboardingProjection(
      tx,
      accountId,
    );
    if (!accountLocked) return { kind: 'not_found' as const };

    const [row] = await tx<SelectionAccountRow[]>`
      SELECT
        a.subscription_status,
        a.price_variant,
        COUNT(b.id)::integer AS active_locations,
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
        -- Beta comp eligibility, scoped to the Account's PRIMARY Business.
        -- Deliberately a SCALAR SUBQUERY and not an extra predicate on the
        -- LEFT JOIN below: that join feeds COUNT(b.id) AS active_locations, so
        -- an AND b.is_primary = TRUE there would silently collapse the location
        -- count to 1 and mis-price every multi-location attempt. An unscoped
        -- read of onboarded_by would be just as wrong the other way -- the
        -- coupon decision would depend on an arbitrary location
        -- (admin-invite-funnel review-log round 3 finding 3).
        (SELECT pb.onboarded_by
           FROM businesses pb
          WHERE pb.account_id = a.id
            AND pb.is_primary = TRUE
            AND pb.archived_at IS NULL
          LIMIT 1) AS primary_onboarded_by,
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
      LEFT JOIN businesses b
        ON b.account_id = a.id
        AND b.account_id = ${accountId}::uuid
        AND b.archived_at IS NULL
      LEFT JOIN account_offboardings ao
        ON ao.account_id = a.id
        AND ao.account_id = ${accountId}::uuid
        AND ao.terminal_at IS NULL
      WHERE a.id = ${accountId}::uuid
      GROUP BY a.id, ao.id
      ORDER BY ao.created_at DESC NULLS LAST
      LIMIT 1
    `;
    if (!row) {
      // The row vanished between the caller's lookup and now (e.g., cleanup
      // poller deleted it). Surface as account_incomplete.
      return { kind: 'not_found' as const };
    }
    if (isCheckoutBlocked(activeOffboardingStateFromProjection(row))) {
      return { kind: 'offboarding_blocked' as const };
    }
    if (row.subscription_status !== SubscriptionStatus.PENDING_PAYMENT) {
      return {
        kind: 'wrong_status' as const,
        status: row.subscription_status,
      };
    }
    if (!isPriceVariant(row.price_variant)) {
      throw new Error(`Account ${accountId} has invalid price_variant`);
    }

    const variant = row.price_variant;

    // A replacement may not coexist with an older open provider Session. The
    // provider status is resolved while all three advisory locks and the
    // account row lock are held. A completed Session is left for its webhook;
    // creating another subscription would double-bill the owner.
    const preparation = await prepareCheckoutAttempt(row, {
      accountId,
      tier,
      variant,
      ownerEmail,
      trial,
    });
    // A reused attempt took its coupon decision when it was created; there is
    // nothing new to report, and re-emitting would double-count the funnel.
    if (preparation.kind === 'reuse') {
      return { ...preparation.result, couponDecision: null };
    }
    const { checkoutCreateShape, newAttemptPricing } = preparation;
    const { snapshot, basePriceId, overagePriceId } = newAttemptPricing;

    const [locked] = await tx<{
      subscription_status: string;
      price_variant: string;
    }[]>`
      SELECT subscription_status, price_variant
      FROM accounts
      WHERE id = ${accountId}::uuid
      FOR UPDATE
    `;
    if (!locked) return { kind: 'not_found' as const };
    if (locked.subscription_status !== SubscriptionStatus.PENDING_PAYMENT) {
      return {
        kind: 'wrong_status' as const,
        status: locked.subscription_status,
      };
    }
    if (locked.price_variant !== variant) {
      throw new Error(`Account ${accountId} price_variant changed during selection`);
    }

    const attemptId = randomUUID();
    const provisionalOverageQuantity = computeOverageQuantity(
      Number(row.active_locations),
      snapshot.included,
    );

    await writeTierSnapshot(tx, {
      accountId,
      tier,
      variant,
      locationsPaid: 0,
      audit: {
        eventType: 'tier_selected',
        actorUserId,
        payload: { source: 'checkout' },
      },
    });
    await tx`
      UPDATE accounts
      SET checkout_attempt_id = ${attemptId}::uuid,
          checkout_session_id = NULL,
          checkout_attempt_state = 'creating',
          checkout_attempt_tier = ${tier},
          checkout_attempt_price_variant = ${variant},
          checkout_attempt_base_price_id = ${basePriceId},
          checkout_attempt_overage_price_id = ${overagePriceId},
          checkout_attempt_base_price_cents = ${snapshot.baseCents},
          checkout_attempt_overage_price_cents = ${snapshot.overageCents},
          checkout_attempt_locations_included = ${snapshot.included},
          checkout_attempt_locations_paid = 0,
          checkout_attempt_overage_quantity = ${provisionalOverageQuantity},
          checkout_attempt_trial_period_days = ${checkoutCreateShape.trialPeriodDays},
          checkout_attempt_tax_enabled = ${checkoutCreateShape.taxEnabled},
          checkout_attempt_customer_email = ${checkoutCreateShape.customerEmail},
          checkout_attempt_success_url = ${checkoutCreateShape.successUrl},
          checkout_attempt_cancel_url = ${checkoutCreateShape.cancelUrl},
          -- NULL here is an explicit NO-COUPON DECISION, not an absence: it is
          -- the recorded answer for every self-serve owner and for an invitee
          -- whose comp is switched off, and migration 105's active branch
          -- leaves it unconstrained precisely so a full-price attempt is still
          -- a COMPLETE attempt. Written in the same statement as the rest of
          -- the snapshot so no attempt can exist without its coupon answer.
          checkout_attempt_coupon_id = ${checkoutCreateShape.couponId},
          checkout_attempt_updated_at = NOW(),
          updated_at = NOW()
      WHERE id = ${accountId}::uuid
    `;
    // The coupon decision rides OUT of the transaction on the result so it can
    // be reported after COMMIT — see recordCouponDecision.
    return {
      kind: 'ok' as const,
      accountId,
      variant,
      attemptId,
      couponDecision: {
        couponId: checkoutCreateShape.couponId,
        reason: checkoutCreateShape.couponReason,
      },
    };
  });
  if (result.kind !== 'ok') return result;

  await synchronizeBusinessTierMirror(sql, result.accountId);
  if (result.couponDecision) {
    await recordCouponDecision(sql, {
      accountId: result.accountId,
      attemptId: result.attemptId,
      actorUserId,
      ...result.couponDecision,
    });
  }
  return {
    kind: 'ok',
    accountId: result.accountId,
    variant: result.variant,
    attemptId: result.attemptId,
  };
}

/**
 * Best-effort observability for the beta comp decision, run AFTER the
 * tier-snapshot transaction commits.
 *
 * Post-commit and log-and-swallow, both deliberately:
 *   - Post-commit because `checkout_coupon_decision` is admitted by the
 *     `analytics_events.event_name` CHECK only once migration 106 is applied;
 *     emitting inside `sql.begin` would let an unapplied 106 abort the whole
 *     tier snapshot (the blast radius migration 102's header describes).
 *   - Log-and-swallow because a telemetry failure caught by the caller would
 *     turn an already-committed attempt into a failed plan selection
 *     (CLAUDE.md: never let observability poison the success path).
 *
 * The raw coupon id is NOT logged: an admin diagnosing a miss needs the
 * DECISION, and the id is already recoverable from the attempt row. It appears
 * in exactly one place — the invalid-coupon error message in
 * create-checkout-session.ts, where naming it IS the actionable content.
 */
async function recordCouponDecision(
  sql: Sql,
  input: {
    accountId: string;
    attemptId: string;
    actorUserId?: string | null;
    couponId: string | null;
    reason: CheckoutCouponDecisionReason;
  },
): Promise<void> {
  const decision = checkoutCouponDecisionLabel(input.reason);
  createWorkerLogger(LOG_PREFIX).log('Beta comp coupon decision', {
    account_id: input.accountId,
    attempt_id: input.attemptId,
    decision,
    reason: input.reason,
    coupon_applied: input.couponId !== null,
  });
  try {
    await enqueueAnalyticsEvent(sql, {
      eventName: 'checkout_coupon_decision',
      // One decision per attempt by construction — the attempt id is minted in
      // the same transaction that takes the decision, so a replay of this
      // emission drops on ON CONFLICT (event_key) DO NOTHING.
      eventKey: makeAnalyticsEventKey('checkout_coupon_decision', [
        input.attemptId,
      ]),
      distinctId: input.accountId,
      accountId: input.accountId,
      userId: input.actorUserId ?? null,
      properties: {
        decision,
        reason: input.reason,
        coupon_applied: input.couponId !== null,
      },
    });
  } catch (err) {
    reportCaughtError('checkout-attempt', err, {
      reason: 'checkout_coupon_decision_analytics_enqueue_failed',
      accountId: input.accountId,
      attemptId: input.attemptId,
    });
  }
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
