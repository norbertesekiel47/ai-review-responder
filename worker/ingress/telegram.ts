// worker/ingress/telegram.ts
//
// Telegram webhook ingress. Two paths:
//   A. Enrollment — message.text starts with '/start <rawToken>'.
//      Looks up channel_enrollments by SHA-256(token), flips to verified,
//      stores chat_id as handle.
//   B. Callback_query — inline button tap. Model A ack ordering:
//      cheap validation → answerCallbackQuery → approval transaction →
//      editMessage* for visible confirmation. Errors classified as
//      permanent link-state (typed errors → processed, not failed) vs
//      unexpected (→ failed, reclaim retries).
//
// Security invariants enforced on every callback:
//   1. X-Telegram-Bot-Api-Secret-Token matches env
//   2. inbound_events dedup by update_id
//   3. approval_links row live AND channel='telegram'
//   4. callback_query.from.id matches a verified telegram enrollment
//      for the link's business_id

import type { FastifyReply, FastifyRequest } from 'fastify';
import { claimInboundEvent, markInboundEventProcessed, markInboundEventFailed } from './shared';
import { verifyTelegramSecret } from './telegram-verify';
import { TelegramClient } from '../../src/lib/notifications/channels/telegram-client';
import { type TelegramUpdate, redactForAudit } from './telegram-shared';
import { handleEnrollment } from './telegram-enrollment';
import { handleCallback } from './telegram-callback';

export async function handleTelegramWebhook(
  request: FastifyRequest,
  reply: FastifyReply,
): Promise<void> {
  // Step 1: signature verification
  const secretHeader = request.headers['x-telegram-bot-api-secret-token'];
  const headerValue = typeof secretHeader === 'string' ? secretHeader : undefined;
  if (!verifyTelegramSecret(headerValue)) {
    reply.code(401).send({ ok: false });
    return;
  }

  const update = request.body as TelegramUpdate;
  if (!update || typeof update.update_id !== 'number') {
    reply.code(400).send({ ok: false });
    return;
  }
  const dedupKey = `tg:${update.update_id}`;
  const eventType = update.callback_query ? 'callback_query' : 'enrollment_start';

  // Step 2: dedup claim with redacted payload
  const claim = await claimInboundEvent('telegram', dedupKey, eventType, redactForAudit(update));
  if (claim === 'duplicate') {
    reply.code(200).send({ ok: true });
    return;
  }

  const client = new TelegramClient();
  const ipAddress: string | null = request.ip ?? null;

  try {
    if (update.callback_query) {
      await handleCallback(update, dedupKey, client, reply, ipAddress);
      return;
    }
    if (update.message?.text?.startsWith('/start ')) {
      await handleEnrollment(update, dedupKey, client);
      reply.code(200).send({ ok: true });
      return;
    }
    // Unknown update type — silent 200, mark processed
    await markInboundEventProcessed(dedupKey);
    reply.code(200).send({ ok: true });
  } catch (err) {
    const msg = (err as Error).message ?? 'unknown';
    await markInboundEventFailed(dedupKey, msg).catch(() => {});
    reply.code(503).send({ ok: false });
  }
}
