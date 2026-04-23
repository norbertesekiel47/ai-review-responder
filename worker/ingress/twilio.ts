// worker/ingress/twilio.ts
//
// Twilio webhook ingress. Phase 1 exports the status-callback handler
// (used by the Messaging Service statusCallback URL on every outbound send).
// Task 13 will append the inbound-message handler (STOP/START webhooks).
//
// Shared scaffolding:
//   - Signature verification via twilio-verify.ts
//   - Dedup lease via inbound_events (matches worker/ingress/resend.ts pattern)
//   - fullUrl built from WORKER_PUBLIC_URL + request.url (Railway terminates TLS upstream)

import type { FastifyRequest, FastifyReply } from 'fastify';
import { v7 as uuidv7 } from 'uuid';
import { sql, jsonb } from '../../src/lib/db/server';
import { claimInboundEvent } from './shared';
import { parseTwilioBody, verifyTwilioSignature } from './twilio-verify';

const LOG_PREFIX = '[ingress/twilio]';

function fullUrl(request: FastifyRequest): string {
  return `${process.env.WORKER_PUBLIC_URL}${request.url}`;
}

/**
 * Twilio Messaging Service statusCallback handler.
 *
 * Dedup key: `${MessageSid}:${MessageStatus}` — each status transition is a
 * separate dedupable event.
 *
 * Flow:
 *   - Verify X-Twilio-Signature (401 on mismatch, no DB side-effects).
 *   - Claim inbound_event (duplicate → 200 silently).
 *   - Parse MessageStatus:
 *     - Intermediate (queued/sending/sent): mark processed + 200.
 *     - Unknown: log + mark processed + 200.
 *     - Terminal (delivered/undelivered/failed):
 *       - No delivery row → mark failed + 503 (dedup reclaim will retry).
 *       - Row has existing terminal timestamp → first-wins: mark processed + 200.
 *       - Row exists, non-terminal: UPDATE with inline race guard.
 *   - Mark processed + 200.
 */
export async function handleTwilioStatusCallback(
  request: FastifyRequest,
  reply: FastifyReply,
): Promise<void> {
  const rawBody = (request as unknown as { rawBody?: string }).rawBody ?? '';
  const params = parseTwilioBody(rawBody);
  const sig = request.headers['x-twilio-signature'] as string | undefined;

  if (
    !verifyTwilioSignature({
      authToken: process.env.TWILIO_AUTH_TOKEN,
      signatureHeader: sig,
      fullUrl: fullUrl(request),
      params,
    })
  ) {
    console.warn(`${LOG_PREFIX} Invalid signature on status callback`);
    reply.status(401).send({ error: 'invalid_signature' });
    return;
  }

  const { MessageSid, MessageStatus, ErrorCode } = params;
  if (!MessageSid || !MessageStatus) {
    reply.status(400).send({ error: 'missing_fields' });
    return;
  }

  const dedupKey = `${MessageSid}:${MessageStatus}`;
  const claim = await claimInboundEvent('twilio', dedupKey, `status:${MessageStatus}`, params);
  if (claim === 'duplicate') {
    reply.status(200).send({ received: true, duplicate: true });
    return;
  }

  const isTerminal =
    MessageStatus === 'delivered' || MessageStatus === 'undelivered' || MessageStatus === 'failed';

  if (!isTerminal) {
    if (!(MessageStatus === 'queued' || MessageStatus === 'sending' || MessageStatus === 'sent')) {
      console.log(`${LOG_PREFIX} Unknown MessageStatus ${MessageStatus} for ${MessageSid}`);
    }
    await sql`
      UPDATE inbound_events SET status = 'processed', processed_at = NOW()
      WHERE external_event_key = ${dedupKey}
    `;
    reply.status(200).send({ received: true });
    return;
  }

  const [row] = await sql<{ id: string; delivered_at: Date | null; failed_at: Date | null }[]>`
    SELECT id, delivered_at, failed_at FROM notification_deliveries
    WHERE external_message_id = ${MessageSid} AND channel = 'sms'
    LIMIT 1
  `;

  if (!row) {
    // Terminal status arrived before our dispatcher INSERTed the sent_at row.
    // Mark inbound_event failed so dedup-reclaim picks up Twilio's retry.
    await sql`
      UPDATE inbound_events
      SET status = 'failed', error_message = 'delivery_row_not_yet_present'
      WHERE external_event_key = ${dedupKey}
    `;
    reply.status(503).send({ received: true, retry: 'delivery_row_not_yet_present' });
    return;
  }

  if (row.delivered_at || row.failed_at) {
    // First-wins: another terminal status already landed, preserve it.
    await sql`
      UPDATE inbound_events SET status = 'processed', processed_at = NOW()
      WHERE external_event_key = ${dedupKey}
    `;
    reply.status(200).send({ received: true, terminal_state_preserved: true });
    return;
  }

  if (MessageStatus === 'delivered') {
    await sql`
      UPDATE notification_deliveries
      SET delivered_at = NOW()
      WHERE id = ${row.id} AND channel = 'sms' AND delivered_at IS NULL AND failed_at IS NULL
    `;
  } else {
    await sql`
      UPDATE notification_deliveries
      SET failed_at = NOW(), failure_reason = ${`twilio:${ErrorCode ?? 'unknown'}`}
      WHERE id = ${row.id} AND channel = 'sms' AND delivered_at IS NULL AND failed_at IS NULL
    `;
  }

  await sql`
    UPDATE inbound_events SET status = 'processed', processed_at = NOW()
    WHERE external_event_key = ${dedupKey}
  `;
  reply.status(200).send({ received: true });
}

