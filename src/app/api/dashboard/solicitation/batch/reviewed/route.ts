// POST /api/dashboard/solicitation/batch/reviewed — records that an owner
// opened the spoilage report (#544). Separate from the GET on purpose: the
// client polls the read route every 2s while a batch builds, so only an
// explicit ping from a rendered report can mean "a human looked".
//
// Route orchestrates only: flag gate, writable-owner auth, same-origin,
// location resolution; the idempotent first-write-wins UPDATE lives in
// src/lib/solicitation/batch-view.ts.

import { NextRequest, NextResponse } from 'next/server';
import { sql } from '@/lib/db/server';
import { errorResponse, withSameOrigin } from '@/lib/auth/route-helpers';
import { createWorkerLogger } from '@/lib/shared/logger';
import { isValidUuid } from '@/lib/shared/ids';
import { reportCaughtError } from '@/lib/shared/report-caught-error';
import { markBatchReviewed } from '@/lib/solicitation/batch-view';
import {
  requireContactsLocationScope,
  requireContactsWriteAccess,
} from '@/app/api/dashboard/contacts/location-scope';

export const dynamic = 'force-dynamic';

// Same single structured-logging owner the GET uses; the createWorkerLogger name
// is historical, not a worker-only scope.
const logger = createWorkerLogger('api/dashboard/solicitation/batch/reviewed');

/** The batch id, or null when the body is absent, malformed, or not a UUID. */
async function readBatchId(request: NextRequest): Promise<string | null> {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return null;
  }
  if (typeof body !== 'object' || body === null) return null;
  const batchId = (body as { batchId?: unknown }).batchId;
  return typeof batchId === 'string' && isValidUuid(batchId) ? batchId : null;
}

async function markBatchReviewedHandler(request: NextRequest): Promise<NextResponse> {
  // Mutation posture: flag gate FIRST (invariant #13) + requireWritableOwner,
  // mirroring the contacts mutation routes.
  const owner = await requireContactsWriteAccess(sql, request);
  if (!owner.ok) return owner.response;
  const { user, accountId } = owner;

  try {
    // Location resolution is not optional: the body carries only batchId, so
    // without it the three-key UPDATE has no proven business_id. Callers must
    // send ?scope= — resolveDashboardRequest otherwise falls back to the
    // owner's default location and the UPDATE silently matches zero rows.
    const location = await requireContactsLocationScope(sql, request, {
      accountId,
      userLocationId: user.locationId,
    });
    if (!location.ok) return location.response;

    // A malformed id gets the same uniform 404 as an unknown row.
    const batchId = await readBatchId(request);
    if (batchId === null) return errorResponse('Not found', 404);

    // 0 rows means "already reviewed" — an idempotent no-op, not a failure, so
    // the status is 204 either way. The count is LOGGED because that is the only
    // thing separating that legitimate no-op from the silent failure the comment
    // above names: a caller that omits ?scope= keys the UPDATE on the owner's
    // default location, matches zero rows, and loses the engagement signal with
    // no other symptom. rowsUpdated:0 in this line is that symptom.
    const rowsUpdated = await markBatchReviewed(sql, accountId, location.locationId, batchId);
    logger.log('batch_reviewed_ping', {
      rowsUpdated,
      businessId: location.locationId,
    });
    return new NextResponse(null, { status: 204 });
  } catch (error) {
    reportCaughtError('api/dashboard/solicitation/batch/reviewed', error, { accountId });
    return errorResponse('Failed to record batch review', 500);
  }
}

export const POST = withSameOrigin()(markBatchReviewedHandler);
