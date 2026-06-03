// src/app/api/dashboard/past-replies/[responseId]/retry/route.ts
//
// POST /api/dashboard/past-replies/:responseId/retry
//
// Recovery route #1 — re-enqueues a 'failed' edit-publisher row for another
// publish attempt. Two distinct recovery shapes are funnelled through the same
// route, distinguished by `posting_error` prefix:
//
//   delete_failed_*           → DELETE didn't succeed externally; the original
//                               'posted' sibling is still alive on Google.
//                               Recovery clears posting_error → publisher
//                               re-enters DELETE+POST.
//   post_after_delete_failed_* → DELETE succeeded but POST didn't. Sibling is
//                               'superseded'; Google's reply slot is empty
//                               (orphan state). Recovery RE-INSTALLS the
//                               'pending_after_delete_succeeded' orphan marker
//                               so the publisher takes the no-DELETE branch.
//
// Critical security check (step 2a — branch-shape validation): without it,
// /retry on a stale `post_after_delete_failed_*` row could undo a successful
// /restore-original. See spec §4.7 for the full scenario walk-through.
//
// Lock order: review FOR UPDATE → response FOR UPDATE (canonical, matches
// every other route in this feature). Same-origin enforced inline for symmetry;
// withSameOrigin would also work for (req, context)-shaped handlers since it passes ...args through.
//
// See docs/superpowers/specs/2026-05-01-edit-existing-replies-design.md §4.7.

import { NextRequest, NextResponse } from 'next/server';
import { v7 as uuidv7 } from 'uuid';
import { sql, jsonb } from '@/lib/db/server';
import { assertSameOrigin, SameOriginError } from '@/lib/shared/csrf';
import { resolveOwnerScope, ScopeError } from '@/lib/auth/resolve-owner-scope';
import { assertCanEditReply } from '@/lib/responses/edit-existing';
import { mapEditReplyError } from '@/app/api/dashboard/past-replies/_shared/edit-reply-errors';
import { insertAuditLogSession } from '@/lib/approval/audit';
import type { SessionAuditContext } from '@/lib/approval/audit';
import type { PublishResponsePayload } from '@/lib/shared/worker-types';
import {
  DELETE_FAILED_PREFIX,
  POST_AFTER_DELETE_FAILED_PREFIX,
  PENDING_AFTER_DELETE,
  isRecoverableFailedPostingError,
} from '../../../../../../../worker/jobs/publisher/orphan-markers';

export const dynamic = 'force-dynamic';

interface RouteParams {
  params: Promise<{ responseId: string }>;
}

