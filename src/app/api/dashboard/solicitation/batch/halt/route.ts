// POST /api/dashboard/solicitation/batch/halt — the owner stops a batch (#629;
// executor design D10). Route orchestrates only: flag gate, writable-owner
// auth, same-origin, location resolution, body parse; the monotone halt latch
// lives in src/lib/solicitation/approval.ts.
//
// The body carries ONLY `batchId`. The halt reason is derived from the batch
// state server-side inside `haltBatch` — a client that could name its own
// reason could file a mid-drip halt as a veto and make the audit trail lie
// about whether email had already left.

import { NextRequest, NextResponse } from 'next/server';
import { sql } from '@/lib/db/server';
import { errorResponse, jsonResponse, withSameOrigin } from '@/lib/auth/route-helpers';
import { createWorkerLogger } from '@/lib/shared/logger';
import { isValidUuid } from '@/lib/shared/ids';
import { reportCaughtError } from '@/lib/shared/report-caught-error';
import { haltBatch } from '@/lib/solicitation/approval';
import {
  requireContactsLocationScope,
  requireSolicitationSendWriteAccess,
} from '@/app/api/dashboard/contacts/location-scope';

export const dynamic = 'force-dynamic';

const logger = createWorkerLogger('api/dashboard/solicitation/batch/halt');

/** The batch id, or null when the body is absent, malformed, or not a UUID.
 *  Nothing else is read: see the header note on the derived halt reason. */
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

async function haltHandler(request: NextRequest): Promise<NextResponse> {
  const owner = await requireSolicitationSendWriteAccess(sql, request);
  if (!owner.ok) return owner.response;
  const { user, accountId } = owner;

  try {
    const location = await requireContactsLocationScope(sql, request, {
      accountId,
      userLocationId: user.locationId,
    });
    if (!location.ok) return location.response;

    const batchId = await readBatchId(request);
    if (batchId === null) return errorResponse('Not found', 404);

    const result = await haltBatch(sql, {
      batchId,
      accountId,
      businessId: location.locationId,
      haltedByUserId: user.id,
    });

    // Ids, counts and the DERIVED reason only — no rendered subject or body is
    // ever interpolated into a log string (D6e: string args are logged
    // verbatim). The reason is logged because it is the audit-visible fact the
    // client could not choose.
    logger.log('batch_halted', {
      status: result.status,
      batchId,
      businessId: location.locationId,
      haltReason: result.status === 'halted' ? result.reason : null,
      cancelledCount: result.status === 'halted' ? result.cancelledCount : 0,
    });

    switch (result.status) {
      case 'halted':
      case 'already_halted':
        return jsonResponse(result);
      case 'not_haltable':
        return jsonResponse(result, 409);
      case 'not_found':
        return errorResponse('Not found', 404);
    }
  } catch (error) {
    reportCaughtError('api/dashboard/solicitation/batch/halt', error, { accountId });
    return errorResponse('Failed to halt batch', 500);
  }
}

export const POST = withSameOrigin()(haltHandler);
