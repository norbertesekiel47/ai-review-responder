// src/app/api/dashboard/reviews/[reviewId]/draft-status/route.ts
//
// GET /api/dashboard/reviews/[reviewId]/draft-status
//
// Polls the On-demand generation lane for one review. Distinct from
// past-replies/draft-status (D-C): keyed on reviewId (which the Reviews list
// row already carries, so a refresh resumes the poll) rather than outbox_id
// (client state a refresh loses), account-scoped rather than
// location-cookie-scoped, and NOT gated on EDIT_REPLIES_ENABLED — Generate
// never touches a live Google reply.
//
// States: { status: 'generating' } | { status: 'failed', error } |
//         { status: 'ready', response_id, response_text }
//         { status: 'idle' }  — nothing in flight and no draft

import { NextRequest, NextResponse } from 'next/server';
import { sql, sqlRead } from '@/lib/db/server';
import { requireDashboardReviewOwner } from '@/lib/approval/http-routes';
import { openFlagExistsSql } from '@/lib/moderation/held-draft';
import { QUEUE_NAMES } from '@/lib/shared/queue-names';
import { classifyOutboxStatus } from '@/lib/shared/job-outbox-status';
import { NON_TERMINAL_STATUSES } from '@/lib/shared/response-status';
import { statusArraySql } from '@/lib/shared/response-status-sql';
import { reportCaughtError } from '@/lib/shared/report-caught-error';
import { NO_STORE_HEADERS } from '@/lib/shared/constants';
import { proveReviewOwnership } from '@/lib/responses/review-ownership';

export const dynamic = 'force-dynamic';

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ reviewId: string }> },
): Promise<Response> {
  const owner = await requireDashboardReviewOwner(request);
  if (owner instanceof NextResponse) return owner;

  const { reviewId } = await params;

  // Tenant proof FIRST — identical shape to the generate door, so a caller can
  // never observe another account's generation status or draft text. On the
  // READ pool like every other query in this handler: the route is polled every
  // ~1.5s per expanded row and writes nothing, so there is no read-your-write
  // to preserve and no reason to spend a write-pool connection on it.
  const businessId = await proveReviewOwnership(sqlRead, reviewId, owner.accountId);
  if (!businessId) {
    return NextResponse.json({ error: 'review_not_found' }, { status: 404, headers: NO_STORE_HEADERS });
  }

  try {
    // F5 / invariant #4: a high-severity moderation flag leaves the draft at
    // `pending_approval` with an OPEN `flagged_responses` row. Returning it as
    // `ready` would hand the owner held text plus an `Approve & post` button —
    // the exact release path `src/lib/moderation/held-draft.ts` exists to block.
    // That module is the SEMANTIC OWNER of "is this draft held"; this read
    // path composes its openFlagExistsSql fragment (#730).
    // The `held` flag is SELECTed (not filtered) so a held draft is
    // distinguishable from "no draft at all"; filtering would make this route
    // report `idle` for both and the list fall through to `generate` (D9).
    const draftRows = await sqlRead<
      { id: string; status: string; response_text: string | null; held: boolean }[]
    >`
      SELECT
        resp.id, resp.status, resp.response_text,
        ${openFlagExistsSql(sqlRead, sqlRead`resp.id`)} AS held
      FROM responses resp
      WHERE resp.review_id = ${reviewId}::uuid
        AND resp.business_id = ${businessId}::uuid
        AND resp.status = ANY(${statusArraySql(sql, NON_TERMINAL_STATUSES)})
      ORDER BY resp.version DESC
      LIMIT 1
    `;
    if (draftRows[0]?.held) {
      // Never `ready`, never `response_text`. `idle` stops the poller; the list
      // row re-renders as `held` from its own query. Admin re-notification at
      // /admin/flagged is the owner's only path back.
      return NextResponse.json({ status: 'idle' }, { status: 200, headers: NO_STORE_HEADERS });
    }
    if (draftRows[0]) {
      return NextResponse.json(
        { status: 'ready', response_id: draftRows[0].id, response_text: draftRows[0].response_text },
        { status: 200, headers: NO_STORE_HEADERS },
      );
    }

    const outboxRows = await sqlRead<{ status: string; last_error: string | null }[]>`
      SELECT status, last_error
      FROM job_outbox
      WHERE topic = ${QUEUE_NAMES.GENERATE_RESPONSE}
        AND aggregate_id = ${reviewId}
      ORDER BY created_at DESC
      LIMIT 1
    `;
    const outbox = outboxRows[0];
    if (!outbox) {
      return NextResponse.json({ status: 'idle' }, { status: 200, headers: NO_STORE_HEADERS });
    }
    // The in-flight set is IMPORTED, never re-spelled. Invariant #2's
    // byte-for-byte hand-spelling requirement covers SQL literals only — it
    // exists because a bind parameter inside an `ON CONFLICT … WHERE` predicate
    // defeats partial-index inference. This is a JS comparison, so the exported
    // constant is the right tool (import-offer-view.ts is the same call).
    switch (classifyOutboxStatus(outbox.status)) {
      case 'in_flight':
        return NextResponse.json({ status: 'generating' }, { status: 200, headers: NO_STORE_HEADERS });
      case 'completed':
        // Completed but no non-terminal draft: the draft was held by moderation
        // (invariant #4) or already settled. Nothing for the row to expand.
        return NextResponse.json({ status: 'idle' }, { status: 200, headers: NO_STORE_HEADERS });
      case 'terminal':
        return NextResponse.json(
          { status: 'failed', error: outbox.last_error },
          { status: 200, headers: NO_STORE_HEADERS },
        );
    }
  } catch (err) {
    reportCaughtError('reviews/draft-status', err, { accountId: owner.accountId, businessId, reviewId });
    return NextResponse.json({ error: 'internal_error' }, { status: 500 });
  }
}
