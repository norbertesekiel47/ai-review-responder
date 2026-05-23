// src/app/api/dashboard/past-replies/draft/route.ts
//
// POST /api/dashboard/past-replies/draft
//
// Two-mode endpoint that opens an "edit existing reply" workflow:
//
//   - mode='manual'      → INSERT a new responses row at status='pending_approval',
//                          carrying the existing posted reply as the "before" text and
//                          the owner-supplied new_text as the proposed reply.
//   - mode='regenerate'  → INSERT a generate_response outbox row so the
//                          ResponseGeneratorWorker produces a fresh AI draft.
//
// Both modes serialize on the reviews row with FOR UPDATE so two concurrent
// /draft calls cannot both create competing drafts (spec §4.4 in-flight regenerate guard).
//
// Wrapped with withSameOrigin (CSRF). Tier-gated by assertCanEditReply.
// Optimistic concurrency runs INSIDE the tx, AFTER the row lock.
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
import type { GenerateResponsePayload } from '@/lib/shared/worker-types';

export const dynamic = 'force-dynamic';

const snapshotSchema = z.object({
  hash: z.string().min(1),
  version: z.number().int().positive(),
});

const bodySchema = z.discriminatedUnion('mode', [
  z.object({
    mode: z.literal('manual'),
    review_id: z.string().uuid(),
    new_text: z.string().trim().min(1).max(2000),
    snapshot: snapshotSchema,
  }),
  z.object({
    mode: z.literal('regenerate'),
    review_id: z.string().uuid(),
    snapshot: snapshotSchema,
  }),
]);

async function handler(request: NextRequest): Promise<Response> {
  if (
    process.env.PAST_REPLIES_VIEW_ENABLED !== 'true' ||
    process.env.EDIT_REPLIES_ENABLED !== 'true'
  ) {
    return NextResponse.json({ error: 'feature_disabled' }, { status: 503 });
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

  const json = await request.json().catch(() => null);
  const parsed = bodySchema.safeParse(json);
  if (!parsed.success) {
    return NextResponse.json(
      { error: 'invalid_body', details: parsed.error.flatten() },
      { status: 400 },
    );
  }

  // Tier + ownership gate BEFORE any side effects.
  try {
    await assertCanEditReply(parsed.data.review_id, { accountId, locationId });
  } catch (err) {
    const mapped = mapEditReplyError(err);
    if (mapped) return mapped;
    throw err;
  }

  try {
    return await sql.begin(async (tx) => {
      // 1. Lock review row. Two concurrent /draft calls on the same review
      //    serialize here — second waits until first commits.
      const lockedRows = await tx<{ id: string }[]>`
        SELECT id FROM reviews
        WHERE id = ${parsed.data.review_id} AND business_id = ${locationId}
        FOR UPDATE
      `;
      if (lockedRows.length === 0) {
        return NextResponse.json({ error: 'review_not_found' }, { status: 404 });
      }

      // 2a. Reject if any non-terminal response already exists.
      const existing = await tx<{ exists: number }[]>`
        SELECT 1 AS exists FROM responses
        WHERE review_id = ${parsed.data.review_id}
          AND status IN ('pending_approval', 'approved', 'edited', 'awaiting_owner_connect')
        LIMIT 1
      `;
      if (existing.length > 0) {
        return NextResponse.json({ error: 'draft_already_exists' }, { status: 409 });
      }

      // 2b. Reject if a regenerate is in flight (worker hasn't INSERTed yet,
      //     so step 2a wouldn't catch it).
      const pendingGen = await tx<{ exists: number }[]>`
        SELECT 1 AS exists FROM job_outbox
        WHERE topic = 'generate_response'
          AND aggregate_id = ${parsed.data.review_id}
          AND status IN ('pending', 'dispatching', 'dispatched')
        LIMIT 1
      `;
      if (pendingGen.length > 0) {
        return NextResponse.json({ error: 'regenerate_in_progress' }, { status: 409 });
      }

      // 3. Optimistic concurrency check (in-tx, post-lock).
      try {
        await validateOptimisticConcurrency(tx, parsed.data.review_id, parsed.data.snapshot);
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

      // 4. Compute next version (MAX over ALL responses for this review, not
      //    just the posted one — keeps version monotonic across superseded rows).
      const versionRows = await tx<{ next_version: number }[]>`
        SELECT COALESCE(MAX(version), 0) + 1 AS next_version
        FROM responses WHERE review_id = ${parsed.data.review_id}
      `;
      const nextVersion = versionRows[0]?.next_version ?? 1;

      // 5. Manual: INSERT response row. Regenerate: INSERT outbox row.
      if (parsed.data.mode === 'manual') {
        const postedRows = await tx<{
          approved_text: string | null;
          response_text: string | null;
          response_language: string | null;
        }[]>`
          SELECT approved_text, response_text, response_language
          FROM responses
          WHERE review_id = ${parsed.data.review_id} AND status = 'posted'
        `;
        const posted = postedRows[0];
        if (!posted) {
          return NextResponse.json({ error: 'response_changed' }, { status: 409 });
        }

        const beforeText = posted.approved_text ?? posted.response_text ?? '';
        const responseId = uuidv7();
        await tx`
          INSERT INTO responses (
            id, review_id, business_id,
            response_text, approved_text, original_draft_text, edited_text,
            response_language, version, status
          ) VALUES (
            ${responseId}, ${parsed.data.review_id}, ${locationId},
            ${beforeText}, ${parsed.data.new_text}, ${beforeText}, ${parsed.data.new_text},
            ${posted.response_language}, ${nextVersion}, 'pending_approval'
          )
        `;
        return NextResponse.json({ response_id: responseId }, { status: 200 });
      }

      // Regenerate mode.
      const outboxId = uuidv7();
      const payload: GenerateResponsePayload = {
        review_id: parsed.data.review_id,
        business_id: locationId,
        version: nextVersion,
        suppress_notification: true,
      };
      await tx`
        INSERT INTO job_outbox (id, topic, aggregate_type, aggregate_id, payload, status)
        VALUES (
          ${outboxId}, 'generate_response', 'review',
          ${parsed.data.review_id}, ${jsonb(payload)}, 'pending'
        )
      `;
      return NextResponse.json({ outbox_id: outboxId }, { status: 200 });
    });
  } catch (err) {
    console.error('[past-replies/draft] unexpected:', err);
    return NextResponse.json({ error: 'internal_error' }, { status: 500 });
  }
}

export const POST = withSameOrigin()(handler);
