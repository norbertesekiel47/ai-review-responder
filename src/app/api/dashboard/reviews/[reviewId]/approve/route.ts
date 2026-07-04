import { NextRequest, NextResponse } from 'next/server';
import { sql } from '@/lib/db/server';
import {
  requireDashboardReviewOwner,
  runDashboardReviewAction,
} from '@/lib/approval/http-routes';
import { approveBySession } from '@/lib/approval/service';
import { withSameOrigin } from '@/lib/auth/route-helpers';

export const dynamic = 'force-dynamic';

async function approveReview(
  request: NextRequest,
  { params }: { params: Promise<{ reviewId: string }> },
): Promise<NextResponse> {
  const owner = await requireDashboardReviewOwner(request);
  if (owner instanceof NextResponse) return owner;

  const { reviewId } = await params;
  return runDashboardReviewAction(
    sql,
    request,
    reviewId,
    owner,
    'approve',
    'Response approved.',
    ({ tx, responseId, businessId, audit, correlationId }) => (
      approveBySession(tx, responseId, businessId, audit, correlationId)
    ),
  );
}

export const POST = withSameOrigin()(approveReview);
