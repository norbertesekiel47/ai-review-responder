// worker/ingress/stripe/apply-subscription-state.ts
//
// The SINGLE applier of accounts.subscription_status for the trial lifecycle.
// Stripe is the source of truth; this projects a retrieved Stripe subscription
// onto the DB via a concrete, monotonic transition table (`cancelled` is
// terminal). Every webhook handler that changes status routes through here, and
// the billing reconcile poller calls it to CORRECT stuck `trialing` rows.
//
// Invariants enforced here:
//   - inv #2 (transactional outbox): the status write, the audit row, the
//     overage-recompute enqueue, and the trial analytics fact ALL run inside the
//     caller-supplied `tx`. The caller wraps this in sql.begin().
//   - `trial_ends_at IS NOT NULL ⟺ status='trialing'`: set on entering trialing
//     (= Stripe trial_end), cleared on every exit.
//   - `subscription_activated_at` is the service-start anchor: set via COALESCE
//     on entering trialing OR active (first writer wins), never overwritten.
//   - Stale / out-of-order events are no-ops (changed:false).

import type postgres from 'postgres';
import type Stripe from 'stripe';
import { extractCustomerId } from './shared';
import { writeAccountAuditLog } from '../../../src/lib/audit/log';
import {
  enqueueStripeOverageRecompute,
  enqueueStripeSubscriptionMirrorSync,
} from '../../../src/lib/shared/job-outbox-helpers';
import {
  enqueueTrialStarted,
  enqueueTrialConverted,
  enqueueTrialPaymentFailed,
  enqueueTrialCancelled,
} from '../../../src/lib/analytics/trial-events';
import { SubscriptionStatus, type SubscriptionStatusValue } from '../../../src/lib/shared/subscription-status';
import { acquireTierEntitlementLock } from '../../../src/lib/accounts/billing-locks';

// The applier is ALWAYS invoked inside sql.begin() (transactional-outbox
// invariant), so the transaction handle is a postgres.TransactionSql. This also
// matches enqueueStripeOverageRecompute's strict TxClient parameter.
type TxSql = postgres.TransactionSql;
type StripeSubscriptionState = Pick<
  Stripe.Subscription,
  'id' | 'status' | 'trial_end'
> & { customer?: unknown };

/**
 * How the applier resolves the target account. Two resolution strategies — the
 * caller picks whichever it can satisfy from what it already holds:
 *   - 'checkout'     → resolve by accounts.id. The name is historical (the
 *                      checkout handler was the first caller). Needs no Stripe
 *                      ids to resolve.
 *   - 'subscription' → resolve by (stripe_customer_id, stripe_subscription_id);
 *                      acts only on the account's CURRENT subscription.
 */
export type ApplyStripeRef =
  | { mode: 'checkout'; accountId: string }
  | { mode: 'subscription'; stripeCustomerId: string; stripeSubscriptionId: string };

export interface TransitionResult {
  accountResolved: boolean;
  fromStatus: string | null;
  toStatus: string | null;
  changed: boolean;
  /** True when this transition entered an entitled state (trialing or active). */
  activated: boolean;
  primaryBusinessId: string | null;
}

/**
 * Map a raw Stripe subscription status to the RepWorth DB target status.
 * `trialing`→trialing, `active`→active, cancel→cancelled, everything else that
 * represents a billing problem (past_due/unpaid/incomplete*) →past_due. Stripe
 * statuses we don't act on map to null (no-op).
 */
function mapStripeStatus(stripeStatus: Stripe.Subscription.Status | string): SubscriptionStatusValue | null {
  switch (stripeStatus) {
    case 'trialing':
      return SubscriptionStatus.TRIALING;
    case 'active':
      return SubscriptionStatus.ACTIVE;
    case 'canceled':
      return SubscriptionStatus.CANCELLED;
    // NOTE-B: incomplete_expired maps to PAST_DUE (not CANCELLED) on purpose —
    // it preserves the 7-day grace/dunning window rather than hard-cancelling.
    case 'past_due':
    case 'unpaid':
    case 'incomplete':
    case 'incomplete_expired':
      return SubscriptionStatus.PAST_DUE;
    default:
      return null;
  }
}

