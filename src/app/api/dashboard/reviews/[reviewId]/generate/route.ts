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
// Composition root only (invariants #12/#15): auth → rate limit → ownership
// proof → writable pre-check → budget peek → sql.begin → result→HTTP mapping.
// The transaction itself — lock, TOCTOU re-check, sibling guards, version
// allocation, outbox enqueue (invariants #2/#3) — lives in
// @/lib/reviews/on-demand-generate.

import { NextRequest, NextResponse } from 'next/server';
import { sql } from '@/lib/db/server';
import { requireDashboardReviewOwner } from '@/lib/approval/http-routes';
import { errorResponse, withSameOrigin } from '@/lib/auth/route-helpers';
import { assertWritableSubscriptionForAccount } from '@/lib/shared/writable-subscription';
import { onDemandGenerateTx } from '@/lib/reviews/on-demand-generate';
import { proveReviewOwnership } from '@/lib/responses/review-ownership';
import {
  enforceDashboardRegenRateLimit,
  enforceRegenBudgetForReview,
} from '@/lib/shared/dashboard-regen-rate-limit';
import { reportCaughtError } from '@/lib/shared/report-caught-error';
import { createWorkerLogger } from '@/lib/shared/logger';
import { NO_STORE_HEADERS } from '@/lib/shared/constants';

export const dynamic = 'force-dynamic';

// Auth/rate-limit setup deliberately stays route-local: first generation and
// regeneration diverge immediately afterward in ownership, budget, and enqueue semantics.
async function generateFirstDraft(
  request: NextRequest,
  { params }: { params: Promise<{ reviewId: string }> },
): Promise<NextResponse> {
  // fallow-ignore-next-line code-duplication
  const owner = await requireDashboardReviewOwner(request);
  if (owner instanceof NextResponse) return owner;

  // Rate limiting is fail-open and runs before any database work.
  const limited = await enforceDashboardRegenRateLimit(owner.accountId);
  if (limited) return limited;

  const { reviewId } = await params;

  // Tenant proof: the review must belong to a live location under this account.
  // This is the ownership gate — do NOT trust a location cookie here.
  const businessId = await proveReviewOwnership(sql, reviewId, owner.accountId);
  if (!businessId) {
    return errorResponse('review_not_found', 404);
  }

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
    return errorResponse(writable.error, writable.status);
  }

  // Read-only peek — consumes no budget, fails open. Authoritative gate stays
  // the worker's Lua INCR in generate-draft.ts.
  const capped = await enforceRegenBudgetForReview(reviewId);
  if (capped) return capped;

  try {
    const result = await sql.begin((tx) => onDemandGenerateTx(tx, { reviewId, businessId }));

    if (!result.ok) {
      switch (result.reason) {
        case 'review_not_found':
          // In-tx miss under the lock. The pre-tx ownership 404 above keeps
          // its NO_STORE headers; this one historically had none — preserved
          // byte-for-byte (#729 moves code, it does not normalize headers).
          return NextResponse.json({ error: 'review_not_found' }, { status: 404 });
        case 'not_writable':
          return NextResponse.json(
            { error: result.error },
            { status: result.status, headers: NO_STORE_HEADERS },
          );
        case 'already_answered':
          return NextResponse.json({ error: 'already_answered' }, { status: 409 });
        case 'draft_already_exists':
          return NextResponse.json(
            { error: 'draft_already_exists', existing: result.existing },
            { status: 409 },
          );
        case 'orphan_recovery_pending':
          return NextResponse.json({ error: 'orphan_recovery_pending' }, { status: 409 });
        case 'regenerate_in_progress':
          return NextResponse.json({ error: 'regenerate_in_progress' }, { status: 409 });
      }
    }

    // Post-commit: sql.begin has resolved, so this line can never report an
    // enqueue that rolled back.
    createWorkerLogger('[OnDemandGenerate]').log({
      event: 'on_demand_generate_enqueued',
      reviewId,
      businessId,
      version: result.version,
      outboxId: result.outboxId,
    });

    return NextResponse.json(
      { outbox_id: result.outboxId, version: result.version },
      { status: 200 },
    );
  } catch (err) {
    reportCaughtError('reviews/generate', err, { accountId: owner.accountId, businessId, reviewId });
    return NextResponse.json(
      { error: 'internal_error' },
      { status: 500, headers: NO_STORE_HEADERS },
    );
  }
}

export const POST = withSameOrigin()(generateFirstDraft);
