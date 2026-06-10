// worker/ingress/telegram/telegram-shared.ts
//
// Provider-specific shared helpers for the Telegram ingress handlers
// (orchestrator, enrollment, callback). Extracted from telegram.ts so the
// per-flow modules can share the update DTO and the small classifier helpers
// without re-declaring them. Mirrors whatsapp-shared.ts.

import {
  ConsumedLinkError,
  RevokedLinkError,
  ExpiredLinkError,
  ResponseNotPendingError,
  ArchivedLocationError,
} from '../../../src/lib/approval/errors';
import { SubscriptionReadOnlyError } from '../../../src/lib/shared/writable-subscription';

// Narrow shape of the Telegram update payload. We intentionally declare ONLY
// the fields we read — Telegram includes additional fields (from.username,
// from.first_name, from.last_name, message.entities, etc.) at runtime. Those
// are stripped in redactForAudit before inbound_events persistence (L6).
export interface TelegramUpdate {
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

const CALLBACK_UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function parseCallbackData(
  data: string,
): { action: 'approve' | 'regenerate'; approvalLinkId: string } | null {
  let action: 'approve' | 'regenerate';
  let rest: string;
  if (data.startsWith('a:')) {
    action = 'approve';
    rest = data.slice(2);
  } else if (data.startsWith('r:')) {
    action = 'regenerate';
    rest = data.slice(2);
  } else {
    return null;
  }
  if (!CALLBACK_UUID_RE.test(rest)) return null;
  return { action, approvalLinkId: rest };
}

// Strip PII from the update before persisting to inbound_events.payload.
// Telegram includes from.first_name / from.last_name / from.username and
// similar on every update — the TypeScript narrowing doesn't remove them
// at runtime. We keep only numeric ids + enrollment-relevant fields.
export function redactForAudit(update: TelegramUpdate): Record<string, unknown> {
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

// Maps a typed approval-flow error to the user-visible message we send back
// to Telegram on a permanent link-state failure (consumed/revoked/expired/
// channel-mismatch/response-not-pending). Lives in shared so callback flow
// can reuse it without owning the import surface.
//
// ChannelMismatchError intentionally falls through to the generic "no longer
// valid" message — owners don't need to know the link was minted for a
// different channel; from their perspective it just doesn't work.
export function messageForLinkError(err: Error): string {
  if (err instanceof ConsumedLinkError || err instanceof RevokedLinkError) {
    return 'This reply was just handled on another channel.';
  }
  if (err instanceof ExpiredLinkError) {
    return 'This approval link has expired — a new draft will arrive on the next review.';
  }
  if (err instanceof ArchivedLocationError) {
    // Subclass of ResponseNotPendingError — must match before the parent,
    // otherwise the owner sees "already been handled", which is false here.
    return 'This location has been archived — this draft can no longer be regenerated.';
  }
  if (err instanceof ResponseNotPendingError) {
    // The approval_link was still live, but the response had already been
    // approved (or superseded/posted) via another path — typically a parallel
    // email/dashboard approval landed in the ~15s window before the tap.
    return 'This review has already been handled — no further action needed.';
  }
  if (err instanceof SubscriptionReadOnlyError) {
    if (err.error === 'past_due_read_only') {
      return 'Billing recovery has ended. Update billing in RepWorth before approving replies.';
    }
    if (err.error === 'account_offboarding_blocked' || err.error === 'no_business') {
      return 'This RepWorth account is being offboarded, so this approval can no longer be completed.';
    }
    return 'Billing is not active. Update billing in RepWorth before approving replies.';
  }
  return 'This approval is no longer valid.';
}
