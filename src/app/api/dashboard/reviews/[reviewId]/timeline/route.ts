import { NextRequest, NextResponse } from 'next/server';
import { requireDashboardReviewOwner } from '@/lib/approval/http-routes';
import { getReviewTimeline } from '@/lib/agents/read';
import { sql } from '@/lib/db/server';
import { NO_STORE_HEADERS } from '@/lib/shared/constants';
import { isValidUuid } from '@/lib/shared/ids';

export const dynamic = 'force-dynamic';

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ reviewId: string }> },
): Promise<NextResponse> {
  const { reviewId } = await params;
  if (!isValidUuid(reviewId)) {
    return NextResponse.json(
      { error: 'Invalid review ID' },
      { status: 400, headers: NO_STORE_HEADERS },
    );
  }

  const owner = await requireDashboardReviewOwner(request);
  if (owner instanceof NextResponse) return owner;

  const timeline = await getReviewTimeline(sql, {
    accountId: owner.accountId,
    reviewId,
  });
  if (!timeline) {
    return NextResponse.json(
      { error: 'Review not found' },
      { status: 404, headers: NO_STORE_HEADERS },
    );
  }

  return NextResponse.json(timeline, { headers: NO_STORE_HEADERS });
}
