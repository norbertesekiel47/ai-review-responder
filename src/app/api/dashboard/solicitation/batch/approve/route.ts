// POST /api/dashboard/solicitation/batch/approve — the owner approves a built
// batch, optionally excluding individual asks (#629; executor design D23).
// Route orchestrates only: the send-lane flag gate, writable-owner auth,
// location resolution, body parse and the 500 mapping all live in
// `withScopedBatch` (../_shared/scoped-batch-route.ts); the transaction lives
// in src/lib/solicitation/approval.ts.

import type { NextRequest } from 'next/server';
import { sql } from '@/lib/db/server';
import { errorResponse, jsonResponse, withSameOrigin } from '@/lib/auth/route-helpers';
import { isValidUuid } from '@/lib/shared/ids';
import { approveBatch } from '@/lib/solicitation/approval';
import { requireSolicitationSendWriteAccess } from '@/app/api/dashboard/contacts/location-scope';
import { readJsonObject, withScopedBatch } from '../_shared/scoped-batch-route';

export const dynamic = 'force-dynamic';

/** The batch id plus the excluded outreach ids, or null when the body is
 *  absent, malformed, or carries a non-UUID anywhere. The one batch body that
 *  is more than a batch id, so it reads the object itself rather than using the
 *  shared `readBatchId`. */
async function readApproval(
  request: NextRequest,
): Promise<{ batchId: string; excludedOutreachIds: string[] } | null> {
  const body = await readJsonObject(request);
  if (body === null) return null;
  const { batchId, excludedOutreachIds } = body;
  if (typeof batchId !== 'string' || !isValidUuid(batchId)) return null;
  if (excludedOutreachIds === undefined) return { batchId, excludedOutreachIds: [] };
  if (!Array.isArray(excludedOutreachIds)) return null;
  if (!excludedOutreachIds.every((id) => typeof id === 'string' && isValidUuid(id))) return null;
  return { batchId, excludedOutreachIds };
}

export const POST = withSameOrigin()(
  withScopedBatch(
    sql,
    {
      endpoint: 'api/dashboard/solicitation/batch/approve',
      failureMessage: 'Failed to approve batch',
      // BOTH flags: the approval lane lives inside the watch surface.
      requireWriteAccess: requireSolicitationSendWriteAccess,
      readInput: readApproval,
    },
    async ({ accountId, locationId, actorUserId, input, logger }) => {
      const result = await approveBatch(sql, {
        batchId: input.batchId,
        accountId,
        businessId: locationId,
        approvedByUserId: actorUserId,
        excludedOutreachIds: input.excludedOutreachIds,
      });

      // Ids and counts only — no rendered subject or body is ever interpolated
      // into a log string (D6e: string args are logged verbatim).
      logger.log('batch_approved', {
        status: result.status,
        batchId: input.batchId,
        businessId: locationId,
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
    },
  ),
);
