import Stripe from 'stripe';
import { sql } from '../../../src/lib/db/server';
import { writeAccountAuditLog } from '../../../src/lib/audit/log';
import { SubscriptionStatus } from '../../../src/lib/shared/subscription-status';
import { LOG_PREFIX, extractCustomerId, invoiceSubscriptionId, getStripe, maybeEnqueueBackfillResume } from './shared';
import { applyStripeSubscriptionState } from './apply-subscription-state';
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
  // FIX 4 (PLAN §4.12): trialing accounts seen on this invoice get a SECOND
  // convert path, independent of customer.subscription.updated. Collected here
  // and processed AFTER this tx so the Stripe retrieve doesn't hold the tx open.
  const trialingAccountIds: string[] = [];

  await sql.begin(async (tx) => {
    // Find accounts for this customer that are past_due
    const accounts = await tx<{ id: string; subscription_status: string }[]>`
      SELECT id, subscription_status
      FROM accounts
      WHERE stripe_customer_id = ${customerId}
      FOR UPDATE
    `;

    for (const acct of accounts) {
      // FIX 4: defer trialing accounts to the post-tx convert path below.
      if (acct.subscription_status === SubscriptionStatus.TRIALING) {
        trialingAccountIds.push(acct.id);
        continue;
      }
      if (acct.subscription_status !== SubscriptionStatus.PAST_DUE) continue;

      await tx`SELECT pg_advisory_xact_lock(hashtext(${acct.id + ':status_change'}))`;

      await tx`
        UPDATE accounts
        SET subscription_status = 'active',  -- enum: SubscriptionStatus.ACTIVE
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
        SET subscription_status = 'active', updated_at = NOW()  -- enum: SubscriptionStatus.ACTIVE
        WHERE account_id = ${acct.id}::uuid
          AND subscription_status = 'past_due'  -- enum: SubscriptionStatus.PAST_DUE
      `;

      // Recompute Stripe overage quantity after recovery — the worker is
      // idempotent so a redundant enqueue is harmless convergence. Must be
      // inside this tx (transactional outbox invariant: state change +
      // enqueue in one Postgres transaction).
      await enqueueStripeOverageRecompute(tx, acct.id);

      recovered.push(acct);
    }
  });

  // FIX 4 (PLAN §4.12): second convert path for trialing accounts. Retrieve the
  // subscription (pinned getStripe() + bounded timeout — inv #1, Railway worker)
  // OUTSIDE the recovery tx, then route through the SINGLE applier (subscription
  // mode). The applier converts trialing→active ONLY when the retrieved Stripe
  // status is `active`, so the $0 trial-START invoice.paid (sub still trialing)
  // is a safe no-op, and this is idempotent with customer.subscription.updated.
  // The retrieve is gated to trialing accounts — the active/past_due paths above
  // never incur it.
  await convertTrialingAccounts(invoice, customerId, trialingAccountIds);

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

/**
 * Trial-conversion path for invoice.paid (PLAN §4.12 / FIX 4).
 *
 * For each trialing account on this invoice, retrieve the subscription (pinned
 * client + bounded timeout) and route through the single applier in subscription
 * mode. The applier's transition table converts trialing→active ONLY when the
 * retrieved Stripe status is `active`; a still-trialing sub (the $0 trial-start
 * invoice) is a no-op. On a real conversion, run best-effort backfill resume.
 *
 * A retrieve failure throws so the ingress wrapper replies 500 and Stripe
 * redelivers — idempotent via the applier's status-guarded write (a redundant
 * redelivery after the account is already active is a transition-table no-op).
 */
async function convertTrialingAccounts(
  invoice: Stripe.Invoice,
  customerId: string,
  trialingAccountIds: string[],
): Promise<void> {
  if (trialingAccountIds.length === 0) return;

  const subscriptionId = invoiceSubscriptionId(invoice);
  if (!subscriptionId) {
    console.warn(`${LOG_PREFIX} invoice.paid trialing account(s) for customer=${customerId} but no subscription id on invoice — skipping trial convert`);
    return;
  }

  const subscription = await getStripe().subscriptions.retrieve(subscriptionId);

  for (const accountId of trialingAccountIds) {
    const transition = await sql.begin((tx) =>
      applyStripeSubscriptionState(
        tx,
        { mode: 'subscription', stripeCustomerId: customerId, stripeSubscriptionId: subscriptionId },
        subscription,
      ),
    );

    if (!transition.changed || !transition.activated) continue;

    console.log(`${LOG_PREFIX} Account ${accountId} converted trialing→active via invoice.paid (customer=${customerId})`);

    const businessId = transition.primaryBusinessId;
    if (businessId) {
      await maybeEnqueueBackfillResume(businessId).catch((err) => {
        console.error(`${LOG_PREFIX} maybeEnqueueBackfillResume failed for business=${businessId}: ${err instanceof Error ? err.message : err}`);
      });
    }
  }
}
