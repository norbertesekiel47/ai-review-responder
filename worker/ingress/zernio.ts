// worker/ingress/zernio.ts
//
// Fastify ingress handler for Zernio webhooks. Mirrors worker/ingress/stripe.ts:198.
//
// Choreography (per spec §5.3):
//   1. Flag check (503 feature_disabled)
//   2. Verify HMAC-SHA256 signature on raw body
//   3. Extract event ID (header preferred, body.id fallback)
//   4. claimInboundEvent dedup (200 duplicate on second delivery)
//   5. Switch on body.event:
//        account.disconnected → multi-business UPDATE+INSERT in single tx (§5.4)
//        account.connected    → log only (defensive drift detector)
//        review.new           → INCRBY zernio_event_seen counter (Phase 3 readiness)
//        review.updated       → INCRBY zernio_event_seen counter (Phase 3 readiness)
//        webhook.test         → log + 200
//        default              → log unhandled, 200
//   6. Mark inbound_events processed
//   7. On exception: mark failed + 500 (Zernio retries 7x over 51h)

import type { FastifyRequest, FastifyReply } from 'fastify';
import { sql } from '../../src/lib/db/server';
import { claimInboundEvent } from './shared';
import { verifyZernioSignature } from './zernio-verify';
import {
  parseZernioReviewWebhook,
  ZernioReviewWebhookParseError,
} from '../../src/lib/zernio/parse-review-webhook';

const LOG_PREFIX = '[ingress/zernio]';

interface ZernioWebhookBody {
  event?: string;
  id?: string;
  reason?: string;
  account?: { id?: string };
  // Allow arbitrary additional fields — Zernio may add new shapes; we only
  // dispatch on `event` and known per-event fields.
  [key: string]: unknown;
}

/**
 * Handle account.disconnected per spec §5.4 round-14.
 *
 * The zernio_connections.account_id index is non-unique by design — the same
 * Google account COULD be connected to multiple Zernio profiles owned by the
 * same person across multiple RepWorth businesses. The handler must notify
 * EVERY business affected by the disconnect, not just the first one found.
 *
 * The CTE below disconnects all matching active rows AND inserts one outbox
 * row per affected business in a single statement — atomic.
 */
async function processAccountDisconnected(body: ZernioWebhookBody): Promise<void> {
  const accountId = body.account?.id;
  if (!accountId || typeof accountId !== 'string') {
    console.warn(`${LOG_PREFIX} account.disconnected missing account.id — skipping`);
    return;
  }

  const reason = typeof body.reason === 'string' ? body.reason : 'webhook account.disconnected';

  await sql.begin(async (tx) => {
    await tx`
      WITH disconnected AS (
        UPDATE zernio_connections
        SET status = 'disconnected',
            disconnect_reason = 'webhook_event',
            disconnected_at = NOW(),
            last_error = ${reason},
            last_error_at = NOW(),
            updated_at = NOW()
        WHERE zernio_account_id = ${accountId}
          AND status = 'active'
        RETURNING business_id
      )
      INSERT INTO job_outbox (
        id, topic, aggregate_type, aggregate_id, payload, attempts, max_attempts
      )
      SELECT
        gen_random_uuid(),
        'notify_owner_connection_lost',
        'business',
        d.business_id,
        jsonb_build_object(
          'kind', 'connection_lost',
          'business_id', d.business_id
        ),
        0,
        5
      FROM disconnected d
    `;
  });

  console.log(`${LOG_PREFIX} account.disconnected processed for account=${accountId}`);
}

