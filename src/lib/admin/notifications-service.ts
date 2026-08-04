// src/lib/admin/notifications-service.ts
//
// Extracted verbatim from src/app/api/admin/notifications/route.ts's GET body
// (admin console Phase 2, Task 7). Same dynamic-WHERE data query, count
// query, and businesses-dropdown query, same sql.unsafe() parameterized
// builder, same row→DTO mapping. Born-injected: `sql` is a parameter, not an
// import — the composition root (the route, and the notifications server
// page) supplies the singleton (invariant #15).

import type { Sql } from 'postgres';
import type { LocationId, AccountId } from '@/lib/shared/ids';

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

export interface AdminNotificationsFilters {
  limit: number;
  offset: number;
  businessId?: LocationId | '';
  accountId?: AccountId | '';
  channel?: string;
  status?: string;
}

export interface AdminNotificationsData {
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
  businesses: { id: string; name: string }[];
}

/**
 * Notification delivery log page + the businesses dropdown for the filter bar
 * (spec §4). `businessId`/`accountId`/`channel`/`status` are optional filters;
 * `account_id` is preferred over `business_id` when both are present
 * (VAL-ADMIN-003 — enables the idx_nd_account index scan).
 */
export async function getAdminNotifications(
  sql: Sql,
  { limit, offset, businessId = '', accountId = '', channel = '', status = '' }: AdminNotificationsFilters,
): Promise<AdminNotificationsData> {
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

  if (channel === 'email') {
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

  return {
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
    businesses: businessRows.map((row) => ({ id: row.id, name: row.name })),
  };
}
