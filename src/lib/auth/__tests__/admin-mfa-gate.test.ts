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
  cookieBackedServerClient: () => ({ auth: { mfa: {} } }),
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

import { z } from 'zod';
import { requireAdminJson, requireAdminWithAal2 } from '../admin-mfa-gate';
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

// ---------------------------------------------------------------------------
// requireAdminJson (#909, follow-up B3.11)
// ---------------------------------------------------------------------------
//
// The contract these cases pin is EQUIVALENCE, not new behaviour: the three
// admin mutation routes hand-spelled this preamble, and the helper must produce
// byte-identical refusals or the extraction changed the wire.
//
// The other half of #909 lives in scripts/ci/__tests__/admin-aal2-audit.test.ts:
// this helper is a RECOGNIZED gate shape only because that audit was widened to
// see it, provenance-checked to this module. Neither half is complete alone —
// which is exactly why the first attempt was reverted.

describe('requireAdminJson', () => {
  const Schema = z.strictObject({ note: z.string().trim().min(1).max(10) });

  function jsonReq(body: unknown): NextRequest {
    return new NextRequest('https://app.example.com/api/admin/x', {
      method: 'POST',
      body: typeof body === 'string' ? body : JSON.stringify(body),
      headers: { 'content-type': 'application/json' },
    });
  }

  it('returns the gated admin AND the parsed body when everything passes', async () => {
    const result = await requireAdminJson(jsonReq({ note: 'ok' }), Schema);

    expect(result).toEqual({ ok: true, admin: ADMIN, data: { note: 'ok' } });
  });

  it('passes the gate refusal straight through — 403 mfa_required is unchanged', async () => {
    // The helper must not re-wrap or re-word an auth refusal: the three routes
    // returned `gate.response` verbatim, and an admin hitting a step-up wall
    // must read the same thing after the extraction as before it.
    mockAal.mockResolvedValue({ ok: false, reason: 'mfa_required' });

    const result = await requireAdminJson(jsonReq({ note: 'ok' }), Schema);

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('expected failure');
    expect(result.response.status).toBe(403);
    expect(await result.response.json()).toEqual({ error: 'mfa_required' });
  });

  it('never reads the body when the gate refuses — auth outranks parsing', async () => {
    // Order is load-bearing. Parsing first would let an unauthenticated caller
    // learn which bodies a schema accepts by reading the 400 it gets back.
    mockRequireRole.mockRejectedValue(new AuthError('Unauthorized', 401));

    const result = await requireAdminJson(jsonReq('not json at all'), Schema);

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('expected failure');
    expect(result.response.status).toBe(401);
    expect(await result.response.json()).toEqual({ error: 'Unauthorized' });
  });

  it('returns 400 invalid_body (no-store) for an unreadable body', async () => {
    const result = await requireAdminJson(jsonReq('{ not json'), Schema);

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('expected failure');
    expect(result.response.status).toBe(400);
    expect(await result.response.json()).toEqual({ error: 'invalid_body' });
    expect(result.response.headers.get('Cache-Control')).toBe('no-store, private');
  });

  it("returns 400 with the schema's FIRST issue message (no-store)", async () => {
    const result = await requireAdminJson(jsonReq({ note: '' }), Schema);

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('expected failure');
    expect(result.response.status).toBe(400);
    const body = (await result.response.json()) as { error: string };
    expect(body.error).not.toBe('invalid_request');
    expect(body.error.length).toBeGreaterThan(0);
    expect(result.response.headers.get('Cache-Control')).toBe('no-store, private');
  });

  it('keeps strictObject strict — an unknown field is a 400, not a silent drop', async () => {
    // The breaker-reset and halt routes both rely on this: a body naming
    // `actorUserId` or `reason` must be REJECTED, never overridden, so a caller
    // cannot believe it chose the actor or the halt reason.
    const result = await requireAdminJson(jsonReq({ note: 'ok', actorUserId: 'x' }), Schema);

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('expected failure');
    expect(result.response.status).toBe(400);
  });

  it("falls back to 'invalid_request' when an issue carries no message", async () => {
    const messageless = {
      safeParse: () => ({ success: false as const, error: { issues: [{}] } }),
    } as unknown as z.ZodType<{ note: string }>;

    const result = await requireAdminJson(jsonReq({ note: 'ok' }), messageless);

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('expected failure');
    expect(await result.response.json()).toEqual({ error: 'invalid_request' });
  });
});
