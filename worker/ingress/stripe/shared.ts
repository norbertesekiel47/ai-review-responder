import type Stripe from 'stripe';
import { v7 as uuidv7 } from 'uuid';
import { sql, jsonb } from '../../../src/lib/db/server';

export const LOG_PREFIX = '[ingress/stripe]';

export { getStripe } from '../../../src/lib/payments/stripe-client';

/**
 * Thrown by subscription.updated/.deleted handlers when no account resolves by
 * stripe_customer_id. accounts.stripe_customer_id is written ONLY by
 * checkout-completed, and Stripe does not guarantee event ordering, so a
 * subscription.* event can arrive BEFORE its checkout.session.completed. This
 * is a deliberate, transient retry signal — NOT a bug: the ingress wrapper maps
 * any throw to status='failed' + HTTP 500 so Stripe redelivers, by which time
 * checkout-completed has written the customer id and the redelivery resolves
 * the account (idempotent via claimInboundEvent + the status-guarded UPDATE). A
 * genuinely orphaned customer (checkout abandoned, account never created)
 * simply retries until Stripe's ~3-day schedule gives up; the hourly reconcile
 * poller is the standing backstop. (deep-scan §6.2)
 */
export class AccountNotProvisionedYetError extends Error {
  constructor(customerId: string) {
    super(
      `No account found for stripe_customer_id=${customerId} — likely a subscription event delivered before checkout.session.completed; signaling retry`,
    );
    this.name = 'AccountNotProvisionedYetError';
  }
}

export function extractCustomerId(customer: string | Stripe.Customer | Stripe.DeletedCustomer | null): string | null {
  if (!customer) return null;
  return typeof customer === 'string' ? customer : customer.id;
}

export function extractSubscriptionId(subscription: string | Stripe.Subscription | null): string | null {
  if (!subscription) return null;
  return typeof subscription === 'string' ? subscription : subscription.id;
}

// Canonical UUID 8-4-4-4-12 hex shape — accepts all version digits (we use
// v7 from the `uuid` package, but legacy admin rows may be v4). Same regex
// + reasoning as worker/ingress/twilio/twilio-whatsapp.ts:154.
export const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Auto-recovery: when a business activates AND has an active Zernio
 * connection AND no completed backfill exists yet, enqueue a fresh
 * zernio_initial_backfill outbox row so the worker runs the backfill.
 *
 * Predicate is "no completed run exists" (NOT EXISTS completed_at IS
 * NOT NULL) so the hook covers BOTH:
 *   - past_due → active recovery where a prior worker run inserted a
 *     row but skipped backfill via subscription guard (completed_at
 *     stayed NULL) — the run is retryable via ON CONFLICT DO NOTHING.
 *   - Admin-onboarded business that connected Zernio BEFORE checkout
 *     completed — no zernio_backfill_runs row exists yet because the
 *     connect callback's needs_backfill predicate didn't fire (it
 *     gates on subscription_activated_at IS NOT NULL).
 *
 * In-flight outbox dedup: skips enqueue when a non-terminal
 * zernio_initial_backfill outbox row already exists for the business
 * (avoids re-enqueueing on rapid duplicate webhooks).
 *
 * Invoked OUTSIDE the activation tx — billing flip is the load-bearing
 * mutation, this is best-effort on top.
 */
export async function maybeEnqueueBackfillResume(businessId: string): Promise<void> {
  if (process.env.ZERNIO_PUBLISHING_ENABLED !== 'true') return;

  const [target] = await sql<{
    zernio_account_id: string;
    zernio_location_id: string;
    subscription_tier: string;
    subscription_activated_at: Date;
  }[]>`
    SELECT
      zc.zernio_account_id,
      zc.zernio_location_id,
      a.subscription_tier,
      a.subscription_activated_at
    FROM zernio_connections zc
    JOIN businesses b ON b.id = zc.business_id
    JOIN accounts a ON a.id = b.account_id
    WHERE zc.business_id = ${businessId}::uuid
      AND zc.status = 'active'
      AND b.archived_at IS NULL
      AND a.subscription_status = 'active'
      AND a.subscription_activated_at IS NOT NULL
      AND NOT EXISTS (
        SELECT 1 FROM zernio_backfill_runs br
        WHERE br.business_id = ${businessId}::uuid
          AND br.completed_at IS NOT NULL
      )
    LIMIT 1
  `;

  if (!target) return;

  await sql`
    INSERT INTO job_outbox (id, topic, aggregate_type, aggregate_id, payload, status)
    SELECT
      ${uuidv7()},
      'zernio_initial_backfill',
      'business',
      ${businessId}::uuid,
      ${jsonb({
        business_id: businessId,
        zernio_account_id: target.zernio_account_id,
        zernio_location_id: target.zernio_location_id,
        subscription_tier: target.subscription_tier,
        subscription_activated_at: target.subscription_activated_at.toISOString(),
        correlation_id: uuidv7(),
      })},
      'pending'
    WHERE NOT EXISTS (
      SELECT 1 FROM job_outbox jo
      WHERE jo.aggregate_id = ${businessId}::uuid
        AND jo.topic = 'zernio_initial_backfill'
        AND jo.status IN ('pending', 'dispatching', 'dispatched')
    )
  `;
  console.log(`${LOG_PREFIX} Re-enqueued zernio_initial_backfill for business=${businessId} (post-activation backfill resume)`);
}
