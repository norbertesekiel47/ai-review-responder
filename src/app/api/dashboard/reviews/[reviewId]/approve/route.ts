import { NextRequest, NextResponse } from 'next/server';
import { sql } from '@/lib/db/server';
import { requireRole, AuthError } from '@/lib/db/auth';
import { approveBySession } from '@/lib/approval/service';
import { ResponseNotPendingError } from '@/lib/approval/errors';
import type { SessionAuditContext } from '@/lib/approval/service';
import { NO_STORE_HEADERS } from '@/lib/shared/constants';

export const dynamic = 'force-dynamic';

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ reviewId: string }> },
): Promise<NextResponse> {
  let user;
  try {
    user = await requireRole(request, 'owner');
  } catch (err) {
    if (err instanceof AuthError) {
      return NextResponse.json({ error: err.message }, { status: err.statusCode, headers: NO_STORE_HEADERS });
    }
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401, headers: NO_STORE_HEADERS });
  }

  if (!user.businessId) {
    return NextResponse.json({ error: 'No business associated with this account' }, { status: 403, headers: NO_STORE_HEADERS });
  }

  const { reviewId } = await params;

  const rows = await sql`
    SELECT r.id, r.business_id, r.status
    FROM responses r
    JOIN reviews rv ON rv.id = r.review_id
    WHERE rv.id = ${reviewId} AND r.status NOT IN ('superseded', 'failed')
    ORDER BY r.version DESC LIMIT 1
  `;

  const response = rows[0];
  if (!response) {
    return NextResponse.json({ error: 'No actionable response found for this review' }, { status: 404, headers: NO_STORE_HEADERS });
  }

  if (response.business_id !== user.businessId) {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403, headers: NO_STORE_HEADERS });
  }

  const ip = request.headers.get('x-forwarded-for') ?? null;
  const audit: SessionAuditContext = { actorUserId: user.id, ipAddress: ip };

  try {
    await sql.begin(async (tx) => {
      await approveBySession(tx, response.id as string, user.businessId!, audit);
    });

    return NextResponse.json(
      { success: true, message: 'Response approved.' },
      { status: 200, headers: NO_STORE_HEADERS },
    );
  } catch (err) {
    if (err instanceof ResponseNotPendingError) {
      return NextResponse.json({ error: err.message }, { status: 409, headers: NO_STORE_HEADERS });
    }
    console.error('[api/dashboard/reviews/approve] Unexpected error:', err);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500, headers: NO_STORE_HEADERS });
  }
}
