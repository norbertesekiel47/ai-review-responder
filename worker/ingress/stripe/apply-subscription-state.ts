// worker/ingress/stripe/apply-subscription-state.ts
//
// The SINGLE applier of accounts.subscription_status for the trial lifecycle.
// Stripe is the source of truth; this applies a Stripe status to one account via
// a concrete, monotonic transition table (`cancelled` is terminal). Every webhook
// handler that changes status routes through here, and the billing reconcile
// poller calls it to CORRECT stuck `trialing` rows.
//
// Contract (#1355): `applyStripeSubscriptionState(tx, accountId, target)`. The
// caller resolves the account, holds its entitlement lock and, when it resolved
// by Stripe lineage, confirms that lineage on the locked row
// (`lockAccountForStripeLineage`). The target is a normalized
// `{ status, customerId, subscriptionId, trialEnd }` built once at the call
// site (`stripeStatusTarget`) — no resolver modes, no partial Stripe objects.
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
import { SubscriptionStatus, subscriptionGrantsFullAccess, type SubscriptionStatusValue } from '../../../src/lib/shared/subscription-status';
import { acquireStripeCustomerBindingLock } from '../../../src/lib/accounts/billing-locks';

// The applier is ALWAYS invoked inside sql.begin() (transactional-outbox
// invariant), so the transaction handle is a postgres.TransactionSql. This also
// matches enqueueStripeOverageRecompute's strict TxClient parameter.
type TxSql = postgres.TransactionSql;
type StripeSubscriptionState = Pick<Stripe.Subscription, 'id' | 'status' | 'trial_end'>;

