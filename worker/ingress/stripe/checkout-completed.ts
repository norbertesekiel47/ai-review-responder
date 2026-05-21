import Stripe from 'stripe';
import { v7 as uuidv7 } from 'uuid';
import { sql, jsonb } from '../../../src/lib/db/server';
import { LOG_PREFIX, extractCustomerId, extractSubscriptionId, UUID_RE, maybeEnqueueBackfillResume } from './shared';

export async function processCheckoutSessionCompleted(session: Stripe.Checkout.Session): Promise<void> {
  // The client_reference_id is set by /api/billing/checkout to the account ID.
  // Legacy Payment Links used the business ID instead. We try the account table
  // first (new flow), then fall back to the business table (legacy).
  const refId = session.client_reference_id ?? session.metadata?.business_id;
  if (!refId) {
    console.warn(`${LOG_PREFIX} checkout.session.completed missing client_reference_id — skipping`);
    return;
  }

  // Validate UUID shape BEFORE the `${refId}::uuid` cast inside the tx.
  // Same reasoning as the original guard — malformed IDs would crash the
  // Postgres cast and cause Stripe retries for ~3 days.
  if (!UUID_RE.test(refId)) {
    console.warn(
      `${LOG_PREFIX} checkout.session.completed has malformed ref_id=${JSON.stringify(refId)} — skipping (Stripe will not retry; inbound_events marked processed)`,
    );
    return;
  }

  const customerId = extractCustomerId(session.customer);
  const subscriptionId = extractSubscriptionId(session.subscription as string | Stripe.Subscription | null);

  // Only activate for subscription-mode sessions with confirmed payment
  if (session.mode !== 'subscription') {
    console.warn(`${LOG_PREFIX} checkout.session.completed mode=${session.mode} (not subscription) — skipping activation`);
    return;
  }

  if (session.payment_status !== 'paid') {
    console.warn(`${LOG_PREFIX} checkout.session.completed payment_status=${session.payment_status} (not paid) — skipping activation for ref ${refId}`);
    return;
  }

  // Resolve whether refId is an account_id (new Checkout Session flow)
  // or a business_id (legacy Payment Link flow).
  let accountId: string | null = null;
  let businessId: string | null = null;

  const [accountLookup] = await sql<{ id: string }[]>`
    SELECT id FROM accounts WHERE id = ${refId}::uuid
  `;
  if (accountLookup) {
    accountId = accountLookup.id;
  } else {
    // Legacy Payment Link flow: refId was a business_id.
    const [bizLookup] = await sql<{ account_id: string }[]>`
      SELECT account_id FROM businesses WHERE id = ${refId}::uuid
    `;
    if (bizLookup) {
      accountId = bizLookup.account_id;
      businessId = refId;
    }
  }

  if (!accountId) {
    console.warn(`${LOG_PREFIX} checkout.session.completed ref_id=${refId} matches neither account nor business — skipping`);
    return;
  }

  // The ':activation' advisory lock serializes concurrent
  // checkout.session.completed deliveries for the same account. Cross-handler
  // ordering against customer.subscription.updated/deleted (which take
  // differently-keyed advisory locks) is provided by the FOR UPDATE row lock on
  // accounts below, not by this advisory lock.
  let activated = false;
  await sql.begin(async (tx) => {
    await tx`SELECT pg_advisory_xact_lock(hashtext(${accountId! + ':activation'}))`;

    // VAL-BILLING-007: Activate the account
    const [acctRow] = await tx<{ subscription_status: string }[]>`
      SELECT subscription_status
      FROM accounts
      WHERE id = ${accountId!}::uuid
      FOR UPDATE
    `;

    if (!acctRow) {
      console.warn(`${LOG_PREFIX} Account ${accountId!} not found during activation — skipping`);
      return;
    }

    const oldStatus = acctRow.subscription_status;

    // VAL-BILLING-008: Idempotent — only flip if not already active
    const updateAcct = await tx`
      UPDATE accounts
      SET
        subscription_status = 'active',
        stripe_customer_id = ${customerId},
        stripe_subscription_id = ${subscriptionId},
        subscription_activated_at = COALESCE(subscription_activated_at, NOW()),
        updated_at = NOW()
      WHERE id = ${accountId!}::uuid
        AND subscription_status IN ('pending_payment', 'past_due')
    `;

    if (updateAcct.count > 0) {
      console.log(`${LOG_PREFIX} Account ${accountId!} activated (customer=${customerId}, old_status=${oldStatus})`);
      activated = true;

      // VAL-LOC-029 / VAL-LOC-058: Audit log for subscription_status_changed
      await tx`
        INSERT INTO account_audit_log (id, account_id, event_type, payload)
        VALUES (
          ${uuidv7()}::uuid,
          ${accountId!}::uuid,
          'subscription_status_changed',
          ${jsonb({ fromStatus: oldStatus, toStatus: 'active' })}
        )
      `;
    } else {
      console.warn(`${LOG_PREFIX} Account ${accountId!} not activated — current status is ${oldStatus}`);
    }

    // Also write to businesses deprecated columns (retained per VAL-SCHEMA-037).
    // Only update the primary business for legacy compatibility.
    await tx`
      UPDATE businesses
      SET
        subscription_status = 'active',
        stripe_customer_id = ${customerId},
        stripe_subscription_id = ${subscriptionId},
        subscription_activated_at = COALESCE(subscription_activated_at, NOW()),
        updated_at = NOW()
      WHERE account_id = ${accountId!}::uuid
        AND is_primary = TRUE
        AND archived_at IS NULL
        AND subscription_status IN ('pending_payment', 'past_due')
    `;
  });

  // Best-effort backfill resume — only after a real status transition.
  // Use the primary business for the backfill query.
  if (activated) {
    if (!businessId) {
      // Find the primary business for this account
      const [primaryBiz] = await sql<{ id: string }[]>`
        SELECT id FROM businesses
        WHERE account_id = ${accountId!}::uuid
          AND is_primary = TRUE AND archived_at IS NULL
        LIMIT 1
      `;
      if (primaryBiz) businessId = primaryBiz.id;
    }
    if (businessId) {
      await maybeEnqueueBackfillResume(businessId).catch((err) => {
        console.error(`${LOG_PREFIX} maybeEnqueueBackfillResume failed for business=${businessId}: ${err instanceof Error ? err.message : err}`);
      });
    }
  }
}
