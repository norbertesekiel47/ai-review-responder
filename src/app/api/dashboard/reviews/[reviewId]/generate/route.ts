// src/app/api/dashboard/reviews/[reviewId]/generate/route.ts
//
// POST /api/dashboard/reviews/[reviewId]/generate
//
// The Generate door: creates the FIRST draft for a never-replied review from
// the Reviews list (On-demand generation, spec §6.3b). Neither existing lane
// creates a first draft — past-replies/draft hard-requires a status='posted'
// row and the dashboard reviews lane 404s without an existing responses row
// (#669 reuse audit).
//
// Shape mirrors past-replies/draft/route.ts (mode='regenerate') MINUS
// validateOptimisticConcurrency and the version snapshot — there is no live
// reply to be concurrent with. Publish reuses reviews/[reviewId]/approve, NOT
// past-replies/publish.
//
// Invariant #3: the enqueue pins originLane = ON_DEMAND_GENERATE and
// suppressNotification = true. A Generate draft is version 1, so the lane is
// the ONLY thing excluding it from isAutoApprovalCandidate. Do not add a
// second guard here (ticket #678).
//
// Invariant #2: the outbox row is written inside the same tx that takes the
// review lock, via enqueueGenerateResponse.

import { NextRequest, NextResponse } from 'next/server';
import { v7 as uuidv7 } from 'uuid';
import { sql } from '@/lib/db/server';
import { requireDashboardReviewOwner } from '@/lib/approval/http-routes';
import { withSameOrigin } from '@/lib/auth/route-helpers';
import { assertWritableSubscriptionForAccount } from '@/lib/shared/writable-subscription';
import { QUEUE_NAMES } from '@/lib/shared/queue-names';
import { NON_TERMINAL_STATUSES } from '@/lib/shared/response-status';
import { statusArraySql } from '@/lib/shared/response-status-sql';
import { GENERATE_RESPONSE_ORIGIN_LANE } from '@/lib/shared/worker-types';
import { enqueueGenerateResponse } from '@/lib/shared/job-outbox-helpers';
import {
  enforceDashboardRegenRateLimit,
  enforceRegenBudgetForReview,
} from '@/lib/shared/dashboard-regen-rate-limit';
import { reportCaughtError } from '@/lib/shared/report-caught-error';
import { createWorkerLogger } from '@/lib/shared/logger';
import { NO_STORE_HEADERS } from '@/lib/shared/constants';

export const dynamic = 'force-dynamic';

