import type Stripe from 'stripe';
import { sql } from '../../../src/lib/db/server';
import {
  isPriceVariant,
  isSubscriptionTier,
  tierGrantsAutopilot,
  type PriceVariant,
  type SubscriptionTierValue,
} from '../../../src/lib/accounts/tier-config';
import { acquireTierBillingActivationLocks } from '../../../src/lib/accounts/billing-locks';
import {
  activeOffboardingStateFromProjection,
  isCheckoutBlocked,
  lockAccountBeforeOffboardingProjection,
  type ActiveOffboardingProjection,
} from '../../../src/lib/account-offboarding/gate';
import {
  synchronizeBusinessTierMirror,
  writeResolvedTierSnapshot,
} from '../../../src/lib/accounts/tier-snapshot';
import { autopilotPurchasable } from '../../../src/lib/payments/tier-purchasability';
import { reportCaughtError } from '../../../src/lib/shared/report-caught-error';
import { SubscriptionStatus } from '../../../src/lib/shared/subscription-status';
import type { CheckoutAttemptLeaseColumns } from '../../../src/lib/payments/checkout-attempt';
import {
  LOG_PREFIX,
  extractCustomerId,
  extractSubscriptionId,
  UUID_RE,
  resumePrimaryBusinessBackfill,
  getStripe,
} from './shared';
import {
  applyStripeSubscriptionStateUnderEntitlementLock,
  type TransitionResult,
} from './apply-subscription-state';

interface CheckoutAccountRow
  extends CheckoutAttemptLeaseColumns, ActiveOffboardingProjection {
  id: string;
  subscription_tier: string;
  subscription_status: string;
  price_variant: string;
  base_price_cents: number;
  locations_paid: number;
  locations_overage_price_cents: number;
  locations_included: number;
  stripe_subscription_id: string | null;
  stripe_customer_id: string | null;
  checkout_attempt_tax_enabled: boolean | null;
  checkout_attempt_customer_email: string | null;
  checkout_attempt_success_url: string | null;
  checkout_attempt_cancel_url: string | null;
}

type AlertReason =
  | 'account_missing'
  | 'customer_mismatch'
  | 'bound_subscription_mismatch'
  | 'bound_customer_mismatch'
  | 'invalid_trial'
  | 'stale_checkout_attempt'
  | 'checkout_session_mismatch'
  | 'checkout_line_items_mismatch'
  | 'checkout_create_shape_mismatch'
  | 'checkout_snapshot_mismatch'
  | 'checkout_account_status_mismatch'
  | 'checkout_subscription_not_entitled'
  | 'checkout_status_binding_failed'
  | 'checkout_blocked_by_offboarding'
  | 'autopilot_activated_while_unavailable';

interface OperationalAlert {
  accountId: string;
  sessionId: string;
  subscriptionId: string;
  reason: AlertReason;
  priceId?: string;
}

interface CheckoutProjection {
  transition: TransitionResult | null;
  /** Completed replay also converges a previously failed deprecated mirror. */
  mirrorNeedsSync: boolean;
  alerts: OperationalAlert[];
}

interface PriceLine {
  quantity?: number | null;
  price?: { id?: string | null } | null;
}

const TRIAL_PERIOD_DAYS = 30;
const SECONDS_PER_DAY = 86_400;

function trialContractMatchesLease(
  providerSession: Stripe.Checkout.Session,
  subscription: Stripe.Subscription,
  account: CheckoutAccountRow,
): boolean {
  const leasedDays = account.checkout_attempt_trial_period_days;
  if (leasedDays === null) {
    return (
      subscription.status === 'active' &&
      providerSession.payment_status === 'paid' &&
      subscription.trial_start === null &&
      subscription.trial_end === null
    );
  }
  if (Number(leasedDays) !== TRIAL_PERIOD_DAYS) return false;

  const trialStart = subscription.trial_start;
  const trialEnd = subscription.trial_end;
  return (
    subscription.status === 'trialing' &&
    providerSession.payment_status === 'no_payment_required' &&
    typeof trialStart === 'number' &&
    Number.isSafeInteger(trialStart) &&
    typeof trialEnd === 'number' &&
    Number.isSafeInteger(trialEnd) &&
    trialEnd > Math.floor(Date.now() / 1000) &&
    trialEnd - trialStart === TRIAL_PERIOD_DAYS * SECONDS_PER_DAY
  );
}

