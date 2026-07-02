import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { v7 as uuidv7 } from 'uuid';
import { sql, jsonb } from '@/lib/db/server';
import { QUEUE_NAMES } from '@/lib/shared/queue-names';
import { writeAccountAuditLog } from '@/lib/audit/log';
import { requireAdminWithAal2, internalError } from '@/lib/auth/admin-mfa-gate';
import { withSameOrigin } from '@/lib/auth/route-helpers';
import { zernioPublishingEnabled } from '@/lib/publishing/flags';

export const dynamic = 'force-dynamic';

const NO_STORE = { 'Cache-Control': 'no-store, private' } as const;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const ActionSchema = z.discriminatedUnion('action', [
  z.object({ action: z.literal('force_drain') }),
  z.object({ action: z.literal('dismiss'), responseId: z.uuid() }),
]);

class QueueActionError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
  ) {
    super(code);
    this.name = 'QueueActionError';
  }
}

async function handleZernioQueueAction(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
): Promise<NextResponse> {
  const { id: businessId } = await params;

  // FP: security ordering — the admin AAL2 auth/authorization gate must pass before the untrusted request body is parsed; these awaits cannot run in parallel.
  // react-doctor-disable-next-line react-doctor/server-sequential-independent-await
  const gate = await requireAdminWithAal2(request);
  if (!gate.ok) return gate.response;
  const admin = gate.admin;

  if (!UUID_RE.test(businessId)) {
    return NextResponse.json({ error: 'invalid_business_id' }, { status: 400, headers: NO_STORE });
  }

  let rawBody: unknown;
  try {
    rawBody = await request.json();
  } catch {
    return NextResponse.json({ error: 'invalid_body' }, { status: 400, headers: NO_STORE });
  }

  const parsed = ActionSchema.safeParse(rawBody);
  if (!parsed.success) {
    return NextResponse.json(
      { error: parsed.error.issues[0]?.message ?? 'invalid_request' },
      { status: 400, headers: NO_STORE },
    );
  }

  try {
    if (parsed.data.action === 'force_drain') {
      if (!zernioPublishingEnabled()) {
        return NextResponse.json({ error: 'feature_disabled' }, { status: 503, headers: NO_STORE });
      }
      const queued = await forceDrain(businessId, admin.id);
      return NextResponse.json({ ok: true, action: 'force_drain', queued }, { headers: NO_STORE });
    }

    await dismiss(businessId, parsed.data.responseId, admin.id);
    return NextResponse.json({ ok: true, action: 'dismiss' }, { headers: NO_STORE });
  } catch (err) {
    if (err instanceof QueueActionError) {
      return NextResponse.json({ error: err.code }, { status: err.status, headers: NO_STORE });
    }
    return internalError('[api/admin/businesses/[id]/zernio-queue] failed:', err);
  }
}

async function forceDrain(businessId: string, adminId: string): Promise<number> {
  return sql.begin(async (tx) => {
    const connRows = await tx<{ status: string; account_id: string }[]>`
      SELECT zc.status, b.account_id
      FROM zernio_connections zc
      JOIN businesses b ON b.id = zc.business_id
      WHERE zc.business_id = ${businessId}
      ORDER BY zc.created_at DESC
      LIMIT 1
      FOR UPDATE OF zc
    `;
    const conn = connRows[0];
    // Only an 'active' connection can publish. 'pending'/'disconnected' (or no
    // row) would just re-park everything, so drain is refused until the owner
    // reconnects — do NOT relax this to `!== 'disconnected'`.
    if (!conn || conn.status !== 'active') {
      throw new QueueActionError(409, 'connection_not_active');
    }

    const countRows = await tx<{ stuck_count: number }[]>`
      SELECT COUNT(*)::int AS stuck_count
      FROM responses
      WHERE business_id = ${businessId} AND status = 'awaiting_owner_connect'
    `;
    const stuckCount = countRows[0]?.stuck_count ?? 0;
    if (stuckCount === 0) {
      throw new QueueActionError(409, 'queue_empty');
    }

    // Re-run the SAME drain the reconnect flow fires — payload matches
    // finalize-tx.ts byte-for-byte (the one authoritative producer shape). The
    // DrainOwnerConnectWorker is idempotent, so repeat clicks are harmless; the
    // admin origin of this drain is recorded in the account_audit_log below.
    const payload = { business_id: businessId, kind: 'drain' };
    await tx`
      INSERT INTO job_outbox (id, topic, aggregate_type, aggregate_id, payload, attempts, max_attempts)
      VALUES (${uuidv7()}, ${QUEUE_NAMES.DRAIN_OWNER_CONNECT}, 'business', ${businessId}, ${jsonb(payload)}, 0, 5)
    `;

    await writeAccountAuditLog(
      {
        accountId: conn.account_id,
        actorUserId: adminId,
        eventType: 'zernio_queue_force_drained',
        entityType: 'business',
        entityId: businessId,
        payload: { stuck_count: stuckCount },
      },
      tx,
    );

    return stuckCount;
  });
}

async function dismiss(businessId: string, responseId: string, adminId: string): Promise<void> {
  await sql.begin(async (tx) => {
    const rows = await tx<{ id: string; account_id: string }[]>`
      SELECT r.id, b.account_id
      FROM responses r
      JOIN businesses b ON b.id = r.business_id
      WHERE r.id = ${responseId}
        AND r.business_id = ${businessId}
        AND r.status = 'awaiting_owner_connect'
      FOR UPDATE OF r
    `;
    const row = rows[0];
    if (!row) {
      throw new QueueActionError(409, 'not_awaiting');
    }

    // Terminal 'give up on this parked draft' transition — the same status +
    // posting_error pattern process-review.ts uses for parked responses.
    await tx`
      UPDATE responses
      SET status = 'superseded',
          posting_error = 'admin_dismissed_awaiting_connect',
          updated_at = NOW()
      WHERE id = ${responseId} AND status = 'awaiting_owner_connect'
    `;

    await writeAccountAuditLog(
      {
        accountId: row.account_id,
        actorUserId: adminId,
        eventType: 'zernio_queue_response_dismissed',
        entityType: 'response',
        entityId: responseId,
        // entityId already records the response; carry the location so the
        // audit row is self-describing without a join back to responses.
        payload: { business_id: businessId },
      },
      tx,
    );
  });
}

// CSRF by construction: same-origin enforced at the export, not inside the gate.
export const POST = withSameOrigin()(handleZernioQueueAction);
