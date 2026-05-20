import Stripe from 'stripe';
import { v7 as uuidv7 } from 'uuid';
import { sql, jsonb } from '../../../src/lib/db/server';
import { LOG_PREFIX, extractCustomerId } from './shared';

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

    // Idempotent: only flip active → past_due (skip if already past_due or other status)
    if (acctRow.subscription_status === 'active') {
      await tx`
        UPDATE accounts
        SET subscription_status = 'past_due', updated_at = NOW()
        WHERE id = ${acctRow.id}::uuid
      `;

      // VAL-LOC-029 / VAL-LOC-058: Audit log for subscription_status_changed
      await tx`
        INSERT INTO account_audit_log (id, account_id, event_type, payload)
        VALUES (
          ${uuidv7()}::uuid,
          ${acctRow.id}::uuid,
          'subscription_status_changed',
          ${jsonb({ fromStatus: 'active', toStatus: 'past_due' })}
        )
      `;

      // Also update businesses deprecated column
      await tx`
        UPDATE businesses
        SET subscription_status = 'past_due', updated_at = NOW()
        WHERE account_id = ${acctRow.id}::uuid
          AND subscription_status = 'active'
      `;

      console.log(`${LOG_PREFIX} Account ${acctRow.id} marked past_due (customer=${customerId})`);
    } else {
      console.log(`${LOG_PREFIX} Account ${acctRow.id} already ${acctRow.subscription_status} — skipping past_due transition`);
    }
  });
}
