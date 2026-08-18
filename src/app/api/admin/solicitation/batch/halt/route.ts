// POST /api/admin/solicitation/batch/halt — the admin arm of the Halt latch
// (#865; plan §3.3). A RepWorth operator stops a customer's send batch, with a
// required note that lands in the durable `account_audit_log` receipt.
//
// Shape is the admin control plane's, not the dashboard's: this follows
// `src/app/api/admin/autonomy/unsuspend/route.ts` — `requireAdminWithAal2` →
// `z.strictObject` body → one domain call → `internalError` on throw →
// `export const POST = withSameOrigin()(handler)`. The owner arm lives at
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
import { internalError, requireAdminWithAal2 } from '@/lib/auth/admin-mfa-gate';
import { withSameOrigin } from '@/lib/auth/route-helpers';
import { sql } from '@/lib/db/server';
import { NO_STORE_HEADERS } from '@/lib/shared/constants';
import { adminHaltBatch, type AdminHaltBatchResult } from '@/lib/solicitation/approval';
import type { BatchState } from '@/lib/solicitation/outreach';

export const dynamic = 'force-dynamic';

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
        closed: result.close.status !== 'not_settled',
      };
    case 'not_haltable':
      return { status: result.status, state: result.state };
    default:
      return { status: result.status };
  }
}

async function halt(request: NextRequest): Promise<NextResponse> {
  const gate = await requireAdminWithAal2(request);
  if (!gate.ok) return gate.response;

  let rawBody: unknown;
  try {
    rawBody = await request.json();
  } catch {
    return NextResponse.json(
      { error: 'invalid_body' },
      { status: 400, headers: NO_STORE_HEADERS },
    );
  }
  const parsed = AdminHaltSchema.safeParse(rawBody);
  if (!parsed.success) {
    return NextResponse.json(
      { error: parsed.error.issues[0]?.message ?? 'invalid_request' },
      { status: 400, headers: NO_STORE_HEADERS },
    );
  }

  try {
    const result = await adminHaltBatch(sql, {
      batchId: parsed.data.batchId,
      accountId: parsed.data.accountId,
      businessId: parsed.data.businessId,
      actorUserId: gate.admin.id,
      note: parsed.data.note,
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

// `withSameOrigin` is applied AT THE EXPORT on purpose — the wrapper is visible
// at the route boundary, which is what stops a new admin POST from shipping
// CSRF-open (route-helpers.ts records why the old opt-in flag was removed).
export const POST = withSameOrigin()(halt);
