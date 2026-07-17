import Stripe from 'stripe';
import type postgres from 'postgres';
import { sql } from '../../../src/lib/db/server';
import { SubscriptionStatus } from '../../../src/lib/shared/subscription-status';
import { LOG_PREFIX, extractCustomerId, invoiceSubscriptionId, getStripe } from './shared';
import { applyStripeSubscriptionStateUnderEntitlementLock } from './apply-subscription-state';
import { enqueueTrialPaymentFailed } from '../../../src/lib/analytics/trial-events';
import { acquireTierEntitlementLock } from '../../../src/lib/accounts/billing-locks';

type TxSql = postgres.TransactionSql;
const STRIPE_STATUS_READ_TIMEOUT_MS = 20_000;

/**
 * Conversion-analytics accuracy: Stripe flips a trial trialing→active BEFORE the
 * first renewal charge, so a card-decline-AT-conversion lands on an already-'active'
 * account where trial_converted already fired. If the account converted in the last
 * 3 days (the conversion charge + dunning retries, not a months-later renewal),
 * emit trial_payment_failed so net conversions = trial_converted − trial_payment_failed.
 * Idempotent (keyed by account+subscription); the tier-entitlement advisory
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
  // Resolve identity without a row lock. The transaction acquires entitlement
  // before the applier re-reads and locks the canonical account row.
  const [accountRef] = await sql<{ id: string }[]>`
    SELECT id
    FROM accounts
    WHERE stripe_customer_id = ${customerId}
      AND stripe_subscription_id = ${failedSubscriptionId}
  `;
  if (!accountRef) {
    console.warn(`${LOG_PREFIX} invoice.payment_failed no account found for customer=${customerId} subscription=${failedSubscriptionId} — skipping`);
    return;
  }

  await sql.begin(async (tx) => {
    await acquireTierEntitlementLock(tx, accountRef.id);
    // Serialize the provider observation, not only the later DB write. This is
    // deliberately before the account row lock, so a bounded Stripe read never
    // creates an account -> entitlement edge.
    const subscription = await getStripe().subscriptions.retrieve(
      failedSubscriptionId,
      {},
      { timeout: STRIPE_STATUS_READ_TIMEOUT_MS },
    );
    const transition = await applyStripeSubscriptionStateUnderEntitlementLock(
      tx,
      accountRef.id,
      { mode: 'subscription', stripeCustomerId: customerId, stripeSubscriptionId: failedSubscriptionId },
      subscription,
    );
    if (!transition.changed) {
      console.log(`${LOG_PREFIX} Account ${accountRef.id} already ${transition.toStatus ?? 'missing'} — skipping past_due transition`);
      return;
    }
    console.log(`${LOG_PREFIX} Account ${accountRef.id} projected to ${transition.toStatus} (customer=${customerId})`);
    if (
      transition.fromStatus === SubscriptionStatus.ACTIVE
      && transition.toStatus === SubscriptionStatus.PAST_DUE
    ) {
      await recordTrialConversionFailureIfRecent(tx, accountRef.id, failedSubscriptionId);
    }
  });
}
