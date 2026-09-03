import Stripe from 'stripe';
import { sql } from '../../../src/lib/db/server';
import {
  LOG_PREFIX,
  extractCustomerId,
  AccountNotProvisionedYetError,
  warnStripeSubscriptionEventAckedForAge,
  ACKED_FOR_AGE,
  HANDLED_NORMALLY,
  type StripeSubscriptionAck,
  outOfOrderRetryWindowOpen,
  OUT_OF_ORDER_RETRY_WINDOW_SECONDS,
  type StripeEventContext,
} from './shared';
import { applyStripeSubscriptionStateUnderEntitlementLock } from './apply-subscription-state';
import { acquireTierEntitlementLock } from '../../../src/lib/accounts/billing-locks';

export async function processSubscriptionDeleted(
  sub: Stripe.Subscription,
  eventContext: StripeEventContext,
): Promise<StripeSubscriptionAck> {
  const subscriptionId = sub.id;
  if (!subscriptionId) {
    console.warn(`${LOG_PREFIX} customer.subscription.deleted missing subscription id — skipping`);
    return HANDLED_NORMALLY;
  }

  const customerId = extractCustomerId(sub.customer);
  if (!customerId) {
    console.warn(`${LOG_PREFIX} customer.subscription.deleted missing customer — skipping`);
    return HANDLED_NORMALLY;
  }

  // VAL-BILLING-015: Set subscription_status = 'cancelled'
  // VAL-BILLING-062: Advisory lock prevents duplicate cancellation writes.
  const acctRows = await sql<{
    id: string;
    subscription_status: string;
    stripe_subscription_id: string | null;
    active_offboarding_subscription_id: string | null;
  }[]>`
    SELECT
      a.id,
      a.subscription_status,
      a.stripe_subscription_id,
      CASE
        WHEN EXISTS (
          SELECT 1
          FROM account_offboardings ao
          WHERE ao.account_id = a.id
            AND ao.stripe_subscription_id = ${subscriptionId}
            AND ao.terminal_at IS NULL
        )
        THEN ${subscriptionId}
        ELSE NULL
      END AS active_offboarding_subscription_id
    FROM accounts a
    WHERE a.stripe_customer_id = ${customerId}
  `;

  if (acctRows.length === 0) {
    // Out-of-order delivery (deep-scan §6.2): mirror subscription-updated —
    // THROW so the wrapper replies 500 and Stripe redelivers once
    // checkout-completed has written stripe_customer_id. Cancellation re-applies
    // idempotently (status-guarded UPDATE skips an already-cancelled account).
    //
    // D7 bounds that throw. The window predicate and its boundary live in
    // ./shared so this arm and subscription-updated's cannot drift apart.
    if (outOfOrderRetryWindowOpen(eventContext.created)) {
      console.warn(`${LOG_PREFIX} customer.subscription.deleted no account found for customer=${customerId} — signaling retry`);
      throw new AccountNotProvisionedYetError(customerId);
    }
    console.warn(
      `${LOG_PREFIX} customer.subscription.deleted no account found for customer=${customerId} after ${OUT_OF_ORDER_RETRY_WINDOW_SECONDS}s — acking event=${eventContext.id}; the inbound_events row is retained as stale_ignored and stays replayable`,
    );
    warnStripeSubscriptionEventAckedForAge({
      eventContext,
      eventType: 'customer.subscription.deleted',
      customerId,
      subscriptionId,
    });
    return ACKED_FOR_AGE;
  }

  // Subscription-lineage scope: a Stripe customer can map to MULTIPLE accounts.
  // Cancel the one whose CURRENT subscription is the deleted one — resolving by
  // subscription, never the arbitrary first customer row. The SELECT stays
  // customer-scoped on purpose: we must see every account under the customer to
  // tell out-of-order delivery (throw → retry) from a genuine mismatch (skip)
  // from an expected post-offboarding-snapshot delete (skip).
  const acctRow = acctRows.find((a) => a.stripe_subscription_id === subscriptionId);
  if (!acctRow) {
    const offboardingMatch = acctRows.find(
      (a) => a.active_offboarding_subscription_id === subscriptionId,
    );
    if (offboardingMatch) {
      console.log(
        `${LOG_PREFIX} customer.subscription.deleted subscription=${subscriptionId} matches active offboarding snapshot for account ${offboardingMatch.id} but not its current subscription — skipping live status update`,
      );
      return HANDLED_NORMALLY;
    }
    console.warn(
      `${LOG_PREFIX} customer.subscription.deleted subscription=${subscriptionId} does not match any account's current/active-offboarding subscription for customer=${customerId} — skipping`,
    );
    return HANDLED_NORMALLY;
  }

  await sql.begin(async (tx) => {
    await acquireTierEntitlementLock(tx, acctRow.id);
    await applyStripeSubscriptionStateUnderEntitlementLock(
      tx,
      acctRow.id,
      { mode: 'subscription', stripeCustomerId: customerId, stripeSubscriptionId: subscriptionId },
      sub,
    );
  });

  return HANDLED_NORMALLY;
}
