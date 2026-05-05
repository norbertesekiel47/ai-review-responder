// worker/ingress/telegram/telegram-enrollment.ts
//
// Telegram enrollment flow — invoked when an inbound message starts with
// '/start <rawToken>'. Looks up channel_enrollments by SHA-256(token), flips
// status to verified, stores chat_id as handle. Group/channel chats are
// rejected so future DM notifications don't 403.
//
// State invariants preserved verbatim from telegram.ts pre-split:
//   - markInboundEventProcessed runs BEFORE the confirmation sendMessage so
//     a Bot API failure does not flip the inbound_events row to 'failed'.
//   - SELECT FOR UPDATE + UPDATE share a single sql.begin transaction so the
//     row lock survives across both statements.

import { createHash } from 'node:crypto';
import { sql } from '../../../src/lib/db/server';
import { markInboundEventProcessed } from '../shared';
import { TelegramClient } from '../../../src/lib/notifications/channels/telegram-client';
import type { TelegramUpdate } from './telegram-shared';

export async function handleEnrollment(
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
    await markInboundEventProcessed(dedupKey);
    return;
  }

  // M3: reject group/channel enrollment. The bot may be reachable from a
  // group, but future DM notifications will 403 ("can't message user") if
  // the owner has never opened a DM with the bot. Force enrollment from a
  // private chat so we know DMs will reach them.
  const chatType = message.chat?.type;
  if (chatType && chatType !== 'private') {
    await markInboundEventProcessed(dedupKey);
    await client.sendMessage({
      chat_id: chatId,
      text: 'Please open a direct message with this bot and tap the connection link from there. Group enrollment is not supported.',
    }).catch(() => {});
    return;
  }

  if (!rawToken) {
    await markInboundEventProcessed(dedupKey);
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
    await markInboundEventProcessed(dedupKey);
    await client.sendMessage({ chat_id: chatId, text: 'This link is invalid or expired. Please request a new one from your RepWorth admin.' })
      .catch(() => {});
    return;
  }

  // State already mutated — mark processed before confirmation send so a
  // sendMessage failure does not cause the outer catch to call markFailed.
  await markInboundEventProcessed(dedupKey);
  await client.sendMessage({
    chat_id: chatId,
    text: "✅ You're connected to RepWorth — we'll ping you here when a review needs approval.",
  }).catch(() => { /* UX degraded but enrollment is complete */ });
}