export async function POST(
  request: NextRequest,
  context: RouteParams,
): Promise<Response> {
  if (
    process.env.PAST_REPLIES_VIEW_ENABLED !== 'true' ||
    process.env.EDIT_REPLIES_ENABLED !== 'true'
  ) {
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

  let accountId, locationId, userId;
  try {
    ({ accountId, locationId, userId } = await resolveOwnerScope(request));
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

  // Tier gate (spec §4.4 cross-cutting: applies to ALL routes except /draft-status).
  // Resolve review_id with a non-locking SELECT so assertCanEditReply (which
  // queries reviews + businesses on its own connection) doesn't run inside
  // the transaction. Scoped by locationId — a response_id from another location → 404.
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
      // 0. Lock the review row first (canonical lock order — serializes
      //    against process-review.ts content-change invalidation tx so we
      //    read the latest posting_error AFTER any in-flight stale-marking
      //    has committed).
      const lockedReview = await tx<{ id: string }[]>`
        SELECT id FROM reviews
        WHERE id = ${reviewId} AND business_id = ${locationId}
        FOR UPDATE
      `;
      if (lockedReview.length === 0) {
        return NextResponse.json({ error: 'review_not_found' }, { status: 404 });
      }

      // 1. Lock the failed candidate. Re-fetch + status check inside the tx
      //    serializes against concurrent /retry clicks.
      const lockedRows = await tx<{
        status: string;
        posting_error: string | null;
        approved_text: string | null;
        response_text: string | null;
      }[]>`
        SELECT status, posting_error, approved_text, response_text FROM responses
        WHERE id = ${responseId} AND business_id = ${locationId}
        FOR UPDATE
      `;
      const row = lockedRows[0];
      if (!row) {
        return NextResponse.json({ error: 'response_not_found' }, { status: 404 });
      }
      if (row.status !== 'failed') {
        return NextResponse.json({ error: 'already_recovered' }, { status: 409 });
      }

      // 1a. Non-terminal sibling check. /draft intentionally ignores 'failed'
      //     rows when computing the in-flight guard, so an owner can have a
      //     recoverable failed row AND a fresh non-terminal draft. Transitioning
      //     this failed row to 'approved' while the new draft also exists would
      //     trip migration-029's partial unique index — surface as 409 instead.
      const nonTermRows = await tx`
        SELECT 1 FROM responses
        WHERE review_id = ${reviewId}
          AND status IN ('pending_approval', 'approved', 'edited', 'awaiting_owner_connect')
        LIMIT 1
      `;
      if (nonTermRows.length > 0) {
        return NextResponse.json({ error: 'newer_draft_exists' }, { status: 409 });
      }

      // 2. Allowlist the failure category. Only edit-publisher failures are
      //    safe to retry (delete_failed_* and post_after_delete_failed_*).
      //    Excluded by name: 'review_content_changed', 'stale_after_review_changed',
      //    and any fresh-publish-path errors. The allowlist predicate lives in
      //    orphan-markers.ts (single source of truth — must not be re-typed).
      if (!isRecoverableFailedPostingError(row.posting_error)) {
        return NextResponse.json(
          { error: 'not_recoverable_via_retry' },
          { status: 409 },
        );
      }
      const isDeleteFail = row.posting_error!.startsWith(DELETE_FAILED_PREFIX);
      const isPostAfterDeleteFail = row.posting_error!.startsWith(
        POST_AFTER_DELETE_FAILED_PREFIX,
      );

      // 2a. Branch-shape validation (security-critical). The failure prefix
      //     encodes which state the world should be in for recovery to be safe:
      //       delete_failed_*        → expects live 'posted' sibling
      //       post_after_delete_*    → expects EMPTY reply slot (no posted)
      //
      //     Most dangerous case this prevents: a stale `post_after_delete_failed_*`
      //     row left behind after `/restore-original` published the original
      //     reply back to Google. Without this check, /retry would DELETE the
      //     restored original and POST the failed edit text — undoing the recovery.
      const livePostedRows = await tx`
        SELECT id FROM responses
        WHERE review_id = ${reviewId} AND status = 'posted'
        LIMIT 1
      `;
      const livePosted = livePostedRows.length > 0;
      if (isDeleteFail && !livePosted) {
        return NextResponse.json({ error: 'sibling_state_mismatch' }, { status: 409 });
      }
      if (isPostAfterDeleteFail && livePosted) {
        return NextResponse.json({ error: 'live_reply_exists' }, { status: 409 });
      }

      // 3. Transition row back to publishable. The posting_error transition
      //    depends on which branch we're recovering:
      //      - delete_failed_*  → sibling is still 'posted'. Publisher's
      //                            pre-flight finds existingPosted → enters
      //                            DELETE+POST branch. Clear posting_error.
      //      - post_after_delete_failed_*  → sibling is 'superseded'.
      //                            Publisher needs to take the no-DELETE
      //                            branch — re-install the orphan marker
      //                            (PENDING_AFTER_DELETE) so isOrphanRetry is
      //                            true on the next attempt.
      const newPostingError = isPostAfterDeleteFail ? PENDING_AFTER_DELETE : null;
      await tx`
        UPDATE responses
        SET status = 'approved',
            posting_error = ${newPostingError},
            approved_at = NOW(),
            approved_text = COALESCE(approved_text, response_text),
            updated_at = NOW()
        WHERE id = ${responseId}
      `;

      // 4. Audit log (session-scoped — actor_user_id = users.id, NOT account).
      await insertAuditLogSession(
        tx,
        responseId,
        locationId,
        'retry_after_failure',
        audit,
        { previous_posting_error: row.posting_error },
        { responseTextAtApproval: row.approved_text ?? row.response_text ?? '' },
      );

      // 5. Enqueue publish_response outbox in the SAME tx (spec §4.2 atomicity).
      const outboxId = uuidv7();
      const payload: PublishResponsePayload = {
        response_id: responseId,
        business_id: locationId,
      };
      await tx`
        INSERT INTO job_outbox (id, topic, aggregate_type, aggregate_id, payload, status)
        VALUES (
          ${outboxId}, 'publish_response', 'response',
          ${responseId}, ${jsonb(payload)}, 'pending'
        )
      `;

      return NextResponse.json({ outbox_id: outboxId }, { status: 200 });
    });
  } catch (err) {
    console.error('[past-replies/retry] unexpected:', err);
    return NextResponse.json({ error: 'internal_error' }, { status: 500 });
  }
}
