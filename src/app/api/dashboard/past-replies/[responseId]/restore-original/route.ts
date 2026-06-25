// src/app/api/dashboard/past-replies/[responseId]/restore-original/route.ts
//
// POST /api/dashboard/past-replies/:responseId/restore-original
//
// Recovery route #2 — for `post_after_delete_failed_*` orphan rows ONLY
// (DELETE succeeded, Google's reply slot empty). Republishes the previously-
// posted reply text DIRECTLY (like /retry), without routing the owner through
// the drawer's validating /publish path.
//
// Restore is a TERMINAL recovery action: the orphan state has no live `posted`
// row, so the drawer's preview→submitManual path (PATCH + /publish, both
// running validateOptimisticConcurrency, which REQUIRES a live `posted` row)
// would 409. Instead, this route INSERTs the restored row directly at
// status='approved' (approved_text = the superseded original text), sets
// approved_at = NOW(), writes the session audit row, AND enqueues a
// publish_response outbox — all in ONE tx. The publisher then POSTs the
// original into the empty Google slot via the normal post-reply path (the
// restored row has no posted sibling and no orphan marker, so the edit-publish
// dispatch predicate does NOT match it).
//
// Crucially, the OLD failed row is INTENTIONALLY LEFT in place (not retired
// to 'superseded'). Abandoning it is no longer necessary, but keeping it is
// harmless: the delete_failed-only sidecar (prior fix) means it won't
// false-badge the new posted card, and /retry's step 2a branch-shape check
// rejects it once a posted row exists. Layered defenses (step 1c non-terminal
// sibling check, /retry's step 2a branch-shape validation) block dangerous
// re-recovery — see spec §4.7 long comment block on /restore-original.
//
// Lock order: review FOR UPDATE → response FOR UPDATE → superseded sibling
// FOR UPDATE. Same-origin enforced inline for symmetry; withSameOrigin would
// also work for (req, context)-shaped handlers since it passes ...args through.
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
import { POST_AFTER_DELETE_FAILED_PREFIX } from '@/lib/publishing/orphan-markers';
import { reportCaughtError } from '@/lib/shared/report-caught-error';

export const dynamic = 'force-dynamic';

