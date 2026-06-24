import Stripe from 'stripe';
import { sql } from '../../../src/lib/db/server';
import { SubscriptionStatus } from '../../../src/lib/shared/subscription-status';
import { LOG_PREFIX, extractCustomerId, invoiceSubscriptionId, getStripe, maybeEnqueueBackfillResume } from './shared';
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
  // FIX 4 (PLAN §4.12): trialing accounts seen on this invoice get a SECOND
  // convert path, independent of customer.subscription.updated. Collected here
  // and processed AFTER this tx so the Stripe retrieve doesn't hold the tx open.
  const trialingAccountIds: string[] = [];

  // Resolve the subscription id once — fallback synthetic id for the applier in
  // checkout mode (the applier COALESCEs it onto stripe_subscription_id, so it is
  // only ever written when the account is somehow missing one).
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
      // FIX 4: defer trialing accounts to the post-tx convert path below.
      if (acct.subscription_status === SubscriptionStatus.TRIALING) {
        trialingAccountIds.push(acct.id);
        continue;
      }
      if (acct.subscription_status !== SubscriptionStatus.PAST_DUE) continue;

      await tx`SELECT pg_advisory_xact_lock(hashtext(${acct.id + ':status_change'}))`;

      // Synth id for the applier's ACTIVE-path COALESCE(stripe_subscription_id, id):
      // prefer the account's existing id (makes the COALESCE a strict no-op in the
      // realistic case), fall back to the invoice's real subscription id (a correct
      // backfill if the account was somehow missing one). The trailing '' is
      // unreachable for a real invoice.paid recovery (which always carries a
      // subscription) — it only satisfies the applier's `string` id type and is
      // never written, since one of the two ids is always present. (Guards against
      // writing '' onto a null-subscription account, which would make it
      // unresolvable by every later subscription-mode webhook.)
      const synthSubscriptionId = acct.stripe_subscription_id ?? recoverySubscriptionId ?? '';

      // Single writer for the recovery transition (QUALITY-OBS): the applier
      // flips past_due→active, clears past_due_at, writes the audit row,
      // mirrors businesses, and enqueues the overage recompute — all in this tx.
      const transition = await applyStripeSubscriptionState(
        tx,
        { mode: 'checkout', accountId: acct.id },
        { id: synthSubscriptionId, status: 'active', trial_end: null, customer: customerId },
      );
      if (transition.changed) recovered.push(acct);
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
