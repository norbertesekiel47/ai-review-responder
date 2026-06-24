import Stripe from 'stripe';
import type postgres from 'postgres';
import { sql } from '../../../src/lib/db/server';
import { SubscriptionStatus } from '../../../src/lib/shared/subscription-status';
import { LOG_PREFIX, extractCustomerId, invoiceSubscriptionId } from './shared';
import { applyStripeSubscriptionState } from './apply-subscription-state';
import { enqueueTrialPaymentFailed } from '../../../src/lib/analytics/trial-events';

type TxSql = postgres.TransactionSql;

/**
 * Conversion-analytics accuracy: Stripe flips a trial trialing→active BEFORE the
 * first renewal charge, so a card-decline-AT-conversion lands on an already-'active'
 * account where trial_converted already fired. If the account converted in the last
 * 3 days (the conversion charge + dunning retries, not a months-later renewal),
 * emit trial_payment_failed so net conversions = trial_converted − trial_payment_failed.
 * Idempotent (keyed by account+subscription); the caller's :status_change advisory
 * lock serializes the convert vs fail webhooks, so the trial_converted row is visible.
 * Runs in the caller's tx. The only caller passes a guaranteed-non-null subscription
 * id (the handler early-returns when the invoice has none), so this takes `string`.
 */
async function recordTrialConversionFailureIfRecent(
  tx: TxSql,
  accountId: string,
  failedSubscriptionId: string,
): Promise<void> {
  const [recentConvert] = await tx<{ ok: boolean }[]>`
    SELECT EXISTS (
      SELECT 1 FROM analytics_events
      WHERE account_id = ${accountId}::uuid
        AND event_name = 'trial_converted'
        AND created_at > NOW() - INTERVAL '3 days'
    ) AS ok
  `;
  if (recentConvert?.ok) {
    await enqueueTrialPaymentFailed(tx, { accountId, stripeSubscriptionId: failedSubscriptionId });
  }
}

export async function processInvoicePaymentFailed(invoice: Stripe.Invoice): Promise<void> {
  const customerId = extractCustomerId(invoice.customer);
  if (!customerId) {
    console.warn(`${LOG_PREFIX} invoice.payment_failed missing customer — skipping`);
    return;
  }

  // Subscription-lineage scope (adversarial review): a Stripe customer can map to
  // MULTIPLE RepWorth accounts. Resolve by BOTH customer AND the failed invoice's
  // subscription so a failure for subscription B can never mark account A (sharing
  // the customer) past_due. A subscription invoice always carries a subscription
  // id; absent it we cannot attribute the failure to an account → no-op.
  const failedSubscriptionId = invoiceSubscriptionId(invoice);
  if (!failedSubscriptionId) {
    console.warn(`${LOG_PREFIX} invoice.payment_failed for customer=${customerId} has no subscription id — skipping (cannot attribute to an account)`);
    return;
  }

  // VAL-BILLING-012: Set accounts.subscription_status = 'past_due'
  // VAL-BILLING-062: Advisory lock prevents duplicate past_due writes under
  // concurrent webhook deliveries for the same customer.
  await sql.begin(async (tx) => {
    const [acctRow] = await tx<{ id: string; subscription_status: string }[]>`
      SELECT id, subscription_status
      FROM accounts
      WHERE stripe_customer_id = ${customerId}
        AND stripe_subscription_id = ${failedSubscriptionId}
      FOR UPDATE
    `;
    if (!acctRow) {
      console.warn(`${LOG_PREFIX} invoice.payment_failed no account found for customer=${customerId} subscription=${failedSubscriptionId} — skipping`);
      return;
    }
    await tx`SELECT pg_advisory_xact_lock(hashtext(${acctRow.id + ':status_change'}))`;

    // Trialing card-fail: route through the applier (subscription mode).
    if (acctRow.subscription_status === SubscriptionStatus.TRIALING) {
      await applyStripeSubscriptionState(
        tx,
        { mode: 'subscription', stripeCustomerId: customerId, stripeSubscriptionId: failedSubscriptionId },
        { id: failedSubscriptionId, status: 'past_due', trial_end: null, customer: customerId },
      );
      return;
    }

    if (acctRow.subscription_status === SubscriptionStatus.ACTIVE) {
      const transition = await applyStripeSubscriptionState(
        tx,
        { mode: 'checkout', accountId: acctRow.id },
        { id: failedSubscriptionId, status: 'past_due', trial_end: null, customer: customerId },
      );
      if (transition.changed) {
        console.log(`${LOG_PREFIX} Account ${acctRow.id} marked past_due (customer=${customerId})`);
        await recordTrialConversionFailureIfRecent(tx, acctRow.id, failedSubscriptionId);
      }
    } else {
      console.log(`${LOG_PREFIX} Account ${acctRow.id} already ${acctRow.subscription_status} — skipping past_due transition`);
    }
  });
}
