import { NextRequest, NextResponse } from 'next/server';
import { createServerClient } from '@supabase/ssr';
import { z } from 'zod';
import { v7 as uuidv7 } from 'uuid';
import { sql, jsonb } from '@/lib/db/server';
import { AuthError, requireRole } from '@/lib/db/auth';
import { writeAccountAuditLog } from '@/lib/audit/log';
import { requireCurrentAal2FromSupabase, type SupabaseMfaAalClient } from '@/lib/auth/mfa';
import { assertSameOrigin, SameOriginError } from '@/lib/shared/csrf';
import type { SendNotificationPayload, GenerateResponsePayload } from '@/lib/shared/worker-types';

export const dynamic = 'force-dynamic';

const NO_STORE = { 'Cache-Control': 'no-store, private' } as const;

/**
 * Build the cookie-backed Supabase client used for the AAL2 (MFA step-up)
 * check. Both GET (reads cross-tenant flagged draft text) and POST (mutates
 * dispositions) require a current AAL2 session — flagged drafts contain
 * sensitive, potentially policy-violating customer-facing text.
 */
function mfaClientForRequest(request: NextRequest): SupabaseMfaAalClient {
  return createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    {
      cookies: {
        getAll() {
          return request.cookies.getAll();
        },
        setAll() {
          // Route handlers cannot mutate request cookies; proxy handles refresh.
        },
      },
    },
  ) as SupabaseMfaAalClient;
}

interface FlaggedRow {
  id: string;
  response_id: string;
  business_id: string;
  account_id: string;
  review_id: string;
  source: string;
  reason: string | null;
  severity: string;
  status: string;
  created_at: string;
  response_text: string;
  version: number;
  reviewer_name: string;
  star_rating: number;
  business_name: string;
}

export async function GET(request: NextRequest): Promise<NextResponse> {
  try {
    await requireRole(request, 'admin');
  } catch (err) {
    if (err instanceof AuthError) {
      return NextResponse.json({ error: err.message }, { status: err.statusCode, headers: NO_STORE });
    }
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401, headers: NO_STORE });
  }

  // Reading the queue exposes flagged draft text + reviewer/business identity
  // across every tenant — same sensitivity as the POST disposition, so it gets
  // the same MFA step-up requirement.
  const aal = await requireCurrentAal2FromSupabase(mfaClientForRequest(request));
  if (!aal.ok) {
    return NextResponse.json({ error: aal.reason }, { status: 403, headers: NO_STORE });
  }

  const rawLimit = request.nextUrl.searchParams.get('limit');
  const rawOffset = request.nextUrl.searchParams.get('offset');
  const limit = Math.min(Math.max(parseInt(rawLimit ?? '20', 10) || 20, 1), 100);
  const offset = Math.max(parseInt(rawOffset ?? '0', 10) || 0, 0);

  // Admin cross-tenant read of the OPEN flagged queue. The joins to tenant
  // tables (responses/reviews/businesses) are intentionally unscoped (admin
  // sees every tenant) and are covered by tenant-scope-allowlist.ts entries.
  const rows = await sql<FlaggedRow[]>`
    SELECT fr.id, fr.response_id, fr.business_id, fr.account_id, fr.review_id,
           fr.source, fr.reason, fr.severity, fr.status, fr.created_at,
           r.response_text, r.version,
           rev.reviewer_name, rev.star_rating,
           b.name AS business_name
    FROM flagged_responses fr
    JOIN responses r ON r.id = fr.response_id
    JOIN reviews rev ON rev.id = fr.review_id
    JOIN businesses b ON b.id = fr.business_id
    WHERE fr.status = 'open'
    ORDER BY fr.created_at DESC
    LIMIT ${limit} OFFSET ${offset}
  `;

  const flagged = rows.map((row) => ({
    id: row.id,
    responseId: row.response_id,
    businessId: row.business_id,
    accountId: row.account_id,
    reviewId: row.review_id,
    source: row.source,
    reason: row.reason,
    severity: row.severity,
    status: row.status,
    createdAt: row.created_at,
    responseText: row.response_text,
    version: row.version,
    reviewerName: row.reviewer_name,
    starRating: row.star_rating,
    businessName: row.business_name,
  }));

  return NextResponse.json({ flagged, limit, offset }, { headers: NO_STORE });
}

const DispositionSchema = z.object({
  flaggedId: z.string().uuid(),
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

interface OpenFlagRow {
  id: string;
  response_id: string;
  business_id: string;
  account_id: string;
}

export async function POST(request: NextRequest): Promise<NextResponse> {
  try {
    assertSameOrigin(request);
  } catch (err) {
    if (err instanceof SameOriginError) {
      return NextResponse.json({ error: 'forbidden' }, { status: 403, headers: NO_STORE });
    }
    return dispositionErrorResponse(err);
  }

  let admin;
  try {
    admin = await requireRole(request, 'admin');
  } catch (err) {
    if (err instanceof AuthError) {
      return NextResponse.json({ error: err.message }, { status: err.statusCode, headers: NO_STORE });
    }
    return dispositionErrorResponse(err);
  }

  const aal = await requireCurrentAal2FromSupabase(mfaClientForRequest(request));
  if (!aal.ok) {
    return NextResponse.json({ error: aal.reason }, { status: 403, headers: NO_STORE });
  }

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
        const payload: SendNotificationPayload = {
          response_id: flag.response_id,
          business_id: flag.business_id,
        };
        await tx`
          INSERT INTO job_outbox (id, topic, aggregate_type, aggregate_id, payload, status)
          VALUES (
            ${uuidv7()}, 'send_notification', 'response', ${flag.response_id},
            ${jsonb(payload)}, 'pending'
          )
        `;
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
        const resp = respRows[0];
        if (resp && resp.status === 'pending_approval') {
          await tx`
            UPDATE responses
            SET status = 'superseded', updated_at = NOW()
            WHERE id = ${flag.response_id}::uuid AND business_id = ${flag.business_id}::uuid
          `;
          const regenPayload: GenerateResponsePayload = {
            review_id: resp.review_id,
            business_id: flag.business_id,
            version: resp.version + 1,
          };
          await tx`
            INSERT INTO job_outbox (id, topic, aggregate_type, aggregate_id, payload, status)
            VALUES (
              ${uuidv7()}, 'generate_response', 'review', ${resp.review_id},
              ${jsonb(regenPayload)}, 'pending'
            )
          `;
        }
      }

      await writeAccountAuditLog(
        {
          accountId: flag.account_id,
          actorUserId: admin.id,
          eventType: 'flagged_response_dispositioned',
          entityType: 'flagged_response',
          entityId: flaggedId,
          payload: { action, response_id: flag.response_id },
        },
        tx,
      );
    });
  } catch (err) {
    if (err instanceof DispositionError) {
      return NextResponse.json({ error: err.code }, { status: err.status, headers: NO_STORE });
    }
    return dispositionErrorResponse(err);
  }

  return NextResponse.json({ ok: true, action }, { headers: NO_STORE });
}

function dispositionErrorResponse(error: unknown): NextResponse {
  console.error('[api/admin/flagged] disposition failed:', error);
  return NextResponse.json({ error: 'internal_error' }, { status: 500, headers: NO_STORE });
}
