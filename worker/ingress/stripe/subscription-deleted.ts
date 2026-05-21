import Stripe from 'stripe';
import { v7 as uuidv7 } from 'uuid';
import { sql, jsonb } from '../../../src/lib/db/server';
import { LOG_PREFIX, extractCustomerId } from './shared';

export async function processSubscriptionDeleted(sub: Stripe.Subscription): Promise<void> {
  const customerId = extractCustomerId(sub.customer);
  if (!customerId) {
    console.warn(`${LOG_PREFIX} customer.subscription.deleted missing customer — skipping`);
    return;
  }

  // VAL-BILLING-015: Set subscription_status = 'cancelled'
  // VAL-BILLING-062: Advisory lock prevents duplicate cancellation writes.
  await sql.begin(async (tx) => {
    const [acctRow] = await tx<{ id: string; subscription_status: string }[]>`
      SELECT id, subscription_status
      FROM accounts
      WHERE stripe_customer_id = ${customerId}
      FOR UPDATE
    `;

    if (!acctRow) {
      console.warn(`${LOG_PREFIX} customer.subscription.deleted no account found for customer=${customerId} — skipping`);
      return;
    }

    await tx`SELECT pg_advisory_xact_lock(hashtext(${acctRow.id + ':status_change'}))`;

    // Idempotent: when the account is already cancelled we intentionally skip
    // the write (and log the skip in the else branch); re-applying 'cancelled'
    // would be a no-op.
    if (acctRow.subscription_status !== 'cancelled') {
      const oldStatus = acctRow.subscription_status;

      await tx`
        UPDATE accounts
        SET subscription_status = 'cancelled', cancelled_at = NOW(), updated_at = NOW()
        WHERE id = ${acctRow.id}::uuid
      `;

      // VAL-LOC-029 / VAL-LOC-058: Audit log for subscription_status_changed
      await tx`
        INSERT INTO account_audit_log (id, account_id, event_type, payload)
        VALUES (
          ${uuidv7()}::uuid,
          ${acctRow.id}::uuid,
          'subscription_status_changed',
          ${jsonb({ fromStatus: oldStatus, toStatus: 'cancelled' })}
        )
      `;

      // Also update businesses deprecated column
      await tx`
        UPDATE businesses
        SET subscription_status = 'cancelled', updated_at = NOW()
        WHERE account_id = ${acctRow.id}::uuid
      `;

      console.log(`${LOG_PREFIX} Account ${acctRow.id} cancelled (was ${oldStatus}, customer=${customerId})`);
    } else {
      console.log(`${LOG_PREFIX} Account ${acctRow.id} already cancelled — skipping`);
    }
  });
}
