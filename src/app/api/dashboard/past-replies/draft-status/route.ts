// src/app/api/dashboard/past-replies/draft-status/route.ts
//
// GET /api/dashboard/past-replies/draft-status?outbox_id=<uuid>
//
// Polls a regenerate generation's job_outbox row. The client polls this
// after POST /draft (mode='regenerate') returns { outbox_id }. Four states:
//
//   - { status: 'generating' }                — outbox pending/dispatching/dispatched
//   - { status: 'failed', error }             — outbox failed (last_error surfaced)
//   - { status: 'failed', error: 'held_for_review' } — outbox completed but the
//     resolved response carries an OPEN moderation flag (invariant #4): terminal
//     for the poller; neither response_id nor response_text is returned
//   - { response_id, status, response_text }  — outbox completed; response row found
//
// SECURITY: tenant-ownership guard runs on BOTH the outbox payload's
// business_id AND the resolved response row. Without that, polling by raw
// outbox_id could leak generation status / draft text across tenants
// (spec §4.4 "Auth: ... MUST verify ... business_id ... AND the resolved
// response_id ... also belongs to the same business").
//
// NOT wrapped with withSameOrigin — GETs are not subject to the same CSRF
// threat model (spec §4.4 cross-cutting bullet: "GET /draft-status is
// exempt from origin checking").
//
// Auth: requireRole(request, 'owner') for session validation; current location
// resolved from the 'rw_location_scope' cookie via getRequestScope (same as SSR).
// Falls back to primary location when cookie is absent or invalid.
//
// Status enum vs. spec §4.4 wording: spec says "pending/dispatching/dispatched"
// → 'generating', "completed" → response lookup, "failed" → surface error.
// Outbox `status` enum from job_outbox includes additional terminal states
// (e.g. 'cancelled') — those are treated as 'failed' for polling purposes
// since the client has nothing else to do with them.

import { NextRequest, NextResponse } from 'next/server';
import { sql, sqlRead } from '@/lib/db/server';
import { openFlagExistsSql } from '@/lib/moderation/held-draft';
import { resolveOwnerScope, ScopeError } from '@/lib/auth/resolve-owner-scope';
import { reportCaughtError } from '@/lib/shared/report-caught-error';
import { editRepliesEnabled } from '@/lib/past-replies/flags';
import { OUTBOX_IN_FLIGHT_STATUSES } from '@/lib/shared/job-outbox-status';

export const dynamic = 'force-dynamic';

