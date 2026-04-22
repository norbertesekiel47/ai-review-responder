import { describe, it, expect, vi, beforeEach } from 'vitest';

const { sqlReturnQueue, mockSql, mockTx, updateCalls, insertCalls } = vi.hoisted(() => {
  const sqlReturnQueue: unknown[] = [];
  const updateCalls: string[] = [];
  const insertCalls: Array<Record<string, unknown>> = [];
  const mockTx: any = vi.fn((template: TemplateStringsArray, ...values: unknown[]) => {
    const queryText = template.join('?');
    if (queryText.match(/UPDATE approval_links/i)) {
      updateCalls.push(queryText);
      return Promise.resolve([]);
    }
    if (queryText.match(/INSERT INTO approval_links/i)) {
      insertCalls.push({ queryText, values });
      return Promise.resolve([]);
    }
    // pg_advisory_xact_lock is a no-op lock acquisition — always [].
    if (queryText.match(/pg_advisory_xact_lock/i)) {
      return Promise.resolve([]);
    }
    // Delivery-check SELECT (and any future tx-level SELECT) dequeues from
    // the test-staged return queue.
    return Promise.resolve(sqlReturnQueue.shift() ?? []);
  });
  const mockSql: any = vi.fn((_t: TemplateStringsArray, ..._v: unknown[]) =>
    Promise.resolve(sqlReturnQueue.shift() ?? []));
  mockSql.begin = vi.fn(async (cb: (tx: any) => Promise<any>) => cb(mockTx));
  return { sqlReturnQueue, mockSql, mockTx, updateCalls, insertCalls };
});

vi.mock('@/lib/db/server', () => ({ sql: mockSql }));
vi.mock('uuid', () => ({ v7: () => 'uuid-v7-fixture' }));

import { createApprovalLink } from '../create-link';

describe('createApprovalLink — channel-aware', () => {
  beforeEach(() => {
    sqlReturnQueue.length = 0;
    updateCalls.length = 0;
    insertCalls.length = 0;
    mockSql.mockClear();
    mockSql.begin.mockClear();
    mockTx.mockClear();
  });

  it('inserts approval_links row with the provided channel', async () => {
    sqlReturnQueue.push([]);

    const { rawToken, tokenHash, approvalLinkId } = await createApprovalLink({
      responseId: 'resp-1',
      businessId: 'biz-1',
      channel: 'sms',
    });

    expect(rawToken).toMatch(/^[0-9a-f-]{36}$/);
    expect(tokenHash).toHaveLength(64);
    expect(approvalLinkId).toBe('uuid-v7-fixture');
    expect(insertCalls).toHaveLength(1);
    const insertQuery = insertCalls[0]!.queryText as string;
    expect(insertQuery).toMatch(/INSERT INTO approval_links/);
    expect(insertCalls[0]!.values).toContain('sms');
  });

  it('orphaned_only revokes ONLY same-channel non-consumed links', async () => {
    sqlReturnQueue.push([]);

    await createApprovalLink({
      responseId: 'resp-1',
      businessId: 'biz-1',
      channel: 'sms',
      revokeMode: 'orphaned_only',
    });

    expect(updateCalls).toHaveLength(1);
    expect(updateCalls[0]).toMatch(/channel\s*=/i);
  });

  it('orphaned_only does NOT revoke when a prior same-channel delivery exists', async () => {
    sqlReturnQueue.push([{ id: 'prior-delivery-id' }]);

    await createApprovalLink({
      responseId: 'resp-1',
      businessId: 'biz-1',
      channel: 'email',
      revokeMode: 'orphaned_only',
    });

    expect(updateCalls).toHaveLength(0);
    expect(insertCalls).toHaveLength(1);
  });

  it('always-mode revokes same-channel links unconditionally', async () => {
    await createApprovalLink({
      responseId: 'resp-1',
      businessId: 'biz-1',
      channel: 'email',
      revokeMode: 'always',
    });

    expect(updateCalls).toHaveLength(1);
    expect(updateCalls[0]).toMatch(/channel\s*=/i);
  });
});
