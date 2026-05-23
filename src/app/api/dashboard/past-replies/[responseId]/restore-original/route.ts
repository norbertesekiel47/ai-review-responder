// src/app/api/dashboard/past-replies/[responseId]/restore-original/route.ts
//
// POST /api/dashboard/past-replies/:responseId/restore-original
//
// Recovery route #2 — for `post_after_delete_failed_*` orphan rows ONLY
// (DELETE succeeded, Google's reply slot empty). Inserts a NEW
// pending_approval row pre-filled with the previously-posted reply text
// so the owner can review it and click "Update on Google" via /publish to
// republish what was on Google before the failed edit.
//
// Crucially, the OLD failed row is INTENTIONALLY LEFT in place (not retired
// to 'superseded'). Earlier drafts retired it, but that strands the review
// on cancel: if the owner abandons the restore draft (DELETE /draft → status
// 'superseded'), the failed row would already be retired with no recovery
// path. Layered defenses (step 1c non-terminal sibling check, /retry's
// step 2a branch-shape validation) block dangerous re-recovery — see
// spec §4.7 long comment block on /restore-original.
//
// NO outbox row is enqueued here. /publish is the second hop: owner reviews
// the new pending_approval draft + clicks "Update on Google".
//
// Lock order: review FOR UPDATE → response FOR UPDATE → superseded sibling
// FOR UPDATE. Same-origin enforced inline for symmetry; withSameOrigin would
// also work for (req, context)-shaped handlers since it passes ...args through.
//
// See docs/superpowers/specs/2026-05-01-edit-existing-replies-design.md §4.7.

import { NextRequest, NextResponse } from 'next/server';
import { v7 as uuidv7 } from 'uuid';
import { sql } from '@/lib/db/server';
import { assertSameOrigin, SameOriginError } from '@/lib/shared/csrf';
import { resolveOwnerScope, ScopeError } from '@/lib/auth/resolve-owner-scope';
import { assertCanEditReply } from '@/lib/responses/edit-existing';
import { mapEditReplyError } from '../../_shared/edit-reply-errors';
import { insertAuditLogSession } from '@/lib/approval/audit';
import type { SessionAuditContext } from '@/lib/approval/audit';
import { POST_AFTER_DELETE_FAILED_PREFIX } from '../../../../../../../worker/jobs/publisher/orphan-markers';

export const dynamic = 'force-dynamic';

interface RouteParams {
  params: Promise<{ responseId: string }>;
}

export async function POST(
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

  // Tier gate (spec §4.4 cross-cutting). Resolve review_id with a non-locking
  // SELECT so assertCanEditReply doesn't run inside the transaction. Scoped by
  // locationId — a response_id from another location → 404.
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
        WHERE review_id = ${reviewId} AND status = 'posted'
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
          AND status IN ('pending_approval', 'approved', 'edited', 'awaiting_owner_connect')
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

      // 3. INSERT a new pending_approval row pre-filled with the restored
      //    text. version = MAX(version) + 1 to avoid colliding with the
      //    still-extant 'failed' row. All three text columns get the same
      //    COALESCE'd value (response_text + original_draft_text are NOT NULL
      //    per migration 001:194,215). edited_text=NULL means /publish picks
      //    'approved' (not 'edited') for the audit mode.
      const restoredText =
        superseded.approved_text ??
        superseded.response_text ??
        superseded.original_draft_text;
      // Defensive — should be impossible because posted_at IS NOT NULL implies
      // at least one text column is set. If we ever hit it, surface as 500
      // rather than crash on the NOT NULL constraint.
      if (restoredText === null) {
        console.error(
          '[past-replies/restore-original] superseded row had all text columns NULL',
          { responseId, supersededId: superseded.id },
        );
        return NextResponse.json({ error: 'internal_error' }, { status: 500 });
      }

      const newId = uuidv7();
      await tx`
        INSERT INTO responses (
          id, review_id, business_id,
          response_text, approved_text, original_draft_text, edited_text,
          response_language, version, status,
          llm_provider, llm_model, prompt_tokens, completion_tokens
        )
        VALUES (
          ${newId}, ${reviewId}, ${failed.business_id},
          ${restoredText}, ${restoredText}, ${restoredText}, ${null},
          ${superseded.response_language},
          (COALESCE((SELECT MAX(version) FROM responses WHERE review_id = ${reviewId}), 0) + 1),
          'pending_approval',
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
      );

      // NO outbox row enqueued. Owner reviews via the standard preview UI,
      // then clicks "Update on Google" → /publish runs the normal
      // pending_approval → approved transition + outbox enqueue.
      //
      // Return the restored text alongside the response_id. The drawer needs
      // it to populate the preview pane — for failed-only orphan rows,
      // row.approved_text on the client is null (no posted sibling), so
      // without this the preview would be empty and the publish click would
      // hit the empty-text guard.
      return NextResponse.json(
        { response_id: newId, response_text: restoredText },
        { status: 200 },
      );
    });
  } catch (err) {
    console.error('[past-replies/restore-original] unexpected:', err);
    return NextResponse.json({ error: 'internal_error' }, { status: 500 });
  }
}
