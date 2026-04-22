// worker/ingress/shared.ts
//
// Shared ingress primitives used across webhook handlers (Twilio, Telegram, etc.).
// claimInboundEvent dedup pattern originated in worker/ingress/twilio.ts and was
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
  ` as unknown as { count: number };

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
