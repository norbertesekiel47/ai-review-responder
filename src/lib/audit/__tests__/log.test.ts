import { beforeEach, describe, expect, it, vi } from 'vitest';

const { mockSql, mockTx, sqlCalls, txCalls } = vi.hoisted(() => {
  const sqlCalls: { text: string; values: unknown[] }[] = [];
  const txCalls: { text: string; values: unknown[] }[] = [];

  const makeTag = (calls: { text: string; values: unknown[] }[]) =>
    vi.fn((strings: TemplateStringsArray, ...values: unknown[]) => {
      calls.push({ text: strings.join('?'), values });
      return Promise.resolve(Object.assign([], { count: 1 }));
    });

  return {
    mockSql: makeTag(sqlCalls),
    mockTx: makeTag(txCalls),
    sqlCalls,
    txCalls,
  };
});

vi.mock('@/lib/db/server', () => ({
  sql: mockSql,
  jsonb: (value: unknown) => ({ __jsonb: value }),
}));

vi.mock('uuid', () => ({
  v7: vi.fn(() => '019dc366-29ce-7000-a000-000000000043'),
}));

describe('writeAccountAuditLog', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    sqlCalls.length = 0;
    txCalls.length = 0;
  });

  it('writes required fields with default sql client', async () => {
    const { writeAccountAuditLog } = await import('../log');

    await writeAccountAuditLog({
      accountId: 'acct-1',
      eventType: 'subscription_status_changed',
      payload: { fromStatus: 'active', toStatus: 'past_due' },
    });

    expect(sqlCalls).toHaveLength(1);
    expect(sqlCalls[0]!.text).toMatch(/INSERT INTO account_audit_log/i);
    expect(sqlCalls[0]!.text).toMatch(/event_type/i);
    expect(sqlCalls[0]!.values).toContain('acct-1');
    expect(sqlCalls[0]!.values).toContain('subscription_status_changed');
    expect(sqlCalls[0]!.values).toContainEqual({
      __jsonb: { fromStatus: 'active', toStatus: 'past_due' },
    });
  });

  it('uses an injected transaction client', async () => {
    const { writeAccountAuditLog } = await import('../log');

    await writeAccountAuditLog(
      {
        accountId: 'acct-1',
        eventType: 'subscription_status_changed',
        payload: { fromStatus: 'past_due', toStatus: 'active' },
      },
      mockTx as never,
    );

    expect(sqlCalls).toHaveLength(0);
    expect(txCalls).toHaveLength(1);
  });

  it('writes optional metadata fields', async () => {
    const { writeAccountAuditLog } = await import('../log');

    await writeAccountAuditLog({
      accountId: 'acct-1',
      locationId: 'biz-location-1',
      actorUserId: 'user-1',
      eventType: 'csv_bulk_import',
      entityType: 'business',
      entityId: 'entity-business-1',
      ip: '203.0.113.10',
      userAgent: 'Vitest',
      requestId: 'req-123',
      payload: { created: 3 },
    });

    const values = sqlCalls[0]!.values;
    expect(values).toContain('biz-location-1');
    expect(values).toContain('user-1');
    expect(values).toContain('business');
    expect(values).toContain('entity-business-1');
    expect(values).toContain('203.0.113.10');
    expect(values).toContain('Vitest');
    expect(values).toContain('req-123');
  });
});