/**
 * Allowed source statuses per target, as a monotonic transition table.
 * `cancelled` is reachable from any non-terminal status; every other target is
 * reachable only from the listed sources. `cancelled` itself is terminal and is
 * the (deliberately absent) common source filtered out by the guard below.
 */
const ALLOWED_TRANSITION_SOURCES: Readonly<
  Record<SubscriptionStatusValue, readonly SubscriptionStatusValue[]>
> = {
  [SubscriptionStatus.TRIALING]: [SubscriptionStatus.PENDING_PAYMENT],
  [SubscriptionStatus.ACTIVE]: [
    SubscriptionStatus.PENDING_PAYMENT,
    SubscriptionStatus.TRIALING,
    SubscriptionStatus.PAST_DUE,
  ],
  [SubscriptionStatus.PAST_DUE]: [SubscriptionStatus.ACTIVE, SubscriptionStatus.TRIALING],
  [SubscriptionStatus.CANCELLED]: [
    SubscriptionStatus.PENDING_PAYMENT,
    SubscriptionStatus.ACTIVE,
    SubscriptionStatus.TRIALING,
    SubscriptionStatus.PAST_DUE,
  ],
  [SubscriptionStatus.PENDING_PAYMENT]: [],
};

/**
 * Is the transition from `current` → `target` allowed by the monotonic table?
 * `cancelled` is terminal (nothing leaves it). Same target as current = no-op.
 */
function isAllowedTransition(current: string, target: SubscriptionStatusValue): boolean {
  if (current === target) return false;
  if (current === SubscriptionStatus.CANCELLED) return false;
  return ALLOWED_TRANSITION_SOURCES[target].includes(current as SubscriptionStatusValue);
}

interface ResolvedAccount {
  id: string;
  subscription_status: string;
  primary_business_id: string | null;
  stripe_customer_id: string | null;
  stripe_subscription_id: string | null;
}

async function resolveAccountId(tx: TxSql, ref: ApplyStripeRef): Promise<string | null> {
  if (ref.mode === 'checkout') {
    const [row] = await tx<{ id: string }[]>`
      SELECT id
      FROM accounts
      WHERE id = ${ref.accountId}::uuid
    `;
    return row?.id ?? null;
  }
  const [row] = await tx<{ id: string }[]>`
    SELECT id
    FROM accounts
    WHERE stripe_customer_id = ${ref.stripeCustomerId}
      AND stripe_subscription_id = ${ref.stripeSubscriptionId}
  `;
  return row?.id ?? null;
}

async function resolveLockedAccount(
  tx: TxSql,
  accountId: string,
  ref: ApplyStripeRef,
): Promise<ResolvedAccount | null> {
  const rows = await tx<ResolvedAccount[]>`
    SELECT a.id, a.subscription_status,
      a.stripe_customer_id, a.stripe_subscription_id,
      (SELECT b.id FROM businesses b
        WHERE b.account_id = a.id AND b.is_primary = TRUE AND b.archived_at IS NULL
        LIMIT 1) AS primary_business_id
    FROM accounts a
    WHERE a.id = ${accountId}::uuid
    FOR UPDATE
  `;
  const account = rows[0] ?? null;
  if (
    account
    && (
      (ref.mode === 'checkout' && ref.accountId !== accountId)
      || (
        ref.mode === 'subscription'
        && (
          account.stripe_customer_id !== ref.stripeCustomerId
          || account.stripe_subscription_id !== ref.stripeSubscriptionId
        )
      )
    )
  ) {
    return null;
  }
  return account;
}

const NO_CHANGE = (
  account: ResolvedAccount | null,
): TransitionResult => ({
  accountResolved: account !== null,
  fromStatus: account?.subscription_status ?? null,
  toStatus: account?.subscription_status ?? null,
  changed: false,
  activated: false,
  primaryBusinessId: account?.primary_business_id ?? null,
});

/**
 * Apply a retrieved Stripe subscription's status onto the account row, in the
 * caller's transaction. Returns a result the caller uses to drive post-commit,
 * best-effort backfill resume.
 */
