import type { FastifyRequest, FastifyReply } from 'fastify';
import Stripe from 'stripe';
import { getWorkerConfig } from '../../src/lib/config/worker';
import { sql } from '../../src/lib/db/server';
import { claimInboundEvent } from './shared';
import { LOG_PREFIX, getStripe } from './stripe/shared';
import { processCheckoutSessionCompleted } from './stripe/checkout-completed';
import { processInvoicePaymentFailed } from './stripe/invoice-payment-failed';
import { processInvoicePaymentActionRequired } from './stripe/invoice-payment-action-required';
import { processInvoicePaid } from './stripe/invoice-paid';
import { processSubscriptionDeleted } from './stripe/subscription-deleted';
import { processSubscriptionUpdated } from './stripe/subscription-updated';

// Stripe retries a failed webhook for up to ~3 days (fresh signature each time,
// but the original event.created). Reject only events far beyond that window —
// a generous anomaly guard that never drops a legitimate retry. Replay within
// the window is already blocked by constructEvent's 5-min signature tolerance +
// idempotency (claimInboundEvent).
const STALE_EVENT_THRESHOLD_SECONDS = 7 * 24 * 60 * 60; // 7 days

export async function handleStripeWebhook(request: FastifyRequest, reply: FastifyReply): Promise<void> {
  const rawBody = (request as unknown as { rawBody?: string }).rawBody ?? '';
  const sig = request.headers['stripe-signature'] as string | undefined;

  if (!sig) {
    console.warn(`${LOG_PREFIX} Missing stripe-signature header`);
    reply.status(401).send({ error: 'missing_signature' });
    return;
  }

  // Worker-only ingress → worker lane. getWorkerConfig() self-loads dotenv and
  // is read at request time. STRIPE_WEBHOOK_SECRET is rawOptionalVar, so the
  // `if (!webhookSecret)` truthy check below is byte-identical to the old raw read.
  const webhookSecret = getWorkerConfig().STRIPE_WEBHOOK_SECRET;
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

  const eventAgeSeconds = Math.floor(Date.now() / 1000) - event.created;
  if (eventAgeSeconds > STALE_EVENT_THRESHOLD_SECONDS) {
    console.warn(
      `${LOG_PREFIX} Rejecting stale event ${event.id} (${event.type}) — age ${eventAgeSeconds}s exceeds ${STALE_EVENT_THRESHOLD_SECONDS}s`,
    );
    reply.status(200).send({ received: true, stale: true });
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

      case 'invoice.payment_action_required':
        await processInvoicePaymentActionRequired(event.data.object as Stripe.Invoice);
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
