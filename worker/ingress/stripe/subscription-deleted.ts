import Stripe from 'stripe';
import { sql } from '../../../src/lib/db/server';
import { writeAccountAuditLog } from '../../../src/lib/audit/log';
import { SubscriptionStatus } from '../../../src/lib/shared/subscription-status';
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
    const [acctRow] = await tx<{
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

    if (!acctRow) {
      // Out-of-order delivery (deep-scan §6.2): mirror subscription-updated —
      // THROW so the wrapper replies 500 and Stripe redelivers once
      // checkout-completed has written stripe_customer_id. Cancellation re-applies
      // idempotently (status-guarded UPDATE skips an already-cancelled account).
      // The mismatch branches below stay clean returns.
      console.warn(`${LOG_PREFIX} customer.subscription.deleted no account found for customer=${customerId} — signaling retry`);
      throw new AccountNotProvisionedYetError(customerId);
    }

    if (subscriptionId !== acctRow.stripe_subscription_id) {
      if (subscriptionId === acctRow.active_offboarding_subscription_id) {
        console.log(
          `${LOG_PREFIX} customer.subscription.deleted subscription=${subscriptionId} matches active offboarding snapshot for account ${acctRow.id} but not current subscription — skipping live status update`,
        );
        return;
      }

      console.warn(
        `${LOG_PREFIX} customer.subscription.deleted subscription=${subscriptionId} does not match account ${acctRow.id} current/active-offboarding subscription — skipping`,
      );
      return;
    }

    await tx`SELECT pg_advisory_xact_lock(hashtext(${acctRow.id + ':status_change'}))`;

    // Cancel during trial (trialing → cancelled): route through the SINGLE
    // applier (subscription mode) so trial_ends_at is cleared and trial_cancelled
    // is emitted, in THIS tx. (Non-trial cancellations keep the unchanged inline
    // path below — they must NOT emit a trial event.)
    if (acctRow.subscription_status === SubscriptionStatus.TRIALING) {
      await applyStripeSubscriptionState(
        tx,
        { mode: 'subscription', stripeCustomerId: customerId, stripeSubscriptionId: subscriptionId },
        sub,
      );
      return;
    }

    // Idempotent: when the account is already cancelled we intentionally skip
    // the write (and log the skip in the else branch); re-applying 'cancelled'
    // would be a no-op.
    if (acctRow.subscription_status !== SubscriptionStatus.CANCELLED) {
      const oldStatus = acctRow.subscription_status;

      await tx`
        UPDATE accounts
        SET subscription_status = 'cancelled',  -- enum: SubscriptionStatus.CANCELLED
            cancelled_at = NOW(),
            past_due_at = NULL,
            updated_at = NOW()
        WHERE id = ${acctRow.id}::uuid
      `;

      // VAL-LOC-029 / VAL-LOC-058: Audit log for subscription_status_changed
      await writeAccountAuditLog(
        {
          accountId: acctRow.id,
          eventType: 'subscription_status_changed',
          entityType: 'account',
          entityId: acctRow.id,
          payload: { fromStatus: oldStatus, toStatus: 'cancelled' },
        },
        tx,
      );

      // Also update businesses deprecated column
      await tx`
        UPDATE businesses
        SET subscription_status = 'cancelled', updated_at = NOW()  -- enum: SubscriptionStatus.CANCELLED
        WHERE account_id = ${acctRow.id}::uuid
      `;

      console.log(`${LOG_PREFIX} Account ${acctRow.id} cancelled (was ${oldStatus}, customer=${customerId})`);
    } else {
      console.log(`${LOG_PREFIX} Account ${acctRow.id} already cancelled — skipping`);
    }
  });
}
