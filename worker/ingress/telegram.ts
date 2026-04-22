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
  ResponseNotPendingError,
} from '../../src/lib/approval/errors';
import { TelegramClient } from '../../src/lib/notifications/channels/telegram-client';

// Narrow shape of the Telegram update payload. We intentionally declare ONLY
// the fields we read — Telegram includes additional fields (from.username,
// from.first_name, from.last_name, message.entities, etc.) at runtime. Those
// are stripped in redactForAudit before inbound_events persistence (L6).
interface TelegramUpdate {
  update_id: number;
  message?: {
    from?: { id: number };
    chat?: { id: number; type?: 'private' | 'group' | 'supergroup' | 'channel' };
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

// Strip PII from the update before persisting to inbound_events.payload.
// Telegram includes from.first_name / from.last_name / from.username and
// similar on every update — the TypeScript narrowing doesn't remove them
// at runtime. We keep only numeric ids + enrollment-relevant fields.
function redactForAudit(update: TelegramUpdate): Record<string, unknown> {
  const clone = JSON.parse(JSON.stringify(update)) as Record<string, unknown>;

  const cbAny = clone.callback_query as Record<string, unknown> | undefined;
  if (cbAny) {
    cbAny.data = '[redacted]';
    const cbFrom = cbAny.from as { id?: number } | undefined;
    if (cbFrom) cbAny.from = { id: cbFrom.id };
    const cbMessage = cbAny.message as Record<string, unknown> | undefined;
    if (cbMessage) {
      const cmFrom = cbMessage.from as { id?: number } | undefined;
      if (cmFrom) cbMessage.from = { id: cmFrom.id };
      const cmChat = cbMessage.chat as { id?: number; type?: string } | undefined;
      if (cmChat) cbMessage.chat = { id: cmChat.id, type: cmChat.type };
    }
  }

  const msgAny = clone.message as Record<string, unknown> | undefined;
  if (msgAny) {
    const text = msgAny.text;
    if (typeof text === 'string' && text.startsWith('/start ')) msgAny.text = '[redacted]';
    const mFrom = msgAny.from as { id?: number } | undefined;
    if (mFrom) msgAny.from = { id: mFrom.id };
    const mChat = msgAny.chat as { id?: number; type?: string } | undefined;
    if (mChat) msgAny.chat = { id: mChat.id, type: mChat.type };
  }

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

  if (!chatId) {
    // Malformed update with no sender — mark processed (permanent, no retry)
    // and skip sendMessage since there's no recipient.
    await markProcessed(dedupKey);
    return;
  }

  // M3: reject group/channel enrollment. The bot may be reachable from a
  // group, but future DM notifications will 403 ("can't message user") if
  // the owner has never opened a DM with the bot. Force enrollment from a
  // private chat so we know DMs will reach them.
  const chatType = message.chat?.type;
  if (chatType && chatType !== 'private') {
    await markProcessed(dedupKey);
    await client.sendMessage({
      chat_id: chatId,
      text: 'Please open a direct message with this bot and tap the connection link from there. Group enrollment is not supported.',
    }).catch(() => {});
    return;
  }

  if (!rawToken) {
    await markProcessed(dedupKey);
    await client.sendMessage({ chat_id: chatId, text: 'This link is invalid or expired. Please request a new one from your RepWorth admin.' })
      .catch(() => {});
    return;
  }

  const tokenHash = createHash('sha256').update(rawToken).digest('hex');

  // SELECT FOR UPDATE + UPDATE must run in one transaction so the row lock is
  // held across both statements. A bare sql`...FOR UPDATE` releases the lock
  // at end-of-statement, leaving a window where two concurrent /start updates
  // with the same token could both pass the select.
  const enrollment = await sql.begin(async (tx) => {
    const rows = await tx<{ id: string; business_id: string }[]>`
      SELECT id, business_id
      FROM channel_enrollments
      WHERE verification_token_hash = ${tokenHash}
        AND channel = 'telegram'
        AND status = 'pending_verification'
        AND verification_token_expires_at > NOW()
      FOR UPDATE
    `;
    const row = rows[0];
    if (!row) return null;

    await tx`
      UPDATE channel_enrollments
      SET handle = ${chatId},
          status = 'verified',
          verified_at = NOW(),
          verification_token_hash = NULL,
          verification_token_expires_at = NULL,
          updated_at = NOW()
      WHERE id = ${row.id}
    `;
    return row;
  });

  if (!enrollment) {
    await markProcessed(dedupKey);
    await client.sendMessage({ chat_id: chatId, text: 'This link is invalid or expired. Please request a new one from your RepWorth admin.' })
      .catch(() => {});
    return;
  }

  // State already mutated — mark processed before confirmation send so a
  // sendMessage failure does not cause the outer catch to call markFailed.
  await markProcessed(dedupKey);
  await client.sendMessage({
    chat_id: chatId,
    text: "✅ You're connected to RepWorth — we'll ping you here when a review needs approval.",
  }).catch(() => { /* UX degraded but enrollment is complete */ });
}

function messageForLinkError(err: Error): string {
  if (err instanceof ConsumedLinkError || err instanceof RevokedLinkError) {
    return 'This reply was just handled on another channel.';
  }
  if (err instanceof ExpiredLinkError) {
    return 'This approval link has expired — a new draft will arrive on the next review.';
  }
  if (err instanceof ResponseNotPendingError) {
    // The approval_link was still live, but the response had already been
    // approved (or superseded/posted) via another path — typically a parallel
    // email/dashboard approval landed in the ~15s window before the tap.
    return 'This review has already been handled — no further action needed.';
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

  // Parse callback data — invalid action is a permanent client error
  const parsed = cb.data ? parseCallbackData(cb.data) : null;
  if (!parsed) {
    await markProcessed(dedupKey);
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
    // Permanent — link is terminal; mark processed before UX send
    await markProcessed(dedupKey);
    await client.answerCallbackQuery({ callback_query_id: cb.id, text: 'This approval is no longer valid — it may have been handled on another channel.' })
      .catch(() => {});
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
    await markProcessed(dedupKey);
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
      await markProcessed(dedupKey);
      await client.sendMessage({ chat_id: chatId, text: messageForLinkError(e) })
        .catch(() => { /* UX degraded but state is terminal */ });
      reply.code(200).send({ ok: true });
      return;
    }

    // Unexpected error — no URL embedded (raw token not in scope), owner uses the Edit button
    const fallback = '⚠️ Something went wrong on our end. Please tap the Edit link in the approval message above to finish approval in the browser.';
    await client.sendMessage({ chat_id: chatId, text: fallback })
      .catch(() => { /* UX degraded; reclaim retries keep state consistent */ });
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
