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

import { createHash } from 'node:crypto';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { sql } from '../../src/lib/db/server';
import { claimInboundEvent } from './shared';
import { verifyTelegramSecret } from './telegram-verify';
import { approveViaCallback, regenerateViaCallback } from '../../src/lib/approval/service';
import {
  ConsumedLinkError,
  RevokedLinkError,
  ExpiredLinkError,
  ChannelMismatchError,
} from '../../src/lib/approval/errors';
import { TelegramClient } from '../../src/lib/notifications/channels/telegram-client';

interface TelegramUpdate {
  update_id: number;
  message?: {
    from?: { id: number };
    chat?: { id: number };
    text?: string;
  };
  callback_query?: {
    id: string;
    from: { id: number };
    data?: string;
    message?: { chat: { id: number }; message_id: number };
  };
}

function parseCallbackData(data: string): { action: 'approve' | 'regenerate'; approvalLinkId: string } | null {
  if (data.startsWith('a:')) return { action: 'approve', approvalLinkId: data.slice(2) };
  if (data.startsWith('r:')) return { action: 'regenerate', approvalLinkId: data.slice(2) };
  return null;
}

function redactForAudit(update: TelegramUpdate): TelegramUpdate {
  const clone = JSON.parse(JSON.stringify(update)) as TelegramUpdate;
  if (clone.callback_query) clone.callback_query.data = '[redacted]';
  if (clone.message?.text?.startsWith('/start ')) clone.message.text = '[redacted]';
  return clone;
}

async function markProcessed(dedupKey: string): Promise<void> {
  await sql`
    UPDATE inbound_events
    SET status = 'processed', processed_at = NOW()
    WHERE external_event_key = ${dedupKey}
  `;
}

async function markFailed(dedupKey: string, reason: string): Promise<void> {
  await sql`
    UPDATE inbound_events
    SET status = 'failed', error_message = ${reason}
    WHERE external_event_key = ${dedupKey}
  `;
}

async function handleEnrollment(
  update: TelegramUpdate,
  dedupKey: string,
  client: TelegramClient,
): Promise<void> {
  const message = update.message!;
  const text = message.text ?? '';
  const rawToken = text.slice(7).trim(); // strip '/start '
  const chatId = String(message.from?.id ?? message.chat?.id ?? '');

  if (!rawToken || !chatId) {
    await client.sendMessage({ chat_id: chatId, text: 'This link is invalid or expired. Please request a new one from your RepWorth admin.' });
    await markProcessed(dedupKey);
    return;
  }

  const tokenHash = createHash('sha256').update(rawToken).digest('hex');
  const rows = await sql<{ id: string; business_id: string }[]>`
    SELECT id, business_id
    FROM channel_enrollments
    WHERE verification_token_hash = ${tokenHash}
      AND channel = 'telegram'
      AND status = 'pending_verification'
      AND verification_token_expires_at > NOW()
    FOR UPDATE
  `;

  const enrollment = rows[0];
  if (!enrollment) {
    await client.sendMessage({ chat_id: chatId, text: 'This link is invalid or expired. Please request a new one from your RepWorth admin.' });
    await markProcessed(dedupKey);
    return;
  }

  await sql`
    UPDATE channel_enrollments
    SET handle = ${chatId},
        status = 'verified',
        verified_at = NOW(),
        verification_token_hash = NULL,
        verification_token_expires_at = NULL,
        updated_at = NOW()
    WHERE id = ${enrollment.id}
  `;
  await client.sendMessage({
    chat_id: chatId,
    text: "✅ You're connected to RepWorth — we'll ping you here when a review needs approval.",
  });
  await markProcessed(dedupKey);
}

function messageForLinkError(err: Error): string {
  if (err instanceof ConsumedLinkError || err instanceof RevokedLinkError) {
    return 'This reply was just handled on another channel.';
  }
  if (err instanceof ExpiredLinkError) {
    return 'This approval link has expired — a new draft will arrive on the next review.';
  }
  if (err instanceof ChannelMismatchError) {
    return 'This approval is no longer valid.';
  }
  return 'This approval is no longer valid.';
}

