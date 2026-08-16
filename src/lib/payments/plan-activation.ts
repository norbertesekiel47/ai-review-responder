// src/lib/payments/plan-activation.ts
//
// Self-serve plan-activation transaction + trial-eligibility policy for the
// select-plan checkout flow (A+ campaign PR 2c extraction from
// src/app/api/onboarding/select-plan/route.ts). Single owner of:
//   1. applyTierSnapshot — the lock-then-snapshot tier transaction that flips
//      a pending_payment account into the chosen tier (VAL-BILLING-065
//      quota/price snapshot), mirroring the tier-change snapshot in
//      src/lib/accounts/tier-change.ts.
//   2. isTrialEligible + primaryOnboardedBySql — the trial-eligibility policy
//      and the primary-scoped `onboarded_by` read, each with exactly one owner
//      and both consumed by BOTH checkout entry points (select-plan and
//      billing/checkout); resolveCheckoutContext is the funnel's caller of them.
// The route keeps its guard stack (feature flag, CSRF, auth, rate limits,
// body parse, tier validation), maps each result to HTTP, and calls
// createCheckoutSession itself.
//
// Validation contract: VAL-BILLING-065, VAL-SCHEMA-037 (deprecated
// businesses.subscription_tier column, retained for backward compat).

import type { Sql, TransactionSql } from 'postgres';
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
import { errorStringProperty } from '@/lib/payments/stripe-error-inspect';
import { enqueueAnalyticsEvent } from '@/lib/analytics/enqueue';
import { makeAnalyticsEventKey } from '@/lib/analytics/events';
import { createWorkerLogger } from '@/lib/shared/logger';
import { reportCaughtError } from '@/lib/shared/report-caught-error';
import {
  checkoutCouponDecisionLabel,
  type CheckoutAttemptLeaseColumns,
  type CheckoutCouponDecisionReason,
} from './checkout-attempt';
import { selfServeSignupEnabled } from '@/lib/auth/flags';
import { betaCompCouponId, stripeTaxEnabled, trialEnabled } from './flags';

const LOG_PREFIX = '[checkout-attempt]';

type SqlExecutor = Sql | TransactionSql;

// ── onboarded_by, read once; trial eligibility, decided once ─────────────

/**
 * The Account's PRIMARY Business's `onboarded_by`, as a scalar subquery.
 *
 * SINGLE OWNER of this spelling. It was written three times before #H2 — twice
 * primary-scoped (here and in `billing/checkout/route.ts`) and once NOT scoped
 * by `is_primary` at all (`resolveCheckoutContext`), which read the field off
 * whichever Business the caller happened to pass. `onboarded_by` is the ONLY
 * eligibility marker for both the Beta comp coupon and the self-serve trial
 * (CONTEXT.md "Beta comp coupon"), and it lives per-Business while both
 * decisions are per-Account — so "which Business" is the whole question, and it
 * has exactly one right answer: the primary, un-archived one.
 *
 * A SCALAR SUBQUERY on purpose, never a JOIN predicate. At the
 * `applyTierSnapshot` call site the `businesses` LEFT JOIN feeds
 * `COUNT(b.id) AS active_locations`; an `AND b.is_primary = TRUE` there would
 * silently collapse the location count to 1 and mis-price every multi-location
 * attempt (admin-invite-funnel review-log round 3 finding 3).
 *
 * Takes the account id as a VALUE rather than correlating to an outer alias, so
 * the fragment carries its own tenant predicate and every composed statement
 * stays scoped on its face. Callers that hold only a business id resolve the
 * account first — see `resolveCheckoutContext`.
 *
 * THE CALLER SUPPLIES THE PARENTHESES:
 *
 *     (${primaryOnboardedBySql(sql, accountId)}) AS primary_onboarded_by
 *
 * Wrapping them in here instead would make the whole fragment a parenthesized
 * subquery, and `ci:tenant-scope` strips those before reading predicates — the
 * tenant predicate would go invisible to the audit and need a suppression entry
 * saying "it really is scoped, the scanner just cannot see it". Keeping the
 * SELECT top-level keeps the scope provable. A call site that omits the
 * parentheses is a Postgres syntax error, so the failure mode is loud.
 *
 * Do NOT widen this into a "business lookup" helper: it answers one question.
 */
