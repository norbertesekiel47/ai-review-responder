// GET /api/dashboard/solicitation/batch — the latest Solicitation batch for
// one location, as the Requests screen renders it (#544). Route orchestrates
// only: flag gate, owner auth, location resolution; the tenant-scoped read
// lives in src/lib/solicitation/batch-view.ts.
//
// This GET is a PURE READ. Recording that an owner opened the spoilage report
// is the dedicated POST at ./reviewed — the client polls this route while a
// batch builds, so a write here would mean "a fetch happened", not "a human
// looked".

import { NextRequest, NextResponse } from 'next/server';
import { sql } from '@/lib/db/server';
import { errorResponse, jsonResponse } from '@/lib/auth/route-helpers';
import { createWorkerLogger } from '@/lib/shared/logger';
import { readLatestBatch } from '@/lib/solicitation/batch-view';
import { solicitationWatchEnabled } from '@/lib/solicitation/flags';
import { withDashboardOwnerRead } from '@/app/api/dashboard/policy';
import { requireContactsLocationScope } from '@/app/api/dashboard/contacts/location-scope';

export const dynamic = 'force-dynamic';

// createWorkerLogger is CLAUDE.md's single structured-logging owner; the name
// is historical, not a worker-only scope. Adding a second logging mechanism to
// dodge the name would be the actual violation.
const logger = createWorkerLogger('api/dashboard/solicitation/batch');

export async function GET(request: NextRequest): Promise<NextResponse> {
  // Flag gate FIRST (invariant #13): 404 before auth when watch-mode is off.
  if (!solicitationWatchEnabled()) return errorResponse('Not found', 404);

  return withDashboardOwnerRead(request, {
    errorContext: 'api/dashboard/solicitation/batch',
    errorMessage: 'Failed to fetch batch',
  }, async ({ user, accountId }) => {
    const location = await requireContactsLocationScope(sql, request, {
      accountId,
      userLocationId: user.locationId,
    });
    if (!location.ok) return location.response;

    const view = await readLatestBatch(sql, accountId, location.locationId);

    // The ONLY signal separating a correct empty state from a read bug that
    // renders one: hasBatch:false here next to a batch row in Postgres IS the
    // bug. No review, contact or response text is logged. The building state
    // is skipped because the client polls it every 2s.
    if (view.state !== 'building') {
      logger.log('batch_view_read', {
        hasBatch: view.state !== 'no_batch',
        askCount: view.state === 'built' ? view.evaluated : 0,
        sendCount: view.state === 'built' ? view.queued : 0,
        businessId: location.locationId,
      });
    }

    return jsonResponse(view);
  });
}