async function generateFirstDraft(
  request: NextRequest,
  { params }: { params: Promise<{ reviewId: string }> },
): Promise<NextResponse> {
  const owner = await requireDashboardReviewOwner(request);
  if (owner instanceof NextResponse) return owner;

  // C3: the THIRD caller of the shared per-owner counter. Before any DB work,
  // matching regenerate/route.ts. Fails open by design.
  const limited = await enforceDashboardRegenRateLimit(owner.accountId);
  if (limited) return limited;

  const { reviewId } = await params;

  // Tenant proof: the review must belong to a live location under this account.
  // This is the ownership gate — do NOT trust a location cookie here.
  const ownedRows = await sql<{ business_id: string }[]>`
    SELECT rv.business_id
    FROM reviews rv
    JOIN businesses b ON b.id = rv.business_id
    WHERE rv.id = ${reviewId}::uuid
      AND b.account_id = ${owner.accountId}::uuid
      AND b.archived_at IS NULL
    LIMIT 1
  `;
  const owned = ownedRows[0];
  if (!owned) {
    return NextResponse.json(
      { error: 'review_not_found' },
      { status: 404, headers: NO_STORE_HEADERS },
    );
  }
  const businessId = owned.business_id;

  // ONE guard, not two. assertWritableSubscriptionForAccount already resolves
  // the offboarding state in the SAME query (LEFT JOIN account_offboardings)
  // and returns { status: 403, error: 'account_offboarding_blocked' } when
  // isProcessingBlocked — so a separate getOffboardingState call here would be
  // a duplicate round trip AND a second spelling of a guard that already has
  // one owner. `past-replies/draft` calls the gate directly only because it
  // needs the operational_ui intent class for its manual mode; Generate is
  // processing-class, which is exactly this helper's default.
  const writable = await assertWritableSubscriptionForAccount(owner.accountId, sql);
  if (!writable.ok) {
    return NextResponse.json(
      { error: writable.error },
      { status: writable.status, headers: NO_STORE_HEADERS },
    );
  }

  // Read-only peek — consumes no budget, fails open. Authoritative gate stays
  // the worker's Lua INCR in generate-draft.ts.
  const capped = await enforceRegenBudgetForReview(reviewId);
  if (capped) return capped;

  try {
    return await sql.begin(async (tx) => {
      // Lock the review: two concurrent Generate clicks serialize here.
      const locked = await tx<{ id: string }[]>`
        SELECT id FROM reviews
        WHERE id = ${reviewId}::uuid AND business_id = ${businessId}::uuid
        FOR UPDATE
      `;
      if (locked.length === 0) {
        return NextResponse.json({ error: 'review_not_found' }, { status: 404 });
      }

      // Generate is for NEVER-REPLIED reviews only. A posted sibling means the
      // owner wants Regenerate (which replaces a live Google reply, §6.4).
      const posted = await tx<{ id: string }[]>`
        SELECT id FROM responses
        WHERE review_id = ${reviewId}::uuid AND status = 'posted'
        LIMIT 1
      `;
      if (posted.length > 0) {
        return NextResponse.json({ error: 'already_answered' }, { status: 409 });
      }

      const existing = await tx<{ id: string; status: string }[]>`
        SELECT id, status FROM responses
        WHERE review_id = ${reviewId}::uuid
          AND status = ANY(${statusArraySql(sql, NON_TERMINAL_STATUSES)})
        ORDER BY version DESC
        LIMIT 1
      `;
      if (existing[0]) {
        return NextResponse.json(
          { error: 'draft_already_exists', existing: { response_id: existing[0].id, status: existing[0].status } },
          { status: 409 },
        );
      }

      const pendingGen = await tx<{ exists: number }[]>`
        SELECT 1 AS exists FROM job_outbox
        WHERE topic = ${QUEUE_NAMES.GENERATE_RESPONSE}
          AND aggregate_id = ${reviewId}
          AND status IN ('pending', 'dispatching', 'dispatched')
        LIMIT 1
      `;
      if (pendingGen.length > 0) {
        return NextResponse.json({ error: 'regenerate_in_progress' }, { status: 409 });
      }

      // D-B: MAX-derived, never hardcoded 1. A discarded draft is retained at
      // status='superseded', so version climbs and C1's per-review budget
      // self-arms on the next attempt.
      const versionRows = await tx<{ next_version: number }[]>`
        SELECT COALESCE(MAX(version), 0) + 1 AS next_version
        FROM responses WHERE review_id = ${reviewId}::uuid
      `;
      const nextVersion = versionRows[0]?.next_version ?? 1;

      const outboxId = uuidv7();
      await enqueueGenerateResponse(tx, {
        outboxId,
        reviewId,
        businessId,
        version: nextVersion,
        originLane: GENERATE_RESPONSE_ORIGIN_LANE.ON_DEMAND_GENERATE,
        suppressNotification: true,
      });

      createWorkerLogger('[OnDemandGenerate]').log({
        event: 'on_demand_generate_enqueued',
        reviewId,
        businessId,
        version: nextVersion,
        outboxId,
      });

      return NextResponse.json({ outbox_id: outboxId, version: nextVersion }, { status: 200 });
    });
  } catch (err) {
    reportCaughtError('reviews/generate', err, { accountId: owner.accountId, businessId, reviewId });
    return NextResponse.json({ error: 'internal_error' }, { status: 500 });
  }
}

export const POST = withSameOrigin()(generateFirstDraft);
