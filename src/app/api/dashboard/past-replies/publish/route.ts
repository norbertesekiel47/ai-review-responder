// src/app/api/dashboard/past-replies/publish/route.ts
//
// POST /api/dashboard/past-replies/publish
//
// Atomically transitions a 'pending_approval' draft into a HANDLED status,
// writes the session-scoped audit-log row, and enqueues the publish_response
// outbox — all inside ONE transaction (spec §4.2 atomicity rule: no public
// route may leave a row in a HANDLED status without an outbox to act on it).
//
// The status transition discriminator is the (llm_provider, edited_text) tuple:
//   - manual           : llm_provider IS NULL  AND edited_text IS NOT NULL  → 'edited'
//   - regenerate_as_is : llm_provider NOT NULL AND edited_text IS NULL      → 'approved'
//   - regenerate_edited: llm_provider NOT NULL AND edited_text IS NOT NULL  → 'edited'
//
// approved_text uses COALESCE(approved_text, response_text). Critical for
// regenerate-as-is, where /draft/regenerate (via ResponseGeneratorWorker) inserts
// `response_text` but NOT `approved_text`. Without the COALESCE the publisher
// would post empty text downstream.
//
// Wrapped with withSameOrigin (CSRF). Tier-gated by assertCanEditReply BEFORE
// the tx. Lock order: review → response (canonical, matches every other route
// in this feature).
//
// Auth: requireRole(request, 'owner') for session validation; current location
// resolved from the 'rw_location_scope' cookie via getRequestScope (same as SSR).
// Falls back to primary location when cookie is absent or invalid.
//
// See docs/superpowers/specs/2026-05-01-edit-existing-replies-design.md §4.4.

import { NextRequest, NextResponse } from 'next/server';
import { v7 as uuidv7 } from 'uuid';
import { z } from 'zod';
import { sql, jsonb } from '@/lib/db/server';
import { withSameOrigin } from '@/lib/auth/route-helpers';
import { resolveOwnerScope, ScopeError } from '@/lib/auth/resolve-owner-scope';
import {
  assertCanEditReply,
  validateOptimisticConcurrency,
  ReviewChangedError,
  ResponseChangedError,
} from '@/lib/responses/edit-existing';
import { mapEditReplyError } from '../_shared/edit-reply-errors';
import { insertAuditLogSession } from '@/lib/approval/audit';
import type { SessionAuditContext } from '@/lib/approval/audit';
import type { PublishResponsePayload } from '@/lib/shared/worker-types';

export const dynamic = 'force-dynamic';

const snapshotSchema = z.object({
  hash: z.string().min(1),
  version: z.number().int().positive(),
});

const bodySchema = z.object({
  response_id: z.string().uuid(),
  snapshot: snapshotSchema,
});

type PublishMode = 'manual' | 'regenerate_as_is' | 'regenerate_edited';

function computePublishMode(
  llmProvider: string | null,
  editedText: string | null,
): PublishMode {
  if (llmProvider === null && editedText !== null) return 'manual';
  if (llmProvider !== null && editedText === null) return 'regenerate_as_is';
  if (llmProvider !== null && editedText !== null) return 'regenerate_edited';
  // Both NULL is impossible at /publish: every candidate row was created by
  // /draft manual mode (sets edited_text) or ResponseGeneratorWorker (sets
  // llm_provider). If we ever see this, surfacing it as 'manual' is the
  // safest fallback (won't hide a defect downstream — the audit row will
  // still record what happened).
  return 'manual';
}

async function handler(request: NextRequest): Promise<Response> {
  if (
    process.env.PAST_REPLIES_VIEW_ENABLED !== 'true' ||
    process.env.EDIT_REPLIES_ENABLED !== 'true'
  ) {
    return NextResponse.json({ error: 'feature_disabled' }, { status: 503 });
  }

  // Auth + current-location scope. CSRF handled by withSameOrigin wrapper.
  let accountId, locationId, userId;
  try {
    ({ accountId, locationId, userId } = await resolveOwnerScope(request));
  } catch (err) {
    if (err instanceof ScopeError) {
      return NextResponse.json({ error: err.message }, { status: err.statusCode });
    }
    throw err;
  }

  const json = await request.json().catch(() => null);
  const parsed = bodySchema.safeParse(json);
  if (!parsed.success) {
    return NextResponse.json(
      { error: 'invalid_body', details: parsed.error.flatten() },
      { status: 400 },
    );
  }

  // Look up review_id BEFORE opening the tx so assertCanEditReply (which
  // queries reviews + businesses on its own connection) doesn't run inside
  // the transaction. Scope by locationId — prevents cross-location response
  // lookup (response_id from a different location → 404).
  const responseRows = await sql<{ review_id: string }[]>`
    SELECT review_id FROM responses
    WHERE id = ${parsed.data.response_id} AND business_id = ${locationId}
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

  const ip = request.headers.get('x-forwarded-for') ?? null;
  const audit: SessionAuditContext = { actorUserId: userId, ipAddress: ip };

  try {
    return await sql.begin(async (tx) => {
      // 1. Lock the review row first (canonical lock order — serializes against
      //    /draft, PATCH /draft/:id, and process-review hash-bump).
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

      // 3. Lock the candidate response row + verify it's still pending_approval.
      const lockedRows = await tx<{
        status: string;
        edited_text: string | null;
        response_text: string | null;
        llm_provider: string | null;
      }[]>`
        SELECT status, edited_text, response_text, llm_provider
        FROM responses
        WHERE id = ${parsed.data.response_id} AND business_id = ${locationId}
        FOR UPDATE
      `;
      const candidate = lockedRows[0];
      if (!candidate) {
        return NextResponse.json({ error: 'response_not_found' }, { status: 404 });
      }
      if (candidate.status !== 'pending_approval') {
        return NextResponse.json({ error: 'response_changed' }, { status: 409 });
      }

      // 4. Compute the audit mode using the (llm_provider, edited_text) tuple.
      const mode = computePublishMode(candidate.llm_provider, candidate.edited_text);

      // 5. Transition status. COALESCE on approved_text is the regression guard
      //    for regenerate_as_is — the worker-inserted row has approved_text NULL
      //    until /publish backfills it from response_text.
      await tx`
        UPDATE responses
        SET status = CASE WHEN edited_text IS NOT NULL THEN 'edited' ELSE 'approved' END,
            approved_at = NOW(),
            approved_text = COALESCE(approved_text, response_text),
            updated_at = NOW()
        WHERE id = ${parsed.data.response_id} AND business_id = ${locationId}
      `;

      // 6. Audit log (session-scoped — sets actor_user_id + auth_method='owner_session').
      await insertAuditLogSession(
        tx,
        parsed.data.response_id,
        locationId,
        'approve_edit',
        audit,
        { mode },
      );

      // 7. Enqueue publish_response outbox in the SAME tx.
      const outboxId = uuidv7();
      const payload: PublishResponsePayload = {
        response_id: parsed.data.response_id,
        business_id: locationId,
      };
      await tx`
        INSERT INTO job_outbox (id, topic, aggregate_type, aggregate_id, payload, status)
        VALUES (
          ${outboxId}, 'publish_response', 'response',
          ${parsed.data.response_id}, ${jsonb(payload)}, 'pending'
        )
      `;

      return NextResponse.json({ outbox_id: outboxId }, { status: 200 });
    });
  } catch (err) {
    console.error('[past-replies/publish] unexpected:', err);
    return NextResponse.json({ error: 'internal_error' }, { status: 500 });
  }
}

export const POST = withSameOrigin()(handler);
