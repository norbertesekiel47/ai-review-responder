// src/lib/notifications/channels/transient-send-error.ts
//
// Single owner of "which provider send errors are TRANSIENT (worth retrying)".
// Defined ONCE here so every dispatcher that must decide retry-vs-give-up on a
// channel send reads the same set instead of re-enumerating it (the auto-post
// FYI dispatcher and the approval dispatcher had each grown their own copy, and
// the two had already drifted on the Telegram cases).

import { WhatsAppRateLimitError, WhatsAppTimeoutError } from './whatsapp-client';
import { TelegramRateLimitError, TelegramApiError } from './telegram-client';

/**
 * True when a thrown channel-send error is a TRANSIENT provider condition
 * (rate limit, timeout, network blip) — i.e. an identical retry could succeed.
 * Everything else (blocked/invalid recipient, template/session config, unknown)
 * is terminal.
 *
 * `TelegramApiError` wraps timeout/network failures with `errorCode === 0`
 * (see telegram-client.ts `call()`); any other Telegram API code is terminal.
 */
export function isTransientChannelSendError(err: unknown): boolean {
  if (err instanceof WhatsAppRateLimitError || err instanceof WhatsAppTimeoutError) return true;
  if (err instanceof TelegramRateLimitError) return true;
  if (err instanceof TelegramApiError) return err.errorCode === 0;
  return false;
}
