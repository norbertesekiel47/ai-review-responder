// src/app/api/locations/promote-primary/route.ts
//
// POST /api/locations/promote-primary — Promotes a location to primary.
// Gated by MULTI_LOCATION_ENABLED flag.
//
// Atomically changes is_primary from the current primary to the new one.
// The partial unique index `businesses_account_primary_uniq` ensures
// exactly one primary per active account at all times.
//
// Feature spec: Primary promotion changes is_primary atomically from old to new.

import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { promotePrimaryTransaction } from '@/lib/locations/promote-primary-tx';
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
  const owner = await readOwnerForMultiLocationRoute(req);
  if (!owner.ok) return owner.response;
  const { user } = owner;

  const body = await readLocationRouteJson(req, PromotePrimarySchema);
  if (!body.ok) return body.response;
  const { newPrimaryId, accountId } = body.data;

  // ── Ownership: body.accountId must match authenticated user ──────────────
  if (accountId !== user.accountId) {
    return ownerAccountMismatchResponse();
  }

  // ── Ownership: verify the target location belongs to this account ───────
  const targetLocation = await getLocationById(newPrimaryId);
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
    const result = await promotePrimaryTransaction({
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

    // Map known error patterns to HTTP status codes
    if (message.includes('already the primary')) {
      return NextResponse.json(
        { error: 'already_primary' },
        { status: 400, headers: NO_STORE },
      );
    }

    if (message.includes('not found') || message.includes('not accessible')) {
      return NextResponse.json(
        { error: 'location_not_found' },
        { status: 404, headers: NO_STORE },
      );
    }

    if (message.includes('archived')) {
      return NextResponse.json(
        { error: 'location_archived' },
        { status: 400, headers: NO_STORE },
      );
    }

    console.error(`[locations/promote-primary] Transaction failed for account=${accountId}: ${message}`);
    return NextResponse.json(
      { error: 'promote_primary_failed', detail: message },
      { status: 500, headers: NO_STORE },
    );
  }
}
