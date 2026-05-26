import { beforeEach, describe, expect, it, vi } from 'vitest';

const {
  mockVerifyImpersonationSession,
  mockLoadActiveImpersonationSession,
  mockSql,
  sqlCalls,
} = vi.hoisted(() => {
  const sqlCalls: { text: string; values: unknown[] }[] = [];
  const mockSql: any = vi.fn((strings: TemplateStringsArray, ...values: unknown[]) => {
    sqlCalls.push({ text: strings.join('?'), values });
    return Promise.resolve([
      {
        id: '22222222-2222-4222-8222-222222222222',
        email: 'admin@example.com',
        role: 'admin',
      },
    ]);
  });
  return {
    mockVerifyImpersonationSession: vi.fn(),
    mockLoadActiveImpersonationSession: vi.fn(),
    mockSql,
    sqlCalls,
  };
});

vi.mock('@/lib/admin/impersonation/cookie', () => ({
  verifyImpersonationSession: mockVerifyImpersonationSession,
}));

vi.mock('@/lib/admin/impersonation/session', () => ({
  loadActiveImpersonationSession: mockLoadActiveImpersonationSession,
}));

vi.mock('@/lib/db/server', () => ({
  sql: mockSql,
}));

const SESSION_ID = '44444444-4444-7444-8444-444444444444';
const ADMIN_ID = '22222222-2222-4222-8222-222222222222';
const ACCOUNT_ID = '11111111-1111-4111-8111-111111111111';

describe('resolveImpersonationViewSession', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    sqlCalls.length = 0;
    mockVerifyImpersonationSession.mockReturnValue(SESSION_ID);
    mockSql.mockImplementation((strings: TemplateStringsArray, ...values: unknown[]) => {
      sqlCalls.push({ text: strings.join('?'), values });
      return Promise.resolve([
        {
          id: ADMIN_ID,
          email: 'admin@example.com',
          role: 'admin',
        },
      ]);
    });
    mockLoadActiveImpersonationSession.mockResolvedValue({
      id: SESSION_ID,
      actorUserId: ADMIN_ID,
      impersonatedUserId: '33333333-3333-4333-8333-333333333333',
      accountId: ACCOUNT_ID,
      ticketId: 'SUP-123',
      reason: 'Diagnose support ticket.',
      startedAt: new Date('2026-05-26T12:00:00.000Z'),
      expiresAt: new Date('2026-05-26T13:00:00.000Z'),
      impersonatedEmail: 'owner@example.com',
      accountDisplayName: 'Example Cafe',
    });
  });

  it('requires a signed cookie matching the route session id', async () => {
    const { resolveImpersonationViewSession } = await import('../view');

    await expect(resolveImpersonationViewSession({
      routeSessionId: SESSION_ID,
      signedCookieValue: null,
      authUserId: 'auth-admin-id',
      isAal2: true,
    })).resolves.toEqual({ status: 'not_found' });

    mockVerifyImpersonationSession.mockReturnValueOnce('different-session');
    await expect(resolveImpersonationViewSession({
      routeSessionId: SESSION_ID,
      signedCookieValue: 'signed-cookie',
      authUserId: 'auth-admin-id',
      isAal2: true,
    })).resolves.toEqual({ status: 'not_found' });
  });

  it('requires the authenticated app user to be an admin', async () => {
    const { resolveImpersonationViewSession } = await import('../view');

    await expect(resolveImpersonationViewSession({
      routeSessionId: SESSION_ID,
      signedCookieValue: 'signed-cookie',
      authUserId: null,
      isAal2: true,
    })).resolves.toEqual({ status: 'unauthenticated' });

    mockSql.mockResolvedValueOnce([{ id: ADMIN_ID, email: 'owner@example.com', role: 'owner' }]);
    await expect(resolveImpersonationViewSession({
      routeSessionId: SESSION_ID,
      signedCookieValue: 'signed-cookie',
      authUserId: 'auth-owner-id',
      isAal2: true,
    })).resolves.toEqual({ status: 'forbidden' });
  });

  it('requires the current session to be AAL2 before exposing customer data', async () => {
    const { resolveImpersonationViewSession } = await import('../view');

    await expect(resolveImpersonationViewSession({
      routeSessionId: SESSION_ID,
      signedCookieValue: 'signed-cookie',
      authUserId: 'auth-admin-id',
      isAal2: false,
    })).resolves.toEqual({ status: 'mfa_required' });

    // No customer session is loaded when the admin is not stepped up.
    expect(mockLoadActiveImpersonationSession).not.toHaveBeenCalled();
  });

  it('blocks any non-allowlisted impersonation action by default', async () => {
    const { resolveImpersonationViewSession } = await import('../view');

    await expect(resolveImpersonationViewSession({
      routeSessionId: SESSION_ID,
      signedCookieValue: 'signed-cookie',
      authUserId: 'auth-admin-id',
      isAal2: true,
      action: 'delete_account',
    })).resolves.toEqual({ status: 'forbidden' });

    expect(mockLoadActiveImpersonationSession).not.toHaveBeenCalled();
  });

  it('loads only the active session for the admin actor', async () => {
    const { resolveImpersonationViewSession } = await import('../view');

    const result = await resolveImpersonationViewSession({
      routeSessionId: SESSION_ID,
      signedCookieValue: 'signed-cookie',
      authUserId: 'auth-admin-id',
      isAal2: true,
      now: new Date('2026-05-26T12:30:00.000Z'),
    });

    expect(result).toEqual({
      status: 'ok',
      admin: { id: ADMIN_ID, email: 'admin@example.com' },
      session: expect.objectContaining({
        id: SESSION_ID,
        accountId: ACCOUNT_ID,
      }),
    });
    expect(sqlCalls[0]!.text).toMatch(/FROM users/i);
    expect(sqlCalls[0]!.text).toMatch(/WHERE auth_id =/i);
    expect(mockLoadActiveImpersonationSession).toHaveBeenCalledWith({
      sessionId: SESSION_ID,
      actorUserId: ADMIN_ID,
      now: new Date('2026-05-26T12:30:00.000Z'),
    });
  });
});

describe('loadImpersonationAccountLocations', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    sqlCalls.length = 0;
    mockSql.mockImplementation((strings: TemplateStringsArray, ...values: unknown[]) => {
      sqlCalls.push({ text: strings.join('?'), values });
      return Promise.resolve([
        {
          id: '55555555-5555-4555-8555-555555555555',
          name: 'Downtown',
          display_label: 'Downtown Cafe',
          is_primary: true,
          archived_at: null,
        },
      ]);
    });
  });

  it('loads account locations with an account_id predicate', async () => {
    const { loadImpersonationAccountLocations } = await import('../view');

    const rows = await loadImpersonationAccountLocations(ACCOUNT_ID);

    expect(rows).toEqual([
      {
        id: '55555555-5555-4555-8555-555555555555',
        name: 'Downtown',
        displayLabel: 'Downtown Cafe',
        isPrimary: true,
        archivedAt: null,
      },
    ]);
    expect(sqlCalls[0]!.text).toMatch(/FROM businesses/i);
    expect(sqlCalls[0]!.text).toMatch(/WHERE account_id =/i);
    expect(sqlCalls[0]!.values).toContain(ACCOUNT_ID);
  });
});
