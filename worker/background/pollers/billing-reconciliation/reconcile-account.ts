// worker/background/pollers/billing-reconciliation/reconcile-account.ts
//
// Reconciles ONE account against Stripe: retrieves the subscription, checks for
// duplicate subscriptions, status/price/quantity drift, and upcoming-invoice
// drift. Each outbound Stripe call has explicit failure handling. Returns a
// structured outcome — the orchestrator (runOnce) emits the collected drifts and
// tallies the counts. A non-missing retrieve error is re-thrown so the
// orchestrator's per-account catch records it without marking the account checked.

import Stripe from 'stripe';
import { isSubscriptionTier, TIER_CONFIG } from '../../../../src/lib/accounts/tier-config';
import { findOverageItem } from '../../../../src/lib/payments/overage-item';
import { basePriceIdSet } from '../../../../src/lib/payments/price-tier-map';
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
import { LOG_PREFIX } from './constants';
import type { DriftAlertPayload } from './drift-alert';
import type { AccountWithLocations, BillingReconciliationAccount } from './types';

export interface AccountReconcileOutcome {
  accountsChecked: 0 | 1;
  drifts: DriftAlertPayload[];
  errors: number;
}

export async function reconcileAccount(
  stripe: Stripe,
  account: AccountWithLocations,
  overagePriceIds: Set<string>,
): Promise<AccountReconcileOutcome> {
  const drifts: DriftAlertPayload[] = [];
  let errors = 0;

  const tier = account.subscription_tier;
  if (!isSubscriptionTier(tier)) {
    console.error(`${LOG_PREFIX} Unknown tier ${tier} for account ${account.id} — skipping`);
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
      const customerSubscriptions = await stripe.subscriptions.list({
        customer: stripeCustomerId,
        status: 'all',
        limit: 100,
      });
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
      const message = err instanceof Error ? err.message : String(err);
      console.error(
        `${LOG_PREFIX} Error listing Stripe subscriptions for account ${account.id}: ${message}`,
      );
    }
  }

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

  const overageItem = findOverageItem(subscription.items?.data ?? [], {
    overagePriceIds,
    basePriceIds: basePriceIdSet(),
    storedOveragePriceCents: expectedInvoice.overageUnitPriceCents,
  });
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

    const upcoming = await stripe.invoices.createPreview({
      customer: stripeCustomerId,
      subscription: account.stripe_subscription_id,
    });
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
    const message = err instanceof Error ? err.message : String(err);
    console.error(
      `${LOG_PREFIX} Error reconciling invoice preview for account ${account.id}: ${message}`,
    );
  }

  return { accountsChecked: 1, drifts, errors };
}
