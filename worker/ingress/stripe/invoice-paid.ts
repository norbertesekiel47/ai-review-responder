import Stripe from 'stripe';
import { sql } from '../../../src/lib/db/server';
import { SubscriptionStatus } from '../../../src/lib/shared/subscription-status';
import { LOG_PREFIX, extractCustomerId, invoiceSubscriptionId, getStripe, resumePrimaryBusinessBackfill } from './shared';
import { applyStripeSubscriptionState } from './apply-subscription-state';

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
  // FIX 4 (PLAN §4.12): the trialing account whose subscription matches this
  // invoice gets a SECOND convert path, independent of customer.subscription.updated.
  // At most one account can match (stripe_subscription_id is 1:1 with an account).
  // Deferred to post-tx so the Stripe retrieve doesn't hold the tx open.
  let trialingAccountId: string | null = null;

  // Resolve the invoice's subscription id once. Both the recovery loop and the
  // trialing-defer use it for subscription-lineage scope: a payment for subscription
  // B never reactivates or converts an account A that merely shares the customer.
  const recoverySubscriptionId = invoiceSubscriptionId(invoice);

  await sql.begin(async (tx) => {
    // Find accounts for this customer that are past_due
    const accounts = await tx<{ id: string; subscription_status: string; stripe_subscription_id: string | null }[]>`
      SELECT id, subscription_status, stripe_subscription_id
      FROM accounts
      WHERE stripe_customer_id = ${customerId}
      FOR UPDATE
    `;

    for (const acct of accounts) {
      // FIX 4: defer the matching trialing account to the post-tx convert path below.
      // Subscription-lineage scope (mirror of the recovery guard below): a Stripe
      // customer can map to multiple accounts. Only the account whose CURRENT
      // subscription is the one this invoice paid is a conversion candidate — defer
      // exactly that one. Other trialing accounts under the customer are unrelated.
      if (acct.subscription_status === SubscriptionStatus.TRIALING) {
        if (recoverySubscriptionId && acct.stripe_subscription_id === recoverySubscriptionId) {
          trialingAccountId = acct.id;
        }
        continue;
      }
      if (acct.subscription_status !== SubscriptionStatus.PAST_DUE) continue;

      // Subscription-lineage scope (adversarial review): a Stripe customer can map
      // to MULTIPLE RepWorth accounts. Recover ONLY the account whose CURRENT
      // subscription is the one this invoice paid — never reactivate an unrelated
      // past_due account sharing the customer. Require the invoice's subscription
      // id; absent it we cannot attribute the payment, so skip (no recover-by-customer).
      if (!recoverySubscriptionId || acct.stripe_subscription_id !== recoverySubscriptionId) {
        continue;
      }

      await tx`SELECT pg_advisory_xact_lock(hashtext(${acct.id + ':status_change'}))`;

      // The loop guard above guarantees acct.stripe_subscription_id === recoverySubscriptionId,
      // so the applier's ACTIVE-path COALESCE is a strict no-op.
      const transition = await applyStripeSubscriptionState(
        tx,
        { mode: 'checkout', accountId: acct.id },
        { id: recoverySubscriptionId, status: 'active', trial_end: null, customer: customerId },
      );
      if (transition.changed) recovered.push(acct);
    }
  });

  // FIX 4 (PLAN §4.12): second convert path for the matching trialing account.
  // Retrieve the subscription (pinned getStripe() + bounded timeout — inv #1,
  // Railway worker) OUTSIDE the recovery tx, then route through the SINGLE
  // applier (subscription mode). The applier converts trialing→active ONLY when
  // the retrieved Stripe status is `active`, so the $0 trial-START invoice.paid
  // (sub still trialing) is a safe no-op, and this is idempotent with
  // customer.subscription.updated. The retrieve is gated to the one trialing
  // account whose subscription matches the invoice — active/past_due paths and
  // unrelated trialing siblings never incur it.
  await convertTrialingAccount(invoice, customerId, trialingAccountId);

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
    await resumePrimaryBusinessBackfill(primaryBiz?.id ?? null);
  }
}

/**
 * Trial-conversion path for invoice.paid (PLAN §4.12 / FIX 4).
 *
 * Converts the single trialing account whose current subscription matches the
 * invoice. Retrieve the subscription (pinned client + bounded timeout) and route
 * through the single applier in subscription mode. The applier's transition table
 * converts trialing→active ONLY when the retrieved Stripe status is `active`; a
 * still-trialing sub (the $0 trial-start invoice) is a no-op. On a real
 * conversion, run best-effort backfill resume.
 *
 * A retrieve failure throws so the ingress wrapper replies 500 and Stripe
 * redelivers — idempotent via the applier's status-guarded write (a redundant
 * redelivery after the account is already active is a transition-table no-op).
 */
async function convertTrialingAccount(
  invoice: Stripe.Invoice,
  customerId: string,
  trialingAccountId: string | null,
): Promise<void> {
  if (!trialingAccountId) return;

  const subscriptionId = invoiceSubscriptionId(invoice);
  if (!subscriptionId) {
    console.warn(`${LOG_PREFIX} invoice.paid trialing account ${trialingAccountId} for customer=${customerId} but no subscription id on invoice — skipping trial convert`);
    return;
  }

  const subscription = await getStripe().subscriptions.retrieve(subscriptionId);

  const transition = await sql.begin((tx) =>
    // subscription mode → applier resolves by (customer, subscription), so this
    // is implicitly lineage-scoped.
    applyStripeSubscriptionState(
      tx,
      { mode: 'subscription', stripeCustomerId: customerId, stripeSubscriptionId: subscriptionId },
      subscription,
    ),
  );

  if (!transition.changed || !transition.activated) return;

  // trialingAccountId is guaranteed to be the account the applier resolves:
  // we deferred only the one account whose stripe_subscription_id === subscriptionId.
  console.log(`${LOG_PREFIX} Account ${trialingAccountId} converted trialing→active via invoice.paid (customer=${customerId})`);

  await resumePrimaryBusinessBackfill(transition.primaryBusinessId);
}