export async function applyStripeSubscriptionState(
  tx: TxSql,
  ref: ApplyStripeRef,
  stripeSub: StripeSubscriptionState,
): Promise<TransitionResult> {
  // Resolve without a row lock, then serialize status/tier/publisher state
  // before re-reading and locking the account. Never wait for entitlement
  // while holding the account row.
  const accountId = await resolveAccountId(tx, ref);
  if (!accountId) return NO_CHANGE(null);
  await acquireTierEntitlementLock(tx, accountId);
  return applyStripeSubscriptionStateInternal(tx, accountId, ref, stripeSub);
}

/**
 * Status projection for callers that already hold the entitlement advisory
 * lock for `lockedAccountId`. The explicit account id is the linearization
 * anchor: never re-resolve the Stripe lineage after taking another account's
 * lock. The locked row rechecks that the customer/subscription lineage still
 * belongs to that same account before any mutation. Those callers must project
 * the deprecated business mirror only after the canonical transaction commits,
 * in business -> entitlement order.
 */
export async function applyStripeSubscriptionStateUnderEntitlementLock(
  tx: TxSql,
  lockedAccountId: string,
  ref: ApplyStripeRef,
  stripeSub: StripeSubscriptionState,
): Promise<TransitionResult> {
  return applyStripeSubscriptionStateInternal(tx, lockedAccountId, ref, stripeSub);
}

interface StatusTransitionPlan {
  current: string;
  target: SubscriptionStatusValue;
}

function resolveStatusTransition(
  account: ResolvedAccount,
  stripeStatus: Stripe.Subscription.Status | string,
): StatusTransitionPlan | null {
  const target = mapStripeStatus(stripeStatus);
  if (!target || !isAllowedTransition(account.subscription_status, target)) return null;
  return { current: account.subscription_status, target };
}

function stripeTrialEndIso(trialEnd: number | null | undefined): string | null {
  if (typeof trialEnd !== 'number' || trialEnd <= 0) return null;
  return new Date(trialEnd * 1000).toISOString();
}

function grantsEntitledAccess(status: SubscriptionStatusValue): boolean {
  return status === SubscriptionStatus.TRIALING || status === SubscriptionStatus.ACTIVE;
}

async function persistStatusTransition(
  tx: TxSql,
  input: {
    account: ResolvedAccount;
    transition: StatusTransitionPlan;
    stripeSub: StripeSubscriptionState;
    ref: ApplyStripeRef;
  },
): Promise<void> {
  const stripeSubscriptionId = input.stripeSub.id;
  const stripeCustomerId = extractStripeCustomerId(input.stripeSub.customer, input.ref);
  await writeStatusColumns(
    tx,
    input.account.id,
    input.transition.target,
    stripeTrialEndIso(input.stripeSub.trial_end),
    stripeCustomerId,
    stripeSubscriptionId,
  );
  await writeAccountAuditLog(tx, {
    accountId: input.account.id,
    eventType: 'subscription_status_changed',
    entityType: 'account',
    entityId: input.account.id,
    payload: {
      fromStatus: input.transition.current,
      toStatus: input.transition.target,
    },
  });
  if (grantsEntitledAccess(input.transition.target)) {
    await enqueueStripeOverageRecompute(tx, input.account.id);
  }
  await enqueueLifecycleAnalytics(
    tx,
    input.account.id,
    input.transition.current,
    input.transition.target,
    stripeSubscriptionId,
  );
  await enqueueStripeSubscriptionMirrorSync(tx, input.account.id);
}

async function applyStripeSubscriptionStateInternal(
  tx: TxSql,
  accountId: string,
  ref: ApplyStripeRef,
  stripeSub: StripeSubscriptionState,
): Promise<TransitionResult> {
  const account = await resolveLockedAccount(tx, accountId, ref);
  if (!account) return NO_CHANGE(null);

  const transition = resolveStatusTransition(account, stripeSub.status);
  if (!transition) return NO_CHANGE(account);
  await persistStatusTransition(tx, {
    account,
    transition,
    stripeSub,
    ref,
  });

  return {
    accountResolved: true,
    fromStatus: transition.current,
    toStatus: transition.target,
    changed: true,
    activated: grantsEntitledAccess(transition.target),
    primaryBusinessId: account.primary_business_id,
  };
}

