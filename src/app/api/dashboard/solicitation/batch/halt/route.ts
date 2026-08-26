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
import { haltBatch, type HaltBatchResult } from '@/lib/solicitation/approval';
import { batchDidClose } from '@/lib/solicitation/outreach';
import { requireSolicitationSendWriteAccess } from '@/app/api/dashboard/contacts/location-scope';
import { readBatchId, withScopedBatch } from '../_shared/scoped-batch-route';

export const dynamic = 'force-dynamic';

/**
 * Everything the browser is allowed to learn from a halt, and nothing else.
 * `HaltBatchResult.close` carries `parentRunId` — an internal `agent_runs`
 * UUID — plus the spine's `disposition`/`parentStatus` vocabulary and raw
 * status counts. None of it is read by the panel and none of it belongs on the
 * Requests surface: no internal id is ever rendered there (#629 round-2 finding
 * F10 — this route and `approve` ARE that precedent, which `regenerate` and
 * `withdraw` cite in turn).
 * Whitelisting also means a field added to the domain union later cannot start
 * shipping by accident — it has to be named here first.
 */
interface HaltWire {
  status: HaltBatchResult['status'];
  reason?: string;
  cancelledCount?: number;
  closed?: boolean;
  state?: string;
}

function toWire(result: HaltBatchResult): HaltWire {
  switch (result.status) {
    case 'halted':
      return {
        status: result.status,
        reason: result.reason,
        cancelledCount: result.cancelledCount,
        // The POSITIVE predicate, not `!== 'not_settled'`: `no_send_parent`
        // (an all-withheld built batch, haltable but with nothing to close)
        // writes nothing and must report `closed: false` (#891).
        closed: batchDidClose(result.close),
      };
    case 'not_haltable':
      return { status: result.status, state: result.state };
    default:
      return { status: result.status };
  }
}

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

      // Project to an EXPLICIT wire shape — see `toWire` above. Halt leaks worse
      // than approve would: a halt normally settles the batch, so `close` is
      // populated on the ORDINARY path, not just an edge case.
      const wire = toWire(result);

      switch (result.status) {
        case 'halted':
        case 'already_halted':
          return jsonResponse(wire);
        case 'not_haltable':
          return jsonResponse(wire, 409);
        case 'not_found':
          return errorResponse('Not found', 404);
      }
    },
  ),
);
