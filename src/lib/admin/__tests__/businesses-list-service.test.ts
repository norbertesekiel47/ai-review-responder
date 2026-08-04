import { describe, expect, it, vi } from 'vitest';
import type { Sql } from 'postgres';

const { mockSql, sqlReturnQueue, sqlCalls, resetMockSql } = await vi.hoisted(async () => {
  const { createMockSql } = await import('../../../../worker/__tests__/helpers/mock-sql');
  return { ...createMockSql() };
});

import { getAdminBusinessesList } from '../businesses-list-service';

describe('getAdminBusinessesList', () => {
  it('maps the list page + total, converting last_sync_at to an ISO string', async () => {
    resetMockSql();
    sqlReturnQueue.push([
      {
        id: 'biz-1',
        name: 'Test Cafe',
        category: 'restaurant',
        subscription_status: 'active',
        // A real Date, exactly what Postgres.js decodes a timestamptz into.
        // The RSC boundary preserves Date instances, so a DTO field typed
        // `string` holding a Date breaks the server page on first paint.
        last_sync_at: new Date('2026-08-01T12:30:00.000Z'),
        pending_count: 3,
      },
      {
        id: 'biz-2',
        name: 'Never Synced',
        category: null,
        subscription_status: 'past_due',
        last_sync_at: null,
        pending_count: 0,
      },
    ]);
    sqlReturnQueue.push([{ total: 42 }]);

    const result = await getAdminBusinessesList(mockSql as unknown as Sql, { limit: 20, offset: 0 });

    expect(result).toEqual({
      businesses: [
        {
          id: 'biz-1',
          name: 'Test Cafe',
          category: 'restaurant',
          subscriptionStatus: 'active',
          lastSyncAt: '2026-08-01T12:30:00.000Z',
          pendingCount: 3,
        },
        {
          id: 'biz-2',
          name: 'Never Synced',
          category: null,
          subscriptionStatus: 'past_due',
          lastSyncAt: null,
          pendingCount: 0,
        },
      ],
      total: 42,
    });

    // The trap guard: `toEqual` above would pass for a Date whose ISO string
    // matches, so assert the runtime type explicitly.
    expect(typeof result.businesses[0]!.lastSyncAt).toBe('string');

    expect(sqlCalls[0]!.text).toContain('FROM businesses b');
    expect(sqlCalls[0]!.text).toContain('JOIN accounts a ON a.id = b.account_id');
    expect(sqlCalls[0]!.text).toContain('LEFT JOIN responses resp');
    expect(sqlCalls[0]!.text).toContain("resp.status != 'superseded'");
    expect(sqlCalls[0]!.text).toContain("resp.status = 'pending_approval'");
    expect(sqlCalls[0]!.text).toContain('ORDER BY b.name ASC');
    expect(sqlCalls[0]!.values).toEqual([20, 0]);

    expect(sqlCalls[1]!.text).toContain('SELECT COUNT(*)::int AS total FROM businesses');
  });

  it('returns an empty list and a zero total for empty results', async () => {
    resetMockSql();
    sqlReturnQueue.push([]);
    sqlReturnQueue.push([]);

    const result = await getAdminBusinessesList(mockSql as unknown as Sql, { limit: 20, offset: 40 });

    expect(result).toEqual({ businesses: [], total: 0 });
    expect(sqlCalls[0]!.values).toEqual([20, 40]);
  });
});
