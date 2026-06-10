// src/app/api/locations/archive/route.ts
//
// POST /api/locations/archive — Archives a location (soft delete).
// Gated by MULTI_LOCATION_ENABLED flag.
//
// Guard rules:
//   - Archive attempt on primary with other active locations: 409 'promote first'
//   - Archive attempt on last active location: 409
//   - Archive of non-primary succeeds: sets archived_at, inserts audit,
//     enqueues Stripe quantity decrement
//
// Validation contract: VAL-LOC-043, VAL-LOC-044, VAL-LOC-047.

import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import {
  assertCanArchiveLocation,
  archiveLocationTransaction,
} from '@/lib/locations/archive-location-tx';
import { getAccountOwnerUserId } from '@/lib/accounts/repo';
import {
  LOCATION_DENIAL_STATUS,
  LOCATION_ROUTE_NO_STORE as NO_STORE,
  locationDenialResponse,
  readLocationActionRequest,
  UUID_RE,
} from '@/lib/locations/owner-route';

export const dynamic = 'force-dynamic';

// ── Request schema ─────────────────────────────────────────────────────────

const ArchiveLocationSchema = z.object({
  locationId: z.string().regex(UUID_RE, 'Invalid location ID format'),
  accountId: z.string().regex(UUID_RE, 'Invalid account ID format'),
});

// Denial→status mapping is shared across all locations routes
// (LOCATION_DENIAL_STATUS in owner-route.ts): both the pre-tx guard result
// and the in-tx re-assert throws resolve through it, so the same denial can
// never return different statuses depending on which layer caught it.

// ── Handler ─────────────────────────────────────────────────────────────────

/**
 * POST /api/locations/archive
 *
 * Archives a location. The archive transaction atomically:
 *   1. Sets businesses.archived_at = NOW()
 *   2. Inserts account_audit_log with event_type 'location_archived'
 *   3. Inserts job_outbox for Stripe overage decrement
 *
 * Reviews and responses for the archived location are preserved (not deleted).
 * The notification context will skip dispatch for archived locations.
 */
export async function POST(req: NextRequest): Promise<NextResponse> {
  const reqCtx = await readLocationActionRequest(req, ArchiveLocationSchema);
  if (!reqCtx.ok) return reqCtx.response;
  const { locationId, accountId } = reqCtx.data;

  // Run guard checks
  const guardResult = await assertCanArchiveLocation(locationId, accountId);

  if (!guardResult.allowed) {
    const httpStatus = LOCATION_DENIAL_STATUS[guardResult.reason] ?? 403;
    return NextResponse.json(
      { error: guardResult.reason },
      { status: httpStatus, headers: NO_STORE },
    );
  }

  const actorUserId = await getAccountOwnerUserId(accountId);

  // Execute the archive transaction. The audit payload's location counts come
  // from the tx's locked snapshot, not a pre-tx read.
  try {
    const result = await archiveLocationTransaction({
      locationId,
      accountId,
      actorUserId,
    });

    return NextResponse.json(
      {
        locationId: result.locationId,
        archived: result.archived,
        activeLocations: guardResult.activeLocationsAfterArchive,
      },
      { status: 200, headers: NO_STORE },
    );
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`[locations/archive] Transaction failed for location=${locationId}: ${message}`);
    const denial = locationDenialResponse(message);
    if (denial) return denial;
    return NextResponse.json(
      { error: 'archive_location_failed' },
      { status: 500, headers: NO_STORE },
    );
  }
}
