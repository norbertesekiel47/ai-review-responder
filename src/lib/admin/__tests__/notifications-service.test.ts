import { describe, expect, it, vi } from 'vitest';
import type { Sql } from 'postgres';
import { asLocationId, asAccountId } from '@/lib/shared/ids';

const { mockSql, sqlReturnQueue, sqlCalls, isInTransaction, resetMockSql } = await vi.hoisted(async () => {
  const { createMockSql } = await import('../../../../worker/__tests__/helpers/mock-sql');
  return { ...createMockSql() };
});

// The notifications service uses sql.unsafe() for the dynamic-WHERE data and
// count queries — the shared harness only models tagged-template calls, so
// unsafe() is added here, sharing the same queue/call-log, recording the
// real query text + params (unlike the route-level test's placeholder stub)
// so WHERE-fragment assertions below can inspect it directly. inTransaction
// is wired to the harness's isInTransaction() rather than hardcoded false —
// getAdminNotifications is read-only and never called inside sql.begin()
// today, but a future transactional service copying this pattern gets a
// correct signal instead of a silently wrong one.
(mockSql as unknown as { unsafe: (text: string, params: unknown[]) => Promise<unknown> }).unsafe = (
  text: string,
  params: unknown[],
) => {
  sqlCalls.push({ text, values: params, inTransaction: isInTransaction() });
  const result = sqlReturnQueue.shift() ?? [];
  return Promise.resolve(result);
};

import { getAdminNotifications } from '../notifications-service';

const sql = mockSql as unknown as Sql;

describe('getAdminNotifications', () => {
  it('filters by account_id when provided, preferring it over business_id', async () => {
    resetMockSql();
    sqlReturnQueue.push([
      {
        id: 'nd-1',
        business_name: 'Downtown',
        channel: 'email',
        recipient: 'owner@example.com',
        template: 'approval_request',
        sent_at: new Date('2026-08-01T00:00:00.000Z'),
        delivered_at: new Date('2026-08-01T00:01:00.000Z'),
        failed_at: null,
        failure_reason: null,
        created_at: new Date('2026-08-01T00:00:00.000Z'),
      },
    ]);
    sqlReturnQueue.push([{ total: '1' }]);
    sqlReturnQueue.push([{ id: 'loc-1', name: 'Downtown' }]);

    const data = await getAdminNotifications(sql, {
      limit: 20,
      offset: 0,
      accountId: asAccountId('acct-123'),
      businessId: asLocationId('loc-999'),
    });

    expect(data).toEqual({
      notifications: [
        {
          id: 'nd-1',
          businessName: 'Downtown',
          channel: 'email',
          recipient: 'owner@example.com',
          template: 'approval_request',
          sentAt: '2026-08-01T00:00:00.000Z',
          deliveredAt: '2026-08-01T00:01:00.000Z',
          failedAt: null,
          failureReason: null,
          createdAt: '2026-08-01T00:00:00.000Z',
        },
      ],
      total: 1,
      businesses: [{ id: 'loc-1', name: 'Downtown' }],
    });

    // account_id wins over business_id
    expect(sqlCalls[0]!.text).toContain('nd.account_id = $1');
    expect(sqlCalls[0]!.text).not.toMatch(/WHERE nd\.business_id/);
    expect(sqlCalls[0]!.values[0]).toBe('acct-123');
    expect(sqlCalls[1]!.text).toContain('nd.account_id = $1');
  });

  it('filters by business_id when account_id is absent', async () => {
    resetMockSql();
    sqlReturnQueue.push([]);
    sqlReturnQueue.push([{ total: '0' }]);
    sqlReturnQueue.push([]);

    await getAdminNotifications(sql, {
      limit: 20,
      offset: 0,
      businessId: asLocationId('loc-1'),
    });

    expect(sqlCalls[0]!.text).toContain('nd.business_id = $1');
    expect(sqlCalls[0]!.values[0]).toBe('loc-1');
  });

  it('adds channel and status predicates when provided', async () => {
    resetMockSql();
    sqlReturnQueue.push([]);
    sqlReturnQueue.push([{ total: '0' }]);
    sqlReturnQueue.push([]);

    await getAdminNotifications(sql, { limit: 20, offset: 0, channel: 'email', status: 'failed' });

    expect(sqlCalls[0]!.text).toContain('nd.channel = $1');
    expect(sqlCalls[0]!.text).toContain('nd.failed_at IS NOT NULL');
  });

  it('returns zeroed defaults for empty results', async () => {
    resetMockSql();
    sqlReturnQueue.push([]);
    sqlReturnQueue.push([]);
    sqlReturnQueue.push([]);

    const data = await getAdminNotifications(sql, { limit: 20, offset: 0 });

    expect(data).toEqual({ notifications: [], total: 0, businesses: [] });
  });
});