// ─────────────────────────────────────────────────────────────────────
// Inbound SMS handler (STOP/START + miscellaneous)
// ─────────────────────────────────────────────────────────────────────

/**
 * STOP keyword set: Twilio's built-in keywords plus common English synonyms
 * and Spanish equivalents (Twilio natively handles ES STOP keywords on
 * Messaging Services in ES locale; we mirror them here so the handler works
 * identically if OptOutType is absent, e.g. some regional carrier routes).
 */
const STOP_KEYWORDS = new Set([
  'STOP', 'STOPALL', 'UNSUBSCRIBE', 'CANCEL', 'END', 'QUIT', 'REVOKE', 'OPTOUT',
  'PARE', 'PARAR', 'PARARLO', 'CANCELAR', 'DESUSCRIBIR', 'DETENER',
]);
const START_KEYWORDS = new Set(['START', 'UNSTOP', 'YES', 'ARRANCAR']);

type InboundIntent = 'stop' | 'start' | 'none';
type IntentSource = 'twilio_optouttype' | 'twilio_inbound_keyword' | '';

function classifyIntent(
  params: Record<string, string>,
): { intent: InboundIntent; source: IntentSource } {
  const optOutType = params.OptOutType;
  if (optOutType === 'STOP') return { intent: 'stop', source: 'twilio_optouttype' };
  if (optOutType === 'START' || optOutType === 'UNSTOP') {
    return { intent: 'start', source: 'twilio_optouttype' };
  }

  // Strip leading/trailing non-letters to handle punctuation like "STOP!" or
  // "  stop.", then take the first whitespace-delimited token.
  const body = (params.Body ?? '').trim().toUpperCase().replace(/^[^A-Z]+|[^A-Z]+$/g, '');
  const first = body.split(/\s+/)[0] ?? '';
  if (STOP_KEYWORDS.has(first)) return { intent: 'stop', source: 'twilio_inbound_keyword' };
  if (START_KEYWORDS.has(first)) return { intent: 'start', source: 'twilio_inbound_keyword' };
  return { intent: 'none', source: '' };
}

/**
 * Redact Body before persisting: inbound_events.payload retains every other
 * Twilio field (From, MessageSid, OptOutType, etc.) for debugging + TCPA
 * evidence, but the message text itself is dropped to avoid storing whatever
 * the sender typed. The intent classifier reads params BEFORE redaction, so
 * keyword detection is unaffected.
 */
function redactedPayload(params: Record<string, string>): Record<string, string> {
  return { ...params, Body: '[redacted]' };
}

/**
 * Inbound SMS handler. Receives every inbound message Twilio routes to our
 * Messaging Service number.
 *
 * Flow (signature-verified, deduped):
 *   - intent='stop':  sms_sender_opt_outs UPSERT + audit event + channel_enrollments flip
 *                     (all in one txn; sender-wide fan-out across businesses)
 *   - intent='start': sms_sender_opt_outs UPDATE opted_in_at + audit event
 *                     (channel_enrollments NOT flipped — admin must re-verify via /verify)
 *   - intent='none':  log + no state change, still mark inbound_event processed
 */
