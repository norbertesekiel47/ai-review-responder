// worker/ingress/conversational-seam.ts
//
// Future-agent seam (Workstream C). Today a deliberate NO-OP: non-command,
// non-button free-text inbound to the bot is acknowledged and marked processed,
// with NO reply. This is the single, clearly-named extension point for a future
// conversational RepWorth AI Agent — and it SHIPS with the two boundaries that
// must exist before any future reply (see docs/adr/0003-conversational-channel-seams.md):
//
//   - REDACTION (Codex R1 #9): handled at the audit-persistence layer — the
//     Telegram redactor strips ALL message bodies and the WhatsApp redactor
//     strips Body before inbound_events is written, so no raw user text reaches
//     audit until an explicit conversation-storage/privacy design exists.
//   - AUTH BOUNDARY (Codex R1 #10): a future response is allowed ONLY for a
//     verified, non-archived enrollment tied to an account that can still be
//     served (active, or past_due within grace). Unknown / unenrolled senders
//     are silently acknowledged — never an unauthenticated bot surface. We
//     resolve and log that gate NOW so the seam cannot be extended into an open
//     surface by accident.
//
// NO NLU, NO conversation store, NO agent today.

import { sql } from '../../src/lib/db/server';
import { maskChannelHandle } from '../../src/lib/notifications/mask-handle';
import { checkSubscription, type AccountFlagsInput } from '../../src/lib/shared/subscription-guard';
import type { MobileChannel } from '../../src/lib/channels/mobile-enrollment';

const LOG_PREFIX = '[ingress/conversational-seam]';

export interface ConversationalSeamInput {
  channel: MobileChannel;
  /** Provider sender id: Telegram chat_id (string) or WhatsApp E.164 handle. */
  senderHandle: string;
}

export async function handleConversationalMessage(input: ConversationalSeamInput): Promise<void> {
  const authorized = await isAuthorizedConversationalSender(input.channel, input.senderHandle);
  // Today: NO reply on either branch. The gate is structural — a future agent
  // plugs its response in ONLY behind `authorized === true`. Logging both
  // branches makes the seam observable without leaking any message content.
  console.log(
    `${LOG_PREFIX} noop channel=${input.channel} sender=${maskChannelHandle(input.channel, input.senderHandle)} ` +
    `authorized=${authorized} — acknowledged, no reply (future-agent seam; see ADR 0003)`,
  );
}

/**
 * The auth boundary a future conversational response MUST pass before replying:
 * the sender is a verified, non-archived enrollment on an account that can still
 * be served (active, or past_due within grace). Returns false for unknown
 * senders. Exported so the future agent wires its response strictly behind it.
 */
export async function isAuthorizedConversationalSender(
  channel: MobileChannel,
  senderHandle: string,
): Promise<boolean> {
  if (!senderHandle) return false;
  const rows = await sql<
    { subscription_status: string; past_due_at: Date | null; flags: AccountFlagsInput | null }[]
  >`
    SELECT a.subscription_status, a.past_due_at, a.flags
    FROM channel_enrollments ce
    JOIN accounts a ON a.id = ce.account_id
    WHERE ce.channel = ${channel}
      AND ce.handle = ${senderHandle}
      AND ce.status = 'verified'
      AND ce.archived_at IS NULL
    LIMIT 1
  `;
  const row = rows[0];
  if (!row) return false;
  // Use the SHARED subscription guard so past_due honors the 7-day grace window
  // (a past_due-beyond-grace account is NOT authorized) — same semantics as the
  // notification worker, rather than a bare `status IN ('active','past_due')`
  // that would authorize an expired past_due account (Codex review P2).
  return checkSubscription({
    status: row.subscription_status,
    pastDueAt: row.past_due_at,
    accountFlags: row.flags ?? {},
    workerType: 'notification',
  }).allowed;
}
