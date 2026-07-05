import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Sql } from 'postgres';
import { createMockSql, mkTaggedResult } from '../../../../../worker/__tests__/helpers/mock-sql';

// session.ts no longer imports the @/lib/db/server singleton — sql is an
// explicit parameter (A+ campaign 2b, T4) — so tests hand the shared mock
// client directly to each function instead of vi.mock'ing a module import.
// sql.begin(cb) invokes cb with the SAME mock client (see createMockSql),
// so `sql` below stands in for both the top-level client and the tx passed
// to writeAccountAuditLog.
const { mockSql, sqlReturnQueue, sqlCalls, resetMockSql } = createMockSql();
const sql = mockSql as unknown as Sql;

const { mockWriteAccountAuditLog } = vi.hoisted(() => ({
  mockWriteAccountAuditLog: vi.fn(),
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
    resetMockSql();
    mockWriteAccountAuditLog.mockResolvedValue(undefined);
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-05-26T12:00:00.000Z'));
  });

  it('starts a one-hour audited impersonation session', async () => {
    const { startImpersonationSession } = await import('../session');
    sqlReturnQueue.push(mkTaggedResult([])); // reap expired-but-unended sessions
    sqlReturnQueue.push([]); // active pre-check SELECT — no existing session
    sqlReturnQueue.push(mkTaggedResult([])); // INSERT

    const result = await startImpersonationSession(sql, {
      actorUserId: 'admin-user-id',
      impersonatedUserId: 'owner-user-id',
      accountId: 'account-id',
      ticketId: 'SUP-123',
      reason: 'Diagnose support ticket.',
    });

    expect(result.sessionId).toBe('018f0000-0000-7000-8000-000000000048');
    expect(result.expiresAt.toISOString()).toBe('2026-05-26T13:00:00.000Z');
    expect(mockSql.begin).toHaveBeenCalledTimes(1);
    // First reaps expired-but-unended sessions, then checks for an active one, then inserts.
    expect(sqlCalls[0]!.text).toMatch(/UPDATE impersonation_sessions/i);
    expect(sqlCalls[0]!.text).toMatch(/SET ended_at/i);
    expect(sqlCalls[0]!.text).toMatch(/expires_at <= NOW\(\)/i);
    expect(sqlCalls[0]!.text).toMatch(/ended_at IS NULL/i);
    expect(sqlCalls[1]!.text).toMatch(/SELECT id\s+FROM impersonation_sessions/i);
    expect(sqlCalls[1]!.text).toMatch(/ended_at IS NULL/i);
    expect(sqlCalls[1]!.text).toMatch(/FOR UPDATE/i);
    expect(sqlCalls[2]!.text).toMatch(/INSERT INTO impersonation_sessions/i);
    expect(mockWriteAccountAuditLog).toHaveBeenCalledWith(
      expect.objectContaining({
        accountId: 'account-id',
        actorUserId: 'admin-user-id',
        eventType: 'impersonation_started',
        entityType: 'user',
        entityId: 'owner-user-id',
      }),
      sql,
    );
  });

  it('rejects starting a second active session for the same actor', async () => {
    // First tx call is the expired-session reap; second is the active pre-check
    // SELECT, which here finds a still-active (non-expired) session.
    sqlReturnQueue.push(mkTaggedResult([]));
    sqlReturnQueue.push([{ id: 'existing-session-id' }]);
    const { startImpersonationSession, ImpersonationStartError } = await import('../session');

    await expect(startImpersonationSession(sql, {
      actorUserId: 'admin-user-id',
      impersonatedUserId: 'owner-user-id',
      accountId: 'account-id',
      ticketId: 'SUP-123',
      reason: 'Diagnose support ticket.',
    })).rejects.toBeInstanceOf(ImpersonationStartError);

    // No INSERT, no audit row when an active session already exists.
    expect(sqlCalls.some((c) => /INSERT INTO impersonation_sessions/i.test(c.text))).toBe(false);
    expect(mockWriteAccountAuditLog).not.toHaveBeenCalled();
  });

  it('ends an active session and writes an audit row', async () => {
    sqlReturnQueue.push([{ account_id: 'account-id', impersonated_user_id: 'owner-user-id' }]);
    const { endImpersonationSession } = await import('../session');

    await expect(endImpersonationSession(sql, {
      sessionId: 'session-id',
      actorUserId: 'admin-user-id',
    })).resolves.toEqual({ ended: true });

    expect(sqlCalls[0]!.text).toMatch(/UPDATE impersonation_sessions/i);
    expect(sqlCalls[0]!.text).toMatch(/RETURNING account_id, impersonated_user_id/i);
    expect(mockWriteAccountAuditLog).toHaveBeenCalledWith(
      expect.objectContaining({
        accountId: 'account-id',
        actorUserId: 'admin-user-id',
        eventType: 'impersonation_ended',
      }),
      sql,
    );
  });

  it('reports ended=false when no active session row was updated', async () => {
    sqlReturnQueue.push([]);
    const { endImpersonationSession } = await import('../session');

    await expect(endImpersonationSession(sql, {
      sessionId: 'session-id',
      actorUserId: 'admin-user-id',
    })).resolves.toEqual({ ended: false });

    expect(sqlCalls[0]!.text).toMatch(/UPDATE impersonation_sessions/i);
    expect(mockWriteAccountAuditLog).not.toHaveBeenCalled();
  });
});
