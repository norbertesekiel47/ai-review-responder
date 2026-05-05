// worker/ingress/shared.ts
//
// Shared ingress primitives used across webhook handlers (Twilio, Telegram, etc.).
// claimInboundEvent dedup pattern originated in worker/ingress/twilio/twilio.ts and was
// extracted here when Telegram was added — see docs/superpowers/specs/2026-04-22-telegram-phase-2-design.md §2.

import { v7 as uuidv7 } from 'uuid';
import { sql, jsonb } from '../../src/lib/db/server';

/**
 * Claim an inbound webhook event for exactly-once processing.
 *
 * Returns:
 *   'claimed'   — caller owns processing; proceed with business logic.
 *   'duplicate' — another worker/request already handled this event; return 200 no-op.
 *
 * Reclaim semantics: a row stuck in status='received' for > 2min, or status='failed',
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
      AND (status = 'failed' OR (status = 'received' AND received_at < NOW() - INTERVAL '2 minutes'))
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
