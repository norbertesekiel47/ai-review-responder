// src/lib/notifications/__tests__/enrollments.test.ts
import { describe, it, expect, vi, beforeEach } from 'vitest';

const { sqlReturnQueue, mockSql } = vi.hoisted(() => {
  const sqlReturnQueue: unknown[] = [];
  const mockSql: any = vi.fn((_s: TemplateStringsArray, ..._v: unknown[]) => {
    const result = sqlReturnQueue.shift() ?? [];
    return Promise.resolve(result);
  });
  return { sqlReturnQueue, mockSql };
});

vi.mock('../../db/server', () => ({
  sql: mockSql,
}));

import { getVerifiedEnrollments } from '../enrollments';

describe('getVerifiedEnrollments', () => {
  beforeEach(() => {
    sqlReturnQueue.length = 0;
    mockSql.mockClear();
  });

  it('returns verified, non-unsubscribed enrollments for the business', async () => {
    sqlReturnQueue.push([
      { channel: 'email', handle: 'owner@example.com' },
      { channel: 'sms', handle: '+15551234567' },
    ]);

    const result = await getVerifiedEnrollments('biz-1');

    expect(result).toEqual([
      { channel: 'email', handle: 'owner@example.com' },
      { channel: 'sms', handle: '+15551234567' },
    ]);
    expect(mockSql).toHaveBeenCalledTimes(1);

    // Sanity-check the query shape — should filter on status='verified',
    // unsubscribed_at IS NULL, and archived_at IS NULL.
    const [template] = mockSql.mock.calls[0] as [TemplateStringsArray, ...unknown[]];
    const queryText = template.join('?');
    expect(queryText).toMatch(/channel_enrollments/);
    expect(queryText).toMatch(/status = 'verified'/);
    expect(queryText).toMatch(/unsubscribed_at IS NULL/);
    expect(queryText).toMatch(/archived_at IS NULL/);
  });

  it('excludes rows where archived_at IS NOT NULL (query shape)', async () => {
    // This guards the intent of Task 4: the dispatcher must never send to
    // archived enrollments, even if they still show status='verified' and
    // unsubscribed_at IS NULL. We assert the WHERE clause carries the
    // archived_at IS NULL predicate so a hard-deleted/admin-archived row is
    // always filtered out at the SQL layer.
    sqlReturnQueue.push([{ channel: 'email', handle: 'owner@example.com' }]);

    await getVerifiedEnrollments('biz-archived-check');

    const [template] = mockSql.mock.calls[0] as [TemplateStringsArray, ...unknown[]];
    const queryText = template.join('?');
    expect(queryText).toMatch(/archived_at IS NULL/);
  });

  it('returns an empty array when no enrollments match', async () => {
    sqlReturnQueue.push([]);
    const result = await getVerifiedEnrollments('biz-with-no-channels');
    expect(result).toEqual([]);
  });
});