/** What to apply: a mapped status plus the Stripe identifiers to bind. */
export interface StripeStatusTarget {
  /** Mapped DB status; `null` (a Stripe status we don't act on) is a no-op. */
  status: SubscriptionStatusValue | null;
  /** Bound write-once via COALESCE on entering trialing/active. */
  customerId: string | null;
  /** Bound write-once via COALESCE; also the trial analytics key. */
  subscriptionId: string;
  /** Stripe `trial_end` (unix seconds) — becomes `trial_ends_at` on trialing. */
  trialEnd: number | null;
}

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
export function mapStripeStatus(stripeStatus: Stripe.Subscription.Status | string): SubscriptionStatusValue | null {
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
export const ALLOWED_TRANSITION_SOURCES: Readonly<
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

interface LockedAccountRow {
  id: string;
  subscription_status: string;
  primary_business_id: string | null;
}

/**
 * The result for "no account to apply to": the account row is gone, or a
 * lineage-scoped caller found it no longer bound to the Stripe lineage it
 * resolved by. Nothing was written.
 */
export const UNRESOLVED_TRANSITION: Readonly<TransitionResult> = Object.freeze({
  accountResolved: false,
  fromStatus: null,
  toStatus: null,
  changed: false,
  activated: false,
  primaryBusinessId: null,
});

const NO_CHANGE = (account: LockedAccountRow): TransitionResult => ({
  accountResolved: true,
  fromStatus: account.subscription_status,
  toStatus: account.subscription_status,
  changed: false,
  activated: false,
  primaryBusinessId: account.primary_business_id,
});

/**
 * Normalize a retrieved Stripe subscription into the applier's target, once, at
 * the call site. `customerId` is the Stripe customer the caller binds: the id it
 * resolved the account by, or — for checkout, where the account is resolved by
 * `client_reference_id` — the retrieved subscription's own customer.
 */
export function stripeStatusTarget(
  subscription: StripeSubscriptionState,
  customerId: string | null,
): StripeStatusTarget {
  return {
    status: mapStripeStatus(subscription.status),
    customerId,
    subscriptionId: subscription.id,
    trialEnd: subscription.trial_end ?? null,
  };
}

/**
 * Lock the account row for a lineage-scoped status apply and confirm it is
 * still bound to the Stripe (customer, subscription) the caller resolved it by.
 *
 * Callers resolve the account WITHOUT a row lock, then take its tier-entitlement
 * lock; the lineage can move in between. The explicit account id is the
 * linearization anchor: never re-resolve the lineage after taking that lock,
 * recheck it on the locked row instead. `false` means apply nothing — return
 * UNRESOLVED_TRANSITION.
 *
 * Order: entitlement (held by the caller) → customer binding → account row.
 * The applier re-takes both of the last two; both are re-entrant in the same
 * transaction.
 */
export async function lockAccountForStripeLineage(
  tx: TxSql,
  accountId: string,
  lineage: { customerId: string; subscriptionId: string },
): Promise<boolean> {
  if (lineage.customerId) {
    await acquireStripeCustomerBindingLock(tx, lineage.customerId);
  }
  const [row] = await tx<{ stripe_customer_id: string | null; stripe_subscription_id: string | null }[]>`
    SELECT stripe_customer_id, stripe_subscription_id
    FROM accounts
    WHERE id = ${accountId}::uuid
    FOR UPDATE
  `;
  return row !== undefined
    && row.stripe_customer_id === lineage.customerId
    && row.stripe_subscription_id === lineage.subscriptionId;
}

/**
 * Apply a Stripe subscription status to one account, in the caller's
 * transaction. Returns a result the caller uses to drive post-commit,
 * best-effort backfill resume.
 *
 * Preconditions, owned by the caller: it resolved `accountId`, holds that
 * account's tier-entitlement advisory lock (never wait for entitlement while
 * holding the account row), and — when it resolved the account by Stripe
 * lineage — has confirmed that lineage via lockAccountForStripeLineage. Callers
 * must project the deprecated business mirror only after the canonical
 * transaction commits, in business -> entitlement order.
 */
export async function applyStripeSubscriptionState(
  tx: TxSql,
  accountId: string,
  target: StripeStatusTarget,
): Promise<TransitionResult> {
  // The writer half of the Stripe-customer binding lock. It lives HERE, in the
  // one function every status writer calls, so no binding write can sit outside
  // it.
  //
  // The reader half is the offboarding purge's redaction guard, which counts
  // the accounts sharing a customer before clearing that customer's
  // identifying fields at Stripe. Every non-null binding assignment below is
  // COALESCE(stripe_customer_id, $1) — write-once — so a binding only ever
  // lands on an account whose column is NULL; the lock is what stops that
  // landing between the guard's count and its Stripe call.
  //
  // Order: the caller's account-scoped entitlement lock is already held, and
  // this customer-keyed lock is taken second. Never invert them.
  if (target.customerId) {
    await acquireStripeCustomerBindingLock(tx, target.customerId);
  }

  const [account] = await tx<LockedAccountRow[]>`
    SELECT a.id, a.subscription_status,
      (SELECT b.id FROM businesses b
        WHERE b.account_id = a.id AND b.is_primary = TRUE AND b.archived_at IS NULL
        LIMIT 1) AS primary_business_id
    FROM accounts a
    WHERE a.id = ${accountId}::uuid
    FOR UPDATE
  `;
  if (!account) return UNRESOLVED_TRANSITION;

  const nextStatus = target.status;
  if (!nextStatus || !isAllowedTransition(account.subscription_status, nextStatus)) {
    return NO_CHANGE(account);
  }
  const transition = { current: account.subscription_status, target: nextStatus };
  await persistStatusTransition(tx, account.id, transition, target);

  return {
    accountResolved: true,
    fromStatus: transition.current,
    toStatus: transition.target,
    changed: true,
    activated: subscriptionGrantsFullAccess(transition.target),
    primaryBusinessId: account.primary_business_id,
  };
}

function stripeTrialEndIso(trialEnd: number | null): string | null {
  if (typeof trialEnd !== 'number' || trialEnd <= 0) return null;
  return new Date(trialEnd * 1000).toISOString();
}

async function persistStatusTransition(
  tx: TxSql,
  accountId: string,
  transition: { current: string; target: SubscriptionStatusValue },
  target: StripeStatusTarget,
): Promise<void> {
  await writeStatusColumns(
    tx,
    accountId,
    transition.target,
    stripeTrialEndIso(target.trialEnd),
    target.customerId,
    target.subscriptionId,
  );
  await writeAccountAuditLog(tx, {
    accountId,
    eventType: 'subscription_status_changed',
    entityType: 'account',
    entityId: accountId,
    payload: {
      fromStatus: transition.current,
      toStatus: transition.target,
    },
  });
  if (subscriptionGrantsFullAccess(transition.target)) {
    await enqueueStripeOverageRecompute(tx, accountId);
  }
  await enqueueLifecycleAnalytics(
    tx,
    accountId,
    transition.current,
    transition.target,
    target.subscriptionId,
  );
  await enqueueStripeSubscriptionMirrorSync(tx, accountId);
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
      // (checkout, resolved by client_reference_id) persists them so the
      // trialing account is resolvable by every later lineage-scoped webhook
      // and by the Billing Portal.
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
