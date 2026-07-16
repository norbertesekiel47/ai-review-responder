import Stripe from 'stripe';
import { sql } from '../../../src/lib/db/server';
import { LOG_PREFIX, extractCustomerId, invoiceSubscriptionId, getStripe, resumePrimaryBusinessBackfill } from './shared';
import { applyStripeSubscriptionStateUnderEntitlementLock } from './apply-subscription-state';
import { acquireTierEntitlementLock } from '../../../src/lib/accounts/billing-locks';

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

  const transition = await sql.begin(async (tx) => {
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
