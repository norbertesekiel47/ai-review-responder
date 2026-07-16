import Stripe from 'stripe';
import { sql } from '../../../src/lib/db/server';
import { SubscriptionStatus } from '../../../src/lib/shared/subscription-status';
import { LOG_PREFIX, extractCustomerId, invoiceSubscriptionId, getStripe, resumePrimaryBusinessBackfill } from './shared';
import { applyStripeSubscriptionStateUnderEntitlementLock } from './apply-subscription-state';
import { acquireTierEntitlementLock } from '../../../src/lib/accounts/billing-locks';

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
  const [accountRef] = await sql<{ id: string; subscription_status: string }[]>`
    SELECT id, subscription_status
    FROM accounts
    WHERE stripe_customer_id = ${customerId}
      AND stripe_subscription_id = ${recoverySubscriptionId}
  `;
  if (!accountRef) return;

  if (
    accountRef.subscription_status !== SubscriptionStatus.TRIALING
    && accountRef.subscription_status !== SubscriptionStatus.PAST_DUE
  ) {
    return;
  }
  // Provider-current retrieval happens outside all DB locks. This makes both
  // trial conversion and past-due recovery converge under stale/reversed invoice
  // delivery rather than synthesizing active from the event type.
  const subscription = await getStripe().subscriptions.retrieve(recoverySubscriptionId);

  const transition = await sql.begin(async (tx) => {
    await acquireTierEntitlementLock(tx, accountRef.id);
    return applyStripeSubscriptionStateUnderEntitlementLock(
      tx,
      accountRef.id,
      {
        mode: 'subscription',
        stripeCustomerId: customerId,
        stripeSubscriptionId: recoverySubscriptionId,
      },
      subscription,
    );
  });

  if (!transition.changed || !transition.activated) return;

  console.log(`${LOG_PREFIX} Account ${accountRef.id} recovered to active via invoice.paid (customer=${customerId})`);

  await resumePrimaryBusinessBackfill(transition.primaryBusinessId);
}
