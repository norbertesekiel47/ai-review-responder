// src/app/api/locations/promote-primary/route.ts
//
// POST /api/locations/promote-primary — Promotes a location to primary.
// Gated by MULTI_LOCATION_ENABLED flag.
//
// Atomically changes is_primary from the current primary to the new one.
// Also the REPAIR path for zero-primary accounts: demoting 0 rows is legal
// (see the one-primary invariant docblock in
// src/lib/locations/promote-primary-tx.ts — the index enforces AT MOST one;
// the app repairs AT LEAST one).
//
// Feature spec: Primary promotion changes is_primary atomically from old to new.

import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { sql } from '@/lib/db/server';
import { promotePrimaryTransaction } from '@/lib/locations/promote-primary-tx';
import { getLocationById } from '@/lib/locations/repo';
import { reportCaughtError } from '@/lib/shared/report-caught-error';
import {
  LOCATION_ROUTE_NO_STORE as NO_STORE,
  locationDenialResponse,
  readLocationActionRequest,
  UUID_RE,
} from '@/lib/locations/owner-route';

export const dynamic = 'force-dynamic';

// ── Request schema ─────────────────────────────────────────────────────────

const PromotePrimarySchema = z.object({
  newPrimaryId: z.string().regex(UUID_RE, 'Invalid location ID format'),
  accountId: z.string().regex(UUID_RE, 'Invalid account ID format'),
});

// ── Handler ─────────────────────────────────────────────────────────────────

/**
 * POST /api/locations/promote-primary
 *
 * Promotes the specified location to primary, demoting the current primary.
 * The transaction atomically:
 *   1. Sets is_primary = FALSE on the current primary
 *   2. Sets is_primary = TRUE on the new primary
 *   3. Inserts account_audit_log with event_type 'primary_promoted'
 */
export async function POST(req: NextRequest): Promise<NextResponse> {
  const reqCtx = await readLocationActionRequest(req, PromotePrimarySchema);
  if (!reqCtx.ok) return reqCtx.response;
  const { user } = reqCtx;
  const { newPrimaryId, accountId } = reqCtx.data;

  // ── Ownership: verify the target location belongs to this account ───────
  const targetLocation = await getLocationById(sql, newPrimaryId);
  if (!targetLocation) {
    return NextResponse.json(
      { error: 'location_not_found' },
      { status: 404, headers: NO_STORE },
    );
  }
  if (targetLocation.account_id !== user.accountId) {
    return NextResponse.json(
      { error: 'location_not_owned' },
      { status: 403, headers: NO_STORE },
    );
  }

  try {
    const result = await promotePrimaryTransaction(sql, {
      accountId,
      newPrimaryId,
    });

    return NextResponse.json(
      {
        oldPrimaryId: result.oldPrimaryId,
        newPrimaryId: result.newPrimaryId,
      },
      { status: 200, headers: NO_STORE },
    );
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const denial = locationDenialResponse(message);
    if (denial) return denial;

    reportCaughtError('locations/promote-primary', err, { accountId, newPrimaryId });
    return NextResponse.json(
      { error: 'promote_primary_failed' },
      { status: 500, headers: NO_STORE },
    );
  }
}
