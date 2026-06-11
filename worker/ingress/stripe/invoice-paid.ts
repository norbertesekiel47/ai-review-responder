import Stripe from 'stripe';
import { v7 as uuidv7 } from 'uuid';
import { sql, jsonb } from '../../../src/lib/db/server';
import { writeAccountAuditLog } from '../../../src/lib/audit/log';
import { LOG_PREFIX, extractCustomerId, maybeEnqueueBackfillResume } from './shared';
import { enqueueStripeOverageRecompute } from '../../../src/lib/shared/job-outbox-helpers';

export async function processInvoicePaid(invoice: Stripe.Invoice): Promise<void> {
  const customerId = extractCustomerId(invoice.customer);
  if (!customerId) {
    console.warn(`${LOG_PREFIX} invoice.paid missing customer — skipping`);
    return;
  }

  // VAL-BILLING-013: Recover account from past_due to active
  // VAL-BILLING-014: No-op for already-active accounts
  // VAL-BILLING-062: Advisory lock prevents duplicate recovery writes.
  const recovered: { id: string }[] = [];

  await sql.begin(async (tx) => {
    // Find accounts for this customer that are past_due
    const accounts = await tx<{ id: string; subscription_status: string }[]>`
      SELECT id, subscription_status
      FROM accounts
      WHERE stripe_customer_id = ${customerId}
      FOR UPDATE
    `;

    for (const acct of accounts) {
      if (acct.subscription_status !== 'past_due') continue;

      await tx`SELECT pg_advisory_xact_lock(hashtext(${acct.id + ':status_change'}))`;

      await tx`
        UPDATE accounts
        SET subscription_status = 'active',
            past_due_at = NULL,
            updated_at = NOW()
        WHERE id = ${acct.id}::uuid
      `;

      // VAL-LOC-029 / VAL-LOC-058: Audit log for subscription_status_changed
      await writeAccountAuditLog(
        {
          accountId: acct.id,
          eventType: 'subscription_status_changed',
          entityType: 'account',
          entityId: acct.id,
          payload: { fromStatus: 'past_due', toStatus: 'active' },
        },
        tx,
      );

      // Also update businesses deprecated column
      await tx`
        UPDATE businesses
        SET subscription_status = 'active', updated_at = NOW()
        WHERE account_id = ${acct.id}::uuid
          AND subscription_status = 'past_due'
      `;

      // Recompute Stripe overage quantity after recovery — the worker is
      // idempotent so a redundant enqueue is harmless convergence. Must be
      // inside this tx (transactional outbox invariant: state change +
      // enqueue in one Postgres transaction).
      await enqueueStripeOverageRecompute(tx, acct.id);

      recovered.push(acct);
    }
  });

  if (recovered.length === 0) {
    return;
  }

  console.log(`${LOG_PREFIX} Account with customer=${customerId} recovered from past_due to active`);

  for (const acct of recovered) {
    // Find the primary business for backfill resume
    const [primaryBiz] = await sql<{ id: string }[]>`
      SELECT id FROM businesses
      WHERE account_id = ${acct.id}::uuid
        AND is_primary = TRUE AND archived_at IS NULL
      LIMIT 1
    `;
    if (primaryBiz) {
      await maybeEnqueueBackfillResume(primaryBiz.id).catch((err) => {
        console.error(`${LOG_PREFIX} maybeEnqueueBackfillResume failed for business=${primaryBiz.id}: ${err instanceof Error ? err.message : err}`);
      });
    }
  }
}
