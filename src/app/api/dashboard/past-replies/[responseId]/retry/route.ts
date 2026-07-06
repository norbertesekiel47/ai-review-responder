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
import { getOffboardingState, isPublishingBlocked } from '@/lib/account-offboarding/gate';
import { sql } from '@/lib/db/server';
import { NON_TERMINAL_STATUSES } from '@/lib/shared/response-status';
import { statusArraySql } from '@/lib/shared/response-status-sql';
import { insertAuditLogSession } from '@/lib/approval/audit';
import {
  resolveEditReplyContext,
  type ResponseIdRouteContext,
} from '@/app/api/dashboard/past-replies/_shared/edit-reply-request';
import { APPROVAL_METHOD } from '@/lib/auto-approval/types';
import { enqueuePublishResponse } from '@/lib/shared/job-outbox-helpers';
import {
  DELETE_FAILED_PREFIX,
  POST_AFTER_DELETE_FAILED_PREFIX,
  PENDING_AFTER_DELETE,
  isRecoverableFailedPostingError,
} from '@/lib/publishing/orphan-markers';
import { reportCaughtError } from '@/lib/shared/report-caught-error';

export const dynamic = 'force-dynamic';

export async function POST(
  request: NextRequest,
  context: ResponseIdRouteContext,
): Promise<Response> {
  const ctx = await resolveEditReplyContext(request, context.params);
  if (!ctx.ok) return ctx.response;
  const { accountId, locationId, responseId, reviewId, audit } = ctx.value;

  const offboardingState = await getOffboardingState(accountId, sql);
  if (isPublishingBlocked(offboardingState)) {
    return NextResponse.json({ error: 'account_offboarding_blocked' }, { status: 403 });
  }

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
          AND business_id = ${locationId}
          AND status = ANY(${statusArraySql(NON_TERMINAL_STATUSES)})
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
        WHERE review_id = ${reviewId}
          AND business_id = ${locationId}
          AND status = 'posted'
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
            approval_method = ${APPROVAL_METHOD.OWNER},
            approved_at = NOW(),
            approved_text = COALESCE(approved_text, response_text),
            updated_at = NOW()
        WHERE id = ${responseId}
          AND business_id = ${locationId}
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
      await enqueuePublishResponse(tx, {
        outboxId,
        responseId,
        businessId: locationId,
      });

      return NextResponse.json({ outbox_id: outboxId }, { status: 200 });
    });
  } catch (err) {
    reportCaughtError('past-replies/retry', err, { accountId, locationId, responseId });
    return NextResponse.json({ error: 'internal_error' }, { status: 500 });
  }
}
