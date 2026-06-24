import Stripe from 'stripe';
import { sql } from '../../../src/lib/db/server';
import { LOG_PREFIX, extractCustomerId, AccountNotProvisionedYetError } from './shared';
import { applyStripeSubscriptionState } from './apply-subscription-state';

export async function processSubscriptionDeleted(sub: Stripe.Subscription): Promise<void> {
  const subscriptionId = sub.id;
  if (!subscriptionId) {
    console.warn(`${LOG_PREFIX} customer.subscription.deleted missing subscription id — skipping`);
    return;
  }

  const customerId = extractCustomerId(sub.customer);
  if (!customerId) {
    console.warn(`${LOG_PREFIX} customer.subscription.deleted missing customer — skipping`);
    return;
  }

  // VAL-BILLING-015: Set subscription_status = 'cancelled'
  // VAL-BILLING-062: Advisory lock prevents duplicate cancellation writes.
  await sql.begin(async (tx) => {
    const acctRows = await tx<{
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
      FOR UPDATE
    `;

    if (acctRows.length === 0) {
      // Out-of-order delivery (deep-scan §6.2): mirror subscription-updated —
      // THROW so the wrapper replies 500 and Stripe redelivers once
      // checkout-completed has written stripe_customer_id. Cancellation re-applies
      // idempotently (status-guarded UPDATE skips an already-cancelled account).
      console.warn(`${LOG_PREFIX} customer.subscription.deleted no account found for customer=${customerId} — signaling retry`);
      throw new AccountNotProvisionedYetError(customerId);
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
        return;
      }
      console.warn(
        `${LOG_PREFIX} customer.subscription.deleted subscription=${subscriptionId} does not match any account's current/active-offboarding subscription for customer=${customerId} — skipping`,
      );
      return;
    }

    await tx`SELECT pg_advisory_xact_lock(hashtext(${acctRow.id + ':status_change'}))`;

    // Single writer for ALL cancellations (QUALITY-OBS/B1.1): route through the
    // applier in subscription mode. subscriptionId is guaranteed here (matched
    // against acctRow.stripe_subscription_id above). The applier maps Stripe
    // `canceled` → CANCELLED, clears trial_ends_at/past_due_at, mirrors all
    // businesses (NOTE-A), writes the audit row, and emits trial_cancelled ONLY
    // when the account was leaving a trial — so the trial and non-trial cases
    // unify. Stale events (already CANCELLED) are no-ops in the applier.
    await applyStripeSubscriptionState(
      tx,
      { mode: 'subscription', stripeCustomerId: customerId, stripeSubscriptionId: subscriptionId },
      sub,
    );
  });
}
