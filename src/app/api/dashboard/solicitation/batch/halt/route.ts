// POST /api/dashboard/solicitation/batch/halt — the owner stops a batch (#629;
// executor design D10). Route orchestrates only: the send-lane flag gate,
// writable-owner auth, location resolution, body parse and the 500 mapping all
// live in `withScopedBatch` (../_shared/scoped-batch-route.ts); the monotone
// halt latch lives in src/lib/solicitation/approval.ts.
//
// The body carries ONLY `batchId` — the shared `readBatchId` reads nothing
// else, and nothing client-supplied reaches `haltBatch`. The halt reason is
// derived from the batch state server-side inside `haltBatch`: a client that
// could name its own reason could file a mid-drip halt as a veto and make the
// audit trail lie about whether email had already left.

import { sql } from '@/lib/db/server';
import { errorResponse, jsonResponse, withSameOrigin } from '@/lib/auth/route-helpers';
import { haltBatch } from '@/lib/solicitation/approval';
import { requireSolicitationSendWriteAccess } from '@/app/api/dashboard/contacts/location-scope';
import { readBatchId, withScopedBatch } from '../_shared/scoped-batch-route';

export const dynamic = 'force-dynamic';

export const POST = withSameOrigin()(
  withScopedBatch(
    sql,
    {
      endpoint: 'api/dashboard/solicitation/batch/halt',
      failureMessage: 'Failed to halt batch',
      // BOTH flags: halt is the send lane's other owner verb.
      requireWriteAccess: requireSolicitationSendWriteAccess,
      readInput: readBatchId,
    },
    async ({ accountId, locationId, actorUserId, input: batchId, logger }) => {
      const result = await haltBatch(sql, {
        batchId,
        accountId,
        businessId: locationId,
        haltedByUserId: actorUserId,
      });

      // Ids, counts and the DERIVED reason only — no rendered subject or body is
      // ever interpolated into a log string (D6e: string args are logged
      // verbatim). The reason is logged because it is the audit-visible fact the
      // client could not choose.
      logger.log('batch_halted', {
        status: result.status,
        batchId,
        businessId: locationId,
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
    },
  ),
);
