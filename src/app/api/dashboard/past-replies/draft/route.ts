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
import {
  getOffboardingState,
  isOperationalUIBlocked,
  isProcessingBlocked,
} from '@/lib/account-offboarding/gate';
import { sql } from '@/lib/db/server';
import { QUEUE_NAMES } from '@/lib/shared/queue-names';
import { NON_TERMINAL_STATUSES } from '@/lib/shared/response-status';
import { statusArraySql } from '@/lib/shared/response-status-sql';
import { withSameOrigin } from '@/lib/auth/route-helpers';
import { resolveEditReplyScope } from '../_shared/edit-reply-request';
import {
  assertCanEditReply,
  validateOptimisticConcurrency,
  ReviewChangedError,
  ResponseChangedError,
} from '@/lib/responses/edit-existing';
import { mapEditReplyError } from '../_shared/edit-reply-errors';
import { snapshotSchema } from '../_shared/schemas';
import { GENERATE_RESPONSE_ORIGIN_LANE } from '@/lib/shared/worker-types';
import { enqueueGenerateResponse } from '@/lib/shared/job-outbox-helpers';
import { enforceDashboardRegenRateLimit } from '@/lib/shared/dashboard-regen-rate-limit';
import { reportCaughtError } from '@/lib/shared/report-caught-error';

export const dynamic = 'force-dynamic';

const bodySchema = z.discriminatedUnion('mode', [
  z.object({
    mode: z.literal('manual'),
    review_id: z.uuid(),
    new_text: z.string().trim().min(1).max(2000),
    snapshot: snapshotSchema,
  }),
  z.object({
    mode: z.literal('regenerate'),
    review_id: z.uuid(),
    snapshot: snapshotSchema,
  }),
]);

async function handler(request: NextRequest): Promise<Response> {
  const scope = await resolveEditReplyScope(sql, request);
  if (!scope.ok) return scope.response;
  const { accountId, locationId } = scope.value;

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
    await assertCanEditReply(sql, parsed.data.review_id, { accountId, locationId });
  } catch (err) {
    const mapped = mapEditReplyError(err);
    if (mapped) return mapped;
    throw err;
  }

  const offboardingState = await getOffboardingState(accountId, sql);
  const blocked = parsed.data.mode === 'regenerate'
    ? isProcessingBlocked(offboardingState)
    : isOperationalUIBlocked(offboardingState);
  if (blocked) {
    return NextResponse.json({ error: 'account_offboarding_blocked' }, { status: 403 });
  }

  // Per-owner LLM-cost rate limit — regenerate only (manual mode is a plain
  // INSERT, not an LLM call). Runs before the tx / outbox enqueue.
  if (parsed.data.mode === 'regenerate') {
    const limited = await enforceDashboardRegenRateLimit(accountId);
    if (limited) return limited;
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

      // 2a. If a non-terminal response already exists (reload / crash /
      //     failed-publish left a draft), return it so the client can RESUME
      //     it instead of dead-ending. The posted row is still visible, so
      //     re-opening Edit can publish the existing draft or discard it
      //     (DELETE /draft/:id is idempotent). Scoped by locationId already
      //     via the review lock above.
      const existing = await tx<{
        response_id: string;
        text: string | null;
        is_edited: boolean;
        status: string;
      }[]>`
        SELECT id AS response_id,
               COALESCE(edited_text, approved_text, response_text) AS text,
               (edited_text IS NOT NULL) AS is_edited,
               status
        FROM responses
        WHERE review_id = ${parsed.data.review_id}
          AND status = ANY(${statusArraySql(sql, NON_TERMINAL_STATUSES)})
        ORDER BY version DESC
        LIMIT 1
      `;
      const existingDraft = existing[0];
      if (existingDraft) {
        return NextResponse.json(
          {
            error: 'draft_already_exists',
            existing: {
              response_id: existingDraft.response_id,
              text: existingDraft.text,
              is_edited: existingDraft.is_edited,
              status: existingDraft.status,
            },
          },
          { status: 409 },
        );
      }

      // 2b. Reject if a regenerate is in flight (worker hasn't INSERTed yet,
      //     so step 2a wouldn't catch it).
      const pendingGen = await tx<{ exists: number }[]>`
        SELECT 1 AS exists FROM job_outbox
        WHERE topic = ${QUEUE_NAMES.GENERATE_RESPONSE}
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
      await enqueueGenerateResponse(tx, {
        outboxId,
        reviewId: parsed.data.review_id,
        businessId: locationId,
        version: nextVersion,
        originLane: GENERATE_RESPONSE_ORIGIN_LANE.REGENERATE,
        suppressNotification: true,
      });
      return NextResponse.json({ outbox_id: outboxId }, { status: 200 });
    });
  } catch (err) {
    reportCaughtError('past-replies/draft', err, {
      accountId,
      locationId,
      reviewId: parsed.data.review_id,
      mode: parsed.data.mode,
    });
    return NextResponse.json({ error: 'internal_error' }, { status: 500 });
  }
}

export const POST = withSameOrigin()(handler);