async function handleCallback(
  update: TelegramUpdate,
  dedupKey: string,
  client: TelegramClient,
  reply: FastifyReply,
  ipAddress: string | null,
): Promise<void> {
  const cb = update.callback_query!;
  const chatId = String(cb.message?.chat.id ?? cb.from.id);
  const messageId = cb.message?.message_id ?? 0;

  // Parse callback data
  const parsed = cb.data ? parseCallbackData(cb.data) : null;
  if (!parsed) {
    await client.answerCallbackQuery({ callback_query_id: cb.id, text: 'Invalid action' });
    await markProcessed(dedupKey);
    reply.code(200).send({ ok: true });
    return;
  }

  // Invariant: approval link must be live and channel must match
  const linkRows = await sql<{ id: string; business_id: string; channel: string; consumed_at: Date | null; revoked_at: Date | null; expires_at: Date }[]>`
    SELECT id, business_id, channel, consumed_at, revoked_at, expires_at
    FROM approval_links
    WHERE id = ${parsed.approvalLinkId}
  `;
  const link = linkRows[0];
  const linkLive = !!link
    && link.channel === 'telegram'
    && link.consumed_at === null
    && link.revoked_at === null
    && new Date(link.expires_at) > new Date();

  if (!linkLive) {
    await client.answerCallbackQuery({ callback_query_id: cb.id, text: 'This approval is no longer valid — it may have been handled on another channel.' });
    await markProcessed(dedupKey);
    reply.code(200).send({ ok: true });
    return;
  }

  // Invariant: sender must be a verified enrollment for this business
  const senderId = String(cb.from.id);
  const enrollmentRows = await sql<{ handle: string }[]>`
    SELECT handle FROM channel_enrollments
    WHERE business_id = ${link.business_id}
      AND channel = 'telegram'
      AND status = 'verified'
      AND handle = ${senderId}
  `;
  if (enrollmentRows.length === 0) {
    await client.answerCallbackQuery({ callback_query_id: cb.id, text: 'This approval is no longer valid — it may have been handled on another channel.' });
    await markProcessed(dedupKey);
    reply.code(200).send({ ok: true });
    return;
  }

  // ACK BOUNDARY — Model A: fire ack BEFORE heavy transaction
  const ackText = parsed.action === 'approve' ? 'Approving…' : 'Regenerating — a new draft will follow shortly';
  await client.answerCallbackQuery({ callback_query_id: cb.id, text: ackText });

  // Service call — approval or regeneration
  try {
    if (parsed.action === 'approve') {
      await approveViaCallback({
        approvalLinkId: link.id,
        chatHandle: senderId,
        viaChannel: 'telegram',
        audit: { updateId: update.update_id, ipAddress },
      });
    } else {
      await regenerateViaCallback({
        approvalLinkId: link.id,
        chatHandle: senderId,
        viaChannel: 'telegram',
        audit: { updateId: update.update_id, ipAddress },
      });
    }
  } catch (err) {
    const e = err as Error;
    const isPermanent = e instanceof ConsumedLinkError
      || e instanceof RevokedLinkError
      || e instanceof ExpiredLinkError
      || e instanceof ChannelMismatchError;

    if (isPermanent) {
      await client.sendMessage({ chat_id: chatId, text: messageForLinkError(e) });
      await markProcessed(dedupKey);
      reply.code(200).send({ ok: true });
      return;
    }

    // Unexpected error — no URL embedded (raw token not in scope), owner uses the Edit button
    const fallback = '⚠️ Something went wrong on our end. Please tap the Edit link in the approval message above to finish approval in the browser.';
    await client.sendMessage({ chat_id: chatId, text: fallback });
    await markFailed(dedupKey, e.message);
    reply.code(503).send({ ok: false });
    return;
  }

  // Visible confirmation — edit calls are cosmetic; failures are silently ignored
  if (parsed.action === 'approve') {
    await client.editMessageText({
      chat_id: chatId,
      message_id: messageId,
      text: "✅ Response approved — we'll post it shortly.",
    }).catch(() => { /* cosmetic */ });
  } else {
    await client.editMessageReplyMarkup({
      chat_id: chatId,
      message_id: messageId,
      reply_markup: { inline_keyboard: [] },
    }).catch(() => { /* cosmetic */ });
  }

  await markProcessed(dedupKey);
  reply.code(200).send({ ok: true });
}

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
    await markProcessed(dedupKey);
    reply.code(200).send({ ok: true });
  } catch (err) {
    const msg = (err as Error).message ?? 'unknown';
    await markFailed(dedupKey, msg).catch(() => {});
    reply.code(503).send({ ok: false });
  }
}
