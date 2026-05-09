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
import { sql } from '@/lib/db/server';
import { assertCanAddLocation } from '@/lib/accounts/quota';
import { reactivateLocationTransaction } from '@/lib/locations/archive-location-tx';
import { getAccountOwnerUserId } from '@/lib/accounts/repo';
import { getLocationById } from '@/lib/locations/repo';

export const dynamic = 'force-dynamic';

const NO_STORE = { 'Cache-Control': 'no-store, private' } as const;

// ── Request schema ─────────────────────────────────────────────────────────

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

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

  const parsed = ReactivateSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: 'invalid_body', issues: parsed.error.issues },
      { status: 400, headers: NO_STORE },
    );
  }
  const { locationId, accountId } = parsed.data;

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
    return NextResponse.json(
      { error: 'reactivate_location_failed', detail: message },
      { status: 500, headers: NO_STORE },
    );
  }
}
