import { beforeEach, describe, expect, it, vi } from 'vitest';

const { mockSql, mockTx, sqlCalls, txCalls, txResults, mockWriteAccountAuditLog } = vi.hoisted(() => {
  const sqlCalls: { text: string; values: unknown[] }[] = [];
  const txCalls: { text: string; values: unknown[] }[] = [];
  const txResults: unknown[] = [];
  const mockTx = vi.fn((strings: TemplateStringsArray, ...values: unknown[]) => {
    txCalls.push({ text: strings.join('?'), values });
    return Promise.resolve(txResults.shift() ?? Object.assign([], { count: 1 }));
  });
  const mockSql: any = vi.fn((strings: TemplateStringsArray, ...values: unknown[]) => {
    sqlCalls.push({ text: strings.join('?'), values });
    return Promise.resolve([]);
  });
  mockSql.begin = vi.fn(async (cb: (tx: typeof mockTx) => Promise<unknown>) => cb(mockTx));
  return {
    mockSql,
    mockTx,
    sqlCalls,
    txCalls,
    txResults,
    mockWriteAccountAuditLog: vi.fn(),
  };
});

vi.mock('@/lib/db/server', () => ({
  sql: mockSql,
}));

vi.mock('@/lib/audit/log', () => ({
  writeAccountAuditLog: mockWriteAccountAuditLog,
}));

vi.mock('uuid', () => ({
  v7: () => '018f0000-0000-7000-8000-000000000048',
}));

describe('impersonation session helpers', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    sqlCalls.length = 0;
    txCalls.length = 0;
    txResults.length = 0;
    mockWriteAccountAuditLog.mockResolvedValue(undefined);
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-05-26T12:00:00.000Z'));
  });

  it('starts a one-hour audited impersonation session', async () => {
    const { startImpersonationSession } = await import('../session');

    const result = await startImpersonationSession({
      actorUserId: 'admin-user-id',
      impersonatedUserId: 'owner-user-id',
      accountId: 'account-id',
      ticketId: 'SUP-123',
      reason: 'Diagnose support ticket.',
    });

    expect(result.sessionId).toBe('018f0000-0000-7000-8000-000000000048');
    expect(result.expiresAt.toISOString()).toBe('2026-05-26T13:00:00.000Z');
    expect(mockSql.begin).toHaveBeenCalledTimes(1);
    expect(txCalls[0]!.text).toMatch(/INSERT INTO impersonation_sessions/i);
    expect(mockWriteAccountAuditLog).toHaveBeenCalledWith(
      expect.objectContaining({
        accountId: 'account-id',
        actorUserId: 'admin-user-id',
        eventType: 'impersonation_started',
        entityType: 'user',
        entityId: 'owner-user-id',
      }),
      mockTx,
    );
  });

  it('ends an active session and writes an audit row', async () => {
    txResults.push([{ account_id: 'account-id', impersonated_user_id: 'owner-user-id' }]);
    const { endImpersonationSession } = await import('../session');

    await expect(endImpersonationSession({
      sessionId: 'session-id',
      actorUserId: 'admin-user-id',
    })).resolves.toEqual({ ended: true });

    expect(txCalls[0]!.text).toMatch(/UPDATE impersonation_sessions/i);
    expect(txCalls[0]!.text).toMatch(/RETURNING account_id, impersonated_user_id/i);
    expect(mockWriteAccountAuditLog).toHaveBeenCalledWith(
      expect.objectContaining({
        accountId: 'account-id',
        actorUserId: 'admin-user-id',
        eventType: 'impersonation_ended',
      }),
      mockTx,
    );
  });

  it('reports ended=false when no active session row was updated', async () => {
    txResults.push([]);
    const { endImpersonationSession } = await import('../session');

    await expect(endImpersonationSession({
      sessionId: 'session-id',
      actorUserId: 'admin-user-id',
    })).resolves.toEqual({ ended: false });

    expect(txCalls[0]!.text).toMatch(/UPDATE impersonation_sessions/i);
    expect(mockWriteAccountAuditLog).not.toHaveBeenCalled();
  });
});
