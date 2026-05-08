import type { FastifyRequest, FastifyReply } from 'fastify';
import Stripe from 'stripe';
import { v7 as uuidv7 } from 'uuid';
import { sql, jsonb } from '../../src/lib/db/server';
import { claimInboundEvent } from './shared';
import {
  isSubscriptionTier,
  type SubscriptionTierValue,
} from '../../src/lib/accounts/tier-config';

const LOG_PREFIX = '[ingress/stripe]';

// Lazy singleton — avoids crashing on import when STRIPE_SECRET_KEY is absent
let stripeInstance: Stripe | null = null;
function getStripe(): Stripe {
  if (!stripeInstance) {
    const key = process.env.STRIPE_SECRET_KEY;
    if (!key) throw new Error('STRIPE_SECRET_KEY is not set');
    stripeInstance = new Stripe(key);
  }
  return stripeInstance;
}

function extractCustomerId(customer: string | Stripe.Customer | Stripe.DeletedCustomer | null): string | null {
  if (!customer) return null;
  return typeof customer === 'string' ? customer : customer.id;
}

function extractSubscriptionId(subscription: string | Stripe.Subscription | null): string | null {
  if (!subscription) return null;
  return typeof subscription === 'string' ? subscription : subscription.id;
}

// Canonical UUID 8-4-4-4-12 hex shape — accepts all version digits (we use
// v7 from the `uuid` package, but legacy admin rows may be v4). Same regex
// + reasoning as worker/ingress/twilio/twilio-whatsapp.ts:154.
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

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
async function maybeEnqueueBackfillResume(businessId: string): Promise<void> {
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
      b.subscription_tier,
      b.subscription_activated_at
    FROM zernio_connections zc
    JOIN businesses b ON b.id = zc.business_id
    WHERE zc.business_id = ${businessId}::uuid
      AND zc.status = 'active'
      AND b.subscription_activated_at IS NOT NULL
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

async function processCheckoutSessionCompleted(session: Stripe.Checkout.Session): Promise<void> {
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

  // Serialize concurrent checkout.session.completed / customer.subscription.updated
  // deliveries for the same account on an advisory lock.
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

async function processInvoicePaymentFailed(invoice: Stripe.Invoice): Promise<void> {
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

    // Idempotent: only flip active → past_due (skip if already past_due or other status)
    if (acctRow.subscription_status === 'active') {
      await tx`
        UPDATE accounts
        SET subscription_status = 'past_due', updated_at = NOW()
        WHERE id = ${acctRow.id}::uuid
      `;

      // Also update businesses deprecated column
      await tx`
        UPDATE businesses
        SET subscription_status = 'past_due', updated_at = NOW()
        WHERE account_id = ${acctRow.id}::uuid
          AND subscription_status = 'active'
      `;

      console.log(`${LOG_PREFIX} Account ${acctRow.id} marked past_due (customer=${customerId})`);
    } else {
      console.log(`${LOG_PREFIX} Account ${acctRow.id} already ${acctRow.subscription_status} — skipping past_due transition`);
    }
  });
}