function checkoutCreateShapeMatchesLease(
  providerSession: Stripe.Checkout.Session,
  account: CheckoutAccountRow,
): boolean {
  const taxEnabled = account.checkout_attempt_tax_enabled;
  const customerEmail = account.checkout_attempt_customer_email;
  const successUrl = account.checkout_attempt_success_url;
  const cancelUrl = account.checkout_attempt_cancel_url;
  if (
    typeof taxEnabled !== 'boolean' ||
    !customerEmail ||
    !successUrl ||
    !cancelUrl
  ) {
    return false;
  }

  return (
    providerSession.allow_promotion_codes !== true &&
    providerSession.automatic_tax?.enabled === taxEnabled &&
    (providerSession.automatic_tax?.liability ?? null) === null &&
    (taxEnabled
      ? providerSession.billing_address_collection === 'required'
      : providerSession.billing_address_collection === null
        || providerSession.billing_address_collection === 'auto') &&
    (providerSession.tax_id_collection?.enabled ?? false) === taxEnabled &&
    (providerSession.tax_id_collection?.required ?? 'never') === 'never' &&
    providerSession.customer_email === customerEmail &&
    providerSession.success_url === successUrl &&
    providerSession.cancel_url === cancelUrl
  );
}

class CheckoutRemediationRequiredError extends Error {
  constructor(
    readonly accountId: string,
    readonly sessionId: string,
    readonly subscription: Stripe.Subscription,
    readonly reason: AlertReason,
  ) {
    super(`Checkout provider remediation required: ${reason}`);
    this.name = 'CheckoutRemediationRequiredError';
  }
}

function reportOperationalAlert(alert: OperationalAlert): void {
  reportCaughtError(
    'ingress/stripe/checkout-completed',
    new Error(`Checkout projection requires operator attention: ${alert.reason}`),
    { ...alert },
  );
}

function lineItemsMatchLease(
  items: readonly PriceLine[],
  account: CheckoutAccountRow,
): boolean {
  const baseId = account.checkout_attempt_base_price_id;
  const overageId = account.checkout_attempt_overage_price_id;
  const overageQuantity = Number(account.checkout_attempt_overage_quantity);
  if (!baseId || !overageId || !Number.isSafeInteger(overageQuantity)) return false;

  const base = items.filter((item) => item.price?.id === baseId);
  const overage = items.filter((item) => item.price?.id === overageId);
  const expectedCount = overageQuantity > 0 ? 2 : 1;
  return (
    items.length === expectedCount &&
    base.length === 1 &&
    (base[0]!.quantity ?? 0) === 1 &&
    (overageQuantity === 0
      ? overage.length === 0
      : overage.length === 1 &&
        (overage[0]!.quantity ?? 0) === overageQuantity)
  );
}

function attemptSnapshotMatchesAccount(
  account: CheckoutAccountRow,
): boolean {
  return (
    typeof account.checkout_attempt_tier === 'string' &&
    typeof account.checkout_attempt_price_variant === 'string' &&
    isSubscriptionTier(account.checkout_attempt_tier) &&
    isPriceVariant(account.checkout_attempt_price_variant) &&
    account.subscription_tier === account.checkout_attempt_tier &&
    account.price_variant === account.checkout_attempt_price_variant &&
    Number(account.base_price_cents) ===
      Number(account.checkout_attempt_base_price_cents) &&
    Number(account.locations_overage_price_cents) ===
      Number(account.checkout_attempt_overage_price_cents) &&
    Number(account.locations_included) ===
      Number(account.checkout_attempt_locations_included) &&
    Number(account.locations_paid) === 0
  );
}

