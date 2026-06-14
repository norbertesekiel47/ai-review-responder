// worker/ingress/telegram/telegram.ts
//
// Telegram webhook ingress — thin route orchestrator. Two flow modules:
//   - telegram-enrollment.ts: '/start <rawToken>' message → flip enrollment
//     status to verified, store chat_id as handle.
//   - telegram-callback.ts:   inline button tap → ack → approval/regenerate
//     transaction → editMessageText. Typed link-state errors → permanent
//     (markInboundEventProcessed). Unexpected errors → markInboundEventFailed
//     + 503 so the 2-min reclaim retries.
//
// Shared helpers (TelegramUpdate type, parseCallbackData, redactForAudit,
// messageForLinkError) live in telegram-shared.ts.
//
// Security invariants enforced here, before any business logic dispatches:
//   1. X-Telegram-Bot-Api-Secret-Token matches env (verifyTelegramSecret)
//   2. inbound_events dedup by update_id (claimInboundEvent)
//
// Flow-module invariants (channel='telegram' on approval_links, sender is a
// verified enrollment for the link's business, etc.) live in the per-flow
// files alongside the code that enforces them.

import type { FastifyReply, FastifyRequest } from 'fastify';
import { claimInboundEvent, markInboundEventProcessed, markInboundEventFailed } from '../shared';
import { verifyTelegramSecret } from './telegram-verify';
import { TelegramClient } from '../../../src/lib/notifications/channels/telegram-client';
import { type TelegramUpdate, redactForAudit } from './telegram-shared';
import { handleEnrollment } from './telegram-enrollment';
import { handleCallback } from './telegram-callback';
import { handleConversationalMessage } from '../conversational-seam';

export async function handleTelegramWebhook(
  request: FastifyRequest,
  reply: FastifyReply,
): Promise<void> {
  // Step 1: signature verification — runs before any work, including dedup.
  const secretHeader = request.headers['x-telegram-bot-api-secret-token'];
  const headerValue = typeof secretHeader === 'string' ? secretHeader : undefined;
  if (!verifyTelegramSecret(headerValue)) {
    reply.code(401).send({ ok: false });
    return;
  }

  // Step 2: shape check — anything without a numeric update_id is malformed.
  const update = request.body as TelegramUpdate;
  if (!update || typeof update.update_id !== 'number') {
    reply.code(400).send({ ok: false });
    return;
  }

  const dedupKey = `tg:${update.update_id}`;
  const eventType = update.callback_query
    ? 'callback_query'
    : update.message?.text?.startsWith('/start ')
      ? 'enrollment_start'
      : 'conversational_message';

  // Step 3: dedup claim with redacted payload (PII-stripped audit row).
  const claim = await claimInboundEvent('telegram', dedupKey, eventType, redactForAudit(update));
  if (claim === 'duplicate') {
    reply.code(200).send({ ok: true });
    return;
  }

  // Step 4: dispatch by update type. Each flow module owns its own
  // markInboundEventProcessed / markInboundEventFailed terminal calls; this
  // orchestrator only catches truly unexpected throws (DB outage, etc.) so
  // the inbound_events row never gets stuck in 'received'.
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
    if (typeof update.message?.text === 'string') {
      // Non-command, non-button free text to the bot → future-agent seam.
      // No-op today (auth-gated, no reply); the body is already redacted in
      // the inbound_events payload by redactForAudit.
      await handleConversationalMessage({
        channel: 'telegram',
        senderHandle: String(update.message.chat?.id ?? update.message.from?.id ?? ''),
      });
      await markInboundEventProcessed(dedupKey);
      reply.code(200).send({ ok: true });
      return;
    }
    // Unknown update type (edited message, channel post, …) — silent 200.
    await markInboundEventProcessed(dedupKey);
    reply.code(200).send({ ok: true });
  } catch (err) {
    const msg = (err as Error).message ?? 'unknown';
    await markInboundEventFailed(dedupKey, msg).catch(() => {});
    reply.code(503).send({ ok: false });
  }
}
