// src/lib/auth/__tests__/admin-mfa-gate.test.ts
//
// Contract for requireAdminWithAal2 — the shared admin control-plane preamble.
// Since #1183 it COMPOSES the **Admin transport** seam (resolveAdminApiIdentity)
// with loadAppUser, then decides: role, then a STRICT aal2 test. The permanent
// impersonation routes retain withSameOrigin separately at their exports.
//
// This file pins the gate's COMPOSITION and requireAdminJson, with the seam mocked
// away. The bearer-only policy and cookie exception — the full refusal table,
// the no-fallback rule — lives in ./admin-transport-seam.test.ts, which drives the
// REAL seam through mocked Supabase SDKs. Neither file is sufficient alone: this
// one would pass a seam that resolves nothing correctly, and that one would pass a
// gate that ignored requireAdminJson.

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NextRequest } from 'next/server';

const { mockResolveIdentity, mockLoadAppUser } = vi.hoisted(() => ({
  mockResolveIdentity: vi.fn(),
  mockLoadAppUser: vi.fn(),
}));

vi.mock('@/lib/db/auth', () => ({
  loadAppUser: mockLoadAppUser,
}));

vi.mock('@/lib/auth/verified-identity', () => ({
  resolveAdminApiIdentity: mockResolveIdentity,
}));

process.env.NEXT_PUBLIC_SUPABASE_URL = 'https://supabase.example.com';
process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = 'anon-key';

import { z } from 'zod';
import { requireAdminJson, requireAdminWithAal2 } from '../admin-mfa-gate';

const ADMIN = { id: 'admin-1', name: 'Root', email: 'a@x.com', role: 'admin', accountId: null, locationId: null };
const IDENTITY = { authUserId: 'auth-1', aal: 'aal2', transport: 'bearer' as const };

function req(): NextRequest {
  return new NextRequest('https://app.example.com/api/admin/x', { method: 'POST' });
}

beforeEach(() => {
  vi.clearAllMocks();
  mockResolveIdentity.mockResolvedValue(IDENTITY);
  mockLoadAppUser.mockResolvedValue(ADMIN);
});

describe('requireAdminWithAal2', () => {
  it('returns { ok: true, admin } when admin role and AAL2 both pass', async () => {
    const result = await requireAdminWithAal2(req());

    expect(result).toEqual({ ok: true, admin: ADMIN });
    // The gate hands the request to the seam and the seam's authUserId to the
    // mapper. It never reads a cookie or a header itself — one owner for the
    // transport decision, which is what keeps `src/proxy.ts` (#1185) in step.
    expect(mockResolveIdentity).toHaveBeenCalledWith(expect.anything());
    expect(mockLoadAppUser).toHaveBeenCalledWith('auth-1');
  });

  it('maps a verified non-admin to 403 Forbidden (no-store)', async () => {
    mockLoadAppUser.mockResolvedValue({ ...ADMIN, role: 'owner' });

    const result = await requireAdminWithAal2(req());

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('expected failure');
    expect(result.response.status).toBe(403);
    expect(await result.response.json()).toEqual({ error: 'Forbidden' });
    expect(result.response.headers.get('Cache-Control')).toBe('no-store, private');
  });

  it('maps an unresolved identity to 401 Unauthorized (no-store)', async () => {
    mockResolveIdentity.mockResolvedValue(null);

    const result = await requireAdminWithAal2(req());

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('expected failure');
    expect(result.response.status).toBe(401);
    expect(await result.response.json()).toEqual({ error: 'Unauthorized' });
    expect(result.response.headers.get('Cache-Control')).toBe('no-store, private');
    // Auth outranks the lookup: a refused credential never reaches the database.
    expect(mockLoadAppUser).not.toHaveBeenCalled();
  });

  it('returns 403 with the AAL2 reason when step-up is missing', async () => {
    mockResolveIdentity.mockResolvedValue({ ...IDENTITY, aal: 'aal1' });

    const result = await requireAdminWithAal2(req());

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('expected failure');
    expect(result.response.status).toBe(403);
    expect(await result.response.json()).toEqual({ error: 'mfa_required' });
  });

  it('returns 403 mfa_check_failed when the seam could not read an AAL', async () => {
    // A different answer from mfa_required, and the Admin app acts on the
    // difference: mfa_required means "run your challenge", mfa_check_failed means
    // the assurance level was unreadable. Collapsing them strands the client.
    mockResolveIdentity.mockResolvedValue({ ...IDENTITY, aal: null });

    const result = await requireAdminWithAal2(req());

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('expected failure');
    expect(result.response.status).toBe(403);
    expect(await result.response.json()).toEqual({ error: 'mfa_check_failed' });
  });

  it('returns a clean 500 internal_error on an unexpected (non-auth) failure', async () => {
    mockResolveIdentity.mockRejectedValue(new Error('db down'));

    const result = await requireAdminWithAal2(req());

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('expected failure');
    expect(result.response.status).toBe(500);
    expect(await result.response.json()).toEqual({ error: 'internal_error' });
  });

  it('returns a clean 500 internal_error when the users lookup itself throws', async () => {
    // loadAppUser can throw (pool exhaustion, network) rather than returning null.
    // That must not escape the gate as a raw 500 — it gets the same internalError
    // treatment the identity step uses. A null return is a 403, not a fault.
    mockLoadAppUser.mockRejectedValue(new Error('pool exhausted'));

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
    mockResolveIdentity.mockResolvedValue({ ...IDENTITY, aal: 'aal1' });

    const result = await requireAdminJson(jsonReq({ note: 'ok' }), Schema);

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('expected failure');
    expect(result.response.status).toBe(403);
    expect(await result.response.json()).toEqual({ error: 'mfa_required' });
  });

  it('never reads the body when the gate refuses — auth outranks parsing', async () => {
    // Order is load-bearing. Parsing first would let an unauthenticated caller
    // learn which bodies a schema accepts by reading the 400 it gets back.
    mockResolveIdentity.mockResolvedValue(null);

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
