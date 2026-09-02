import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Sql } from 'postgres';

const { mockSql, sqlReturnQueue, sqlCalls, resetMockSql } = await vi.hoisted(async () => {
  const { createMockSql } = await import('../../../../worker/__tests__/helpers/mock-sql');
  return { ...createMockSql() };
});

const { verifyMock, loadSessionMock } = vi.hoisted(() => ({
  verifyMock: vi.fn<(value: string) => string | null>(),
  loadSessionMock: vi.fn(),
}));
vi.mock('@/lib/admin/impersonation/cookie', () => ({
  verifyImpersonationSession: verifyMock,
}));
vi.mock('@/lib/admin/impersonation/session', () => ({
  loadActiveImpersonationSession: loadSessionMock,
}));

import { loadAdminShellContext, type AdminShellSupabaseClient } from '../shell-context';

const NOW = new Date('2026-09-02T12:00:00.000Z');
const EXPIRES = new Date('2026-09-02T12:45:00.000Z');

function supabaseFake({
  user,
  currentLevel = 'aal1',
  aalError = null,
}: {
  user: { id: string; email?: string | null } | null;
  currentLevel?: string | null;
  aalError?: unknown;
}): AdminShellSupabaseClient {
  return {
    auth: {
      getUser: async () => ({ data: { user } }),
      mfa: {
        getAuthenticatorAssuranceLevel: async () => ({
          data: aalError ? null : { currentLevel, nextLevel: 'aal2' },
          error: aalError,
        }),
      },
    },
  };
}

const sql = mockSql as unknown as Sql;

beforeEach(() => {
  resetMockSql();
  verifyMock.mockReset();
  loadSessionMock.mockReset();
});

describe('loadAdminShellContext', () => {
  it('returns nothing for a signed-out visitor and touches neither the cookie nor the DB', async () => {
    const context = await loadAdminShellContext(sql, {
      supabase: supabaseFake({ user: null }),
      signedImpersonationCookie: 'abc.def',
    });

    expect(context).toEqual({ identity: null, impersonation: null });
    expect(verifyMock).not.toHaveBeenCalled();
    expect(sqlCalls).toHaveLength(0);
  });

  it('reports the email and a stepped-up (AAL2) session', async () => {
    const context = await loadAdminShellContext(sql, {
      supabase: supabaseFake({ user: { id: 'auth-1', email: 'ops@repworth.com' }, currentLevel: 'aal2' }),
      signedImpersonationCookie: null,
    });

    expect(context.identity).toEqual({ email: 'ops@repworth.com', aal2: true });
    expect(context.impersonation).toBeNull();
  });

  it('reports aal2:false for an AAL1 session and when the AAL read itself fails', async () => {
    const aal1 = await loadAdminShellContext(sql, {
      supabase: supabaseFake({ user: { id: 'auth-1', email: 'ops@repworth.com' } }),
      signedImpersonationCookie: null,
    });
    expect(aal1.identity?.aal2).toBe(false);

    const failed = await loadAdminShellContext(sql, {
      supabase: supabaseFake({ user: { id: 'auth-1', email: null }, aalError: new Error('boom') }),
      signedImpersonationCookie: null,
    });
    expect(failed.identity).toEqual({ email: null, aal2: false });
  });

  it('resolves the live view-as session through the actor app-user id, as ISO + label', async () => {
    verifyMock.mockReturnValue('sess-1');
    sqlReturnQueue.push([{ id: 'user-9' }]);
    loadSessionMock.mockResolvedValue({
      id: 'sess-1',
      accountId: 'acct-1',
      accountDisplayName: 'Bella Italia',
      expiresAt: EXPIRES,
    });

    const context = await loadAdminShellContext(sql, {
      supabase: supabaseFake({ user: { id: 'auth-1', email: 'ops@repworth.com' }, currentLevel: 'aal2' }),
      signedImpersonationCookie: 'sess-1.sig',
      now: NOW,
    });

    expect(verifyMock).toHaveBeenCalledWith('sess-1.sig');
    expect(sqlCalls[0]!.text).toContain('FROM users WHERE auth_id = ?');
    expect(sqlCalls[0]!.text).toContain("role = 'admin'");
    expect(sqlCalls[0]!.values).toEqual(['auth-1']);
    expect(loadSessionMock).toHaveBeenCalledWith(sql, {
      sessionId: 'sess-1',
      actorUserId: 'user-9',
      now: NOW,
    });
    expect(context.impersonation).toEqual({
      sessionId: 'sess-1',
      expiresAt: '2026-09-02T12:45:00.000Z',
      accountLabel: 'Bella Italia',
    });
  });

  it('falls back to the account id when the account has no display name', async () => {
    verifyMock.mockReturnValue('sess-1');
    sqlReturnQueue.push([{ id: 'user-9' }]);
    loadSessionMock.mockResolvedValue({
      id: 'sess-1',
      accountId: 'acct-1',
      accountDisplayName: null,
      expiresAt: EXPIRES,
    });

    const context = await loadAdminShellContext(sql, {
      supabase: supabaseFake({ user: { id: 'auth-1' } }),
      signedImpersonationCookie: 'sess-1.sig',
    });

    expect(context.impersonation?.accountLabel).toBe('acct-1');
  });

  it.each([
    ['an unverifiable cookie', () => verifyMock.mockReturnValue(null)],
    [
      'a misconfigured signing secret',
      () => verifyMock.mockImplementation(() => {
        throw new Error('IMPERSONATION_COOKIE_SECRET not configured');
      }),
    ],
  ])('yields no impersonation for %s without touching the DB', async (_label, arrange) => {
    arrange();

    const context = await loadAdminShellContext(sql, {
      supabase: supabaseFake({ user: { id: 'auth-1' } }),
      signedImpersonationCookie: 'garbage',
    });

    expect(context.identity).not.toBeNull();
    expect(context.impersonation).toBeNull();
    expect(sqlCalls).toHaveLength(0);
    expect(loadSessionMock).not.toHaveBeenCalled();
  });

  it('yields no impersonation when the signed-in user is not an admin app user', async () => {
    verifyMock.mockReturnValue('sess-1');
    sqlReturnQueue.push([]);

    const context = await loadAdminShellContext(sql, {
      supabase: supabaseFake({ user: { id: 'auth-1' } }),
      signedImpersonationCookie: 'sess-1.sig',
    });

    expect(context.impersonation).toBeNull();
    expect(loadSessionMock).not.toHaveBeenCalled();
  });

  it('yields no impersonation when the session is ended, expired, or owned by another actor', async () => {
    verifyMock.mockReturnValue('sess-1');
    sqlReturnQueue.push([{ id: 'user-9' }]);
    loadSessionMock.mockResolvedValue(null);

    const context = await loadAdminShellContext(sql, {
      supabase: supabaseFake({ user: { id: 'auth-1' } }),
      signedImpersonationCookie: 'sess-1.sig',
    });

    expect(context.impersonation).toBeNull();
  });
});
