// POST /api/admin/solicitation/batch/halt — the admin arm of the Halt latch
// (#865; plan §3.3). A RepWorth operator stops a customer's send batch, with a
// required note that lands in the durable `account_audit_log` receipt.
//
// Shape is the admin control plane's, not the dashboard's: this follows
// `src/app/api/admin/autonomy/unsuspend/route.ts` — `requireAdminJson(request,
// schema)` (the gate + `request.json()` + `safeParse` + both 400 shapes, #909)
// → one domain call → `internalError` on throw →
// `export const POST = withSameOriginUnlessBearer()(handler)`. The `z.strictObject` below
// is still this route's own; what moved is the PARSING, not the schema. The
// owner arm lives at
// `src/app/api/dashboard/solicitation/batch/halt/route.ts` and shares nothing
// but the latch underneath it, because its actor, its gates and its tenant
// resolution are all different.
//
// Route orchestrates only (invariant #12): the latch write, the outreach
// cancellations, the audit row and the `closeBatchIfSettled` join all happen
// inside `adminHaltBatch`'s single transaction. Nothing here is business logic.
//
// THE TENANT TRIPLE COMES FROM THE BODY, and that is the admin-actor precedent,
// not an oversight (D2): `resolveAdminActor` in
// `src/app/api/_shared/channels/resolve-actor.ts` reads `businessId` from the
// BODY, while the owner-side `resolveOwnerActor` reads `locationId` from the
// SESSION. An operator has no tenant session to resolve; the request names the
// customer. Every query `adminHaltBatch` issues stays scoped by both ids, so a
// mismatched triple is the same 404 an unknown batch id gets — the two are
// deliberately indistinguishable to the caller.
//
// THE ACTOR NEVER COMES FROM THE BODY. `actorUserId` is stamped from the GATE's
// admin (invariant #8, D1) — a request that could name its own `halted_by`
// would make the audit trail lie about who stopped a customer's batch.
//
// NO `SOLICITATION_SEND_ENABLED` GATE, deliberately (D5). Support must be able
// to stop a stranded batch AFTER the lane flag is turned off; the flag is a
// lane switch, not an authorization. The owner arm keeps its
// `requireSolicitationSendWriteAccess` gate — that asymmetry is the decision.

import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { internalError, requireAdminJson } from '@/lib/auth/admin-mfa-gate';
import { withSameOriginUnlessBearer } from '@/lib/auth/route-helpers';
import { sql } from '@/lib/db/server';
import { NO_STORE_HEADERS } from '@/lib/shared/constants';
import { createWorkerLogger } from '@/lib/shared/logger';
import { adminHaltBatch, type AdminHaltBatchResult } from '@/lib/solicitation/approval';
import { batchDidClose, type BatchState } from '@/lib/solicitation/outreach';

export const dynamic = 'force-dynamic';

/** Same prefix the endpoint is named by, so an operator grepping the route path
 *  finds both this line and anything `internalError` reports for it. */
const logger = createWorkerLogger('api/admin/solicitation/batch/halt');

/**
 * `strictObject`, not `object`, and the difference is the ticket's second
 * constraint made mechanical: no request field may name the halt reason. A body
 * carrying `reason`, `haltReason` or `halt_reason` is rejected with **400**,
 * and `adminHaltBatch` is never called. "Ignoring" an unknown field would let a
 * 200 sit next to a client that believes it chose the reason — which is fixed
 * by this route's identity and can never be requested.
 *
 * `note` is required (D10): an operator acting on a customer's account says
 * why. It is bounded because it lands verbatim in the audit payload.
 */
const AdminHaltSchema = z.strictObject({
  accountId: z.uuid(),
  businessId: z.uuid(),
  batchId: z.uuid(),
  note: z.string().trim().min(1).max(1_000),
});

/**
 * Everything an admin browser is allowed to learn from a halt, and nothing
 * else — the owner halt route's `toWire` discipline, for the same reason.
 * `AdminHaltBatchResult.close` carries `parentRunId` (an internal `agent_runs`
 * UUID) plus the spine's `disposition`/`parentStatus` vocabulary and raw status
 * counts. None of it is read by the panel, and whitelisting means a field added
 * to the domain union later cannot start shipping by accident — it has to be
 * named here first.
 */
interface AdminHaltWire {
  status: AdminHaltBatchResult['status'];
  cancelledCount?: number;
  closed?: boolean;
  state?: BatchState;
}

function toWire(result: AdminHaltBatchResult): AdminHaltWire {
  switch (result.status) {
    case 'halted':
      return {
        status: result.status,
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

async function halt(request: NextRequest): Promise<NextResponse> {
  const gate = await requireAdminJson(request, AdminHaltSchema);
  if (!gate.ok) return gate.response;

  try {
    const result = await adminHaltBatch(sql, {
      batchId: gate.data.batchId,
      accountId: gate.data.accountId,
      businessId: gate.data.businessId,
      actorUserId: gate.admin.id,
      note: gate.data.note,
    });

    // IDS AND COUNTS ONLY, and the note is the field this deliberately omits:
    // it is free text an operator typed, and CLAUDE.md's logging rule forbids
    // raw content in a log line (string args are logged verbatim). Its durable
    // home is the `account_audit_log` payload, which is access-controlled; a log
    // sink is not. Mirrors the owner arm's `batch_halted` line, minus the
    // derived reason — this arm's reason is fixed by the route's identity.
    logger.log('admin_batch_halted', {
      status: result.status,
      batchId: gate.data.batchId,
      businessId: gate.data.businessId,
      cancelledCount: result.status === 'halted' ? result.cancelledCount : 0,
    });

    const wire = toWire(result);
    switch (result.status) {
      case 'halted':
      case 'already_halted':
        return NextResponse.json(wire, { headers: NO_STORE_HEADERS });
      case 'not_haltable':
        return NextResponse.json(wire, { status: 409, headers: NO_STORE_HEADERS });
      case 'not_found':
        return NextResponse.json(wire, { status: 404, headers: NO_STORE_HEADERS });
    }
  } catch (error) {
    return internalError('[api/admin/solicitation/batch/halt] failed:', error);
  }
}

// `withSameOriginUnlessBearer` is applied AT THE EXPORT on purpose — the wrapper is visible
// at the route boundary, which is what stops a new admin POST from shipping
// CSRF-open (route-helpers.ts records why the old opt-in flag was removed).
export const POST = withSameOriginUnlessBearer()(halt);
