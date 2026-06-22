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
import { enqueueStripeOverageRecompute } from '../../../src/lib/shared/job-outbox-helpers';
import {
  enqueueTrialStarted,
  enqueueTrialConverted,
  enqueueTrialPaymentFailed,
  enqueueTrialCancelled,
} from '../../../src/lib/analytics/trial-events';
import { SubscriptionStatus, type SubscriptionStatusValue } from '../../../src/lib/shared/subscription-status';

// The applier is ALWAYS invoked inside sql.begin() (transactional-outbox
// invariant), so the transaction handle is a postgres.TransactionSql. This also
// matches enqueueStripeOverageRecompute's strict TxClient parameter.
type TxSql = postgres.TransactionSql;

/** How the applier resolves the target account. */
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
}

async function resolveAccount(tx: TxSql, ref: ApplyStripeRef): Promise<ResolvedAccount | null> {
  if (ref.mode === 'checkout') {
    const rows = await tx<ResolvedAccount[]>`
      SELECT a.id, a.subscription_status,
        (SELECT b.id FROM businesses b
          WHERE b.account_id = a.id AND b.is_primary = TRUE AND b.archived_at IS NULL
          LIMIT 1) AS primary_business_id
      FROM accounts a
      WHERE a.id = ${ref.accountId}::uuid
      FOR UPDATE
    `;
    return rows[0] ?? null;
  }
  // subscription mode: resolve by customer, but only act on the account's
  // CURRENT subscription (ignore stale/old subscription events).
  const rows = await tx<ResolvedAccount[]>`
    SELECT a.id, a.subscription_status,
      (SELECT b.id FROM businesses b
        WHERE b.account_id = a.id AND b.is_primary = TRUE AND b.archived_at IS NULL
        LIMIT 1) AS primary_business_id
    FROM accounts a
    WHERE a.stripe_customer_id = ${ref.stripeCustomerId}
      AND a.stripe_subscription_id = ${ref.stripeSubscriptionId}
    FOR UPDATE
  `;
  return rows[0] ?? null;
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
  stripeSub: Pick<Stripe.Subscription, 'id' | 'status' | 'trial_end'> & { customer?: unknown },
): Promise<TransitionResult> {
  const account = await resolveAccount(tx, ref);
  if (!account) return NO_CHANGE(null);

  const target = mapStripeStatus(stripeSub.status);
  if (!target) return NO_CHANGE(account);

  const current = account.subscription_status;
  if (!isAllowedTransition(current, target)) return NO_CHANGE(account);

  const stripeSubscriptionId = stripeSub.id;
  const stripeCustomerId = extractStripeCustomerId(stripeSub.customer, ref);
  const trialEndIso =
    typeof stripeSub.trial_end === 'number' && stripeSub.trial_end > 0
      ? new Date(stripeSub.trial_end * 1000).toISOString()
      : null;

  await writeStatusColumns(tx, account.id, target, trialEndIso, stripeCustomerId, stripeSubscriptionId);
  await writeBusinessesMirror(tx, account.id, target);

  await writeAccountAuditLog(
    {
      accountId: account.id,
      eventType: 'subscription_status_changed',
      entityType: 'account',
      entityId: account.id,
      payload: { fromStatus: current, toStatus: target },
    },
    tx,
  );

  // Overage recompute on entering an entitled (billable) state.
  if (target === SubscriptionStatus.TRIALING || target === SubscriptionStatus.ACTIVE) {
    await enqueueStripeOverageRecompute(tx, account.id);
  }

  await enqueueLifecycleAnalytics(tx, account.id, current, target, stripeSubscriptionId);

  return {
    accountResolved: true,
    fromStatus: current,
    toStatus: target,
    changed: true,
    activated: target === SubscriptionStatus.TRIALING || target === SubscriptionStatus.ACTIVE,
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
        SET subscription_status = 'trialing',
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
        SET subscription_status = 'active',
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
        SET subscription_status = 'past_due',
            trial_ends_at = NULL,
            past_due_at = NOW(),
            updated_at = NOW()
        WHERE id = ${accountId}::uuid
      `;
      return;
    case SubscriptionStatus.CANCELLED:
      await tx`
        UPDATE accounts
        SET subscription_status = 'cancelled',
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

async function writeBusinessesMirror(
  tx: TxSql,
  accountId: string,
  target: SubscriptionStatusValue,
): Promise<void> {
  // Deprecated businesses.subscription_status mirror (retained per VAL-SCHEMA-037).
  // Mirror the SAME status the accounts row now carries (including 'trialing').
  //
  // On entering an entitled state (trialing OR active), ALSO mirror the
  // service-start anchor onto businesses.subscription_activated_at — first-writer
  // wins via COALESCE, matching the accounts column. The OnboardingDripScheduler
  // gates on businesses.subscription_activated_at IS NOT NULL (and the drip
  // worker hard-fails day_7/day_30 when it is null), so without this mirror trial
  // accounts would never receive onboarding drips. Scoped to the primary,
  // non-archived business — same target row as checkout-completed's paid path.
  // The anchor is NOT touched on past_due/cancelled (those are exits, not starts).
  switch (target) {
    case SubscriptionStatus.TRIALING:
      await tx`
        UPDATE businesses
        SET subscription_status = 'trialing',
            subscription_activated_at = COALESCE(subscription_activated_at, NOW()),
            updated_at = NOW()
        WHERE account_id = ${accountId}::uuid
          AND is_primary = TRUE
          AND archived_at IS NULL
      `;
      return;
    case SubscriptionStatus.ACTIVE:
      await tx`
        UPDATE businesses
        SET subscription_status = 'active',
            subscription_activated_at = COALESCE(subscription_activated_at, NOW()),
            updated_at = NOW()
        WHERE account_id = ${accountId}::uuid
          AND is_primary = TRUE
          AND archived_at IS NULL
      `;
      return;
    case SubscriptionStatus.PAST_DUE:
      await tx`UPDATE businesses SET subscription_status = 'past_due', updated_at = NOW() WHERE account_id = ${accountId}::uuid`;
      return;
    case SubscriptionStatus.CANCELLED:
      await tx`UPDATE businesses SET subscription_status = 'cancelled', updated_at = NOW() WHERE account_id = ${accountId}::uuid`;
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
