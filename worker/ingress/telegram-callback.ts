// worker/ingress/telegram-callback.ts
//
// Telegram callback_query flow — invoked when an owner taps an Approve /
// Regenerate inline button on a notification. Model A ack ordering:
//   1. cheap validation (parse data, look up approval_link, look up enrollment)
//   2. answerCallbackQuery (toast banner)
//   3. approval / regeneration transaction
//   4. editMessageText for visible confirmation
//
// Error classification:
//   - Permanent link-state errors (ConsumedLinkError, RevokedLinkError,
//     ExpiredLinkError, ChannelMismatchError, ResponseNotPendingError)
//     → markInboundEventProcessed, edit message in place, 200 OK. Reclaim
//       must NOT retry these — they would throw the same error forever.
//   - Unexpected errors → markInboundEventFailed, 503, 2-min reclaim retry.
//
// Critical invariant: a sendMessage / editMessageText failure AFTER the
// permanent link-state branch has already markInboundEventProcessed'd must
// NOT reclassify the row to 'failed'. The terminal state is locked in by
// markProcessed; the UX message is best-effort.

import type { FastifyReply } from 'fastify';
import { sql } from '../../src/lib/db/server';
import { markInboundEventProcessed, markInboundEventFailed } from './shared';
import { approveViaCallback, regenerateViaCallback } from '../../src/lib/approval/service';
import {
  ConsumedLinkError,
  RevokedLinkError,
  ExpiredLinkError,
  ChannelMismatchError,
  ResponseNotPendingError,
} from '../../src/lib/approval/errors';
import { TelegramClient } from '../../src/lib/notifications/channels/telegram-client';
import { type TelegramUpdate, parseCallbackData, messageForLinkError } from './telegram-shared';

