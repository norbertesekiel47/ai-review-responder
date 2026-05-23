// src/app/api/dashboard/past-replies/draft/[responseId]/route.ts
//
// PATCH /api/dashboard/past-replies/draft/:responseId
//   "Edit further" on an existing pending_approval row. UPDATEs approved_text +
//   edited_text inside a tx that holds reviews FOR UPDATE so it serializes
//   against /draft, /publish, and process-review hash-bump.
//
//   STATUS DOES NOT TRANSITION — the row stays 'pending_approval'. Only
//   /publish moves it into a HANDLED status (spec §4.2 atomicity rule:
//   no public route leaves a row in a HANDLED status without an outbox
//   to act on it).
//
// DELETE /api/dashboard/past-replies/draft/:responseId
//   "Cancel" a draft. UPDATE responses SET status='superseded' inside a tx
//   with FOR UPDATE. Idempotent — safe to call when the row is missing or
//   already past pending_approval.
//
// Both perform same-origin (CSRF) check inline — assertSameOrigin(request) is
// called directly at the top of each handler for symmetry; withSameOrigin would
// also work for (req, context)-shaped handlers since it passes ...args through. PATCH
// runs the full tier + optimistic-concurrency gate; DELETE skips both per
// spec §4.4 cross-cutting (DELETE is idempotent, no body, no snapshot).
//
// Auth: requireRole(request, 'owner') for session validation; current location
// resolved from the 'rw_location_scope' cookie via getRequestScope (same as SSR).
// Falls back to primary location when cookie is absent or invalid.
//
// See docs/superpowers/specs/2026-05-01-edit-existing-replies-design.md §4.4.

import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { sql } from '@/lib/db/server';
import { assertSameOrigin, SameOriginError } from '@/lib/shared/csrf';
import { resolveOwnerScope, ScopeError } from '@/lib/auth/resolve-owner-scope';
import {
  assertCanEditReply,
  validateOptimisticConcurrency,
  ReviewChangedError,
  ResponseChangedError,
} from '@/lib/responses/edit-existing';
import { mapEditReplyError } from '../../_shared/edit-reply-errors';

export const dynamic = 'force-dynamic';

const snapshotSchema = z.object({
  hash: z.string().min(1),
  version: z.number().int().positive(),
});

const patchBodySchema = z.object({
  new_text: z.string().trim().min(1).max(2000),
  snapshot: snapshotSchema,
});

interface RouteParams {
  params: Promise<{ responseId: string }>;
}

