// worker/ingress/zernio/zernio.ts
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
//        review.new           → processReviewEvent fan-out (§4.3)
//        review.updated       → processReviewEvent fan-out (§4.3)
//        webhook.test         → log + 200
//        default              → log unhandled, 200
//   6. Mark inbound_events processed
//   7. On exception: mark failed + 500 (Zernio retries 7x over 51h)

import type { FastifyRequest, FastifyReply } from 'fastify';
import { sql } from '../../../src/lib/db/server';
import { claimInboundEvent } from '../shared';
import { verifyZernioSignature } from './zernio-verify';
import {
  parseZernioReviewWebhook,
  ZernioReviewWebhookParseError,
} from '../../../src/lib/zernio/parse-review-webhook';
import { SKIP_REASON_ARCHIVED_LOCATION } from '../../../src/lib/shared/worker-types';

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
    // Teardown reconciliation, intentionally narrowed to SINGLE-account snapshots.
    //
    // `zernio_accounts_step` is one outcome for the whole `zernio_account_ids`
    // array, and there is no per-account reconciliation column. A single
    // account.disconnected event therefore can only PROVE the step is done when
    // that account is the entire snapshot (cardinality = 1). For multi-account
    // snapshots one disconnect says nothing about the others, so we do NOT stamp
    // here — the authoritative, idempotent driver is `runZernioTeardown`'s provider
    // DELETE loop (404/410 ⇒ success). The webhook still suppresses the
    // connection-lost notification for multi-account teardowns (below) so an owner
    // mid-offboarding is not paged about an expected disconnect.
    const teardownReconciled = await tx`
      UPDATE account_offboardings
      SET zernio_accounts_step = 'success',
          updated_at = NOW()
      WHERE status = 'tearing_down'
        AND teardown_started_at IS NOT NULL
        AND teardown_completed_at IS NULL
        AND terminal_at IS NULL
        AND zernio_accounts_step <> 'success'
        AND cardinality(zernio_account_ids) = 1
        AND ${accountId} = ANY(zernio_account_ids)
    `;

    if ((teardownReconciled.count ?? 0) > 0) {
      console.log(`${LOG_PREFIX} account.disconnected reconciled active teardown for account=${accountId}`);
      return;
    }

    const [activeTeardown] = await tx<{ id: string }[]>`
      SELECT id
      FROM account_offboardings
      WHERE status = 'tearing_down'
        AND teardown_started_at IS NOT NULL
        AND teardown_completed_at IS NULL
        AND terminal_at IS NULL
        AND zernio_accounts_step <> 'success'
        AND ${accountId} = ANY(zernio_account_ids)
      LIMIT 1
    `;

    if (activeTeardown) {
      console.log(
        `${LOG_PREFIX} account.disconnected matched active multi-account teardown for account=${accountId} — skipping connection-lost notification`,
      );
      return;
    }

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

/**
 * Handle review.new / review.updated per spec §4.3: parse the payload, then
 * emit one ingest_zernio_review outbox row per active connection at the
 * firing Zernio account. When the payload carries a parseable location,
 * narrow the fan-out to that exact location to avoid sibling businesses at
 * the same account walking listReviews + escalating to review_exceptions on
 * every webhook. Account-wide fallback only when payload has no location
 * segment. A 0-row fan-out is disambiguated (best-effort) by the archived
 * probe so ops doesn't chase a phantom unconnected warn for an expected
 * archived skip.
 */