export function primaryOnboardedBySql(sql: SqlExecutor, accountId: string) {
  return sql`
    SELECT pb.onboarded_by
      FROM businesses pb
     WHERE pb.account_id = ${accountId}::uuid
       AND pb.is_primary = TRUE
       AND pb.archived_at IS NULL
     LIMIT 1
  `;
}

/** The Account facts the trial decision is made from. Nothing else feeds it. */
export interface TrialEligibilityFacts {
  /** `accounts.subscription_status` as stored. */
  subscriptionStatus: string;
  /** `onboarded_by` of the PRIMARY Business — read via {@link primaryOnboardedBySql}. */
  primaryOnboardedBy: string | null;
}

/**
 * SINGLE OWNER of "is this Account eligible for the card-up-front trial".
 *
 * The two checkout entry points — `POST /api/onboarding/select-plan` (the
 * funnel) and `POST /api/billing/checkout` (owner-authenticated, and the
 * reactivation target: `account-offboarding/reactivate.ts`) — spelled this
 * independently and DISAGREED: the funnel's copy carried only the first and
 * last term. Both now call this. The stricter reading won, term by term:
 *
 *  - `trialEnabled()` — the trial kill switch. Off everywhere today.
 *  - `selfServeSignupEnabled()` — trials are the self-serve funnel's offer, so
 *    while anonymous signup is CLOSED we do not hand out self-serve trials.
 *    #821 re-scoped this flag to "strangers may mint accounts", and this
 *    remains its one sanctioned clause outside the minting surface
 *    (`docs/superpowers/plans/2026-08-14-admin-invite-funnel-flag-inventory.md`,
 *    `src/lib/auth/flags.ts`). It is NOT a per-account gate and cannot stand in
 *    for one — that job is the last term's, which is why both are here. It also
 *    costs an admin-invited owner nothing: they are already denied by
 *    `primaryOnboardedBy !== null`, whichever way this flag sits.
 *  - `pending_payment` — a trial is the FIRST subscription, never a second one.
 *    Load-bearing, not defence-in-depth: reactivation of a `cancelled` account
 *    posts to `/api/billing/checkout`, and without this term a self-serve
 *    account could take a free trial once per cancellation.
 *  - `primaryOnboardedBy === null` — the per-account self-serve marker. An
 *    admin/partner-onboarded Account must never obtain a $0 trial by direct
 *    POST; it falls back to a normal paid checkout.
 *
 * Reads its two flags itself rather than taking them as arguments: they are
 * server-authoritative (invariant #13) and this function is the policy, not a
 * pure mapping over caller-supplied config.
 */