function completedIdentityMatches(
  account: CheckoutAccountRow,
  sessionId: string,
  subscriptionId: string,
  providerCustomerId: string | null,
): boolean {
  return (
    account.checkout_attempt_state === 'completed' &&
    account.checkout_session_id === sessionId &&
    account.stripe_subscription_id === subscriptionId &&
    account.stripe_customer_id === providerCustomerId
  );
}

async function cancelUnexpectedSubscription(
  subscription: Stripe.Subscription,
): Promise<void> {
  if (
    subscription.status === 'canceled' ||
    subscription.status === 'incomplete_expired'
  ) {
    return;
  }
  await getStripe().subscriptions.cancel(
    subscription.id,
    { invoice_now: false, prorate: false },
    {
      idempotencyKey: `checkout-attempt-remediate:v1:${subscription.id}`,
    },
  );
}

async function markOpenAttemptRemediated(
  accountId: string,
  sessionId: string,
): Promise<void> {
  await sql.begin(async (tx) => {
    await acquireTierBillingActivationLocks(tx, accountId, accountId);
    await tx`
      UPDATE accounts
      SET checkout_attempt_state = 'remediated',
          checkout_attempt_updated_at = NOW(),
          updated_at = NOW()
      WHERE id = ${accountId}::uuid
        AND checkout_session_id = ${sessionId}
        AND checkout_attempt_state = 'open'
    `;
  });
}

function mismatch(
  accountId: string,
  sessionId: string,
  subscriptionId: string,
  reason: AlertReason,
  priceId?: string,
): CheckoutProjection {
  return {
    transition: null,
    mirrorNeedsSync: false,
    alerts: [{ accountId, sessionId, subscriptionId, reason, priceId }],
  };
}

/**
 * Projects provider-current Checkout state under the fixed account lock graph.
 * The account-owned attempt lease, provider-current Session line items, and
 * provider-current subscription must all agree before the single status applier
 * or complete billing-snapshot writer is reached.
 */
