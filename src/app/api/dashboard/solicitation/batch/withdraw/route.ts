// POST /api/dashboard/solicitation/batch/withdraw — the owner withdraws ONE
// approved ask (#872; ADR 0021, **Ask withdrawal**). Route orchestrates only:
// the send-lane flag gate, writable-owner auth, location resolution, body parse
// and the 500 mapping all live in `withScopedBatch`
// (../_shared/scoped-batch-route.ts); the verb lives in
// src/lib/solicitation/approval.ts.
//
// The body carries `batchId` and `askId` and NOTHING else (`readBatchAsk`):
// the disposition reason is fixed server-side (`owner_withdrawn`) and the row
// is resolved under the batch lock, so nothing client-supplied can name a
// reason, a row or a status.

import { sql } from '@/lib/db/server';
import { errorResponse, jsonResponse, withSameOrigin } from '@/lib/auth/route-helpers';
import { withdrawAsk, type WithdrawAskResult } from '@/lib/solicitation/approval';
import { requireSolicitationSendWriteAccess } from '@/app/api/dashboard/contacts/location-scope';
import { readBatchAsk, withScopedBatch } from '../_shared/scoped-batch-route';

export const dynamic = 'force-dynamic';

/**
 * Everything the browser is allowed to learn from a withdrawal, and nothing
 * else. `WithdrawAskResult.close` carries `parentRunId` — an internal
 * `agent_runs` UUID — plus the spine's `disposition`/`parentStatus` vocabulary
 * and raw counts. No internal id reaches the Requests surface — the halt and
 * approve routes' `toWire` precedent (#629 round-2 finding F10; the "ADR 0012"
 * those files cite for it is a misattribution — 0012 is the sentiment-blind
 * withhold enum). `not_live`'s `deliveryStatus` stays server-side too: the panel has
 * one sentence for it, and the row's status is not the owner's to act on.
 */
interface WithdrawWire {
  status: WithdrawAskResult['status'];
  remainingLive?: number;
  closed?: boolean;
  state?: string;
}

function toWire(result: WithdrawAskResult): WithdrawWire {
  switch (result.status) {
    case 'withdrawn':
      return {
        status: result.status,
        remainingLive: result.remainingLive,
        closed: result.close.status !== 'not_settled',
      };
    case 'not_withdrawable':
      return { status: result.status, state: result.state };
    default:
      return { status: result.status };
  }
}

export const POST = withSameOrigin()(
  withScopedBatch(
    sql,
    {
      endpoint: 'api/dashboard/solicitation/batch/withdraw',
      failureMessage: 'Failed to withdraw ask',
      // BOTH flags, like approve/halt/regenerate: withdrawal is a send-lane verb.
      requireWriteAccess: requireSolicitationSendWriteAccess,
      readInput: readBatchAsk,
    },
    async ({ accountId, locationId, actorUserId, input, logger }) => {
      const result = await withdrawAsk(sql, {
        batchId: input.batchId,
        askId: input.askId,
        accountId,
        businessId: locationId,
        withdrawnByUserId: actorUserId,
      });

      // Ids, statuses and counts only — never a subject or body (D6e: string
      // args are logged verbatim).
      logger.log('ask_withdrawn', {
        status: result.status,
        batchId: input.batchId,
        askId: input.askId,
        businessId: locationId,
        remainingLive: result.status === 'withdrawn' ? result.remainingLive : null,
      });

      const wire = toWire(result);
      switch (result.status) {
        case 'withdrawn':
        case 'already_withdrawn':
          return jsonResponse(wire);
        case 'not_withdrawable':
        case 'not_live':
          return jsonResponse(wire, 409);
        case 'not_found':
          return errorResponse('Not found', 404);
      }
    },
  ),
);
