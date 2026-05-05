import type { FastifyRequest, FastifyReply } from 'fastify';
import Stripe from 'stripe';
import { v7 as uuidv7 } from 'uuid';
import { sql, jsonb } from '../../src/lib/db/server';
import { claimInboundEvent } from './shared';

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
  const businessId = session.client_reference_id ?? session.metadata?.business_id;
  if (!businessId) {
    console.warn(`${LOG_PREFIX} checkout.session.completed missing business_id — skipping`);
    return;
  }

  // Validate UUID shape BEFORE the `${businessId}::uuid` cast inside the
  // tx. Without this, a malformed client_reference_id (Stripe CLI test
  // event, manual API call, third-party Payment Link configured to point
  // at our endpoint with a non-UUID metadata field, etc.) would raise a
  // Postgres `invalid input syntax for type uuid` error that escapes
  // through to the outer handler — which then marks inbound_events.status
  // = 'failed' and Stripe retries the event for ~3 days. Cheap upfront
  // regex, identical to twilio-whatsapp.ts's defensive guard against the
  // same Postgres-cast-throws-on-bad-input footgun.
  if (!UUID_RE.test(businessId)) {
    console.warn(
      `${LOG_PREFIX} checkout.session.completed has malformed business_id=${JSON.stringify(businessId)} — skipping (Stripe will not retry; inbound_events marked processed)`,
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
    console.warn(`${LOG_PREFIX} checkout.session.completed payment_status=${session.payment_status} (not paid) — skipping activation for business ${businessId}`);
    return;
  }

  // Serialize concurrent checkout.session.completed / customer.subscription.updated
  // deliveries for the same business on an advisory lock. The lock key is
  // shared with /api/onboarding/business so the wizard cannot race a webhook
  // delivery for the same business — even though the webhook no longer
  // enqueues, future activation-adjacent work staying serialized is cheap.
  //
  // Initial-sync enqueue moved to /api/onboarding/business (the wizard the
  // owner submits AFTER Stripe payment confirms). Self-serve businesses
  // submit business details there; admin-onboarded businesses already had
  // their outbox row written at signup time. Either way, this webhook only
  // flips status now.
  let activated = false;
  await sql.begin(async (tx) => {
    await tx`SELECT pg_advisory_xact_lock(hashtext(${businessId + ':activation'}))`;

    const [bizRow] = await tx<{ subscription_status: string }[]>`
      SELECT subscription_status
      FROM businesses
      WHERE id = ${businessId}::uuid
      FOR UPDATE
    `;

    if (!bizRow) {
      console.warn(`${LOG_PREFIX} Business ${businessId} not found during activation — skipping`);
      return;
    }

    const oldStatus = bizRow.subscription_status;

    const updated = await tx`
      UPDATE businesses
      SET
        subscription_status = 'active',
        stripe_customer_id = ${customerId},
        stripe_subscription_id = ${subscriptionId},
        subscription_activated_at = COALESCE(subscription_activated_at, NOW()),
        updated_at = NOW()
      WHERE id = ${businessId}::uuid
        AND subscription_status IN ('pending_payment', 'past_due')
    `;

    if (updated.count > 0) {
      console.log(`${LOG_PREFIX} Business ${businessId} activated (customer=${customerId}, old_status=${oldStatus})`);
      activated = true;
    } else {
      console.warn(`${LOG_PREFIX} Business ${businessId} not activated — current status is not pending_payment or past_due`);
    }
  });

  // Best-effort backfill resume — only after a real status transition so
  // duplicate webhooks for an already-active business don't burn a SELECT
  // each. Outside the tx so a missing zernio_connections row is a no-op.
  if (activated) {
    await maybeEnqueueBackfillResume(businessId).catch((err) => {
      console.error(`${LOG_PREFIX} maybeEnqueueBackfillResume failed for business=${businessId}: ${err instanceof Error ? err.message : err}`);
    });
  }
}

async function processInvoicePaymentFailed(invoice: Stripe.Invoice): Promise<void> {
  const customerId = extractCustomerId(invoice.customer);
  if (!customerId) {
    console.warn(`${LOG_PREFIX} invoice.payment_failed missing customer — skipping`);
    return;
  }

  await sql`
    UPDATE businesses
    SET subscription_status = 'past_due', updated_at = NOW()
    WHERE stripe_customer_id = ${customerId}
      AND subscription_status = 'active'
  `;
  console.log(`${LOG_PREFIX} Business with customer=${customerId} marked past_due`);
}

async function processInvoicePaid(invoice: Stripe.Invoice): Promise<void> {
  const customerId = extractCustomerId(invoice.customer);
  if (!customerId) {
    console.warn(`${LOG_PREFIX} invoice.paid missing customer — skipping`);
    return;
  }

  // RETURNING id so we can resume any stalled Zernio backfill the worker
  // skipped while the business sat in past_due.
  const recovered = await sql<{ id: string }[]>`
    UPDATE businesses
    SET subscription_status = 'active', updated_at = NOW()
    WHERE stripe_customer_id = ${customerId}
      AND subscription_status = 'past_due'
    RETURNING id
  `;

  if (recovered.length === 0) {
    return;
  }

  console.log(`${LOG_PREFIX} Business with customer=${customerId} recovered from past_due to active`);

  for (const row of recovered) {
    await maybeEnqueueBackfillResume(row.id).catch((err) => {
      console.error(`${LOG_PREFIX} maybeEnqueueBackfillResume failed for business=${row.id}: ${err instanceof Error ? err.message : err}`);
    });
  }
}

async function processSubscriptionDeleted(sub: Stripe.Subscription): Promise<void> {
  const customerId = extractCustomerId(sub.customer);
  if (!customerId) {
    console.warn(`${LOG_PREFIX} customer.subscription.deleted missing customer — skipping`);
    return;
  }

  await sql`
    UPDATE businesses
    SET subscription_status = 'cancelled', updated_at = NOW()
    WHERE stripe_customer_id = ${customerId}
  `;
  console.log(`${LOG_PREFIX} Business with customer=${customerId} cancelled`);
}

async function processSubscriptionUpdated(sub: Stripe.Subscription): Promise<void> {
  const customerId = extractCustomerId(sub.customer);
  if (!customerId) {
    console.warn(`${LOG_PREFIX} customer.subscription.updated missing customer — skipping`);
    return;
  }

  const priceId = sub.items?.data?.[0]?.price?.id;
  if (!priceId) {
    console.warn(`${LOG_PREFIX} customer.subscription.updated missing price ID for customer=${customerId} — skipping tier update`);
    return;
  }

  const priceToTier: Record<string, 'founding' | 'standard' | 'premium'> = {
    [process.env.STRIPE_PRICE_FOUNDING ?? '']: 'founding',
    [process.env.STRIPE_PRICE_STANDARD ?? '']: 'standard',
    [process.env.STRIPE_PRICE_PREMIUM  ?? '']: 'premium',
  };

  const tier = priceToTier[priceId];
  if (!tier) {
    console.warn(`${LOG_PREFIX} Unknown price ID ${priceId} for customer=${customerId} — skipping tier update`);
    return;
  }

  await sql`
    UPDATE businesses
    SET subscription_tier = ${tier}, updated_at = NOW()
    WHERE stripe_customer_id = ${customerId}
  `;
  console.log(`${LOG_PREFIX} Business with customer=${customerId} tier updated to ${tier}`);
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