export function isTrialEligible({
  subscriptionStatus,
  primaryOnboardedBy,
}: TrialEligibilityFacts): boolean {
  return (
    trialEnabled() &&
    selfServeSignupEnabled() &&
    subscriptionStatus === SubscriptionStatus.PENDING_PAYMENT &&
    primaryOnboardedBy === null
  );
}

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
  // Exactly two facts decide the comp, and only two (CONTEXT.md "Beta comp
  // coupon"): the primary Business is admin-invited, AND the env var is set.
  // One binding, because `betaCompCouponId()` already returns `string | null` —
  // the second ternary and `?? null` this replaced were both unreachable, in
  // the four lines that decide whether a founding customer gets charged.
  const couponId = primaryOnboardedBy !== null ? betaCompCouponId() : null;
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
        -- Both the scoping and the reason it may not be a predicate on the
        -- LEFT JOIN below live with the fragment (primaryOnboardedBySql).
        (${primaryOnboardedBySql(tx, accountId)}) AS primary_onboarded_by,
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
    // The DURABLE half of the coupon decision is written here, inside the
    // transaction, so the event cannot survive a rolled-back decision and — the
    // case that matters — a committed decision cannot lose its event to a crash.
    // Only the LOG line rides out on the result, to be emitted after COMMIT.
    const couponDecision = {
      couponId: checkoutCreateShape.couponId,
      reason: checkoutCreateShape.couponReason,
    };
    await emitCouponDecisionEvent(tx, {
      accountId,
      attemptId,
      actorUserId,
      ...couponDecision,
    });
    return {
      kind: 'ok' as const,
      accountId,
      variant,
      attemptId,
      couponDecision,
    };
  });
  if (result.kind !== 'ok') return result;

  await synchronizeBusinessTierMirror(sql, result.accountId);
  if (result.couponDecision) {
    logCouponDecision({
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

interface CouponDecisionRecord {
  accountId: string;
  attemptId: string;
  actorUserId?: string | null;
  couponId: string | null;
  reason: CheckoutCouponDecisionReason;
}

/**
 * Writes the DURABLE coupon decision inside the tier-snapshot transaction,
 * through a savepoint.
 *
 * WHY IN-TRANSACTION. Migration 106's header calls this event "the ONLY
 * durable signal that a beta tester's comp was silently skipped before they
 * are charged". A post-commit emitter loses exactly that signal in exactly the
 * case it exists for: the process dies (or Redis/PG blips) between COMMIT and
 * the insert, and the attempt then carries a coupon answer no event records.
 * Written here, the event commits if and only if the decision does — the
 * property `import-consent.ts:81-90` pins for the same class of event.
 *
 * WHY A SAVEPOINT AND NOT A BARE INSERT. `checkout_coupon_decision` is
 * admitted by the `analytics_events.event_name` CHECK only once migration 106
 * is applied, so a bare in-transaction insert against an un-migrated database
 * would abort the WHOLE tier snapshot — the blast radius migration 102's
 * header describes, and the original reason this ran post-commit. A savepoint
 * closes that: a CHECK violation rolls back to the savepoint only, is swallowed
 * below, and the snapshot commits without its event. So the savepoint form is
 * strictly better than post-commit — it keeps the un-migrated-106 safety AND
 * removes the crash window.
 *
 * Swallows only Postgres-coded failures, per `emitConsentEvent`: anything with
 * no `code` is not a constraint/telemetry fault but a programming error, and
 * rethrowing it is deliberate.
 */
async function emitCouponDecisionEvent(
  tx: TransactionSql,
  input: CouponDecisionRecord,
): Promise<void> {
  const decision = checkoutCouponDecisionLabel(input.reason);
  try {
    await tx.savepoint((sp) =>
      enqueueAnalyticsEvent(sp, {
        eventName: 'checkout_coupon_decision',
        // One decision per attempt by construction — the attempt id is minted
        // in the same transaction that takes the decision, so a replay of this
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
      }),
    );
  } catch (err) {
    if (errorStringProperty(err, 'code') === undefined) throw err;
    reportCaughtError('checkout-attempt', err, {
      reason: 'checkout_coupon_decision_analytics_enqueue_failed',
      accountId: input.accountId,
      attemptId: input.attemptId,
    });
  }
}

/**
 * Logs the beta comp decision AFTER the tier-snapshot transaction commits.
 *
 * Post-commit deliberately: a log line emitted inside the transaction would
 * assert a decision that a later rollback un-makes. The durable half of this
 * observability lives in `emitCouponDecisionEvent`, inside the transaction.
 *
 * The raw coupon id is NOT logged: an admin diagnosing a miss needs the
 * DECISION, and the id is already recoverable from the attempt row. It appears
 * in exactly one place — the invalid-coupon error message in
 * create-checkout-session.ts, where naming it IS the actionable content.
 */
function logCouponDecision(input: CouponDecisionRecord): void {
  createWorkerLogger(LOG_PREFIX).log('Beta comp coupon decision', {
    account_id: input.accountId,
    attempt_id: input.attemptId,
    decision: checkoutCouponDecisionLabel(input.reason),
    reason: input.reason,
    coupon_applied: input.couponId !== null,
  });
}

// ── releaseCouponFaultedAttempt ──────────────────────────────────────────

/**
 * Releases a `creating` Checkout attempt whose frozen coupon snapshot Stripe
 * rejected, so the owner's next click re-snapshots against current config.
 *
 * WITHOUT THIS THE OWNER IS BRICKED PERMANENTLY. `applyTierSnapshot` has
 * already COMMITTED the bad coupon into a `creating` attempt by the time
 * Stripe rejects it, `prepareCheckoutAttempt` REUSES a `creating` attempt for
 * the same selection on every retry, and nothing in the codebase expires or
 * reaps an attempt — there is no `checkout_attempt_expires_at` and no reaper
 * poller. So every retry rebuilds the identical rejected Session params and
 * 502s again, forever, and the rollback plan's stated kill switch ("leave
 * BETA_COMP_COUPON_ID unset — every new attempt then snapshots NULL") cannot
 * reach an owner who already has an attempt: their next attempt is not new.
 * Clearing the lease is what makes that kill switch true.
 *
 * Scoped deliberately narrowly: `state = 'creating'` AND the attempt id the
 * caller just failed on. An `open`/`completed` attempt has a live Stripe
 * Session behind it and must never be cleared from an error path — and the
 * attempt-id predicate means a concurrent request that already replaced the
 * lease is left alone rather than having its attempt yanked.
 *
 * NULLs all nineteen attempt columns in one statement because migration 105's
 * cleared branch of `accounts_checkout_attempt_complete_check` enumerates
 * every one of them: a partial clear does not satisfy either branch and the
 * UPDATE would be rejected. An attempt is complete-or-cleared as a WHOLE.
 *
 * Best-effort by contract: the caller is already returning an error to the
 * owner, so a failure here must not mask it. Never throws.
 */
export async function releaseCouponFaultedAttempt(
  sql: Sql,
  accountId: string,
  attemptId: string,
): Promise<void> {
  try {
    await sql`
      UPDATE accounts
         SET checkout_attempt_state = NULL,
             checkout_attempt_id = NULL,
             checkout_session_id = NULL,
             checkout_attempt_tier = NULL,
             checkout_attempt_price_variant = NULL,
             checkout_attempt_base_price_id = NULL,
             checkout_attempt_overage_price_id = NULL,
             checkout_attempt_base_price_cents = NULL,
             checkout_attempt_overage_price_cents = NULL,
             checkout_attempt_locations_included = NULL,
             checkout_attempt_locations_paid = NULL,
             checkout_attempt_overage_quantity = NULL,
             checkout_attempt_trial_period_days = NULL,
             checkout_attempt_tax_enabled = NULL,
             checkout_attempt_customer_email = NULL,
             checkout_attempt_success_url = NULL,
             checkout_attempt_cancel_url = NULL,
             checkout_attempt_updated_at = NULL,
             checkout_attempt_coupon_id = NULL,
             updated_at = NOW()
       WHERE id = ${accountId}::uuid
         AND checkout_attempt_id = ${attemptId}::uuid
         AND checkout_attempt_state = 'creating'
    `;
  } catch (err) {
    reportCaughtError('plan-activation', err, {
      reason: 'coupon_faulted_attempt_release_failed',
      accountId,
      attemptId,
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
 * Trial eligibility is NOT decided here — {@link isTrialEligible} owns it, and
 * this function's job is to hand it the two Account facts it needs. Until #H2
 * it spelled a second, laxer predicate of its own and read `onboarded_by`
 * straight off the Business it was handed, un-scoped by `is_primary`: correct
 * only because `select-plan` happens to pass the primary and a `pending_payment`
 * Account cannot yet hold a second location (`canAddLocationForAccount` →
 * `subscriptionGrantsFullAccess`). That is a precondition enforced two modules
 * away; a second call site, or pre-payment locations, breaks it silently and in
 * the direction that GRANTS a trial.
 *
 * TWO statements, deliberately. The account id is not known until the first
 * returns, and {@link primaryOnboardedBySql} takes it as a bound value so every
 * composed statement carries its own tenant predicate rather than correlating
 * to an outer alias. The alternative — one query correlating the subquery to
 * `businesses.account_id` — would be a fourth spelling of the thing this change
 * exists to give one owner. Both are indexed single-row lookups on a one-click
 * path, and they run sequentially (never a fan-out: one admission slot at a
 * time, per the #773 chokepoint).
 *
 * @param sql  Postgres.js client (composition root supplies the singleton —
 *   this module never imports @/lib/db/server).
 */
export async function resolveCheckoutContext(
  sql: Sql,
  businessId: string,
): Promise<CheckoutContext | null> {
  const [businessRow] = await sql<{ account_id: string }[]>`
    SELECT account_id FROM businesses WHERE id = ${businessId}::uuid
  `;
  if (!businessRow) {
    return null;
  }
  const accountId = businessRow.account_id;

  const [accountRow] = await sql<{
    subscription_status: string;
    primary_onboarded_by: string | null;
  }[]>`
    SELECT a.subscription_status,
           (${primaryOnboardedBySql(sql, accountId)}) AS primary_onboarded_by
      FROM accounts a
     WHERE a.id = ${accountId}::uuid
  `;
  if (!accountRow) {
    return null;
  }

  return {
    accountId,
    trialEligible: isTrialEligible({
      subscriptionStatus: accountRow.subscription_status,
      primaryOnboardedBy: accountRow.primary_onboarded_by,
    }),
  };
}
