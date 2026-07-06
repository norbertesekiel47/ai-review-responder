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
import { createOffboardingGate, isBillingMutationBlocked } from '@/lib/account-offboarding/gate';
import { assertCanAddLocation } from '@/lib/accounts/quota';
import { reactivateLocationTransaction } from '@/lib/locations/archive-location-tx';
import { getAccountOwnerUserId } from '@/lib/accounts/repo';
import { getLocationById } from '@/lib/locations/repo';
import { reportCaughtError } from '@/lib/shared/report-caught-error';
import {
  locationDenialResponse,
  LOCATION_ROUTE_NO_STORE as NO_STORE,
  readLocationActionRequest,
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
  const offboardingGate = createOffboardingGate(sql);
  const reqCtx = await readLocationActionRequest(sql, req, ReactivateSchema, offboardingGate);
  if (!reqCtx.ok) return reqCtx.response;
  const { locationId, accountId } = reqCtx.data;

  // Reactivating a location re-adds billable capacity (Stripe overage increment),
  // so it is a billing-expanding mutation — frozen while offboarding forbids it
  // (cancel_only scheduled/failed-billing, and all full-block states). Mirrors
  // locations/add.
  const offboardingState = await offboardingGate.getOffboardingState(accountId);
  if (isBillingMutationBlocked(offboardingState)) {
    return NextResponse.json(
      { error: 'account_offboarding_blocked' },
      { status: 403, headers: NO_STORE },
    );
  }

  // Verify the location exists, is owned by this account, and is archived
  const location = await getLocationById(sql, locationId);

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
  const quotaCheck = await assertCanAddLocation(sql, accountId);

  if (!quotaCheck.allowed) {
    return NextResponse.json(
      { error: quotaCheck.reason },
      { status: 403, headers: NO_STORE },
    );
  }

  // Get actor user ID for audit log
  const actorUserId = await getAccountOwnerUserId(sql, accountId);

  // Execute the reactivation transaction
  try {
    const result = await reactivateLocationTransaction(sql, {
      locationId,
      accountId,
      actorUserId,
    });

    return NextResponse.json(
      {
        locationId: result.locationId,
        reactivated: result.reactivated,
        selfPromoted: result.selfPromoted,
        overageUnits: quotaCheck.overageUnits,
      },
      { status: 200, headers: NO_STORE },
    );
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    reportCaughtError('locations/reactivate', err, { accountId, locationId });
    const denial = locationDenialResponse(message);
    if (denial) return denial;
    return NextResponse.json(
      { error: 'reactivate_location_failed' },
      { status: 500, headers: NO_STORE },
    );
  }
}
