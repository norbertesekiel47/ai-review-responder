import Stripe from 'stripe';
import { sql } from '../../../src/lib/db/server';
import { LOG_PREFIX, extractCustomerId, invoiceSubscriptionId, getStripe, resumePrimaryBusinessBackfill } from './shared';
import { applyStripeSubscriptionStateUnderEntitlementLock, mapStripeStatus } from './apply-subscription-state';
import { acquireTierEntitlementLock } from '../../../src/lib/accounts/billing-locks';
import { SubscriptionStatus } from '../../../src/lib/shared/subscription-status';

const STRIPE_STATUS_READ_TIMEOUT_MS = 20_000;

export async function processInvoicePaid(invoice: Stripe.Invoice): Promise<void> {
  const customerId = extractCustomerId(invoice.customer);
  if (!customerId) {
    console.warn(`${LOG_PREFIX} invoice.paid missing customer — skipping`);
    return;
  }

  const recoverySubscriptionId = invoiceSubscriptionId(invoice);
  if (!recoverySubscriptionId) {
    console.warn(`${LOG_PREFIX} invoice.paid for customer=${customerId} has no subscription id — skipping (cannot attribute to an account)`);
    return;
  }

  // Resolve the lineage without a row lock. Advisory entitlement is acquired in
  // the canonical transaction before the applier re-reads/locks this account.
  const [accountRef] = await sql<{ id: string }[]>`
    SELECT id
    FROM accounts
    WHERE stripe_customer_id = ${customerId}
      AND stripe_subscription_id = ${recoverySubscriptionId}
  `;
  if (!accountRef) return;

  const { transition, providerStatus } = await sql.begin(async (tx) => {
    await acquireTierEntitlementLock(tx, accountRef.id);
    // The provider observation belongs to the same serialization boundary as
    // the DB write. Reading before entitlement lets an older observation commit
    // after a newer status writer. No account/business row is held during this
    // bounded network call.
    const subscription = await getStripe().subscriptions.retrieve(
      recoverySubscriptionId,
      {},
      { timeout: STRIPE_STATUS_READ_TIMEOUT_MS },
    );
    const applied = await applyStripeSubscriptionStateUnderEntitlementLock(
      tx,
      accountRef.id,
      {
        mode: 'subscription',
        stripeCustomerId: customerId,
        stripeSubscriptionId: recoverySubscriptionId,
      },
      subscription,
    );
    return { transition: applied, providerStatus: subscription.status };
  });

  if (
    !transition.changed
    && transition.fromStatus === SubscriptionStatus.PAST_DUE
    && mapStripeStatus(providerStatus) === SubscriptionStatus.PAST_DUE
  ) {
    // A paid invoice on a past_due account whose provider-current read STILL
    // says past_due is a stale-read suspect (replica lag / event ordering).
    // The applier deliberately no-ops on past_due→past_due, and silently
    // ACKing here loses the recovery unless customer.subscription.updated
    // arrives (2026-07-16 review finding #2 — the old handler forced a
    // synthetic recovery on this path). Fail the delivery so Stripe
    // redelivers until the read converges; redelivery is bounded by Stripe's
    // webhook retry schedule and the reconcile poller surfaces any residue.
    throw new Error(
      `${LOG_PREFIX} invoice.paid observed a stale past_due subscription read for account ${accountRef.id} (subscription=${recoverySubscriptionId}); failing for provider redelivery`,
    );
  }

  if (!transition.changed || !transition.activated) return;

  console.log(`${LOG_PREFIX} Account ${accountRef.id} recovered to active via invoice.paid (customer=${customerId})`);

  await resumePrimaryBusinessBackfill(transition.primaryBusinessId);
}