export async function PATCH(
  request: NextRequest,
  context: RouteParams,
): Promise<Response> {
  if (process.env.EDIT_REPLIES_ENABLED !== 'true') {
    return NextResponse.json({ error: 'feature_disabled' }, { status: 503 });
  }

  try {
    assertSameOrigin(request);
  } catch (err) {
    if (err instanceof SameOriginError) {
      return NextResponse.json({ error: 'forbidden' }, { status: 403 });
    }
    throw err;
  }

  let accountId, locationId;
  try {
    ({ accountId, locationId } = await resolveOwnerScope(request));
  } catch (err) {
    if (err instanceof ScopeError) {
      return NextResponse.json({ error: err.message }, { status: err.statusCode });
    }
    throw err;
  }

  const { responseId } = await context.params;
  if (!responseId) {
    return NextResponse.json({ error: 'invalid_response_id' }, { status: 400 });
  }

  const json = await request.json().catch(() => null);
  const parsed = patchBodySchema.safeParse(json);
  if (!parsed.success) {
    return NextResponse.json(
      { error: 'invalid_body', details: parsed.error.flatten() },
      { status: 400 },
    );
  }

  // Look up review_id BEFORE opening the tx so assertCanEditReply
  // (which itself queries reviews + businesses) doesn't run inside the lock.
  const responseRows = await sql<{ review_id: string }[]>`
    SELECT review_id FROM responses
    WHERE id = ${responseId} AND business_id = ${locationId}
    LIMIT 1
  `;
  const responseRow = responseRows[0];
  if (!responseRow) {
    return NextResponse.json({ error: 'response_not_found' }, { status: 404 });
  }
  const reviewId = responseRow.review_id;

  // Tier + ownership gate BEFORE any side effects.
  try {
    await assertCanEditReply(reviewId, { accountId, locationId });
  } catch (err) {
    const mapped = mapEditReplyError(err);
    if (mapped) return mapped;
    throw err;
  }

  try {
    return await sql.begin(async (tx) => {
      // 1. Lock the review row first (serializes against /draft, /publish,
      //    process-review hash-bump).
      const lockedReview = await tx<{ id: string }[]>`
        SELECT id FROM reviews
        WHERE id = ${reviewId} AND business_id = ${locationId}
        FOR UPDATE
      `;
      if (lockedReview.length === 0) {
        return NextResponse.json({ error: 'review_not_found' }, { status: 404 });
      }

      // 2. Optimistic concurrency check (in-tx, post-lock).
      try {
        await validateOptimisticConcurrency(tx, reviewId, parsed.data.snapshot);
      } catch (err) {
        if (err instanceof ReviewChangedError) {
          return NextResponse.json(
            {
              error: 'review_changed',
              current_review_text: err.current.reviewText,
              current_review_hash: err.current.reviewHash,
            },
            { status: 409 },
          );
        }
        if (err instanceof ResponseChangedError) {
          return NextResponse.json({ error: 'response_changed' }, { status: 409 });
        }
        throw err;
      }

      // 3. Lock the response row + verify it's still editable.
      const lockedResponseRows = await tx<{ status: string }[]>`
        SELECT status FROM responses
        WHERE id = ${responseId} AND business_id = ${locationId}
        FOR UPDATE
      `;
      const lockedResponse = lockedResponseRows[0];
      if (!lockedResponse) {
        return NextResponse.json({ error: 'response_not_found' }, { status: 404 });
      }
      if (lockedResponse.status !== 'pending_approval') {
        return NextResponse.json({ error: 'response_changed' }, { status: 409 });
      }

      // 4. UPDATE — status STAYS 'pending_approval' (spec §4.4 atomicity rule).
      //    business_id guard mirrors the FOR UPDATE lock scope (defense-in-depth).
      await tx`
        UPDATE responses
        SET approved_text = ${parsed.data.new_text},
            edited_text = ${parsed.data.new_text},
            updated_at = NOW()
        WHERE id = ${responseId}
          AND business_id = ${locationId}
      `;

      return new NextResponse(null, { status: 204 });
    });
  } catch (err) {
    console.error('[past-replies/draft PATCH] unexpected:', err);
    return NextResponse.json({ error: 'internal_error' }, { status: 500 });
  }
}

export async function DELETE(
  request: NextRequest,
  context: RouteParams,
): Promise<Response> {
  if (process.env.EDIT_REPLIES_ENABLED !== 'true') {
    return NextResponse.json({ error: 'feature_disabled' }, { status: 503 });
  }

  try {
    assertSameOrigin(request);
  } catch (err) {
    if (err instanceof SameOriginError) {
      return NextResponse.json({ error: 'forbidden' }, { status: 403 });
    }
    throw err;
  }

  let locationId;
  try {
    ({ locationId } = await resolveOwnerScope(request));
  } catch (err) {
    if (err instanceof ScopeError) {
      return NextResponse.json({ error: err.message }, { status: err.statusCode });
    }
    throw err;
  }

  const { responseId } = await context.params;
  if (!responseId) {
    return NextResponse.json({ error: 'invalid_response_id' }, { status: 400 });
  }

  try {
    return await sql.begin(async (tx) => {
      // 1. Lock the response row. Missing → idempotent 204 (spec §4.4: DELETE
      //    is idempotent — no 404 on missing row).
      const lockedRows = await tx<{ status: string }[]>`
        SELECT status FROM responses
        WHERE id = ${responseId} AND business_id = ${locationId}
        FOR UPDATE
      `;
      const locked = lockedRows[0];
      if (!locked) {
        return new NextResponse(null, { status: 204 });
      }

      // 2. Only transition pending_approval → superseded. Other statuses are
      //    no-ops (already past the editable window — idempotent).
      //    business_id guard mirrors the FOR UPDATE lock scope (defense-in-depth).
      if (locked.status === 'pending_approval') {
        await tx`
          UPDATE responses
          SET status = 'superseded', updated_at = NOW()
          WHERE id = ${responseId}
            AND business_id = ${locationId}
        `;
      }

      return new NextResponse(null, { status: 204 });
    });
  } catch (err) {
    console.error('[past-replies/draft DELETE] unexpected:', err);
    return NextResponse.json({ error: 'internal_error' }, { status: 500 });
  }
}