async function processInvoicePaid(invoice: Stripe.Invoice): Promise<void> {
  const customerId = extractCustomerId(invoice.customer);
  if (!customerId) {
    console.warn(`${LOG_PREFIX} invoice.paid missing customer — skipping`);
    return;
  }

  // VAL-BILLING-013: Recover account from past_due to active
  // VAL-BILLING-014: No-op for already-active accounts
  // VAL-BILLING-062: Advisory lock prevents duplicate recovery writes.
  const recovered: { id: string }[] = [];

  await sql.begin(async (tx) => {
    // Find accounts for this customer that are past_due
    const accounts = await tx<{ id: string; subscription_status: string }[]>`
      SELECT id, subscription_status
      FROM accounts
      WHERE stripe_customer_id = ${customerId}
      FOR UPDATE
    `;

    for (const acct of accounts) {
      if (acct.subscription_status !== 'past_due') continue;

      await tx`SELECT pg_advisory_xact_lock(hashtext(${acct.id + ':status_change'}))`;

      await tx`
        UPDATE accounts
        SET subscription_status = 'active', updated_at = NOW()
        WHERE id = ${acct.id}::uuid
      `;

      // Also update businesses deprecated column
      await tx`
        UPDATE businesses
        SET subscription_status = 'active', updated_at = NOW()
        WHERE account_id = ${acct.id}::uuid
          AND subscription_status = 'past_due'
      `;

      recovered.push(acct);
    }
  });

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

async function processSubscriptionDeleted(sub: Stripe.Subscription): Promise<void> {
  const customerId = extractCustomerId(sub.customer);
  if (!customerId) {
    console.warn(`${LOG_PREFIX} customer.subscription.deleted missing customer — skipping`);
    return;
  }

  // VAL-BILLING-015: Set subscription_status = 'cancelled'
  // VAL-BILLING-062: Advisory lock prevents duplicate cancellation writes.
  await sql.begin(async (tx) => {
    const [acctRow] = await tx<{ id: string; subscription_status: string }[]>`
      SELECT id, subscription_status
      FROM accounts
      WHERE stripe_customer_id = ${customerId}
      FOR UPDATE
    `;

    if (!acctRow) {
      console.warn(`${LOG_PREFIX} customer.subscription.deleted no account found for customer=${customerId} — skipping`);
      return;
    }

    await tx`SELECT pg_advisory_xact_lock(hashtext(${acctRow.id + ':status_change'}))`;

    // Idempotent: cancelled → cancelled is a no-op at the data level,
    // but we still write for consistency (last-write-wins produces same result).
    if (acctRow.subscription_status !== 'cancelled') {
      await tx`
        UPDATE accounts
        SET subscription_status = 'cancelled', cancelled_at = NOW(), updated_at = NOW()
        WHERE id = ${acctRow.id}::uuid
      `;

      // Also update businesses deprecated column
      await tx`
        UPDATE businesses
        SET subscription_status = 'cancelled', updated_at = NOW()
        WHERE account_id = ${acctRow.id}::uuid
      `;

      console.log(`${LOG_PREFIX} Account ${acctRow.id} cancelled (was ${acctRow.subscription_status}, customer=${customerId})`);
    } else {
      console.log(`${LOG_PREFIX} Account ${acctRow.id} already cancelled — skipping`);
    }
  });
}

async function processSubscriptionUpdated(sub: Stripe.Subscription): Promise<void> {
  const customerId = extractCustomerId(sub.customer);
  if (!customerId) {
    console.warn(`${LOG_PREFIX} customer.subscription.updated missing customer — skipping`);
    return;
  }

  // VAL-BILLING-009: Map base price_id to tier
  // VAL-BILLING-030: All 7 price env vars referenced in the reverse-map
  // VAL-BILLING-055: Reverse-map includes all 7 price IDs
  const priceToTier: Record<string, SubscriptionTierValue> = {
    [process.env.STRIPE_PRICE_BASIC ?? '']: 'basic',
    [process.env.STRIPE_PRICE_FOUNDING ?? '']: 'founders',
    [process.env.STRIPE_PRICE_STANDARD ?? '']: 'standard',
    [process.env.STRIPE_PRICE_PREMIUM  ?? '']: 'premium',
  };

  // Overage price IDs (for identifying the overage item)
  const overagePriceIds = new Set([
    process.env.STRIPE_PRICE_FOUNDERS_OVERAGE ?? '',
    process.env.STRIPE_PRICE_STANDARD_OVERAGE ?? '',
    process.env.STRIPE_PRICE_PREMIUM_OVERAGE ?? '',
  ].filter(Boolean));

  const items = sub.items?.data ?? [];

  // Find the base item (first non-overage item with quantity=1)
  const baseItem = items.find(
    (item) => item.price?.id && !overagePriceIds.has(item.price.id),
  );
  if (!baseItem?.price?.id) {
    console.warn(`${LOG_PREFIX} customer.subscription.updated missing base price ID for customer=${customerId} — skipping tier update`);
    return;
  }

  const tier = priceToTier[baseItem.price.id];
  if (!tier) {
    console.warn(`${LOG_PREFIX} Unknown base price ID ${baseItem.price.id} for customer=${customerId} — skipping tier update`);
    return;
  }

  // VAL-BILLING-010: Read overage item quantity → accounts.locations_paid
  // VAL-BILLING-011: Tolerate legacy single-item subscriptions
  const overageItem = items.find(
    (item) => item.price?.id && overagePriceIds.has(item.price.id),
  );
  const locationsPaid = overageItem?.quantity ?? 0;

  // VAL-BILLING-062: Advisory lock prevents concurrent tier/overage writes.
  await sql.begin(async (tx) => {
    const [acctRow] = await tx<{ id: string; subscription_tier: string; subscription_status: string }[]>`
      SELECT id, subscription_tier, subscription_status
      FROM accounts
      WHERE stripe_customer_id = ${customerId}
      FOR UPDATE
    `;

    if (!acctRow) {
      console.warn(`${LOG_PREFIX} customer.subscription.updated no account found for customer=${customerId} — skipping tier update`);
      return;
    }

    await tx`SELECT pg_advisory_xact_lock(hashtext(${acctRow.id + ':subscription_update'}))`;

    // Update accounts (source of truth)
    await tx`
      UPDATE accounts
      SET
        subscription_tier = ${tier},
        locations_paid = ${locationsPaid},
        updated_at = NOW()
      WHERE id = ${acctRow.id}::uuid
    `;

    // Also update businesses deprecated column
    await tx`
      UPDATE businesses
      SET subscription_tier = ${tier}, updated_at = NOW()
      WHERE account_id = ${acctRow.id}::uuid
    `;

    console.log(`${LOG_PREFIX} Account ${acctRow.id} tier updated to ${tier}, locations_paid=${locationsPaid}`);
  });
}

export async function handleStripeWebhook(request: FastifyRequest, reply: FastifyReply): Promise<void> {
  const rawBody = (request as unknown as { rawBody?: string }).rawBody ?? '';
  const sig = request.headers['stripe-signature'] as string | undefined;

  if (!sig) {
    console.warn(`${LOG_PREFIX} Missing stripe-signature header`);
    reply.status(401).send({ error: 'missing_signature' });
    return;
  }

  const webhookSecret = process.env.STRIPE_WEBHOOK_SECRET;
  if (!webhookSecret) {
    console.error(`${LOG_PREFIX} STRIPE_WEBHOOK_SECRET is not set — rejecting request`);
    reply.status(401).send({ error: 'webhook_secret_not_configured' });
    return;
  }

  let event: Stripe.Event;
  try {
    event = getStripe().webhooks.constructEvent(rawBody, sig, webhookSecret);
  } catch (err) {
    console.warn(`${LOG_PREFIX} Signature verification failed: ${err instanceof Error ? err.message : err}`);
    reply.status(401).send({ error: 'invalid_signature' });
    return;
  }

  // Dedup + reclaim: processes first-time events AND failed/stale retries.
  // Returning 200 duplicate on failed rows would permanently swallow a retry
  // (Stripe never retries after a 200), so we route failed + stale-received
  // rows back through processing via claimInboundEvent.
  const claim = await claimInboundEvent('stripe', event.id, event.type, event);
  if (claim === 'duplicate') {
    console.log(`${LOG_PREFIX} Duplicate event ${event.id} — skipping`);
    reply.status(200).send({ received: true, duplicate: true });
    return;
  }

  try {
    switch (event.type) {
      case 'checkout.session.completed':
        await processCheckoutSessionCompleted(event.data.object as Stripe.Checkout.Session);
        break;

      case 'invoice.payment_failed':
        await processInvoicePaymentFailed(event.data.object as Stripe.Invoice);
        break;

      case 'invoice.paid':
        await processInvoicePaid(event.data.object as Stripe.Invoice);
        break;

      case 'customer.subscription.deleted':
        await processSubscriptionDeleted(event.data.object as Stripe.Subscription);
        break;

      case 'customer.subscription.updated':
        await processSubscriptionUpdated(event.data.object as Stripe.Subscription);
        break;

      default:
        console.log(`${LOG_PREFIX} Unhandled event type: ${event.type} — ignoring`);
        break;
    }

    await sql`
      UPDATE inbound_events
      SET status = 'processed', processed_at = NOW()
      WHERE external_event_key = ${event.id}
    `;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`${LOG_PREFIX} Failed to process event ${event.id} (${event.type}): ${message}`);
    await sql`
      UPDATE inbound_events
      SET status = 'failed', error_message = ${message}
      WHERE external_event_key = ${event.id}
    `;
    // Return 500 so Stripe retries
    reply.status(500).send({ error: 'processing_failed' });
    return;
  }

  reply.status(200).send({ received: true });
}
