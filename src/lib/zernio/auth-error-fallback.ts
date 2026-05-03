// src/lib/zernio/auth-error-fallback.ts
//
// Distinct from publisher's applyTransientExhaustionFallback (which requires
// a response_id to park) — ingestion has no response to park. This helper
// handles the connection-side cleanup only.
//
// See spec §6.5b.

import { v7 as uuidv7 } from 'uuid';
import { sql, jsonb } from '@/lib/db/server';
import type { SendOwnerEmailPayload } from '@/lib/shared/worker-types';

/** Strip credential-bearing patterns from the persisted reason. Mirrors
 *  publisher-error-handlers.ts redactSensitiveError — defensive in case
 *  Zernio echoes a token in 401/403 body. */
function redactSensitiveError(body: string): string {
  return body
    .replace(/Bearer\s+[A-Za-z0-9\-._~+/]+=*/gi, 'Bearer [REDACTED]')
    .replace(/Basic\s+[A-Za-z0-9+/]+=*/gi, 'Basic [REDACTED]')
    .replace(/(token|secret|api[_-]?key|password|authorization)=([^&\s"']+)/gi, '$1=[REDACTED]')
    .replace(/("(token|secret|api[_-]?key|password|authorization)"\s*:\s*)"[^"]*"/gi, '$1"[REDACTED]"');
}

export async function applyIngestionAuthErrorFallback(
  businessId: string,
  accountId: string,
  locationId: string,
  reason: string,
): Promise<void> {
  const safeReason = redactSensitiveError(reason);

  await sql.begin(async (tx) => {
    // Disconnect the matching active connection. Scoped by location to avoid
    // accidentally disconnecting a sibling business sharing the same account
    // at a different location.
    const updated = await tx`
      UPDATE zernio_connections
      SET status = 'disconnected',
          disconnected_at = NOW(),
          disconnect_reason = 'auth_error_on_ingest',
          last_error = ${safeReason},
          last_error_at = NOW(),
          updated_at = NOW()
      WHERE business_id = ${businessId}
        AND zernio_account_id = ${accountId}
        AND zernio_location_id = ${locationId}
        AND status = 'active'
      RETURNING 1
    `;

    if (updated.count === 0) {
      // Connection already disconnected by another worker. Don't enqueue
      // another connection_lost notify — the prior path already did.
      return;
    }

    // Enqueue connection_lost notify. Migration 026's dedup index
    // notification_deliveries_connection_lost_dedup caps to one email per
    // business per UTC day, so this is safe across concurrent ingest jobs.
    const lostPayload = {
      kind: 'connection_lost',
      business_id: businessId,
    } satisfies SendOwnerEmailPayload;
    await tx`
      INSERT INTO job_outbox (
        id, topic, aggregate_type, aggregate_id, payload, attempts, max_attempts
      ) VALUES (
        ${uuidv7()},
        'notify_owner_connection_lost',
        'business',
        ${businessId},
        ${jsonb(lostPayload)},
        0, 5
      )
    `;
  });
}
