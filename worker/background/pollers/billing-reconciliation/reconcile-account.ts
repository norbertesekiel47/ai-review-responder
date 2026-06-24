// worker/background/pollers/billing-reconciliation/reconcile-account.ts
//
// Reconciles ONE account against Stripe: retrieves the subscription, checks for
// duplicate subscriptions, status/price/quantity drift, and upcoming-invoice
// drift. Each outbound Stripe call has explicit failure handling. Returns a
// structured outcome — the orchestrator (runOnce) emits the collected drifts and
// tallies the counts. A non-missing retrieve error is re-thrown so the
// orchestrator's per-account catch records it without marking the account checked.

import Stripe from 'stripe';
import { sql } from '../../../../src/lib/db/server';
import { applyStripeSubscriptionState } from '../../../ingress/stripe/apply-subscription-state';
import { SubscriptionStatus } from '../../../../src/lib/shared/subscription-status';
import { isSubscriptionTier, TIER_CONFIG } from '../../../../src/lib/accounts/tier-config';
import { resolveOverageItem } from '../../../../src/lib/payments/overage-item';
import {
  compareUpcomingInvoice,
  isExpectedStatusWindow,
  recurringSubscriptionLineTotalCents,
} from './drift';
import { expectedInvoiceForAccount } from './expected-invoice';
import { parseAccountFlags, isPilotAccount } from './account-flags';
import {
  activeStripeSubscriptions,
  extractStripeCustomerId,
  isMissingStripeSubscriptionError,
} from './stripe-overage';
import { createWorkerLogger, toError } from '../../../../src/lib/shared/logger';
import { LOG_PREFIX } from './constants';
import type { DriftAlertPayload } from './drift-alert';
import type { AccountWithLocations, BillingReconciliationAccount } from './types';

const logger = createWorkerLogger(LOG_PREFIX);

// Per-request Stripe timeout — under the orchestrator's per-account budget
// (ACCOUNT_TIMEOUT_MS=60s) so an in-flight read self-terminates and frees its
// connection rather than hanging on the SDK default. Stripe SDK v22 has no
// request AbortSignal, so this request timeout is the cancellation mechanism.
const STRIPE_READ_TIMEOUT_MS = 20_000;

export interface AccountReconcileOutcome {
  accountsChecked: 0 | 1;
  drifts: DriftAlertPayload[];
  errors: number;
}

