// worker/jobs/notification/errors.ts
//
// Provider error classification for the notification dispatch loop.
// The classifier returns a discriminated directive describing how the
// dispatcher should react: enrollment-mutation kind, failure_reason,
// log level + message. The classifier itself performs no DB writes;
// the dispatcher applies the directive.

import {
  TelegramRecipientBlockedError,
  TelegramChatNotFoundError,
  WhatsAppRecipientBlockedError,
  WhatsAppInvalidRecipientError,
  WhatsAppTemplateConfigError,
  WhatsAppSessionWindowError,
  WhatsAppRateLimitError,
  WhatsAppTimeoutError,
} from '../../../src/lib/notifications/channels';
import type { ChannelId } from '../../../src/lib/notifications/channels/types';

export type LogLevel = 'log' | 'warn' | 'error';

/**
 * Discriminated directive returned to the dispatcher. The `kind` field
 * routes the enrollment mutation in the dispatcher; the `failureReason`
 * is written to notification_deliveries.failure_reason; the log fields
 * are emitted verbatim from the original worker branches.
 *
 * Mutation rules per kind (applied by the dispatcher):
 *  - telegram_blocked       — channel_enrollments → unsubscribed
 *                             (account_id + handle + location scoped)
 *  - telegram_chat_not_found — channel_enrollments → disabled
 *  - whatsapp_blocked        — channel_enrollments → unsubscribed
 *  - whatsapp_invalid_recipient — channel_enrollments → disabled
 *  - whatsapp_template_config / whatsapp_session_window — NO mutation
 *    (CONFIG-ERROR: ops problem, not owner intent)
 *  - whatsapp_rate_limit / whatsapp_timeout — NO mutation (TRANSIENT)
 *  - unknown                 — NO mutation (let BullMQ retry)
 */
export interface ChannelErrorDirective {
  kind:
    | 'telegram_blocked'
    | 'telegram_chat_not_found'
    | 'whatsapp_blocked'
    | 'whatsapp_invalid_recipient'
    | 'whatsapp_template_config'
    | 'whatsapp_session_window'
    | 'whatsapp_rate_limit'
    | 'whatsapp_timeout'
    | 'unknown';
  failureReason: string;
  logLevel: LogLevel;
  logMessage: string;
  /**
   * Optional second log line for additional context after the primary log line.
   */
  extraLog?: { level: LogLevel; message: string };
}

/**
 * Classify a thrown error from `getChannel(id).sendApprovalRequest(...)`
 * into a directive the dispatcher applies. Behavior must match the original
 * NotificationWorker if/else chain exactly — no DB writes, no log lines.
 */
export function classifyChannelError(
  channelId: ChannelId,
  err: unknown,
  ctx: { businessId: string; responseId: string },
): ChannelErrorDirective {
  if (err instanceof TelegramRecipientBlockedError) {
    return {
      kind: 'telegram_blocked',
      failureReason: 'telegram_blocked',
      logLevel: 'log',
      logMessage: `Telegram enrollment flipped to unsubscribed (telegram_blocked) for business ${ctx.businessId}`,
    };
  }

  if (err instanceof TelegramChatNotFoundError) {
    return {
      kind: 'telegram_chat_not_found',
      failureReason: 'telegram_chat_not_found',
      logLevel: 'log',
      logMessage: `Telegram enrollment flipped to disabled (chat_not_found) for business ${ctx.businessId}`,
    };
  }

  if (err instanceof WhatsAppRecipientBlockedError) {
    return {
      kind: 'whatsapp_blocked',
      failureReason: 'whatsapp_blocked',
      logLevel: 'log',
      logMessage: `WhatsApp enrollment flipped to unsubscribed (whatsapp_blocked) for business ${ctx.businessId}`,
    };
  }

  if (err instanceof WhatsAppInvalidRecipientError) {
    return {
      kind: 'whatsapp_invalid_recipient',
      failureReason: 'whatsapp_invalid_recipient',
      logLevel: 'log',
      logMessage: `WhatsApp enrollment flipped to disabled (invalid_recipient) for business ${ctx.businessId}`,
    };
  }

  if (err instanceof WhatsAppTemplateConfigError) {
    return {
      kind: 'whatsapp_template_config',
      failureReason: `whatsapp_template_config:${err.code}`,
      logLevel: 'error',
      logMessage: `WhatsApp template config error for business ${ctx.businessId}: code=${err.code}`,
    };
  }

  if (err instanceof WhatsAppSessionWindowError) {
    return {
      kind: 'whatsapp_session_window',
      failureReason: `whatsapp_session_window:${err.code}`,
      logLevel: 'error',
      logMessage: `WhatsApp session-window error (dispatcher bug?) for business ${ctx.businessId}: code=${err.code}`,
    };
  }

  if (err instanceof WhatsAppRateLimitError) {
    return {
      kind: 'whatsapp_rate_limit',
      failureReason: `whatsapp_rate_limit:${err.code}`,
      logLevel: 'warn',
      logMessage: `WhatsApp rate limit for business ${ctx.businessId}: ${err.code}`,
    };
  }

  if (err instanceof WhatsAppTimeoutError) {
    return {
      kind: 'whatsapp_timeout',
      failureReason: 'whatsapp_timeout',
      logLevel: 'warn',
      logMessage: `WhatsApp timeout for business ${ctx.businessId}`,
    };
  }

  const reason = err instanceof Error ? err.message : String(err);
  return {
    kind: 'unknown',
    failureReason: `send_error:${reason}`,
    logLevel: 'error',
    logMessage: `${channelId} send failed for response ${ctx.responseId}: ${reason}`,
  };
}
