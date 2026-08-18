// POST /api/dashboard/solicitation/batch/regenerate — the owner asks for one
// new draft of one rendered ask (#860; **Ask regeneration**). Route
// orchestrates only: the send-lane flag gate, writable-owner auth, location
// resolution, body parse and the 500 mapping all live in `withScopedBatch`
// (../_shared/scoped-batch-route.ts); the transaction lives in
// src/lib/solicitation/approval.ts.
//
// TWO advisory gates run before the domain call and both fail OPEN:
// the per-owner regenerate limiter (the same keys the two Reviews-lane
// entrypoints use — one wallet, and the hour layer IS the spend bound), and the
// per-ask daily cap peek. Neither is authoritative: the worker's
// `checkAskRegenBudget` is, because an API-only limiter is bypassable via
// outbox replay (SPEC §8.2 r3). They exist so the owner sees "limit reached"
// synchronously instead of a spinner that ends with unchanged copy.

import { sql } from '@/lib/db/server';
import { errorResponse, jsonResponse, withSameOrigin } from '@/lib/auth/route-helpers';
import {
  askRegenLimitResponse,
  enforceDashboardRegenRateLimit,
} from '@/lib/shared/dashboard-regen-rate-limit';
import { peekAskRegenBudgetBatch } from '@/lib/costs/tracker';
import {
  requestAskRegeneration,
  type RequestAskRegenerationResult,
} from '@/lib/solicitation/approval';
import { requireSolicitationSendWriteAccess } from '@/app/api/dashboard/contacts/location-scope';
import { readBatchAsk, withScopedBatch } from '../_shared/scoped-batch-route';

export const dynamic = 'force-dynamic';

/**
 * Everything the browser is allowed to learn, and nothing else. No outbox id,
 * no run id — the halt/approve `toWire` precedent (#629 round-2 F10): no
 * internal id is ever rendered on the Requests surface, and the panel
 * refetches rather than tracking a job.
 */
interface RegenerateWire {
  status: RequestAskRegenerationResult['status'];
  state?: string;
  deliveryStatus?: string;
}

function toWire(result: RequestAskRegenerationResult): RegenerateWire {
  switch (result.status) {
    case 'not_regenerable':
      return { status: result.status, state: result.state };
    case 'ask_not_regenerable':
      return { status: result.status, deliveryStatus: result.deliveryStatus };
    default:
      return { status: result.status };
  }
}

export const POST = withSameOrigin()(
  withScopedBatch(
    sql,
    {
      endpoint: 'api/dashboard/solicitation/batch/regenerate',
      failureMessage: 'Failed to request a new version',
      // BOTH flags, exactly like approve/halt: regeneration is a send-lane act.
      requireWriteAccess: requireSolicitationSendWriteAccess,
      readInput: readBatchAsk,
    },
    async ({ accountId, locationId, actorUserId, input, logger }) => {
      const limited = await enforceDashboardRegenRateLimit(accountId);
      if (limited) return limited;

      // PEEK only. The refusal belongs to the domain call below, which decides
      // it after proving the ask is this tenant's — see `askRegenLimitResponse`.
      // An absent entry is UNKNOWN (Redis down) and travels as `null`, which
      // the domain reads as "proceed"; an absent Redis KEY is a different fact
      // and arrives as `{ used: 0, remaining: 3 }`.
      const budget = (await peekAskRegenBudgetBatch([input.askId])).get(input.askId);

      const result = await requestAskRegeneration(sql, {
        batchId: input.batchId,
        askId: input.askId,
        accountId,
        businessId: locationId,
        requestedByUserId: actorUserId,
        budgetRemaining: budget?.remaining ?? null,
      });

      // Ids and statuses only — no rendered subject or body is ever
      // interpolated into a log string (D6e: string args are logged verbatim).
      logger.log('ask_regeneration_requested', {
        status: result.status,
        batchId: input.batchId,
        askId: input.askId,
        businessId: locationId,
      });

      const wire = toWire(result);

      switch (result.status) {
        // 202, not 200: the work is accepted, not done. The panel starts
        // polling on this answer rather than announcing a completed act.
        case 'accepted':
          return jsonResponse(wire, 202);
        case 'already_in_flight':
        case 'not_regenerable':
        case 'ask_not_regenerable':
          return jsonResponse(wire, 409);
        case 'budget_exhausted': {
          // ASSERT, do not fall back: the domain returns this arm only when
          // `budgetRemaining` was non-null, which required the peek to have
          // answered — so an undefined `budget` here is a broken invariant, not
          // a case needing an invented default limit.
          if (budget === undefined) {
            throw new Error(
              'regenerate route: budget_exhausted without a peeked budget',
            );
          }
          return askRegenLimitResponse(budget.limit);
        }
        case 'not_found':
          return errorResponse('Not found', 404);
      }
    },
  ),
);