async function projectCheckoutSubscription(
  accountId: string,
  eventSessionId: string,
  eventCustomerId: string | null,
): Promise<CheckoutProjection> {
  try {
    return await sql.begin(async (tx) => {
    await acquireTierBillingActivationLocks(tx, accountId, accountId);

    // Both bounded provider reads occur while advisory locks are held and
    // before the account row is locked. Event delivery order is therefore not
    // trusted as provider-current state.
    const providerSession = await getStripe().checkout.sessions.retrieve(
      eventSessionId,
      { expand: ['line_items'] },
    );
    const providerSubscriptionId = extractSubscriptionId(
      providerSession.subscription,
    );
    if (!providerSubscriptionId) {
      // A completed provider Session can be billable even when the event or
      // expanded object temporarily omits its subscription identity. Without
      // that identity we cannot safely bind or cancel, so leave ingress
      // retryable instead of acknowledging an unknown subscription.
      throw new Error(
        `Provider Checkout Session ${eventSessionId} has no subscription identity`,
      );
    }
    const subscription = await getStripe().subscriptions.retrieve(
      providerSubscriptionId,
    );
    const providerCustomerId = extractCustomerId(subscription.customer);
    const providerSessionCustomerId = extractCustomerId(providerSession.customer);

    const [observed] = await tx<CheckoutAccountRow[]>`
      SELECT
        id,
        subscription_tier,
        subscription_status,
        price_variant,
        base_price_cents,
        locations_paid,
        locations_overage_price_cents,
        locations_included,
        stripe_subscription_id,
        stripe_customer_id,
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

    const providerSessionShapeValid =
      providerSession.id === eventSessionId &&
      providerSession.mode === 'subscription' &&
      providerSession.status === 'complete' &&
      (providerSession.payment_status === 'paid' ||
        providerSession.payment_status === 'no_payment_required') &&
      providerSession.client_reference_id === accountId;

    // A retained completed identity is replay authority. The live account and
    // subscription may have undergone a legitimate later tier/quantity change,
    // so replay must not compare them to the original Checkout snapshot or
    // cancel the still-bound subscription.
    if (
      observed &&
      providerSessionShapeValid &&
      providerSession.metadata?.checkout_attempt_id ===
        observed.checkout_attempt_id &&
      completedIdentityMatches(
        observed,
        eventSessionId,
        subscription.id,
        providerCustomerId,
      ) &&
      providerSessionCustomerId === providerCustomerId
    ) {
      return { transition: null, mirrorNeedsSync: true, alerts: [] };
    }

    let reason: AlertReason | null = null;
    if (!observed) {
      reason = 'account_missing';
    } else if (
      observed.checkout_session_id !== eventSessionId ||
      providerSession.metadata?.checkout_attempt_id !== observed.checkout_attempt_id
    ) {
      reason = 'stale_checkout_attempt';
    } else if (
      !providerSessionShapeValid ||
      subscription.metadata.checkout_attempt_id !== observed.checkout_attempt_id
    ) {
      reason = 'checkout_session_mismatch';
    } else if (
      observed.checkout_attempt_state !== 'open'
    ) {
      reason = 'stale_checkout_attempt';
    } else if (
      observed.subscription_status !== SubscriptionStatus.PENDING_PAYMENT
    ) {
      reason = 'checkout_account_status_mismatch';
    } else if (
      !providerCustomerId ||
      providerSessionCustomerId !== providerCustomerId ||
      (eventCustomerId && eventCustomerId !== providerCustomerId)
    ) {
      reason = 'customer_mismatch';
    } else if (
      observed.stripe_subscription_id !== null &&
      observed.stripe_subscription_id !== subscription.id
    ) {
      reason = 'bound_subscription_mismatch';
    } else if (
      observed.stripe_customer_id !== null &&
      observed.stripe_customer_id !== providerCustomerId
    ) {
      reason = 'bound_customer_mismatch';
    } else if (
      subscription.status !== 'active' &&
      subscription.status !== 'trialing'
    ) {
      reason = 'checkout_subscription_not_entitled';
    } else if (!checkoutCreateShapeMatchesLease(providerSession, observed)) {
      reason = 'checkout_create_shape_mismatch';
    } else if (!trialContractMatchesLease(providerSession, subscription, observed)) {
      // trialContractMatchesLease is the single owner of trial validity — for
      // trialing subscriptions it already asserts trial_end is a safe integer
      // in the future, so no re-check follows (a duplicate guard here was
      // provably unreachable; removed in the 2026-07-16 review, finding #9).
      reason = 'invalid_trial';
    } else if (
      !lineItemsMatchLease(providerSession.line_items?.data ?? [], observed) ||
      !lineItemsMatchLease(subscription.items?.data ?? [], observed)
    ) {
      reason = 'checkout_line_items_mismatch';
    } else if (!attemptSnapshotMatchesAccount(observed)) {
      reason = 'checkout_snapshot_mismatch';
    }

    if (reason) {
      if (
        !observed ||
        !completedIdentityMatches(
          observed,
          eventSessionId,
          subscription.id,
          providerCustomerId,
        )
      ) {
        await cancelUnexpectedSubscription(subscription);
      }
      // Only the current bad attempt is marked remediated. A stale completion
      // must never overwrite the newer authoritative lease.
      if (
        observed?.checkout_session_id === eventSessionId &&
        observed.checkout_attempt_state === 'open'
      ) {
        await tx`
          UPDATE accounts
          SET checkout_attempt_state = 'remediated',
              checkout_attempt_updated_at = NOW(),
              updated_at = NOW()
          WHERE id = ${accountId}::uuid
            AND checkout_session_id = ${eventSessionId}
            AND checkout_attempt_state = 'open'
        `;
      }
      return mismatch(
        accountId,
        eventSessionId,
        subscription.id,
        reason,
        subscription.items?.data[0]?.price?.id,
      );
    }

    if (!observed) {
      throw new Error('unreachable checkout account state');
    }

    const accountLocked = await lockAccountBeforeOffboardingProjection(
      tx,
      accountId,
    );
    if (!accountLocked) {
      throw new CheckoutRemediationRequiredError(
        accountId,
        eventSessionId,
        subscription,
        'account_missing',
      );
    }

    const [account] = await tx<CheckoutAccountRow[]>`
      SELECT
        a.id,
        a.subscription_tier,
        a.subscription_status,
        a.price_variant,
        a.base_price_cents,
        a.locations_paid,
        a.locations_overage_price_cents,
        a.locations_included,
        a.stripe_subscription_id,
        a.stripe_customer_id,
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
    if (
      !account ||
      account.checkout_attempt_id !== observed.checkout_attempt_id ||
      account.checkout_session_id !== eventSessionId ||
      account.checkout_attempt_state !== 'open' ||
      account.subscription_status !== SubscriptionStatus.PENDING_PAYMENT ||
      !attemptSnapshotMatchesAccount(account)
    ) {
      if (
        account &&
        completedIdentityMatches(
          account,
          eventSessionId,
          subscription.id,
          providerCustomerId,
        )
      ) {
        return { transition: null, mirrorNeedsSync: true, alerts: [] };
      }
      // Throwing rolls this transaction back and releases the account row plus
      // advisory locks. The outer handler performs the bounded provider call
      // only after those locks are gone.
      throw new CheckoutRemediationRequiredError(
        accountId,
        eventSessionId,
        subscription,
        'stale_checkout_attempt',
      );
    }
    if (!checkoutCreateShapeMatchesLease(providerSession, account)) {
      throw new CheckoutRemediationRequiredError(
        accountId,
        eventSessionId,
        subscription,
        'checkout_create_shape_mismatch',
      );
    }
    if (!trialContractMatchesLease(providerSession, subscription, account)) {
      throw new CheckoutRemediationRequiredError(
        accountId,
        eventSessionId,
        subscription,
        'invalid_trial',
      );
    }
    if (
      !lineItemsMatchLease(providerSession.line_items?.data ?? [], account) ||
      !lineItemsMatchLease(subscription.items?.data ?? [], account)
    ) {
      throw new CheckoutRemediationRequiredError(
        accountId,
        eventSessionId,
        subscription,
        'checkout_line_items_mismatch',
      );
    }
    if (isCheckoutBlocked(activeOffboardingStateFromProjection(account))) {
      throw new CheckoutRemediationRequiredError(
        accountId,
        eventSessionId,
        subscription,
        'checkout_blocked_by_offboarding',
      );
    }

    const transition = await applyStripeSubscriptionStateUnderEntitlementLock(
      tx,
      accountId,
      { mode: 'checkout', accountId },
      subscription,
    );
    if (!transition.changed || !transition.activated) {
      // The applier may already have issued writes inside this transaction.
      // Roll everything back, then cancel and make the attempt reselectable
      // only after the account row and advisory locks have been released.
      throw new CheckoutRemediationRequiredError(
        accountId,
        eventSessionId,
        subscription,
        'checkout_status_binding_failed',
      );
    }
    const tier = account.checkout_attempt_tier as SubscriptionTierValue;
    const variant = account.checkout_attempt_price_variant as PriceVariant;
    const locationsPaid = Number(account.checkout_attempt_overage_quantity);
    await writeResolvedTierSnapshot(tx, {
      accountId,
      snapshot: {
        tier,
        variant,
        baseCents: Number(account.checkout_attempt_base_price_cents),
        overageCents: Number(account.checkout_attempt_overage_price_cents),
        included: Number(account.checkout_attempt_locations_included),
      },
      locationsPaid,
      audit: {
        eventType: 'subscription_updated',
        payload: {
          source: 'checkout_completed',
          checkout_attempt_id: account.checkout_attempt_id,
          stripe_subscription_id: subscription.id,
        },
      },
    });
    const completed = await tx<{ id: string }[]>`
      UPDATE accounts
      SET checkout_attempt_state = 'completed',
          checkout_attempt_locations_paid = ${locationsPaid},
          checkout_attempt_updated_at = NOW(),
          updated_at = NOW()
      WHERE id = ${accountId}::uuid
        AND checkout_attempt_id = ${account.checkout_attempt_id}::uuid
        AND checkout_session_id = ${eventSessionId}
        AND checkout_attempt_state = 'open'
      RETURNING id
    `;
    if (completed.length !== 1) {
      throw new Error('Checkout attempt completion lost its authoritative lease');
    }

    const alerts: OperationalAlert[] = [];
    if (tierGrantsAutopilot(tier) && !autopilotPurchasable()) {
      alerts.push({
        accountId,
        sessionId: eventSessionId,
        subscriptionId: subscription.id,
        reason: 'autopilot_activated_while_unavailable',
        priceId: account.checkout_attempt_base_price_id ?? undefined,
      });
    }
    return { transition, mirrorNeedsSync: true, alerts };
    });
  } catch (error) {
    if (!(error instanceof CheckoutRemediationRequiredError)) throw error;
    await cancelUnexpectedSubscription(error.subscription);
    await markOpenAttemptRemediated(error.accountId, error.sessionId);
    return mismatch(
      error.accountId,
      error.sessionId,
      error.subscription.id,
      error.reason,
    );
  }
}

