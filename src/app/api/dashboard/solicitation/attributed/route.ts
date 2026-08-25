// GET /api/dashboard/solicitation/attributed — every Attributed review for one
// location in the display window (#632). Route orchestrates only: flag gates,
// owner auth, location resolution; the tenant-scoped read lives in
// src/lib/solicitation/attribution.ts (invariants #1, #12, #15).
//
// Deliberately NOT folded into ./batch: that GET is polled every 2s while a
// batch builds, and attribution spans batches. A separate route keeps a slow
// attribution read off the poll and keeps BatchView's "most recent batch"
// contract intact.
//
// Response carries `enabled` explicitly (invariant #13): the browser learns
// the send-flag state from the response, and an empty list under `enabled:true`
// is a genuine empty state rather than a hidden flag.

import { NextRequest, NextResponse } from 'next/server';
import { sql } from '@/lib/db/server';
import { errorResponse, jsonResponse } from '@/lib/auth/route-helpers';
import { listAttributedReviews } from '@/lib/solicitation/attribution';
import { solicitationSendEnabled, solicitationWatchEnabled } from '@/lib/solicitation/flags';
import { withDashboardOwnerRead } from '@/app/api/dashboard/policy';
import { requireContactsLocationScope } from '@/app/api/dashboard/contacts/location-scope';

export const dynamic = 'force-dynamic';

export async function GET(request: NextRequest): Promise<NextResponse> {
  // Watch-mode gate FIRST, before any auth work (invariant #13): the Requests
  // screen is what this section lives on, and when that surface does not exist
  // an unauthenticated probe must not be able to tell the send flag's state
  // apart from a missing route.
  if (!solicitationWatchEnabled()) return errorResponse('Not found', 404);

  return withDashboardOwnerRead(request, {
    errorContext: 'api/dashboard/solicitation/attributed',
    errorMessage: 'Failed to fetch attributed reviews',
  }, async ({ user, accountId }) => {
    const location = await requireContactsLocationScope(sql, request, {
      accountId,
      userLocationId: user.locationId,
    });
    if (!location.ok) return location.response;

    // Read ONCE and pass the same value to both the read model and the body,
    // so the list and the flag the browser is told about can never disagree.
    const sendEnabled = solicitationSendEnabled();
    const attributed = await listAttributedReviews(sql, {
      accountId,
      businessId: location.locationId,
      sendEnabled,
    });

    return jsonResponse({ enabled: sendEnabled, attributed });
  });
}