export async function reconcileAccount(
  stripe: Stripe,
  account: AccountWithLocations,
): Promise<AccountReconcileOutcome> {
  const drifts: DriftAlertPayload[] = [];
  let errors = 0;

  const tier = account.subscription_tier;
  if (!isSubscriptionTier(tier)) {
    logger.error('Unknown subscription tier — skipping account', {
      tier,
      account_id: account.id,
    });
    return { accountsChecked: 0, drifts, errors: 1 };
  }

  const config = TIER_CONFIG[tier];
  const activeLocations = Number(account.active_location_count);
  const expectedAccount: BillingReconciliationAccount = {
    ...account,
    active_location_count: activeLocations,
    flags: parseAccountFlags(account.flags),
  };
  const expectedInvoice = expectedInvoiceForAccount(expectedAccount);
  const isPilot = isPilotAccount(expectedAccount.flags);

  if (!account.stripe_subscription_id) {
    drifts.push({
      driftType: 'missing_subscription',
      dbExpectedOverage: expectedInvoice.overageUnits,
      stripeOverageQuantity: 0,
      activeLocations,
      locationsIncluded: account.locations_included,
      tier,
      isPilot,
      dbStatus: account.subscription_status,
      stripeCustomerId: account.stripe_customer_id,
      driftMessage: `Missing Stripe subscription id for paid account ${account.id}`,
    });
    return { accountsChecked: 1, drifts, errors };
  }

  // Retrieve Stripe subscription
  let subscription: Stripe.Subscription;
  try {
    subscription = await stripe.subscriptions.retrieve(
      account.stripe_subscription_id,
      {},
      { timeout: STRIPE_READ_TIMEOUT_MS },
    );
  } catch (err) {
    if (!isMissingStripeSubscriptionError(err)) {
      throw err;
    }

    drifts.push({
      driftType: 'missing_subscription',
      dbExpectedOverage: expectedInvoice.overageUnits,
      stripeOverageQuantity: 0,
      activeLocations,
      locationsIncluded: account.locations_included,
      tier,
      isPilot,
      dbStatus: account.subscription_status,
      stripeSubscriptionId: account.stripe_subscription_id,
      stripeCustomerId: account.stripe_customer_id,
      driftMessage: `Stripe subscription ${account.stripe_subscription_id} is missing for paid account ${account.id}`,
    });
    return { accountsChecked: 1, drifts, errors };
  }
  const stripeCustomerId = extractStripeCustomerId(subscription.customer);

  if (stripeCustomerId) {
    try {
      const customerSubscriptions = await stripe.subscriptions.list(
        {
          customer: stripeCustomerId,
          status: 'all',
          limit: 100,
        },
        { timeout: STRIPE_READ_TIMEOUT_MS },
      );
      const activeSubscriptions = activeStripeSubscriptions(customerSubscriptions);
      if (activeSubscriptions.length > 1) {
        drifts.push({
          driftType: 'duplicate_subscription',
          dbExpectedOverage: expectedInvoice.overageUnits,
          stripeOverageQuantity: 0,
          activeLocations,
          locationsIncluded: account.locations_included,
          tier,
          isPilot,
          dbStatus: account.subscription_status,
          stripeStatus: subscription.status,
          stripeSubscriptionId: subscription.id,
          stripeCustomerId,
          driftMessage: `Duplicate active Stripe subscriptions for account ${account.id}: ${activeSubscriptions.map((sub) => sub.id).join(',')}`,
        });
      }
    } catch (err) {
      errors++;
      logger.error(
        'Error listing Stripe subscriptions for account',
        { account_id: account.id },
        toError(err),
      );
    }
  }

  // Trial reconciliation with SCOPED CORRECTIVE AUTHORITY (PLAN.md §5).
  //   - DB trialing ↔ Stripe trialing = the expected steady state (no drift).
  //   - A DB `trialing` row whose Stripe status has MOVED (active / canceled /
  //     past_due — e.g. a missed conversion webhook) is the ONE drift this
  //     poller AUTO-CORRECTS, by re-running the single applier in a tx. This
  //     guarantees no entitlement depends on a single webhook. Read-time
  //     `trial_ends_at>now` guards were rejected (can't tell expired-unpaid from
  //     converted-paid); Stripe's current status is the authority.
  const dbTrialing = account.subscription_status === SubscriptionStatus.TRIALING;
  const stripeTrialing = subscription.status === 'trialing';
  if (dbTrialing && !stripeTrialing && account.stripe_subscription_id) {
    // Read-before-tx invariant: all Stripe reads above have resolved; this tx holds a pool connection only for fast DB writes, never across a Stripe call.
    const transition = await sql.begin(async (tx) =>
      applyStripeSubscriptionState(
        tx,
        {
          mode: 'subscription',
          stripeCustomerId: extractStripeCustomerId(subscription.customer) ?? account.stripe_customer_id ?? '',
          stripeSubscriptionId: account.stripe_subscription_id!,
        },
        subscription,
      ),
    );
    if (transition.changed) {
      logger.warn('Corrected stuck trialing row to match Stripe', {
        account_id: account.id,
        stripe_status: subscription.status,
      });
    }
    // The row is now consistent; skip the remaining drift checks this cycle.
    return { accountsChecked: 1, drifts, errors };
  }

  // PLAN.md §5/§15: a DB-`trialing` row whose Stripe status moved is auto-corrected
  // above (early return). The remaining Stripe-`trialing` case here is DB-NON-trialing
  // vs Stripe-`trialing` (e.g. DB `active`/`past_due`/`pending_payment`), which is a
  // genuine anomaly the plan requires SURFACED — not silently hidden. The old
  // `&& !stripeTrialing` blanket suppression hid it; it is intentionally gone. (The
  // benign DB-`trialing`↔Stripe-`trialing` steady state never reaches here as a
  // mismatch because the statuses are equal.)
  if (
    subscription.status !== account.subscription_status
    && !isExpectedStatusWindow(expectedAccount, subscription.status)
  ) {
    drifts.push({
      driftType: 'status_mismatch',
      dbExpectedOverage: expectedInvoice.overageUnits,
      stripeOverageQuantity: 0,
      activeLocations,
      locationsIncluded: account.locations_included,
      tier,
      isPilot,
      dbStatus: account.subscription_status,
      stripeStatus: subscription.status,
      stripeSubscriptionId: subscription.id,
      stripeCustomerId,
      driftMessage: `Stripe status ${subscription.status} differs from DB status ${account.subscription_status}`,
    });
  }

  // Read-only drift detection deliberately accepts ANY confidence, including
  // untrusted descriptor matches — flagging is exactly what this poller is for.
  const overageResolution = resolveOverageItem(subscription.items?.data ?? [], {
    storedOveragePriceCents: expectedInvoice.overageUnitPriceCents,
  });
  const overageItem = overageResolution.kind === 'none' ? undefined : overageResolution.item;
  const stripeOverageQuantity = overageItem?.quantity ?? 0;

  const subscriptionItems = subscription.items?.data ?? [];
  const baseItem = subscriptionItems.find((item) => item.id !== overageItem?.id);
  const baseUnitAmount = baseItem?.price?.unit_amount;
  if (typeof baseUnitAmount === 'number' && baseUnitAmount !== expectedInvoice.baseCents) {
    drifts.push({
      driftType: 'price_mismatch',
      dbExpectedOverage: expectedInvoice.overageUnits,
      stripeOverageQuantity,
      activeLocations,
      locationsIncluded: account.locations_included,
      tier,
      isPilot,
      expectedCents: expectedInvoice.baseCents,
      actualCents: baseUnitAmount,
      dbStatus: account.subscription_status,
      stripeStatus: subscription.status,
      stripeSubscriptionId: subscription.id,
      stripeCustomerId,
      driftMessage: `Stripe base price ${baseUnitAmount} differs from expected ${expectedInvoice.baseCents} for account ${account.id}`,
    });
  }

  const overageUnitAmount = overageItem?.price?.unit_amount;
  if (
    typeof overageUnitAmount === 'number'
    && expectedInvoice.overageUnitPriceCents > 0
    && overageUnitAmount !== expectedInvoice.overageUnitPriceCents
  ) {
    drifts.push({
      driftType: 'price_mismatch',
      dbExpectedOverage: expectedInvoice.overageUnits,
      stripeOverageQuantity,
      activeLocations,
      locationsIncluded: account.locations_included,
      tier,
      isPilot,
      expectedCents: expectedInvoice.overageUnitPriceCents,
      actualCents: overageUnitAmount,
      dbStatus: account.subscription_status,
      stripeStatus: subscription.status,
      stripeSubscriptionId: subscription.id,
      stripeCustomerId,
      driftMessage: `Stripe overage price ${overageUnitAmount} differs from stored account price ${expectedInvoice.overageUnitPriceCents} for account ${account.id}`,
    });
  }

  // Basic tier has no overage concept
  if (!config.multiLocAllowed || config.overageCents === 0) {
    if (overageItem && (overageItem.quantity ?? 0) > 0) {
      // Basic tier should never have overage items with quantity > 0
      drifts.push({
        driftType: 'quantity_mismatch',
        dbExpectedOverage: expectedInvoice.overageUnits,
        stripeOverageQuantity,
        activeLocations,
        locationsIncluded: account.locations_included,
        tier,
        isPilot,
        dbStatus: account.subscription_status,
        stripeStatus: subscription.status,
        stripeSubscriptionId: subscription.id,
        stripeCustomerId,
      });
    }
  } else if (stripeOverageQuantity !== expectedInvoice.overageUnits) {
    drifts.push({
      driftType: 'quantity_mismatch',
      dbExpectedOverage: expectedInvoice.overageUnits,
      stripeOverageQuantity,
      activeLocations,
      locationsIncluded: account.locations_included,
      tier,
      isPilot,
      dbStatus: account.subscription_status,
      stripeStatus: subscription.status,
      stripeSubscriptionId: subscription.id,
      stripeCustomerId,
    });
  }

  try {
    if (!stripeCustomerId) {
      throw new Error('Stripe subscription is missing a customer ID');
    }

    const upcoming = await stripe.invoices.createPreview(
      {
        customer: stripeCustomerId,
        subscription: account.stripe_subscription_id,
      },
      { timeout: STRIPE_READ_TIMEOUT_MS },
    );
    const actualRecurringCents = recurringSubscriptionLineTotalCents(upcoming);

    if (actualRecurringCents === null) {
      throw new Error('Stripe invoice preview returned no recurring subscription lines');
    }

    for (const drift of compareUpcomingInvoice(account.id, expectedInvoice.totalCents, actualRecurringCents)) {
      drifts.push({
        driftType: drift.type,
        dbExpectedOverage: expectedInvoice.overageUnits,
        stripeOverageQuantity,
        activeLocations,
        locationsIncluded: account.locations_included,
        tier,
        isPilot,
        expectedCents: drift.expectedCents,
        actualCents: drift.actualCents,
        dbStatus: account.subscription_status,
        stripeStatus: subscription.status,
        stripeSubscriptionId: subscription.id,
        stripeCustomerId,
        driftMessage: drift.message,
      });
    }
  } catch (err) {
    errors++;
    // While the invoice preview is failing, the upcoming_invoice_mismatch check
    // is blind — and it is the only check that catches a DUPLICATE overage item
    // (the quantity check reads the canonical item, which can look correct while
    // a legacy duplicate still bills). Keep this loud until preview recovers.
    logger.error(
      'Invoice-preview reconciliation UNAVAILABLE — duplicate-overage-item drift undetectable this cycle',
      { account_id: account.id },
      toError(err),
    );
  }

  return { accountsChecked: 1, drifts, errors };
}
