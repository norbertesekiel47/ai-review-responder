// worker/ingress/twilio/twilio-delivery-status.ts
//
// Shared Twilio delivery-status state machine. WhatsApp provides the
// channel-specific adapter values; this module owns signature verification,
// dedup, first-terminal-wins delivery updates, and inbound_event finalization.

import type { FastifyReply, FastifyRequest } from 'fastify';
import { sql } from '../../../src/lib/db/server';
import {
  claimInboundEvent,
  markInboundEventFailed,
  markInboundEventProcessed,
} from '../shared';
import { parseTwilioBody, verifyTwilioSignature } from './twilio-verify';

type DeliveryChannel = 'sms' | 'whatsapp';

interface DeliveryStatusOptions {
  channel: DeliveryChannel;
  fullUrl: (request: FastifyRequest) => string;
  invalidSignatureMessage: string;
  logPrefix: string;
  logUnknownNonTerminal?: boolean;
}

const TERMINAL_STATUSES = new Set(['delivered', 'undelivered', 'failed']);
const KNOWN_NON_TERMINAL_STATUSES = new Set(['queued', 'sending', 'sent']);

export async function handleTwilioDeliveryStatus(
  request: FastifyRequest,
  reply: FastifyReply,
  options: DeliveryStatusOptions,
): Promise<void> {
  const rawBody = (request as unknown as { rawBody?: string }).rawBody ?? '';
  const params = parseTwilioBody(rawBody);
  const sig = request.headers['x-twilio-signature'] as string | undefined;

  if (
    !verifyTwilioSignature({
      authToken: process.env.TWILIO_AUTH_TOKEN,
      signatureHeader: sig,
      fullUrl: options.fullUrl(request),
      params,
    })
  ) {
    console.warn(`${options.logPrefix} ${options.invalidSignatureMessage}`);
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

  if (!TERMINAL_STATUSES.has(MessageStatus)) {
    if (options.logUnknownNonTerminal && !KNOWN_NON_TERMINAL_STATUSES.has(MessageStatus)) {
      console.log(`${options.logPrefix} Unknown MessageStatus ${MessageStatus} for ${MessageSid}`);
    }
    await markInboundEventProcessed(dedupKey);
    reply.status(200).send({ received: true });
    return;
  }

  const [row] = await sql<{ id: string; delivered_at: Date | null; failed_at: Date | null }[]>`
    SELECT id, delivered_at, failed_at FROM notification_deliveries
    WHERE external_message_id = ${MessageSid} AND channel = ${options.channel}
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
      UPDATE notification_deliveries
      SET delivered_at = NOW()
      WHERE id = ${row.id} AND channel = ${options.channel} AND delivered_at IS NULL AND failed_at IS NULL
    `;
  } else {
    await sql`
      UPDATE notification_deliveries
      SET failed_at = NOW(), failure_reason = ${`twilio:${ErrorCode ?? 'unknown'}`}
      WHERE id = ${row.id} AND channel = ${options.channel} AND delivered_at IS NULL AND failed_at IS NULL
    `;
  }

  await markInboundEventProcessed(dedupKey);
  reply.status(200).send({ received: true });
}
