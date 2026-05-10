import { NextRequest, NextResponse } from 'next/server';
import { sql } from '@/lib/db/server';
import { requireRole, AuthError } from '@/lib/db/auth';
import { asLocationId, asAccountId } from '@/lib/shared/ids';
import type { LocationId, AccountId } from '@/lib/shared/ids';

export const dynamic = 'force-dynamic';

interface NotificationRow {
  id: string;
  business_name: string;
  channel: string;
  recipient: string;
  template: string;
  sent_at: Date | null;
  delivered_at: Date | null;
  failed_at: Date | null;
  failure_reason: string | null;
  created_at: Date;
}

interface CountRow {
  total: string;
}

interface BusinessRow {
  id: string;
  name: string;
}

interface NotifData {
  notifications: {
    id: string;
    businessName: string;
    channel: string;
    recipient: string;
    template: string;
    sentAt: string | null;
    deliveredAt: string | null;
    failedAt: string | null;
    failureReason: string | null;
    createdAt: string;
  }[];
  total: number;
  limit: number;
  offset: number;
  businesses: { id: string; name: string }[];
}

export async function GET(request: NextRequest): Promise<NextResponse> {
  try {
    await requireRole(request, 'admin', 'sales_partner');
  } catch (err) {
    if (err instanceof AuthError) {
      return NextResponse.json({ error: err.message }, { status: err.statusCode });
    }
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

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

    // Build dynamic WHERE conditions with positional parameters for sql.unsafe()
    // VAL-ADMIN-003: When account_id is provided, filter notification_deliveries
    // by account_id directly, enabling idx_nd_account index scan.
    const conditions: string[] = [];
    const queryParams: (string | number)[] = [];

    if (accountId) {
      queryParams.push(accountId as string);
      conditions.push(`nd.account_id = $${queryParams.length}`);
    } else if (businessId) {
      // Only use business_id filter when account_id is NOT provided,
      // since account_id is the preferred denormalized filter.
      queryParams.push(businessId as string);
      conditions.push(`nd.business_id = $${queryParams.length}`);
    }

    if (channel === 'email' || channel === 'sms') {
      queryParams.push(channel);
      conditions.push(`nd.channel = $${queryParams.length}`);
    }

    if (status === 'delivered') {
      conditions.push('nd.delivered_at IS NOT NULL');
    } else if (status === 'failed') {
      conditions.push('nd.failed_at IS NOT NULL');
    } else if (status === 'pending') {
      conditions.push('nd.delivered_at IS NULL AND nd.failed_at IS NULL');
    }

    const whereClause =
      conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';

    // Clone params array for count query (same conditions, no limit/offset)
    const countParams = [...queryParams];

    // Add limit/offset params for the data query
    queryParams.push(limit);
    const limitIdx = queryParams.length;
    queryParams.push(offset);
    const offsetIdx = queryParams.length;

    const dataQuery = `
      SELECT
        nd.id,
        b.name AS business_name,
        nd.channel,
        nd.recipient,
        nd.template,
        nd.sent_at,
        nd.delivered_at,
        nd.failed_at,
        nd.failure_reason,
        nd.created_at
      FROM notification_deliveries nd
      JOIN businesses b ON nd.business_id = b.id
      ${whereClause}
      ORDER BY nd.created_at DESC
      LIMIT $${limitIdx} OFFSET $${offsetIdx}
    `;

    const countQuery = `
      SELECT COUNT(*)::text AS total
      FROM notification_deliveries nd
      ${whereClause}
    `;

    const [notificationRows, countRows, businessRows] = await Promise.all([
      sql.unsafe<NotificationRow[]>(dataQuery, queryParams as never[]),
      sql.unsafe<CountRow[]>(countQuery, countParams as never[]),
      // Businesses list: When account_id is provided, only show businesses
      // under that account; otherwise show all with notification activity.
      accountId
        ? sql<BusinessRow[]>`
            SELECT DISTINCT b.id, b.name
            FROM businesses b
            WHERE b.account_id = ${accountId}::uuid
            ORDER BY b.name
          `
        : sql<BusinessRow[]>`
            SELECT DISTINCT b.id, b.name
            FROM businesses b
            JOIN notification_deliveries nd ON nd.business_id = b.id
            ORDER BY b.name
          `,
    ]);

    const total = parseInt(countRows[0]?.total ?? '0', 10);

    const data: NotifData = {
      notifications: notificationRows.map((row) => ({
        id: row.id,
        businessName: row.business_name,
        channel: row.channel,
        recipient: row.recipient,
        template: row.template,
        sentAt: row.sent_at ? new Date(row.sent_at).toISOString() : null,
        deliveredAt: row.delivered_at ? new Date(row.delivered_at).toISOString() : null,
        failedAt: row.failed_at ? new Date(row.failed_at).toISOString() : null,
        failureReason: row.failure_reason ?? null,
        createdAt: new Date(row.created_at).toISOString(),
      })),
      total,
      limit,
      offset,
      businesses: businessRows.map((row) => ({ id: row.id, name: row.name })),
    };

    return NextResponse.json(data);
  } catch (error) {
    console.error('[api/admin/notifications] Failed to fetch notification data:', error);
    return NextResponse.json(
      { error: 'Failed to fetch notification data' },
      { status: 500 },
    );
  }
}
