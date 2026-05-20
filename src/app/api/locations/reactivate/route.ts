// src/app/api/locations/reactivate/route.ts
//
// POST /api/locations/reactivate — Reactivates an archived location.
// Gated by MULTI_LOCATION_ENABLED flag.
//
// Uses assertCanAddLocation to verify the account can have more locations,
// then runs reactivateLocationTransaction to clear archived_at, enqueue
// Stripe increment, and enqueue review sync jobs.
//
// VAL-LOC-070: Reactivate button visible to owner in Settings → Locations.
// VAL-LOC-072: Reactivation always succeeds for active multi-location accounts.
// VAL-LOC-071: Enqueues zernio_initial_backfill + sync_reviews jobs.

import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { assertCanAddLocation } from '@/lib/accounts/quota';
import { reactivateLocationTransaction } from '@/lib/locations/archive-location-tx';
import { getAccountOwnerUserId } from '@/lib/accounts/repo';
import { getLocationById } from '@/lib/locations/repo';
import {
  LOCATION_ROUTE_NO_STORE as NO_STORE,
  ownerAccountMismatchResponse,
  readLocationRouteJson,
  readOwnerForMultiLocationRoute,
  UUID_RE,
} from '@/lib/locations/owner-route';

export const dynamic = 'force-dynamic';

// ── Request schema ─────────────────────────────────────────────────────────

const ReactivateSchema = z.object({
  locationId: z.string().regex(UUID_RE, 'Invalid location ID format'),
  accountId: z.string().regex(UUID_RE, 'Invalid account ID format'),
});

// ── Handler ─────────────────────────────────────────────────────────────────

/**
 * POST /api/locations/reactivate
 *
 * Reactivates an archived location. The transaction atomically:
 *   1. Sets businesses.archived_at = NULL
 *   2. Inserts account_audit_log with event_type 'location_reactivated'
 *   3. Inserts job_outbox for Stripe overage increment
 *   4. Inserts job_outbox for zernio_initial_backfill (review sync)
 *
 * VAL-LOC-072: For active multi-location accounts, reactivation always succeeds.
 * VAL-LOC-071: Enqueues zernio_initial_backfill + sync_reviews jobs.
 */
export async function POST(req: NextRequest): Promise<NextResponse> {
  const owner = await readOwnerForMultiLocationRoute(req);
  if (!owner.ok) return owner.response;
  const { user } = owner;

  const body = await readLocationRouteJson(req, ReactivateSchema);
  if (!body.ok) return body.response;
  const { locationId, accountId } = body.data;

  // ── Ownership: body.accountId must match authenticated user ──────────────
  if (accountId !== user.accountId) {
    return ownerAccountMismatchResponse();
  }

  // Verify the location exists, is owned by this account, and is archived
  const location = await getLocationById(locationId);

  if (!location) {
    return NextResponse.json(
      { error: 'location_not_found' },
      { status: 404, headers: NO_STORE },
    );
  }

  if (location.account_id !== accountId) {
    return NextResponse.json(
      { error: 'location_not_owned' },
      { status: 403, headers: NO_STORE },
    );
  }

  if (location.archived_at === null) {
    return NextResponse.json(
      { error: 'location_not_archived' },
      { status: 409, headers: NO_STORE },
    );
  }

  // VAL-LOC-072: Check quota — for multi-location accounts, reactivation
  // always succeeds with automatic overage billing
  const quotaCheck = await assertCanAddLocation(accountId);

  if (!quotaCheck.allowed) {
    return NextResponse.json(
      { error: quotaCheck.reason },
      { status: 403, headers: NO_STORE },
    );
  }

  // Get actor user ID for audit log
  const actorUserId = await getAccountOwnerUserId(accountId);

  // Execute the reactivation transaction
  try {
    const result = await reactivateLocationTransaction({
      locationId,
      accountId,
      actorUserId,
    });

    return NextResponse.json(
      {
        locationId: result.locationId,
        reactivated: result.reactivated,
        overageUnits: quotaCheck.overageUnits,
      },
      { status: 200, headers: NO_STORE },
    );
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`[locations/reactivate] Transaction failed for location=${locationId}: ${message}`);
    if (message === 'location_reactivate_conflict') {
      return NextResponse.json(
        { error: message },
        { status: 409, headers: NO_STORE },
      );
    }
    return NextResponse.json(
      { error: 'reactivate_location_failed' },
      { status: 500, headers: NO_STORE },
    );
  }
}
