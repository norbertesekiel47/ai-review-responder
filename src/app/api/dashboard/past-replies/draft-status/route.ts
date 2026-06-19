// src/app/api/dashboard/past-replies/draft-status/route.ts
//
// GET /api/dashboard/past-replies/draft-status?outbox_id=<uuid>
//
// Polls a regenerate generation's job_outbox row. The client polls this
// after POST /draft (mode='regenerate') returns { outbox_id }. Three states:
//
//   - { status: 'generating' }                — outbox pending/dispatching/dispatched
//   - { status: 'failed', error }             — outbox failed (last_error surfaced)
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
import { sql } from '@/lib/db/server';
import { resolveOwnerScope, ScopeError } from '@/lib/auth/resolve-owner-scope';
import { reportCaughtError } from '@/lib/shared/report-caught-error';
import { editRepliesEnabled } from '@/lib/past-replies/flags';

export const dynamic = 'force-dynamic';

export async function GET(request: NextRequest): Promise<Response> {
  if (!editRepliesEnabled()) {
    return NextResponse.json({ error: 'feature_disabled' }, { status: 503 });
  }

  // Auth + current-location scope (no CSRF check — GET is exempt).
  let locationId;
  try {
    ({ locationId } = await resolveOwnerScope(request, { allowReadOnly: true }));
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
    const outboxRows = await sql<{
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

    if (
      outbox.status === 'pending' ||
      outbox.status === 'dispatching' ||
      outbox.status === 'dispatched'
    ) {
      return NextResponse.json({ status: 'generating' }, { status: 200 });
    }

    if (outbox.status === 'completed') {
      // Worker INSERTed the response row. aggregate_id is the review_id.
      const responseRows = await sql<{
        id: string;
        status: string;
        response_text: string | null;
        business_id: string;
      }[]>`
        SELECT id, status, response_text, business_id
        FROM responses
        WHERE review_id = ${outbox.aggregate_id}
          AND status IN ('pending_approval', 'approved', 'edited')
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
