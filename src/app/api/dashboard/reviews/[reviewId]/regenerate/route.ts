import { NextRequest, NextResponse } from 'next/server';
import {
  requireDashboardReviewOwner,
  runDashboardReviewAction,
} from '@/lib/approval/http-routes';
import { regenerateBySession } from '@/lib/approval/service';
import { withSameOrigin } from '@/lib/auth/route-helpers';

export const dynamic = 'force-dynamic';

async function regenerateReview(
  request: NextRequest,
  { params }: { params: Promise<{ reviewId: string }> },
): Promise<NextResponse> {
  const owner = await requireDashboardReviewOwner(request);
  if (owner instanceof NextResponse) return owner;

  const { reviewId } = await params;
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