export async function POST(
  request: NextRequest,
  context: ResponseIdRouteContext,
): Promise<Response> {
  const ctx = await resolveEditReplyContext(request, context.params);
  if (!ctx.ok) return ctx.response;
  const { accountId, locationId, responseId, reviewId, audit } = ctx.value;

  const offboardingState = await getOffboardingState(accountId);
  if (isPublishingBlocked(offboardingState)) {
    return NextResponse.json({ error: 'account_offboarding_blocked' }, { status: 403 });
  }

  try {
    return await sql.begin(async (tx) => {
      // 0. Lock the review row first (canonical lock order matching /retry).
      const lockedReview = await tx<{ id: string }[]>`
        SELECT id FROM reviews
        WHERE id = ${reviewId} AND business_id = ${locationId}
        FOR UPDATE
      `;
      if (lockedReview.length === 0) {
        return NextResponse.json({ error: 'review_not_found' }, { status: 404 });
      }

      // 1. Lock the failed candidate. STRICTER allowlist than /retry — only
      //    post_after_delete_failed_* is restorable (delete_failed_* leaves
      //    the original on Google, no need to restore).
      const lockedRows = await tx<{
        review_id: string;
        status: string;
        business_id: string;
        posting_error: string | null;
      }[]>`
        SELECT review_id, status, business_id, posting_error FROM responses
        WHERE id = ${responseId} AND business_id = ${locationId}
        FOR UPDATE
      `;
      const failed = lockedRows[0];
      if (!failed) {
        return NextResponse.json({ error: 'response_not_found' }, { status: 404 });
      }
      if (failed.status !== 'failed') {
        return NextResponse.json({ error: 'already_recovered' }, { status: 409 });
      }
      if (
        failed.posting_error === null ||
        !failed.posting_error.startsWith(POST_AFTER_DELETE_FAILED_PREFIX)
      ) {
        return NextResponse.json({ error: 'not_in_orphan_state' }, { status: 409 });
      }

      // 1b. Defense in depth: confirm there is NO 'posted' sibling. If one
      //     exists, the orphan state isn't real (someone else republished)
      //     and restoring would create a duplicate live reply.
      const livePostedRows = await tx`
        SELECT 1 FROM responses
        WHERE review_id = ${reviewId}
          AND business_id = ${locationId}
          AND status = 'posted'
        LIMIT 1
      `;
      if (livePostedRows.length > 0) {
        return NextResponse.json({ error: 'live_reply_exists' }, { status: 409 });
      }

      // 1c. Non-terminal sibling check (same rationale as /retry step 1a).
      //     INSERTing another non-terminal row would violate migration-029's
      //     partial unique index — surface as 409 instead of 500.
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

      // 2. Find the previously-posted superseded sibling — NOT just any
      //    superseded row. Filter by posted_at IS NOT NULL to exclude
      //    pending/approved drafts that were superseded without ever being
      //    posted (their approved_text may be NULL — would violate NOT NULL
      //    on the INSERT below). ORDER BY posted_at DESC, version DESC picks
      //    the most recently posted — the row our DELETE just superseded.
      const supersededRows = await tx<{
        id: string;
        approved_text: string | null;
        response_text: string | null;
        original_draft_text: string | null;
        response_language: string | null;
        version: number;
        posted_at: Date | null;
      }[]>`
        SELECT id, approved_text, response_text, original_draft_text,
               response_language, version, posted_at
        FROM responses
        WHERE review_id = ${reviewId}
          AND business_id = ${locationId}
          AND status = 'superseded'
          AND posted_at IS NOT NULL
        ORDER BY posted_at DESC, version DESC
        LIMIT 1
        FOR UPDATE
      `;
      const superseded = supersededRows[0];
      if (!superseded) {
        // Defense in depth — should be impossible in real orphan state
        // (DELETE success implies a previously-posted sibling).
        return NextResponse.json(
          { error: 'no_original_to_restore' },
          { status: 404 },
        );
      }

      // 3. INSERT the restored row directly at status='approved' (not
      //    pending_approval) so the publisher can republish it without a
      //    second owner hop. version = MAX(version) + 1 to avoid colliding
      //    with the still-extant 'failed' row. All three text columns get the
      //    same COALESCE'd value (response_text + original_draft_text are NOT
      //    NULL per migration 001:194,215). edited_text=NULL + llm fields NULL
      //    so the published reply records as a plain restore, not an edit.
      const restoredText =
        superseded.approved_text ??
        superseded.response_text ??
        superseded.original_draft_text;
      // Defensive — should be impossible because posted_at IS NOT NULL implies
      // at least one text column is set. If we ever hit it, surface as 500
      // rather than crash on the NOT NULL constraint.
      if (restoredText === null) {
        reportCaughtError(
          'past-replies/restore-original',
          new Error('superseded row had all text columns NULL'),
          { responseId, supersededId: superseded.id },
        );
        return NextResponse.json({ error: 'internal_error' }, { status: 500 });
      }

      const newId = uuidv7();
      await tx`
        INSERT INTO responses (
          id, review_id, business_id,
          response_text, approved_text, original_draft_text, edited_text,
          response_language, version, status, approval_method, approved_at,
          llm_provider, llm_model, prompt_tokens, completion_tokens
        )
        VALUES (
          ${newId}, ${reviewId}, ${failed.business_id},
          ${restoredText}, ${restoredText}, ${restoredText}, ${null},
          ${superseded.response_language},
          (COALESCE((SELECT MAX(version) FROM responses WHERE review_id = ${reviewId} AND business_id = ${failed.business_id}), 0) + 1),
          'approved', ${APPROVAL_METHOD.OWNER}, NOW(),
          ${null}, ${null}, ${null}, ${null}
        )
      `;

      // The OLD failed row is INTENTIONALLY left in place (status='failed',
      // posting_error='post_after_delete_failed_*'). See header comment +
      // spec §4.7 long comment for the cancel-strands-review rationale.

      // 4. Audit log (session-scoped — actor_user_id = users.id, NOT account).
      //    References the NEW row id and cross-links the failed + superseded
      //    source rows in metadata.
      await insertAuditLogSession(
        tx,
        newId,
        failed.business_id,
        'restore_original',
        audit,
        {
          failed_response_id: responseId,
          restored_from_superseded_id: superseded.id,
        },
        { responseTextAtApproval: restoredText },
      );

      // 5. Enqueue publish_response outbox in the SAME tx (spec §4.2 atomicity).
      //    The restored row is status='approved' with no posted sibling and no
      //    orphan marker, so the publisher's edit-publish dispatch predicate
      //    does NOT match it → it routes to the normal post-reply path, which
      //    POSTs the original into the now-empty Google slot → 'posted'.
      const outboxId = uuidv7();
      await enqueuePublishResponse(tx, {
        outboxId,
        responseId: newId,
        businessId: failed.business_id,
      });

      // Restore is terminal — the drawer transitions to a success/closing
      // state on the returned ids and does NOT enter the preview/publish path.
      return NextResponse.json(
        { response_id: newId, outbox_id: outboxId },
        { status: 200 },
      );
    });
  } catch (err) {
    reportCaughtError('past-replies/restore-original', err, { accountId, locationId, responseId });
    return NextResponse.json({ error: 'internal_error' }, { status: 500 });
  }
}
