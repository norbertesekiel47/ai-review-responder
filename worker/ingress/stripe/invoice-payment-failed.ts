import Stripe from 'stripe';
import { sql } from '../../../src/lib/db/server';
import { writeAccountAuditLog } from '../../../src/lib/audit/log';
import { SubscriptionStatus } from '../../../src/lib/shared/subscription-status';
import { LOG_PREFIX, extractCustomerId, invoiceSubscriptionId } from './shared';
import { applyStripeSubscriptionState } from './apply-subscription-state';

export async function processInvoicePaymentFailed(invoice: Stripe.Invoice): Promise<void> {
  const customerId = extractCustomerId(invoice.customer);
  if (!customerId) {
    console.warn(`${LOG_PREFIX} invoice.payment_failed missing customer — skipping`);
    return;
  }

  // VAL-BILLING-012: Set accounts.subscription_status = 'past_due'
  // VAL-BILLING-062: Advisory lock prevents duplicate past_due writes under
  // concurrent webhook deliveries for the same customer.
  await sql.begin(async (tx) => {
    // Resolve the account from the customer ID first
    const [acctRow] = await tx<{ id: string; subscription_status: string }[]>`
      SELECT id, subscription_status
      FROM accounts
      WHERE stripe_customer_id = ${customerId}
      FOR UPDATE
    `;

    if (!acctRow) {
      console.warn(`${LOG_PREFIX} invoice.payment_failed no account found for customer=${customerId} — skipping`);
      return;
    }

    await tx`SELECT pg_advisory_xact_lock(hashtext(${acctRow.id + ':status_change'}))`;

    // Trial card-fail (trialing → past_due): route through the SINGLE applier
    // (subscription mode) so trial_ends_at is cleared and trial_payment_failed
    // is emitted, in THIS tx. Requires the subscription id off the invoice; the
    // applier resolves the account by (customer, subscription) and is a no-op if
    // they don't match the account's current subscription.
    if (acctRow.subscription_status === SubscriptionStatus.TRIALING) {
      const subscriptionId = invoiceSubscriptionId(invoice);
      if (subscriptionId) {
        await applyStripeSubscriptionState(
          tx,
          { mode: 'subscription', stripeCustomerId: customerId, stripeSubscriptionId: subscriptionId },
          { id: subscriptionId, status: 'past_due', trial_end: null, customer: customerId },
        );
      } else {
        console.warn(`${LOG_PREFIX} invoice.payment_failed trialing account ${acctRow.id} but no subscription id on invoice — skipping`);
      }
      return;
    }

    // Idempotent: only flip active → past_due (skip if already past_due or other status)
    if (acctRow.subscription_status === SubscriptionStatus.ACTIVE) {
      await tx`
        UPDATE accounts
        SET subscription_status = 'past_due',  -- enum: SubscriptionStatus.PAST_DUE
            past_due_at = NOW(),
            updated_at = NOW()
        WHERE id = ${acctRow.id}::uuid
      `;

      // VAL-LOC-029 / VAL-LOC-058: Audit log for subscription_status_changed
      await writeAccountAuditLog(
        {
          accountId: acctRow.id,
          eventType: 'subscription_status_changed',
          entityType: 'account',
          entityId: acctRow.id,
          payload: { fromStatus: 'active', toStatus: 'past_due' },
        },
        tx,
      );

      // Also update businesses deprecated column
      await tx`
        UPDATE businesses
        SET subscription_status = 'past_due', updated_at = NOW()  -- enum: SubscriptionStatus.PAST_DUE
        WHERE account_id = ${acctRow.id}::uuid
          AND subscription_status = 'active'  -- enum: SubscriptionStatus.ACTIVE
      `;

      console.log(`${LOG_PREFIX} Account ${acctRow.id} marked past_due (customer=${customerId})`);
    } else {
      console.log(`${LOG_PREFIX} Account ${acctRow.id} already ${acctRow.subscription_status} — skipping past_due transition`);
    }
  });
}
