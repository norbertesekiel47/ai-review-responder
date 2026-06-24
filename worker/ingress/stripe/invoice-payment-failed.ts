import Stripe from 'stripe';
import { sql } from '../../../src/lib/db/server';
import { SubscriptionStatus } from '../../../src/lib/shared/subscription-status';
import { LOG_PREFIX, extractCustomerId, invoiceSubscriptionId } from './shared';
import { applyStripeSubscriptionState } from './apply-subscription-state';
import { enqueueTrialPaymentFailed } from '../../../src/lib/analytics/trial-events';

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

    // Idempotent: only flip active → past_due. Route the status write through the
    // applier (QUALITY-OBS) in checkout/by-accountId mode — acctRow is already
    // resolved + FOR-UPDATE-locked, so no subscription id is needed to resolve.
    // PAST_DUE writes no Stripe ids, so the synthesized `id` is unused for this
    // target. The applier clears trial_ends_at, sets past_due_at, mirrors ALL
    // businesses (NOTE-A), and writes the audit row.
    if (acctRow.subscription_status === SubscriptionStatus.ACTIVE) {
      const failedSubscriptionId = invoiceSubscriptionId(invoice);
      const transition = await applyStripeSubscriptionState(
        tx,
        { mode: 'checkout', accountId: acctRow.id },
        { id: failedSubscriptionId ?? '', status: 'past_due', trial_end: null, customer: customerId },
      );

      if (transition.changed) {
        console.log(`${LOG_PREFIX} Account ${acctRow.id} marked past_due (customer=${customerId})`);

        // Conversion-analytics accuracy (UNCHANGED net-logic, NOT owned by the
        // applier): Stripe flips a trial trialing→active BEFORE the first renewal
        // charge, so a card-decline-AT-conversion lands on an already-'active'
        // account where trial_converted already fired. Emit trial_payment_failed
        // so net conversions = trial_converted − trial_payment_failed. Idempotent
        // (keyed by account+subscription); the :status_change advisory lock above
        // serializes the convert vs fail webhooks.
        if (failedSubscriptionId) {
          const [recentConvert] = await tx<{ ok: boolean }[]>`
            SELECT EXISTS (
              SELECT 1 FROM analytics_events
              WHERE account_id = ${acctRow.id}::uuid
                AND event_name = 'trial_converted'
                AND created_at > NOW() - INTERVAL '3 days'
            ) AS ok
          `;
          if (recentConvert?.ok) {
            await enqueueTrialPaymentFailed(tx, {
              accountId: acctRow.id,
              stripeSubscriptionId: failedSubscriptionId,
            });
          }
        }
      }
    } else {
      console.log(`${LOG_PREFIX} Account ${acctRow.id} already ${acctRow.subscription_status} — skipping past_due transition`);
    }
  });
}