export async function handleCallback(
  update: TelegramUpdate,
  dedupKey: string,
  client: TelegramClient,
  reply: FastifyReply,
  ipAddress: string | null,
): Promise<void> {
  const cb = update.callback_query!;
  const chatId = String(cb.message?.chat.id ?? cb.from.id);
  const messageId = cb.message?.message_id ?? 0;

  // Parse callback data — invalid action is a permanent client error
  const parsed = cb.data ? parseCallbackData(cb.data) : null;
  if (!parsed) {
    await markInboundEventProcessed(dedupKey);
    await client.answerCallbackQuery({ callback_query_id: cb.id, text: 'Invalid action' })
      .catch(() => {});
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
    // Permanent — link is terminal; mark processed before UX send.
    // Ack for the toast banner AND edit the original message so the stale
    // buttons disappear (repeated taps would otherwise just re-fire the
    // same "no longer valid" ack against a dead link).
    await markInboundEventProcessed(dedupKey);
    const deadText = 'This approval is no longer valid — it may have been handled on another channel.';
    await client.answerCallbackQuery({ callback_query_id: cb.id, text: deadText })
      .catch(() => {});
    await client.editMessageText({
      chat_id: chatId,
      message_id: messageId,
      text: deadText,
    }).catch(() => { /* message too old to edit; ack already delivered */ });
    reply.code(200).send({ ok: true });
    return;
  }

  // Invariant: sender must be a verified, non-archived enrollment for this business
  const senderId = String(cb.from.id);
  const enrollmentRows = await sql<{ handle: string }[]>`
    SELECT handle FROM channel_enrollments
    WHERE business_id = ${link.business_id}
      AND channel = 'telegram'
      AND status = 'verified'
      AND handle = ${senderId}
      AND archived_at IS NULL
  `;
  if (enrollmentRows.length === 0) {
    // Permanent — sender not enrolled; mark processed before UX send
    await markInboundEventProcessed(dedupKey);
    await client.answerCallbackQuery({ callback_query_id: cb.id, text: 'This approval is no longer valid — it may have been handled on another channel.' })
      .catch(() => {});
    reply.code(200).send({ ok: true });
    return;
  }

  // ACK BOUNDARY — Model A: fire ack BEFORE heavy transaction.
  // Swallow ack failures (.catch): Telegram's callback_query_id expires 15s
  // after delivery, so once we're past this line the ack is cosmetic. If the
  // Bot API is transiently unavailable here, continuing to the tx is safer
  // than letting the exception bubble — the outer catch would markFailed,
  // and the 2min reclaim would re-fire against an already-stale ack id,
  // looping forever (M2).
  const ackText = parsed.action === 'approve' ? 'Approving…' : 'Regenerating — a new draft will follow shortly';
  await client.answerCallbackQuery({ callback_query_id: cb.id, text: ackText })
    .catch(() => {});

  // Service call — approval or regeneration
  try {
    if (parsed.action === 'approve') {
      await approveViaCallback({
        approvalLinkId: link.id,
        chatHandle: senderId,
        viaChannel: 'telegram',
        audit: {
          providerEventId: String(update.update_id),
          ipAddress,
          telegramUpdateId: update.update_id,
        },
      });
    } else {
      await regenerateViaCallback({
        approvalLinkId: link.id,
        chatHandle: senderId,
        viaChannel: 'telegram',
        audit: {
          providerEventId: String(update.update_id),
          ipAddress,
          telegramUpdateId: update.update_id,
        },
      });
    }
  } catch (err) {
    const e = err as Error;
    // M1: ResponseNotPendingError is permanent — the response was already
    // handled by a parallel channel (email/dashboard), so retrying after a
    // 2min reclaim would throw the same error forever and spam fallback
    // messages. Treat as terminal and markProcessed.
    const isPermanent = e instanceof ConsumedLinkError
      || e instanceof RevokedLinkError
      || e instanceof ExpiredLinkError
      || e instanceof ChannelMismatchError
      || e instanceof ResponseNotPendingError;

    if (isPermanent) {
      await markInboundEventProcessed(dedupKey);
      // Edit the original message in place: replaces the stale draft body
      // with the status line AND implicitly drops the inline keyboard
      // (reply_markup omitted) so the approve/regenerate buttons can't
      // be re-tapped. Fallback to sendMessage if the edit call fails
      // (e.g., message too old to edit, rate-limit) so the owner still
      // gets explicit feedback.
      const statusText = messageForLinkError(e);
      await client.editMessageText({
        chat_id: chatId,
        message_id: messageId,
        text: statusText,
      }).catch(async () => {
        await client.sendMessage({ chat_id: chatId, text: statusText })
          .catch(() => { /* UX degraded but state is terminal */ });
      });
      reply.code(200).send({ ok: true });
      return;
    }

    // Unexpected error — no URL embedded (raw token not in scope), owner uses the Edit button
    const fallback = '⚠️ Something went wrong on our end. Please tap the Edit link in the approval message above to finish approval in the browser.';
    await client.sendMessage({ chat_id: chatId, text: fallback })
      .catch(() => { /* UX degraded; reclaim retries keep state consistent */ });
    await markInboundEventFailed(dedupKey, e.message);
    reply.code(503).send({ ok: false });
    return;
  }

  // Visible confirmation — edit calls are cosmetic; failures are silently ignored.
  // For regenerate: replace the stale draft body with a status line so the owner
  // isn't left staring at the old draft while the new one is being generated.
  // editMessageText implicitly drops the inline keyboard when reply_markup is
  // omitted, so buttons disappear as part of the same call.
  if (parsed.action === 'approve') {
    await client.editMessageText({
      chat_id: chatId,
      message_id: messageId,
      text: "✅ Response approved — we'll post it shortly.",
    }).catch(() => { /* cosmetic */ });
  } else {
    await client.editMessageText({
      chat_id: chatId,
      message_id: messageId,
      text: '🔄 Regenerating — a new draft will follow shortly…',
    }).catch(() => { /* cosmetic */ });
  }

  await markInboundEventProcessed(dedupKey);
  reply.code(200).send({ ok: true });
}
