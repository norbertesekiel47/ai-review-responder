// worker/ingress/twilio-whatsapp.ts
//
// Twilio WhatsApp webhook ingress — sibling file to worker/ingress/twilio.ts.
// Two Fastify handlers registered at different routes:
//
//   POST /ingress/twilio/whatsapp-status  — delivery status callbacks
//   POST /ingress/twilio/whatsapp-inbound — inbound messages (enrollment + button taps + STOP)
//                                           (added in Task 10)
//
// Separation from SMS handlers is deliberate — SMS handler logic in
// worker/ingress/twilio.ts is untouched aside from the twilio-intent import.
// SMS route tests remain the regression safety net.

import type { FastifyRequest, FastifyReply } from 'fastify';
import { sql } from '../../src/lib/db/server';
import { claimInboundEvent } from './shared';
import { parseTwilioBody, verifyTwilioSignature } from './twilio-verify';

const LOG_PREFIX = '[ingress/twilio-whatsapp]';

function fullUrl(request: FastifyRequest): string {
  return `${process.env.WORKER_PUBLIC_URL}${request.url}`;
}

// Redaction helper (also used by the inbound handler in Task 10). Exported
// for unit tests.
export function redactWhatsAppPayload(params: Record<string, string>): Record<string, string> {
  const out = { ...params };
  if ('Body' in out) out.Body = '[redacted]';
  if ('ButtonPayload' in out) out.ButtonPayload = '[redacted]';
  delete out.ProfileName;
  delete out.WaId;
  return out;
}

/**
 * Status callback for WhatsApp template sends. Mirrors the SMS pattern at
 * worker/ingress/twilio.ts (handleTwilioStatusCallback) — signature verify,
 * dedup on `${MessageSid}:${MessageStatus}`, first-wins race guard on terminal
 * state, reclaim if delivery row hasn't been inserted yet. Only delta from
 * SMS handler: the notification_deliveries channel predicate is 'whatsapp'.
 */
export async function handleTwilioWhatsAppStatus(
  request: FastifyRequest,
  reply: FastifyReply,
): Promise<void> {
  const rawBody = (request as unknown as { rawBody?: string }).rawBody ?? '';
  const params = parseTwilioBody(rawBody);
  const sig = request.headers['x-twilio-signature'] as string | undefined;

  if (!verifyTwilioSignature({
    authToken: process.env.TWILIO_AUTH_TOKEN,
    signatureHeader: sig,
    fullUrl: fullUrl(request),
    params,
  })) {
    console.warn(`${LOG_PREFIX} invalid signature on status callback`);
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
    await sql`
      UPDATE inbound_events SET status = 'processed', processed_at = NOW()
      WHERE external_event_key = ${dedupKey}
    `;
    reply.status(200).send({ received: true });
    return;
  }

  const [row] = await sql<{ id: string; delivered_at: Date | null; failed_at: Date | null }[]>`
    SELECT id, delivered_at, failed_at FROM notification_deliveries
    WHERE external_message_id = ${MessageSid} AND channel = 'whatsapp'
    LIMIT 1
  `;
  if (!row) {
    await sql`
      UPDATE inbound_events SET status = 'failed', error_message = 'delivery_row_not_yet_present'
      WHERE external_event_key = ${dedupKey}
    `;
    reply.status(503).send({ received: true, retry: 'delivery_row_not_yet_present' });
    return;
  }
  if (row.delivered_at || row.failed_at) {
    await sql`
      UPDATE inbound_events SET status = 'processed', processed_at = NOW()
      WHERE external_event_key = ${dedupKey}
    `;
    reply.status(200).send({ received: true, terminal_state_preserved: true });
    return;
  }

  if (MessageStatus === 'delivered') {
    await sql`
      UPDATE notification_deliveries SET delivered_at = NOW()
      WHERE id = ${row.id} AND channel = 'whatsapp' AND delivered_at IS NULL AND failed_at IS NULL
    `;
  } else {
    await sql`
      UPDATE notification_deliveries SET failed_at = NOW(), failure_reason = ${`twilio:${ErrorCode ?? 'unknown'}`}
      WHERE id = ${row.id} AND channel = 'whatsapp' AND delivered_at IS NULL AND failed_at IS NULL
    `;
  }
  await sql`
    UPDATE inbound_events SET status = 'processed', processed_at = NOW()
    WHERE external_event_key = ${dedupKey}
  `;
  reply.status(200).send({ received: true });
}

// handleTwilioWhatsAppInbound is added in Task 10