async function processReviewEvent(
  eventType: string,
  eventId: string,
  body: ZernioWebhookBody,
): Promise<void> {
  let parsed;
  try {
    parsed = parseZernioReviewWebhook(body);
  } catch (err) {
    if (err instanceof ZernioReviewWebhookParseError) {
      console.warn(`${LOG_PREFIX} ${eventType} unparseable: ${err.message}`);
      return;  // 200 OK — Zernio shouldn't retry malformed payloads
    }
    throw err;
  }

  console.log(
    `${LOG_PREFIX} ${eventType} received eventId=${eventId} account=${parsed.accountId} review=${parsed.reviewId}` +
      (parsed.locationIdFromPayload ? ` location=${parsed.locationIdFromPayload}` : ' (account-wide fan-out)'),
  );

  // ON CONFLICT DO NOTHING dedups against any non-terminal outbox
  // row already in flight for the same (business, zernio_review_id).
  // Migration 030's partial unique index is the conflict target.
  // Without this, Zernio's webhook retry on worker crash would
  // produce duplicate outbox rows that all do the same listReviews
  // walk → wasted Zernio API quota.
  //
  // One query for both lanes: the only difference between the
  // location-scoped and account-wide fan-out is the location
  // predicate, composed as a conditional Postgres.js fragment.
  const locationFilter = parsed.locationIdFromPayload
    ? sql`AND zc.zernio_location_id = ${parsed.locationIdFromPayload}`
    : sql``;
  const fanoutResult = await sql`
    INSERT INTO job_outbox (id, topic, aggregate_type, aggregate_id, payload, status)
    SELECT
      gen_random_uuid(),
      'ingest_zernio_review',
      'business',
      zc.business_id,
      jsonb_build_object(
        'business_id', zc.business_id,
        'zernio_account_id', ${parsed.accountId}::text,
        'zernio_location_id', zc.zernio_location_id,
        'zernio_review_id', ${parsed.reviewId}::text,
        'correlation_id', ${eventId}::text
      ),
      'pending'
    FROM zernio_connections zc
    JOIN businesses b ON b.id = zc.business_id AND b.archived_at IS NULL
    WHERE zc.zernio_account_id = ${parsed.accountId}
      AND zc.status = 'active'
      ${locationFilter}
    ON CONFLICT (aggregate_id, (payload->>'zernio_review_id'))
      WHERE topic = 'ingest_zernio_review'
        AND status IN ('pending', 'dispatching', 'dispatched')
    DO NOTHING
  `;
  const inserted = fanoutResult.count ?? 0;
  if (inserted > 0) {
    console.log(`${LOG_PREFIX} ${eventType} fan-out enqueued ${inserted} outbox row(s)`);
    return;
  }

  // Pure observability AFTER the primary side effect (the fan-out INSERT
  // committed above), so it gets its own try/catch (log-and-swallow): a
  // transient DB blip during the probe must not flip an already-succeeded
  // event to failed → 500 → Zernio retry.
  try {
    // Archived locations intentionally keep status='active' connections
    // (for reactivation backfill), so a 0-row fan-out means "nobody has
    // connected this account/location", "the connected location is
    // archived", or an ON CONFLICT dedup against an in-flight outbox row
    // (possibly alongside an archived sibling). The EXISTS probe only
    // proves an archived connection is PRESENT — it cannot rule out the
    // dedup case — so the log claims exactly that, no more.
    const [archivedCheck] = await sql<{ archived_match: boolean }[]>`
      SELECT EXISTS (
        SELECT 1
        FROM zernio_connections zc
        JOIN businesses b ON b.id = zc.business_id
        WHERE zc.zernio_account_id = ${parsed.accountId}
          AND zc.status = 'active'
          ${locationFilter}
          AND b.archived_at IS NOT NULL
      ) AS archived_match
    `;
    if (archivedCheck?.archived_match) {
      console.log(
        `${LOG_PREFIX} ${eventType} fan-out inserted 0 rows; archived connection(s) present for account=${parsed.accountId}` +
          (parsed.locationIdFromPayload ? ` location=${parsed.locationIdFromPayload}` : '') +
          ` — skipped`,
        { reason: SKIP_REASON_ARCHIVED_LOCATION },
      );
    } else {
      console.warn(
        `${LOG_PREFIX} ${eventType} fan-out matched 0 active connections for account=${parsed.accountId}` +
          (parsed.locationIdFromPayload ? ` location=${parsed.locationIdFromPayload}` : '') +
          ` — webhook ignored (no business has connected this account/location)`,
      );
    }
  } catch (probeErr) {
    console.warn(
      `${LOG_PREFIX} ${eventType} fan-out inserted 0 rows for account=${parsed.accountId}; ` +
        `archived-vs-unconnected probe failed (event already processed): ${probeErr instanceof Error ? probeErr.message : probeErr}`,
    );
  }
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
  //
  // Future-proof: tolerate Stripe/GitHub-style 'sha256=' prefix in case
  // Zernio ever changes its signature shape. Strip the prefix before
  // verification so the verifier sees a bare hex string either way.
  const HEX_64 = /^[0-9a-f]{64}$/i;
  const strippedSignature = signature.startsWith('sha256=')
    ? signature.slice('sha256='.length)
    : signature;
  if (!strippedSignature || !HEX_64.test(strippedSignature)) {
    console.warn(`${LOG_PREFIX} Missing or malformed x-zernio-signature header`);
    reply.status(401).send({ error: 'invalid_signature_format' });
    return;
  }

  if (!verifyZernioSignature(rawBody, strippedSignature, webhookSecret)) {
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
      case 'review.updated':
        await processReviewEvent(eventType, eventId, body);
        break;

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