export async function handleZernioWebhook(
  request: FastifyRequest,
  reply: FastifyReply,
): Promise<void> {
  // 1. Flag check.
  if (process.env.ZERNIO_PUBLISHING_ENABLED !== 'true') {
    reply.status(503).send({ error: 'feature_disabled' });
    return;
  }

  // 2. Verify signature.
  const rawBody = (request as unknown as { rawBody?: string }).rawBody ?? '';
  const sigHeader = request.headers['x-zernio-signature'];
  const signature = typeof sigHeader === 'string' ? sigHeader : '';

  const webhookSecret = process.env.ZERNIO_WEBHOOK_SECRET;
  if (!webhookSecret) {
    console.error(`${LOG_PREFIX} ZERNIO_WEBHOOK_SECRET is not set — rejecting request`);
    reply.status(401).send({ error: 'webhook_secret_not_configured' });
    return;
  }

  // Per spec §5.3: malformed sig (missing header / bad shape) returns
  // 'invalid_signature_format'; valid shape but bad bytes returns
  // 'invalid_signature'. The verifier collapses both cases into a boolean,
  // so we surface the format error explicitly here.
  const HEX_64 = /^[0-9a-f]{64}$/i;
  if (!signature || !HEX_64.test(signature)) {
    console.warn(`${LOG_PREFIX} Missing or malformed x-zernio-signature header`);
    reply.status(401).send({ error: 'invalid_signature_format' });
    return;
  }

  if (!verifyZernioSignature(rawBody, signature, webhookSecret)) {
    console.warn(`${LOG_PREFIX} Signature verification failed`);
    reply.status(401).send({ error: 'invalid_signature' });
    return;
  }

  // 3. Parse JSON body.
  let body: ZernioWebhookBody;
  try {
    body = JSON.parse(rawBody) as ZernioWebhookBody;
  } catch (err) {
    console.warn(`${LOG_PREFIX} Malformed JSON body: ${err instanceof Error ? err.message : err}`);
    reply.status(400).send({ error: 'malformed_json' });
    return;
  }

  if (!body || typeof body !== 'object') {
    reply.status(400).send({ error: 'malformed_json' });
    return;
  }

  // 4. Extract event ID — header preferred, body.id fallback. Required for dedup.
  const headerEventId = request.headers['x-zernio-event-id'];
  const eventId =
    (typeof headerEventId === 'string' ? headerEventId : undefined) ??
    (typeof body.id === 'string' ? body.id : undefined);

  if (!eventId) {
    console.warn(`${LOG_PREFIX} Missing x-zernio-event-id header and body.id`);
    reply.status(400).send({ error: 'missing_event_id' });
    return;
  }

  const eventType = typeof body.event === 'string' ? body.event : 'unknown';

  // 5. Dedup. Reclaim semantics handle worker crashes + transient retries.
  const claim = await claimInboundEvent('zernio', eventId, eventType, body);
  if (claim === 'duplicate') {
    console.log(`${LOG_PREFIX} Duplicate event ${eventId} — skipping`);
    reply.status(200).send({ received: true, duplicate: true });
    return;
  }

  // 6. Dispatch.
  try {
    switch (eventType) {
      case 'account.disconnected':
        await processAccountDisconnected(body);
        break;

      case 'account.connected':
        // Defensive log only — the connect flow is owner-initiated and we
        // already track state in zernio_connections. This event is purely a
        // drift-detection signal during pilot.
        console.log(
          `${LOG_PREFIX} account.connected: account=${body.account?.id ?? '<unknown>'} (informational)`,
        );
        break;

      case 'review.new':
      case 'review.updated': {
        // Fan-out per spec §4.3: emit one ingest_zernio_review outbox row per
        // active connection at the firing Zernio account. The ingest worker
        // filters by location AFTER fetching the review (necessary because
        // the same Zernio account may be connected to multiple RepWorth
        // businesses at different Google locations).
        let parsed;
        try {
          parsed = parseZernioReviewWebhook(body);
        } catch (err) {
          if (err instanceof ZernioReviewWebhookParseError) {
            console.warn(`${LOG_PREFIX} ${eventType} unparseable: ${err.message}`);
            break;  // 200 OK — Zernio shouldn't retry malformed payloads
          }
          throw err;
        }

        await sql`
          INSERT INTO job_outbox (id, topic, aggregate_type, aggregate_id, payload, status)
          SELECT
            gen_random_uuid(),
            'ingest_zernio_review',
            'business',
            zc.business_id,
            jsonb_build_object(
              'business_id', zc.business_id,
              'zernio_account_id', ${parsed.accountId},
              'zernio_location_id', zc.zernio_location_id,
              'zernio_review_id', ${parsed.reviewId},
              'correlation_id', ${eventId}
            ),
            'pending'
          FROM zernio_connections zc
          WHERE zc.zernio_account_id = ${parsed.accountId}
            AND zc.status = 'active'
        `;
        break;
      }

      case 'webhook.test':
        console.log(`${LOG_PREFIX} webhook.test received (event=${eventId})`);
        break;

      default:
        console.log(`${LOG_PREFIX} Unhandled event type: ${eventType} — ignoring`);
        break;
    }

    // 7. Mark processed. Scope by source='zernio' as defense-in-depth so
    // we never stomp on a row claimed by another provider's ingress.
    await sql`
      UPDATE inbound_events
      SET status = 'processed', processed_at = NOW()
      WHERE external_event_key = ${eventId} AND source = 'zernio'
    `;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(
      `${LOG_PREFIX} Failed to process event ${eventId} (${eventType}): ${message}`,
    );
    await sql`
      UPDATE inbound_events
      SET status = 'failed', error_message = ${message}
      WHERE external_event_key = ${eventId} AND source = 'zernio'
    `;
    // Return 500 so Zernio retries (7x over 51h per spec).
    reply.status(500).send({ error: 'processing_failed' });
    return;
  }

  reply.status(200).send({ received: true });
}
