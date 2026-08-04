import { NextRequest, NextResponse } from 'next/server';
import { sql } from '@/lib/db/server';
import { requireRoleOr401 } from '@/lib/auth/route-helpers';
import { asLocationId, asAccountId } from '@/lib/shared/ids';
import type { LocationId, AccountId } from '@/lib/shared/ids';
import { reportCaughtError } from '@/lib/shared/report-caught-error';
import { getAdminNotifications, type AdminNotificationsData } from '@/lib/admin/notifications-service';

export const dynamic = 'force-dynamic';

type NotifData = AdminNotificationsData & { limit: number; offset: number };

export async function GET(request: NextRequest): Promise<NextResponse> {
  const auth = await requireRoleOr401(request, 'admin');
  if (!auth.ok) return auth.response;

  try {
    const params = request.nextUrl.searchParams;

    const rawLimit = parseInt(params.get('limit') ?? '20', 10);
    const rawOffset = parseInt(params.get('offset') ?? '0', 10);
    const limit = Math.min(Math.max(rawLimit || 20, 1), 100);
    const offset = Math.max(rawOffset || 0, 0);

    const rawBusinessId = params.get('business_id') ?? '';
    const businessId: LocationId | '' = rawBusinessId ? asLocationId(rawBusinessId) : '';
    const rawAccountId = params.get('account_id') ?? '';
    const accountId: AccountId | '' = rawAccountId ? asAccountId(rawAccountId) : '';
    const channel = params.get('channel') ?? '';
    const status = params.get('status') ?? '';

    const notifications = await getAdminNotifications(sql, {
      limit,
      offset,
      businessId,
      accountId,
      channel,
      status,
    });

    const data: NotifData = { ...notifications, limit, offset };

    return NextResponse.json(data);
  } catch (error) {
    reportCaughtError('api/admin/notifications', error);
    return NextResponse.json(
      { error: 'Failed to fetch notification data' },
      { status: 500 },
    );
  }
}