/**
 * Resolve the Stripe customer id to persist alongside the status write.
 *
 * In `checkout` mode the account was found by `client_reference_id`, so the
 * customer/subscription identifiers it needs for every LATER webhook
 * (subscription.updated/.deleted, invoice.payment_failed) and for the Billing
 * Portal must be copied off the retrieved subscription here — they are NOT yet
 * on the account row. In `subscription` mode the account was resolved BY those
 * identifiers, so the ref already carries the authoritative customer id; prefer
 * it and fall back to the subscription object.
 */
function extractStripeCustomerId(
  subscriptionCustomer: unknown,
  ref: ApplyStripeRef,
): string | null {
  if (ref.mode === 'subscription') return ref.stripeCustomerId;
  return extractCustomerId(
    subscriptionCustomer as Stripe.Subscription['customer'] | null,
  );
}

async function writeStatusColumns(
  tx: TxSql,
  accountId: string,
  target: SubscriptionStatusValue,
  trialEndIso: string | null,
  stripeCustomerId: string | null,
  stripeSubscriptionId: string,
): Promise<void> {
  switch (target) {
    case SubscriptionStatus.TRIALING:
      // First-writer-wins on the Stripe identifiers (COALESCE): trial-start
      // (checkout mode) persists them so the trialing account is resolvable by
      // every later subscription-mode webhook and by the Billing Portal.
      await tx`
        UPDATE accounts
        SET subscription_status = ${SubscriptionStatus.TRIALING},
            trial_ends_at = ${trialEndIso},
            past_due_at = NULL,
            stripe_customer_id = COALESCE(stripe_customer_id, ${stripeCustomerId}),
            stripe_subscription_id = COALESCE(stripe_subscription_id, ${stripeSubscriptionId}),
            subscription_activated_at = COALESCE(subscription_activated_at, NOW()),
            updated_at = NOW()
        WHERE id = ${accountId}::uuid
      `;
      return;
    case SubscriptionStatus.ACTIVE:
      await tx`
        UPDATE accounts
        SET subscription_status = ${SubscriptionStatus.ACTIVE},
            trial_ends_at = NULL,
            past_due_at = NULL,
            stripe_customer_id = COALESCE(stripe_customer_id, ${stripeCustomerId}),
            stripe_subscription_id = COALESCE(stripe_subscription_id, ${stripeSubscriptionId}),
            subscription_activated_at = COALESCE(subscription_activated_at, NOW()),
            updated_at = NOW()
        WHERE id = ${accountId}::uuid
      `;
      return;
    case SubscriptionStatus.PAST_DUE:
      await tx`
        UPDATE accounts
        SET subscription_status = ${SubscriptionStatus.PAST_DUE},
            trial_ends_at = NULL,
            past_due_at = NOW(),
            updated_at = NOW()
        WHERE id = ${accountId}::uuid
      `;
      return;
    case SubscriptionStatus.CANCELLED:
      await tx`
        UPDATE accounts
        SET subscription_status = ${SubscriptionStatus.CANCELLED},
            cancelled_at = NOW(),
            trial_ends_at = NULL,
            past_due_at = NULL,
            updated_at = NOW()
        WHERE id = ${accountId}::uuid
      `;
      return;
    default:
      return;
  }
}

async function enqueueLifecycleAnalytics(
  tx: TxSql,
  accountId: string,
  fromStatus: string,
  target: SubscriptionStatusValue,
  stripeSubscriptionId: string,
): Promise<void> {
  // trial_started: entered trialing.
  if (target === SubscriptionStatus.TRIALING) {
    await enqueueTrialStarted(tx, { accountId });
    return;
  }
  // The conversion/failure/cancellation facts only fire when LEAVING a trial.
  if (fromStatus !== SubscriptionStatus.TRIALING) return;

  if (target === SubscriptionStatus.ACTIVE) {
    await enqueueTrialConverted(tx, { accountId, stripeSubscriptionId });
  } else if (target === SubscriptionStatus.PAST_DUE) {
    await enqueueTrialPaymentFailed(tx, { accountId, stripeSubscriptionId });
  } else if (target === SubscriptionStatus.CANCELLED) {
    await enqueueTrialCancelled(tx, { accountId, stripeSubscriptionId });
  }
}