export async function GET(request: NextRequest): Promise<Response> {
  if (!editRepliesEnabled()) {
    return NextResponse.json({ error: 'feature_disabled' }, { status: 503 });
  }

  // Auth + current-location scope (no CSRF check — GET is exempt).
  let locationId;
  try {
    ({ locationId } = await resolveOwnerScope(sql, request, { allowReadOnly: true }));
  } catch (err) {
    if (err instanceof ScopeError) {
      return NextResponse.json({ error: err.message }, { status: err.statusCode });
    }
    throw err;
  }

  const url = new URL(request.url);
  const outboxId = url.searchParams.get('outbox_id');
  if (!outboxId) {
    return NextResponse.json({ error: 'missing_outbox_id' }, { status: 400 });
  }

  try {
    // Route-body reads → the right-sized read bulkhead (#477 Task 1). The
    // resolveOwnerScope auth preamble above stays on write `sql` (shared
    // helper, not threaded onto sqlRead — wiring decision, plan §Task 1).
    const outboxRows = await sqlRead<{
      status: string;
      payload: unknown;
      last_error: string | null;
      aggregate_id: string;
    }[]>`
      SELECT status, payload, last_error, aggregate_id
      FROM job_outbox
      WHERE id = ${outboxId}
      LIMIT 1
    `;
    const outbox = outboxRows[0];
    if (!outbox) {
      return NextResponse.json({ error: 'outbox_not_found' }, { status: 404 });
    }

    // Postgres.js + PgBouncer can return JSONB columns as strings — guard.
    const payload =
      typeof outbox.payload === 'string'
        ? (JSON.parse(outbox.payload) as Record<string, unknown>)
        : (outbox.payload as Record<string, unknown> | null);

    // Tenant ownership guard: outbox payload's business_id must equal the
    // caller's resolved current location. Without this, any owner could poll
    // any outbox_id and observe another tenant's generation status / draft text.
    if (!payload || payload.business_id !== locationId) {
      return NextResponse.json({ error: 'forbidden' }, { status: 403 });
    }

    // The in-flight set is IMPORTED, never re-spelled. Invariant #2's
    // byte-for-byte hand-spelling requirement covers SQL literals only — it
    // exists because a bind parameter inside an `ON CONFLICT … WHERE` predicate
    // defeats partial-index inference. This is a JS comparison, so the exported
    // constant is the right tool (the sibling reviews/[reviewId]/draft-status
    // route and import-offer-view.ts are the same call). This route predates
    // the constant (#56 vs #588); it was the last JS hand-spell left (#764).
    if ((OUTBOX_IN_FLIGHT_STATUSES as readonly string[]).includes(outbox.status)) {
      return NextResponse.json({ status: 'generating' }, { status: 200 });
    }

    if (outbox.status === 'completed') {
      // Worker INSERTed the response row. aggregate_id is the review_id.
      //
      // Invariant #4: a high-severity moderation flag leaves the draft at
      // `pending_approval` with an OPEN `flagged_responses` row — a
      // moderation-held draft "surfaces neither its text nor any button".
      // `src/lib/moderation/held-draft.ts` is the SEMANTIC OWNER of "is this
      // draft held"; this read path composes its openFlagExistsSql fragment
      // (#730).
      const responseRows = await sqlRead<{
        id: string;
        status: string;
        response_text: string | null;
        business_id: string;
        held: boolean;
      }[]>`
        SELECT id, status, response_text, business_id,
          ${openFlagExistsSql(sqlRead, sqlRead`responses.id`)} AS held
        FROM responses
        WHERE review_id = ${outbox.aggregate_id}
          AND status IN ('pending_approval', 'approved', 'edited') -- status-audit-ignore: 3-value poll subset (excludes awaiting_owner_connect); no exact group match, not a reusable grouping
        ORDER BY version DESC
        LIMIT 1
      `;
      const response = responseRows[0];
      if (!response) {
        return NextResponse.json({ error: 'response_not_found' }, { status: 404 });
      }
      // Defense in depth: even if the outbox payload passed the tenant check,
      // re-verify the response row also belongs to the caller's current location
      // before returning the draft text.
      if (response.business_id !== locationId) {
        return NextResponse.json({ error: 'forbidden' }, { status: 403 });
      }
      // Moderation-held draft (invariant #4, semantic owner
      // src/lib/moderation/held-draft.ts): terminal `failed` with the
      // owner-visible refusal vocabulary `held_for_review` — never
      // response_id or response_text. Checked AFTER the tenant re-check so a
      // cross-tenant poll gets a heldness-free 403 (tenant refusal wins).
      if (response.held) {
        return NextResponse.json(
          { status: 'failed', error: 'held_for_review' },
          { status: 200 },
        );
      }
      return NextResponse.json(
        {
          response_id: response.id,
          status: response.status,
          response_text: response.response_text,
        },
        { status: 200 },
      );
    }

    // Treat 'failed' (and any other terminal status the worker may produce)
    // as a failure for polling purposes — the client has nothing else to do.
    return NextResponse.json(
      { status: 'failed', error: outbox.last_error },
      { status: 200 },
    );
  } catch (err) {
    reportCaughtError('past-replies/draft-status GET', err, { locationId, outboxId });
    return NextResponse.json({ error: 'internal_error' }, { status: 500 });
  }
}
