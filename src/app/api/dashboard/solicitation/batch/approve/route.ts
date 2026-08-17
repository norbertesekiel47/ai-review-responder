// POST /api/dashboard/solicitation/batch/approve — the owner approves a built
// batch, optionally excluding individual asks (#629; executor design D23).
// Route orchestrates only: flag gate, writable-owner auth, same-origin,
// location resolution, body parse; the transaction lives in
// src/lib/solicitation/approval.ts.

import { NextRequest, NextResponse } from 'next/server';
import { sql } from '@/lib/db/server';
import { errorResponse, jsonResponse, withSameOrigin } from '@/lib/auth/route-helpers';
import { createWorkerLogger } from '@/lib/shared/logger';
import { isValidUuid } from '@/lib/shared/ids';
import { reportCaughtError } from '@/lib/shared/report-caught-error';
import { approveBatch } from '@/lib/solicitation/approval';
import {
  requireContactsLocationScope,
  requireSolicitationSendWriteAccess,
} from '@/app/api/dashboard/contacts/location-scope';

export const dynamic = 'force-dynamic';

const logger = createWorkerLogger('api/dashboard/solicitation/batch/approve');

/** The batch id plus the excluded outreach ids, or null when the body is
 *  absent, malformed, or carries a non-UUID anywhere. */
async function readApproval(
  request: NextRequest,
): Promise<{ batchId: string; excludedOutreachIds: string[] } | null> {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return null;
  }
  if (typeof body !== 'object' || body === null) return null;
  const { batchId, excludedOutreachIds } = body as {
    batchId?: unknown;
    excludedOutreachIds?: unknown;
  };
  if (typeof batchId !== 'string' || !isValidUuid(batchId)) return null;
  if (excludedOutreachIds === undefined) return { batchId, excludedOutreachIds: [] };
  if (!Array.isArray(excludedOutreachIds)) return null;
  if (!excludedOutreachIds.every((id) => typeof id === 'string' && isValidUuid(id))) return null;
  return { batchId, excludedOutreachIds };
}

async function approveHandler(request: NextRequest): Promise<NextResponse> {
  const owner = await requireSolicitationSendWriteAccess(sql, request);
  if (!owner.ok) return owner.response;
  const { user, accountId } = owner;

  try {
    const location = await requireContactsLocationScope(sql, request, {
      accountId,
      userLocationId: user.locationId,
    });
    if (!location.ok) return location.response;

    const parsed = await readApproval(request);
    if (parsed === null) return errorResponse('Not found', 404);

    const result = await approveBatch(sql, {
      batchId: parsed.batchId,
      accountId,
      businessId: location.locationId,
      approvedByUserId: user.id,
      excludedOutreachIds: parsed.excludedOutreachIds,
    });

    // Ids and counts only — no rendered subject or body is ever interpolated
    // into a log string (D6e: string args are logged verbatim).
    logger.log('batch_approved', {
      status: result.status,
      batchId: parsed.batchId,
      businessId: location.locationId,
      approvedCount: result.status === 'approved' ? result.approvedCount : 0,
      excludedCount: result.status === 'approved' ? result.excludedCount : 0,
    });

    switch (result.status) {
      case 'approved':
      case 'already_approved':
        return jsonResponse(result);
      case 'not_ready':
      case 'not_approvable':
        return jsonResponse(result, 409);
      case 'unknown_exclusion':
        return jsonResponse(result, 400);
      case 'not_found':
        return errorResponse('Not found', 404);
    }
  } catch (error) {
    reportCaughtError('api/dashboard/solicitation/batch/approve', error, { accountId });
    return errorResponse('Failed to approve batch', 500);
  }
}

export const POST = withSameOrigin()(approveHandler);