export async function processCheckoutSessionCompleted(
  session: Stripe.Checkout.Session,
): Promise<void> {
  const refId = session.client_reference_id ?? session.metadata?.business_id;
  if (!refId) {
    console.warn(`${LOG_PREFIX} checkout.session.completed missing client_reference_id — skipping`);
    return;
  }
  if (!UUID_RE.test(refId)) {
    console.warn(
      `${LOG_PREFIX} checkout.session.completed has malformed ref_id=${JSON.stringify(refId)} — skipping (Stripe will not retry; inbound_events marked processed)`,
    );
    return;
  }
  if (session.mode !== 'subscription') {
    console.warn(`${LOG_PREFIX} checkout.session.completed mode=${session.mode} (not subscription) — skipping activation`);
    return;
  }
  if (
    session.payment_status !== 'paid' &&
    session.payment_status !== 'no_payment_required'
  ) {
    console.warn(`${LOG_PREFIX} checkout.session.completed payment_status=${session.payment_status} (not paid/no_payment_required) — skipping activation for ref ${refId}`);
    return;
  }

  let accountId: string | null = null;
  let businessId: string | null = null;
  const [accountLookup] = await sql<{ id: string }[]>`
    SELECT id FROM accounts WHERE id = ${refId}::uuid
  `;
  if (accountLookup) {
    accountId = accountLookup.id;
  } else {
    const [bizLookup] = await sql<{ account_id: string }[]>`
      SELECT account_id FROM businesses WHERE id = ${refId}::uuid
    `;
    if (bizLookup) {
      accountId = bizLookup.account_id;
      businessId = refId;
    }
  }
  if (!accountId) {
    // A delete-data purge can win after the owner completed the hosted Session
    // but before this webhook is projected. The signed event plus provider-
    // current Session/subscription identity is still enough to stop future
    // billing; silently acknowledging here would orphan the subscription.
    console.warn(
      `${LOG_PREFIX} checkout.session.completed ref_id=${refId} matches neither account nor business — retrieving provider state for remediation`,
    );
    accountId = refId;
  }

  const projection = await projectCheckoutSubscription(
    accountId,
    session.id,
    extractCustomerId(session.customer),
  );
  // Report launch-gate downgrade/refund signals before the deprecated mirror.
  // Mirror failure is retryable, but completed replay intentionally does not
  // reconstruct the original alert; emitting first prevents permanent loss.
  for (const alert of projection.alerts) reportOperationalAlert(alert);
  if (projection.mirrorNeedsSync) {
    await synchronizeBusinessTierMirror(sql, accountId);
  }

  if (projection.transition?.changed && projection.transition.activated) {
    await resumePrimaryBusinessBackfill(
      businessId ?? projection.transition.primaryBusinessId,
    );
  }
}
