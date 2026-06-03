// src/lib/auth/__tests__/admin-mfa-gate.test.ts
//
// Contract for requireAdminWithAal2 — the shared admin control-plane preamble
// (requireRole(admin) → AAL2 step-up) used by the five admin routes
// (grant-extension, impersonation start/end, zernio-queue, flagged). CSRF is
// applied separately at each route export via withSameOrigin(), so same-origin
// is intentionally NOT part of this gate's contract.

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NextRequest } from 'next/server';

const { mockRequireRole, mockAal } = vi.hoisted(() => ({
  mockRequireRole: vi.fn(),
  mockAal: vi.fn(),
}));

vi.mock('@/lib/db/auth', () => ({
  requireRole: mockRequireRole,
  AuthError: class AuthError extends Error {
    constructor(message: string, public readonly statusCode: number) {
      super(message);
      this.name = 'AuthError';
    }
  },
}));

vi.mock('@/lib/auth/mfa', () => ({
  requireCurrentAal2FromSupabase: mockAal,
}));

vi.mock('@supabase/ssr', () => ({
  createServerClient: vi.fn(() => ({ auth: { mfa: {} } })),
}));

process.env.NEXT_PUBLIC_SUPABASE_URL = 'https://supabase.example.com';
process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = 'anon-key';

import { requireAdminWithAal2 } from '../admin-mfa-gate';
import { AuthError } from '@/lib/db/auth';

const ADMIN = { id: 'admin-1', name: 'Root', email: 'a@x.com', role: 'admin', accountId: null, locationId: null };

function req(): NextRequest {
  return new NextRequest('https://app.example.com/api/admin/x', { method: 'POST' });
}

beforeEach(() => {
  vi.clearAllMocks();
  mockRequireRole.mockResolvedValue(ADMIN);
  mockAal.mockResolvedValue({ ok: true });
});

describe('requireAdminWithAal2', () => {
  it('returns { ok: true, admin } when admin role and AAL2 both pass', async () => {
    const result = await requireAdminWithAal2(req());
    expect(result).toEqual({ ok: true, admin: ADMIN });
    expect(mockRequireRole).toHaveBeenCalledWith(expect.anything(), 'admin');
  });

  it('maps an AuthError to its status + message (no-store)', async () => {
    mockRequireRole.mockRejectedValue(new AuthError('Forbidden', 403));

    const result = await requireAdminWithAal2(req());

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('expected failure');
    expect(result.response.status).toBe(403);
    expect(await result.response.json()).toEqual({ error: 'Forbidden' });
    expect(result.response.headers.get('Cache-Control')).toBe('no-store, private');
  });

  it('returns 403 with the AAL2 reason when step-up is missing', async () => {
    mockAal.mockResolvedValue({ ok: false, reason: 'mfa_required' });

    const result = await requireAdminWithAal2(req());

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('expected failure');
    expect(result.response.status).toBe(403);
    expect(await result.response.json()).toEqual({ error: 'mfa_required' });
  });

  it('returns a clean 500 internal_error on an unexpected (non-auth) failure', async () => {
    mockRequireRole.mockRejectedValue(new Error('db down'));

    const result = await requireAdminWithAal2(req());

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('expected failure');
    expect(result.response.status).toBe(500);
    expect(await result.response.json()).toEqual({ error: 'internal_error' });
  });

  it('returns a clean 500 internal_error when the AAL2 step itself throws', async () => {
    // requireCurrentAal2FromSupabase / the Supabase client can throw (network,
    // misconfig) rather than returning { ok: false } — that must not escape the
    // gate as a raw 500; it gets the same internalError treatment as the role step.
    mockAal.mockRejectedValue(new Error('aal backend unreachable'));

    const result = await requireAdminWithAal2(req());

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('expected failure');
    expect(result.response.status).toBe(500);
    expect(await result.response.json()).toEqual({ error: 'internal_error' });
  });
});
