import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Sql } from 'postgres';

const { mockCookies, mockRedirect, mockGetUser, mockAal2, mockSql, sqlReturnQueue, resetMockSql } =
  await vi.hoisted(async () => {
    const { createMockSql } = await import('../../../../worker/__tests__/helpers/mock-sql');
    return {
      mockCookies: vi.fn(),
      mockRedirect: vi.fn((url: string) => {
        throw new Error(`REDIRECT:${url}`);
      }),
      mockGetUser: vi.fn(),
      mockAal2: vi.fn(),
      ...createMockSql(),
    };
  });

vi.mock('next/headers', () => ({ cookies: mockCookies }));
vi.mock('next/navigation', () => ({ redirect: mockRedirect }));
vi.mock('@supabase/ssr', () => ({
  createServerClient: vi.fn(() => ({ auth: { getUser: mockGetUser } })),
}));
// `mfaChallengePath` is left as the REAL implementation (`/mfa/challenge?next=...`)
// so this test stays honest about the actual redirect target instead of
// hand-rolling a copy that could drift from src/lib/auth/mfa.ts.
vi.mock('@/lib/auth/mfa', async () => {
  const actual = await vi.importActual<typeof import('@/lib/auth/mfa')>('@/lib/auth/mfa');
  return {
    ...actual,
    requireCurrentAal2FromSupabase: mockAal2,
  };
});

import { requireAdminPage } from '../page-gate';

const sql = mockSql as unknown as Sql;

describe('requireAdminPage', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetMockSql();
    mockCookies.mockResolvedValue({ getAll: () => [] });
  });

  it('redirects to /admin/login when there is no session', async () => {
    mockGetUser.mockResolvedValue({ data: { user: null }, error: null });

    await expect(requireAdminPage(sql, { from: '/admin/jobs' })).rejects.toThrow(
      'REDIRECT:/admin/login?from=%2Fadmin%2Fjobs',
    );
  });

  it('redirects to /admin/login when the user is not an admin', async () => {
    mockGetUser.mockResolvedValue({ data: { user: { id: 'auth-1' } }, error: null });
    sqlReturnQueue.push([{ id: 'user-1', role: 'owner' }]);

    await expect(requireAdminPage(sql, { from: '/admin/jobs' })).rejects.toThrow(
      'REDIRECT:/admin/login?from=%2Fadmin%2Fjobs',
    );
  });

  it('redirects to /admin/login when the users row is missing (deprovisioned admin)', async () => {
    mockGetUser.mockResolvedValue({ data: { user: { id: 'auth-1' } }, error: null });
    sqlReturnQueue.push([]);

    await expect(requireAdminPage(sql, { from: '/admin/jobs' })).rejects.toThrow(
      'REDIRECT:/admin/login?from=%2Fadmin%2Fjobs',
    );
  });

  it('returns the admin user when the session is valid', async () => {
    mockGetUser.mockResolvedValue({ data: { user: { id: 'auth-1' } }, error: null });
    sqlReturnQueue.push([{ id: 'user-1', role: 'admin' }]);

    const user = await requireAdminPage(sql, { from: '/admin/jobs' });

    expect(user).toEqual({ id: 'user-1', role: 'admin' });
    expect(mockAal2).not.toHaveBeenCalled();
  });

  it('enforces AAL2 when requested and redirects to the MFA challenge on mfa_required', async () => {
    mockGetUser.mockResolvedValue({ data: { user: { id: 'auth-1' } }, error: null });
    sqlReturnQueue.push([{ id: 'user-1', role: 'admin' }]);
    mockAal2.mockResolvedValue({ ok: false, reason: 'mfa_required' });

    await expect(requireAdminPage(sql, { from: '/admin/flagged', aal2: true })).rejects.toThrow(
      'REDIRECT:/mfa/challenge?next=%2Fadmin%2Fflagged',
    );
  });

  it('fails closed to the MFA challenge when the AAL2 check throws unexpectedly', async () => {
    mockGetUser.mockResolvedValue({ data: { user: { id: 'auth-1' } }, error: null });
    sqlReturnQueue.push([{ id: 'user-1', role: 'admin' }]);
    mockAal2.mockRejectedValue(new Error('network blip'));

    await expect(requireAdminPage(sql, { from: '/admin/flagged', aal2: true })).rejects.toThrow(
      'REDIRECT:/mfa/challenge?next=%2Fadmin%2Fflagged',
    );
  });

  it('passes AAL2 when the check returns ok', async () => {
    mockGetUser.mockResolvedValue({ data: { user: { id: 'auth-1' } }, error: null });
    sqlReturnQueue.push([{ id: 'user-1', role: 'admin' }]);
    mockAal2.mockResolvedValue({ ok: true });

    const user = await requireAdminPage(sql, { from: '/admin/flagged', aal2: true });

    expect(user.role).toBe('admin');
  });
});
