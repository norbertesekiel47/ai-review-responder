// worker/ingress/twilio/twilio-whatsapp-status.ts
//
// Twilio WhatsApp delivery status callback handler. Mounted by worker/index.ts
// at POST /ingress/twilio/whatsapp-status. Mirrors the SMS status pattern in
// worker/ingress/twilio.ts (handleTwilioStatusCallback) — signature verify,
// dedup on `${MessageSid}:${MessageStatus}`, first-wins race guard on terminal
// state, reclaim if delivery row hasn't been inserted yet. Only delta from
// the SMS handler: the notification_deliveries channel predicate is 'whatsapp'.

import type { FastifyRequest, FastifyReply } from 'fastify';
import { sql } from '../../../src/lib/db/server';
import {
  claimInboundEvent,
  markInboundEventProcessed,
  markInboundEventFailed,
} from '../shared';
import { parseTwilioBody, verifyTwilioSignature } from './twilio-verify';
import { fullUrl } from './whatsapp-shared';

const LOG_PREFIX = '[ingress/twilio-whatsapp]';

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
    await markInboundEventProcessed(dedupKey);
    reply.status(200).send({ received: true });
    return;
  }

  const [row] = await sql<{ id: string; delivered_at: Date | null; failed_at: Date | null }[]>`
    SELECT id, delivered_at, failed_at FROM notification_deliveries
    WHERE external_message_id = ${MessageSid} AND channel = 'whatsapp'
    LIMIT 1
  `;
  if (!row) {
    await markInboundEventFailed(dedupKey, 'delivery_row_not_yet_present');
    reply.status(503).send({ received: true, retry: 'delivery_row_not_yet_present' });
    return;
  }
  if (row.delivered_at || row.failed_at) {
    await markInboundEventProcessed(dedupKey);
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
  await markInboundEventProcessed(dedupKey);
  reply.status(200).send({ received: true });
}
