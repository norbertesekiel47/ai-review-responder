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
import { getActiveLocationCount } from '@/lib/locations/repo';

export const dynamic = 'force-dynamic';

const NO_STORE = { 'Cache-Control': 'no-store, private' } as const;

// ── Request schema ─────────────────────────────────────────────────────────

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const ArchiveLocationSchema = z.object({
  locationId: z.string().regex(UUID_RE, 'Invalid location ID format'),
  accountId: z.string().regex(UUID_RE, 'Invalid account ID format'),
});

// ── HTTP status mapping for guard rejection reasons ────────────────────────

const GUARD_STATUS_MAP: Record<string, number> = {
  location_not_found: 404,
  location_not_owned: 403,
  location_already_archived: 409,
  last_active_location: 409,
  promote_first: 409,
};

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
  // Gate by MULTI_LOCATION_ENABLED
  if (process.env.MULTI_LOCATION_ENABLED !== 'true') {
    return NextResponse.json(
      { error: 'not_found' },
      { status: 404, headers: NO_STORE },
    );
  }

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json(
      { error: 'invalid_json' },
      { status: 400, headers: NO_STORE },
    );
  }

  const parsed = ArchiveLocationSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: 'invalid_body', issues: parsed.error.issues },
      { status: 400, headers: NO_STORE },
    );
  }
  const { locationId, accountId } = parsed.data;

  // Run guard checks
  const guardResult = await assertCanArchiveLocation(locationId, accountId);

  if (!guardResult.allowed) {
    const httpStatus = GUARD_STATUS_MAP[guardResult.reason] ?? 403;
    return NextResponse.json(
      { error: guardResult.reason },
      { status: httpStatus, headers: NO_STORE },
    );
  }

  // Gather pre-transaction data
  const [actorUserId, activeLocationsBefore] = await Promise.all([
    getAccountOwnerUserId(accountId),
    getActiveLocationCount(accountId),
  ]);

  // Execute the archive transaction
  try {
    const result = await archiveLocationTransaction({
      locationId,
      accountId,
      actorUserId,
      activeLocationsBefore,
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
    return NextResponse.json(
      { error: 'archive_location_failed', detail: message },
      { status: 500, headers: NO_STORE },
    );
  }
}