export async function handleTwilioInbound(
  request: FastifyRequest,
  reply: FastifyReply,
): Promise<void> {
  const rawBody = (request as unknown as { rawBody?: string }).rawBody ?? '';
  const params = parseTwilioBody(rawBody);
  const sig = request.headers['x-twilio-signature'] as string | undefined;

  if (
    !verifyTwilioSignature({
      authToken: process.env.TWILIO_AUTH_TOKEN,
      signatureHeader: sig,
      fullUrl: fullUrl(request),
      params,
    })
  ) {
    console.warn(`${LOG_PREFIX} Invalid signature on inbound SMS`);
    reply.status(401).send({ error: 'invalid_signature' });
    return;
  }

  const { MessageSid, From, MessagingServiceSid } = params;
  if (!MessageSid || !From) {
    reply.status(400).send({ error: 'missing_fields' });
    return;
  }
  const msid = MessagingServiceSid || process.env.TWILIO_MESSAGING_SERVICE_SID || '';

  const dedupKey = MessageSid;
  const claim = await claimInboundEvent('twilio', dedupKey, 'inbound_sms', redactedPayload(params));
  if (claim === 'duplicate') {
    reply.status(200).send({ received: true, duplicate: true });
    return;
  }

  const [inboundRow] = await sql<{ id: string }[]>`
    SELECT id FROM inbound_events WHERE external_event_key = ${dedupKey} LIMIT 1
  `;
  const inboundEventId = inboundRow?.id ?? null;

  const { intent, source } = classifyIntent(params);

  try {
    if (intent === 'stop') {
      await sql.begin(async (tx) => {
        await tx`
          INSERT INTO sms_sender_opt_outs (messaging_service_sid, handle, opted_out_at, opted_in_at, last_event_at)
          VALUES (${msid}, ${From}, NOW(), NULL, NOW())
          ON CONFLICT (messaging_service_sid, handle) DO UPDATE
            SET opted_out_at = EXCLUDED.opted_out_at,
                opted_in_at = NULL,
                last_event_at = EXCLUDED.last_event_at
        `;
        await tx`
          INSERT INTO sms_sender_opt_out_events (id, messaging_service_sid, handle, event_type, source, inbound_event_id)
          VALUES (${uuidv7()}, ${msid}, ${From}, 'stop', ${source}, ${inboundEventId})
        `;
        await tx`
          UPDATE channel_enrollments
          SET status = 'unsubscribed',
              unsubscribed_at = COALESCE(unsubscribed_at, NOW()),
              unsubscribed_reason = COALESCE(unsubscribed_reason, 'sms_stop'),
              updated_at = NOW()
          WHERE handle = ${From} AND channel = 'sms' AND archived_at IS NULL
        `;
      });
    } else if (intent === 'start') {
      // Audit event is written UNCONDITIONALLY inside the txn, even if the
      // UPDATE affects 0 rows (spontaneous START without prior STOP is still
      // a TCPA-relevant intent signal). channel_enrollments is intentionally
      // NOT flipped: admins must re-verify the handle through /verify before
      // the channel is usable again.
      await sql.begin(async (tx) => {
        await tx`
          UPDATE sms_sender_opt_outs
          SET opted_in_at = NOW(), last_event_at = NOW()
          WHERE messaging_service_sid = ${msid} AND handle = ${From} AND opted_out_at IS NOT NULL
        `;
        await tx`
          INSERT INTO sms_sender_opt_out_events (id, messaging_service_sid, handle, event_type, source, inbound_event_id)
          VALUES (${uuidv7()}, ${msid}, ${From}, 'start', ${source}, ${inboundEventId})
        `;
      });
    } else {
      console.log(`${LOG_PREFIX} Non-keyword inbound from ${From} (MessageSid=${MessageSid})`);
    }

    await sql`
      UPDATE inbound_events SET status = 'processed', processed_at = NOW()
      WHERE external_event_key = ${dedupKey}
    `;
    reply.status(200).send({ received: true });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`${LOG_PREFIX} inbound processing failed: ${msg}`);
    await sql`
      UPDATE inbound_events SET status = 'failed', error_message = ${msg}
      WHERE external_event_key = ${dedupKey}
    `;
    reply.status(503).send({ received: true, retry: true });
  }
}
