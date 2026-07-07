import { NextRequest, NextResponse } from 'next/server';
import { sql } from '@/lib/db/server';
import { requireDashboardReviewOwner } from '@/lib/approval/http-routes';
import { acknowledgeEscalation } from '@/lib/escalations/transitions';
import { withSameOrigin } from '@/lib/auth/route-helpers';
import { NO_STORE_HEADERS } from '@/lib/shared/constants';
import { assertWritableSubscriptionForAccount } from '@/lib/shared/writable-subscription';

export const dynamic = 'force-dynamic';

// CRAP-only finding on an estimated-coverage basis (route handlers are not on
// fallow's test-reachability graph); the guard branches are exercised by the
// route tests, and the handler is orchestration-only per invariant #12.
// fallow-ignore-next-line complexity
async function acknowledge(
  request: NextRequest,
  { params }: { params: Promise<{ escalationId: string }> },
): Promise<NextResponse> {
  const owner = await requireDashboardReviewOwner(request);
  if (owner instanceof NextResponse) return owner;

  const writable = await assertWritableSubscriptionForAccount(owner.accountId, sql);
  if (!writable.ok) {
    return NextResponse.json({ error: writable.error }, { status: writable.status, headers: NO_STORE_HEADERS });
  }

  const { escalationId } = await params;
  const result = await acknowledgeEscalation(sql, { escalationId, accountId: owner.accountId });
  if (!result.ok) {
    return result.code === 'not_found'
      ? NextResponse.json({ error: 'Escalation not found' }, { status: 404, headers: NO_STORE_HEADERS })
      : NextResponse.json({ error: 'Escalation is already resolved' }, { status: 409, headers: NO_STORE_HEADERS });
  }
  return NextResponse.json(
    { success: true, status: result.status },
    { status: 200, headers: NO_STORE_HEADERS },
  );
}

export const POST = withSameOrigin()(acknowledge);
