// worker/ingress/twilio/twilio-whatsapp-status.ts
//
// Twilio WhatsApp delivery status callback handler. Mounted by worker/index.ts
// at POST /ingress/twilio/whatsapp-status. Signature verify, dedup on
// `${MessageSid}:${MessageStatus}`, first-wins race guard on terminal state,
// reclaim if delivery row hasn't been inserted yet.
// notification_deliveries channel predicate is 'whatsapp'.

import type { FastifyRequest, FastifyReply } from 'fastify';
import { handleTwilioDeliveryStatus } from './twilio-delivery-status';
import { fullUrl, redactDeliveryStatusPayload } from './whatsapp-shared';

const LOG_PREFIX = '[ingress/twilio-whatsapp]';

export async function handleTwilioWhatsAppStatus(
  request: FastifyRequest,
  reply: FastifyReply,
): Promise<void> {
  return handleTwilioDeliveryStatus(request, reply, {
    channel: 'whatsapp',
    fullUrl,
    invalidSignatureMessage: 'invalid signature on status callback',
    logPrefix: LOG_PREFIX,
    redactPayload: redactDeliveryStatusPayload,
  });
}
