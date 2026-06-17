import { NextRequest, NextResponse } from 'next/server';
import {
  requireDashboardReviewOwner,
  runDashboardReviewAction,
} from '@/lib/approval/http-routes';
import { regenerateBySession } from '@/lib/approval/service';
import { withSameOrigin } from '@/lib/auth/route-helpers';
import {
  enforceDashboardRegenRateLimit,
  enforceRegenBudgetForReview,
} from '@/lib/shared/dashboard-regen-rate-limit';

export const dynamic = 'force-dynamic';

async function regenerateReview(
  request: NextRequest,
  { params }: { params: Promise<{ reviewId: string }> },
): Promise<NextResponse> {
  const owner = await requireDashboardReviewOwner(request);
  if (owner instanceof NextResponse) return owner;

  const limited = await enforceDashboardRegenRateLimit(owner.accountId);
  if (limited) return limited;

  const { reviewId } = await params;

  // Per-review daily cap: surface "limit reached" synchronously instead of
  // enqueueing work the worker would silently reject (issue #335). Read-only
  // peek — no budget consumed, fails open.
  const capped = await enforceRegenBudgetForReview(reviewId);
  if (capped) return capped;

  return runDashboardReviewAction(
    request,
    reviewId,
    owner,
    'regenerate',
    'Regeneration requested. A new draft will be generated shortly.',
    ({ tx, responseId, businessId, audit, correlationId }) => (
      regenerateBySession(tx, responseId, businessId, audit, correlationId)
    ),
  );
}

export const POST = withSameOrigin()(regenerateReview);
