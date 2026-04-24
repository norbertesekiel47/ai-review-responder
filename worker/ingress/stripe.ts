import type { FastifyRequest, FastifyReply } from 'fastify';
import Stripe from 'stripe';
import { v7 as uuidv7 } from 'uuid';
import { sql, jsonb } from '../../src/lib/db/server';
import type {
  SyncReviewsPayload,
  ValidatePlaceIdPayload,
} from '../../src/lib/shared/worker-types';
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

async function processCheckoutSessionCompleted(session: Stripe.Checkout.Session): Promise<void> {
  const businessId = session.client_reference_id ?? session.metadata?.business_id;
  if (!businessId) {
    console.warn(`${LOG_PREFIX} checkout.session.completed missing business_id — skipping`);
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
  // deliveries for the same business on an advisory lock, then decide whether to
  // enqueue the initial sync based on the ACTUAL pending_payment → active
  // transition (not past_due → active, not active → active).
  await sql.begin(async (tx) => {
    await tx`SELECT pg_advisory_xact_lock(hashtext(${businessId + ':activation'}))`;

    const [bizRow] = await tx<{
      subscription_status: string;
      google_place_id: string | null;
      google_maps_url: string | null;
      place_id_verified: boolean;
    }[]>`
      SELECT subscription_status, google_place_id, google_maps_url, place_id_verified
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
    } else {
      console.warn(`${LOG_PREFIX} Business ${businessId} not activated — current status is not pending_payment or past_due`);
    }

    // Transition gate: only enqueue the initial sync on the actual
    // pending_payment → active flip. past_due → active is existing-customer
    // recovery (already had syncs). active → active is a duplicate webhook.
    if (oldStatus !== 'pending_payment') return;

    // Decide topic + payload based on the business's place-id verification state.
    const correlationId = uuidv7();
    let topic: 'sync_reviews' | 'validate_place_id';
    let payload: SyncReviewsPayload | ValidatePlaceIdPayload;

    if (bizRow.place_id_verified && bizRow.google_place_id) {
      topic = 'sync_reviews';
      payload = {
        business_id: businessId,
        google_place_id: bizRow.google_place_id,
        correlation_id: correlationId,
      };
    } else if (bizRow.google_maps_url) {
      topic = 'validate_place_id';
      payload = {
        business_id: businessId,
        google_maps_url: bizRow.google_maps_url,
        correlation_id: correlationId,
      };
    } else {
      // Data-integrity breach: a business should never reach active without
      // either a verified place_id or a google_maps_url. Log loudly and skip.
      console.error(
        `${LOG_PREFIX} business ${businessId} has neither verified place_id nor google_maps_url; skipping initial sync enqueue. correlation=${correlationId}`,
      );
      return;
    }

    // Single-statement insert:
    //   - WHERE NOT EXISTS dedup over BOTH topics × non-terminal statuses
    //     (don't stack a second initial-sync row if one is already queued).
    //   - EXISTS self-serve scope predicate: admin-onboarded businesses got
    //     their initial sync at signup time (Task 8). auth_id IS NOT NULL
    //     confirms this is a real Supabase-Auth owner, not an admin-created row.
    await tx`
      INSERT INTO job_outbox (id, topic, aggregate_type, aggregate_id, payload, status)
      SELECT ${uuidv7()}::uuid, ${topic}, 'business', ${businessId}::uuid, ${jsonb(payload)}, 'pending'
      WHERE NOT EXISTS (
        SELECT 1 FROM job_outbox jo
        WHERE jo.aggregate_id = ${businessId}::uuid
          AND jo.topic IN ('sync_reviews', 'validate_place_id')
          AND jo.status IN ('pending', 'dispatching', 'dispatched')
      )
      AND EXISTS (
        SELECT 1 FROM businesses b
        JOIN users u ON u.business_id = b.id AND u.role = 'owner'
        WHERE b.id = ${businessId}::uuid
          AND b.onboarded_by IS NULL
          AND u.auth_id IS NOT NULL
      )
    `;
  });
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

  await sql`
    UPDATE businesses
    SET subscription_status = 'active', updated_at = NOW()
    WHERE stripe_customer_id = ${customerId}
      AND subscription_status = 'past_due'
  `;
  console.log(`${LOG_PREFIX} Business with customer=${customerId} recovered from past_due to active`);
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

  const priceToTier: Record<string, string> = {
    [process.env.STRIPE_PRICE_FOUNDING ?? '']: 'founding',
    [process.env.STRIPE_PRICE_STANDARD ?? '']: 'standard',
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
