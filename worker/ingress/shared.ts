// worker/ingress/shared.ts
//
// Shared ingress primitives used across webhook handlers (Twilio, Telegram, etc.).
// claimInboundEvent dedup pattern originated in worker/ingress/twilio/twilio.ts and was
// extracted here when Telegram was added — see docs/superpowers/specs/2026-04-22-telegram-phase-2-design.md §2.

import { v7 as uuidv7 } from 'uuid';
import { sql, jsonb } from '../../src/lib/db/server';

// A 'received' row is reclaimable after this long — covers worker crashes +
// transient retry windows. Widened from 2min (F-15): if an ingress handler runs
// longer than the window, a concurrent provider retry could reclaim the row and
// double-process. Providers retry on non-200 regardless, so the slower
// crash-recovery is harmless; idempotency backstops any residual double-process.
const RECLAIM_AFTER_MINUTES = 10;

/**
 * Claim an inbound webhook event for exactly-once processing.
 *
 * Returns:
 *   'claimed'   — caller owns processing; proceed with business logic.
 *   'duplicate' — another worker/request already handled this event; return 200 no-op.
 *
 * Reclaim semantics: a row stuck in status='received' for > 10min, or status='failed',
 * is reclaimable — covers worker crashes + transient retry windows.
 */
export async function claimInboundEvent(
  source: string,
  dedupKey: string,
  eventType: string,
  payload: unknown,
): Promise<'claimed' | 'duplicate'> {
  const inserted = await sql`
    INSERT INTO inbound_events (id, source, external_event_key, event_type, payload, status)
    VALUES (${uuidv7()}, ${source}, ${dedupKey}, ${eventType}, ${jsonb(payload)}, 'received')
    ON CONFLICT (external_event_key) DO NOTHING
  `;

  // count > 0 → INSERT landed; count === 0 → conflict, fall through to reclaim.
  if (inserted.count !== 0) return 'claimed';

  const reclaimed = await sql<{ id: string }[]>`
    UPDATE inbound_events
    SET received_at = NOW(), status = 'received', error_message = NULL
    WHERE external_event_key = ${dedupKey}
      AND (status = 'failed' OR (status = 'received'
            AND received_at < NOW() - make_interval(mins => ${RECLAIM_AFTER_MINUTES})))
    RETURNING id
  `;
  return reclaimed.length > 0 ? 'claimed' : 'duplicate';
}

/**
 * Mark an inbound webhook event as successfully processed.
 * Idempotent — if the dedup key has no row, the UPDATE is a no-op.
 */
export async function markInboundEventProcessed(dedupKey: string): Promise<void> {
  await sql`
    UPDATE inbound_events
    SET status = 'processed', processed_at = NOW()
    WHERE external_event_key = ${dedupKey}
  `;
}

/**
 * Mark an inbound webhook event as failed with a reason.
 * Used when validation/dispatch fails after the event has been claimed.
 */
export async function markInboundEventFailed(dedupKey: string, reason: string): Promise<void> {
  await sql`
    UPDATE inbound_events
    SET status = 'failed', error_message = ${reason}
    WHERE external_event_key = ${dedupKey}
  `;
}

// UUID v7 rendered with `v7()` from the `uuid` package produces the canonical
// 8-4-4-4-12 hex form. Validate the suffix shape before hitting the DB — the
// approval_links.id column is UUID, and a malformed string would raise a
// Postgres "invalid input syntax for type uuid" error that escapes the
// post-claim happy path. Malformed payloads route to the same processed/200
// path as an unrecognised `a:`/`r:` prefix.
const APPROVAL_ACTION_UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Parse an inline approval-action payload — `a:<approvalLinkId>` (approve) or
 * `r:<approvalLinkId>` (regenerate) — shared by Telegram callback buttons and
 * WhatsApp quick-reply buttons. Returns null (fail closed) on an unknown
 * prefix or a malformed UUID.
 */
export function parseApprovalActionPayload(
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
  if (!APPROVAL_ACTION_UUID_RE.test(rest)) return null;
  return { action, approvalLinkId: rest };
}
