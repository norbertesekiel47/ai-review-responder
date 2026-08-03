import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { sql } from '@/lib/db/server';
import { writeAccountAuditLog } from '@/lib/audit/log';
import { requireAdminWithAal2, internalError } from '@/lib/auth/admin-mfa-gate';
import { withSameOrigin } from '@/lib/auth/route-helpers';
import { GENERATE_RESPONSE_ORIGIN_LANE } from '@/lib/shared/worker-types';
import { enqueueGenerateResponse, enqueueSendNotification } from '@/lib/shared/job-outbox-helpers';
import { assertLocationNotArchived } from '@/lib/approval/locks';
import { ArchivedLocationError } from '@/lib/approval/errors';
import { listOpenFlaggedResponses } from '@/lib/admin/flagged-service';

export const dynamic = 'force-dynamic';

const NO_STORE = { 'Cache-Control': 'no-store, private' } as const;

export async function GET(request: NextRequest): Promise<NextResponse> {
  // Reading the queue exposes flagged draft text + reviewer/business identity
  // across every tenant — same sensitivity as the POST disposition, so it gets
  // the same admin + AAL2 (MFA step-up) gate. No same-origin: GET is not a
  // mutation.
  const gate = await requireAdminWithAal2(request);
  if (!gate.ok) return gate.response;

  const rawLimit = request.nextUrl.searchParams.get('limit');
  const rawOffset = request.nextUrl.searchParams.get('offset');
  const limit = Math.min(Math.max(parseInt(rawLimit ?? '20', 10) || 20, 1), 100);
  const offset = Math.max(parseInt(rawOffset ?? '0', 10) || 0, 0);

  const { flagged, total } = await listOpenFlaggedResponses(sql, { limit, offset });

  return NextResponse.json({ flagged, limit, offset, total }, { headers: NO_STORE });
}

const DispositionSchema = z.object({
  flaggedId: z.uuid(),
  action: z.enum([
    'approved_for_owner_review',
    'dismissed_false_positive',
    'requires_regeneration',
  ]),
});

class DispositionError extends Error {
  constructor(public readonly status: number, public readonly code: string) {
    super(code);
    this.name = 'DispositionError';
  }
}

/** Archived gate, translated to this route's disposition error vocabulary. */
async function assertFlagLocationActive(
  tx: Parameters<typeof assertLocationNotArchived>[0],
  businessId: string,
): Promise<void> {
  try {
    await assertLocationNotArchived(tx, businessId);
  } catch (err) {
    if (err instanceof ArchivedLocationError) {
      throw new DispositionError(409, 'archived_location');
    }
    throw err;
  }
}

interface OpenFlagRow {
  id: string;
  response_id: string;
  business_id: string;
  account_id: string;
}

async function dispositionFlaggedResponse(request: NextRequest): Promise<NextResponse> {
  const gate = await requireAdminWithAal2(request);
  if (!gate.ok) return gate.response;
  const admin = gate.admin;

  let rawBody: unknown;
  try {
    rawBody = await request.json();
  } catch {
    return NextResponse.json({ error: 'invalid_body' }, { status: 400, headers: NO_STORE });
  }

  const parsed = DispositionSchema.safeParse(rawBody);
  if (!parsed.success) {
    return NextResponse.json(
      { error: parsed.error.issues[0]?.message ?? 'invalid_request' },
      { status: 400, headers: NO_STORE },
    );
  }

  const { flaggedId, action } = parsed.data;

  try {
    await sql.begin(async (tx) => {
      const rows = await tx<OpenFlagRow[]>`
        SELECT id, response_id, business_id, account_id
        FROM flagged_responses
        WHERE id = ${flaggedId}::uuid AND status = 'open'
        FOR UPDATE
      `;
      const flag = rows[0];
      if (!flag) {
        throw new DispositionError(409, 'not_open');
      }

      await tx`
        UPDATE flagged_responses
        SET status = ${action},
            reviewed_by_user_id = ${admin.id}::uuid,
            reviewed_at = NOW(),
            updated_at = NOW()
        WHERE id = ${flaggedId}::uuid AND status = 'open'
      `;

      // Only an explicit approval releases the held draft to the owner — via the
      // transactional outbox, atomic with the status change.
      if (action === 'approved_for_owner_review') {
        // Archived-location gate: releasing to an archived location would
        // close the flag and enqueue a notification that dispatch silently
        // skips — the admin believes the draft was released while the owner
        // never hears of it. Throwing rolls back the whole tx so the flag
        // stays open and the admin sees why. dismissed_false_positive stays
        // UNGATED on purpose: admins must be able to close flags for
        // archived locations or they stay open forever.
        await assertFlagLocationActive(tx, flag.business_id);
        await enqueueSendNotification(tx, {
          responseId: flag.response_id,
          businessId: flag.business_id,
        });
      }

      // Regeneration supersedes the held (unsafe) draft so it can never be
      // published, and enqueues a fresh generation at version+1 — mirroring the
      // owner-facing regenerate path (regenerateBySession). Without this the
      // closed flag would re-open the owner-release gate on the SAME bad text.
      if (action === 'requires_regeneration') {
        const respRows = await tx<{ review_id: string; version: number; status: string }[]>`
          SELECT review_id, version, status
          FROM responses
          WHERE id = ${flag.response_id}::uuid AND business_id = ${flag.business_id}::uuid
          FOR UPDATE
        `;
        // Archived-location gate AFTER the responses lock — uniform
        // responses → businesses lock order with the owner-facing approval
        // lanes. Without it the supersede commits, the flag closes, and the
        // enqueued generate job skips-as-success — review left with no
        // draft, silently.
        await assertFlagLocationActive(tx, flag.business_id);
        const resp = respRows[0];
        if (resp && resp.status === 'pending_approval') {
          await tx`
            UPDATE responses
            SET status = 'superseded', updated_at = NOW()
            WHERE id = ${flag.response_id}::uuid AND business_id = ${flag.business_id}::uuid
          `;
          await enqueueGenerateResponse(tx, {
            reviewId: resp.review_id,
            businessId: flag.business_id,
            version: resp.version + 1,
            originLane: GENERATE_RESPONSE_ORIGIN_LANE.REGENERATE,
          });
        }
      }

      await writeAccountAuditLog(tx, {
        accountId: flag.account_id,
        actorUserId: admin.id,
        eventType: 'flagged_response_dispositioned',
        entityType: 'flagged_response',
        entityId: flaggedId,
        payload: { action, response_id: flag.response_id },
      });
    });
  } catch (err) {
    if (err instanceof DispositionError) {
      return NextResponse.json({ error: err.code }, { status: err.status, headers: NO_STORE });
    }
    return internalError('[api/admin/flagged] disposition failed:', err);
  }

  return NextResponse.json({ ok: true, action }, { headers: NO_STORE });
}

// CSRF by construction: same-origin enforced at the export, not inside the gate.
export const POST = withSameOrigin()(dispositionFlaggedResponse);
