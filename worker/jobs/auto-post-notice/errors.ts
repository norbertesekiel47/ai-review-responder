// worker/jobs/auto-post-notice/errors.ts
//
// Retryable-vs-terminal classification for the auto-approved post FYI send
// (Codex R1 #3 / R2 #4). RETRYABLE failures cause the claim to be RELEASED so a
// BullMQ retry can re-acquire and re-send (transient infra: rate limits,
// timeouts, network blips). TERMINAL failures write a failed delivery row and
// are never retried.
//
// This reuses the channels' typed-error KNOWLEDGE (which provider errors are
// transient), NOT the approval dispatcher's enrollment-flip directives — the
// FYI must not flip enrollment, and the approval directives' log messages
// assume an enrollment flip.

import {
  WhatsAppRateLimitError,
  WhatsAppTimeoutError,
} from '../../../src/lib/notifications/channels/whatsapp-client';
import {
  TelegramRateLimitError,
  TelegramApiError,
} from '../../../src/lib/notifications/channels/telegram-client';

export interface AutoPostNoticeSendClassification {
  retryable: boolean;
  reason: string;
}

export function classifyAutoPostNoticeSendError(err: unknown): AutoPostNoticeSendClassification {
  // Transient provider conditions — retry can succeed.
  if (err instanceof WhatsAppRateLimitError || err instanceof WhatsAppTimeoutError) {
    return { retryable: true, reason: err.message };
  }
  if (err instanceof TelegramRateLimitError) {
    return { retryable: true, reason: err.message };
  }
  // TelegramApiError carries errorCode 0 for timeout/network wrappers (see
  // telegram-client.ts `call()`); treat those as transient, other codes as
  // terminal.
  if (err instanceof TelegramApiError) {
    return { retryable: err.errorCode === 0, reason: err.message };
  }

  // Everything else — blocked/invalid recipient, template/session config,
  // Resend/email errors, unknown — is TERMINAL: recorded as a failed delivery
  // and not retried. A best-effort FYI (the Google post already succeeded) must
  // not churn retries on a likely-permanent error.
  const reason = err instanceof Error ? err.message : String(err);
  return { retryable: false, reason };
}
