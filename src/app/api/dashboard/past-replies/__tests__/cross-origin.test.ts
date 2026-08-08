// Consolidated cross-origin regression guard for all Past Replies routes.
//
// Each route's individual test file already covers its own cross-origin case.
// This file is the single audit point that confirms ALL 6 mutating routes
// reject wrong-Origin requests with 403, AND that the GET /draft-status route
// is exempt (CSRF doesn't apply to GETs per spec §4.4 cross-cutting bullets).
//
// If a future change accidentally drops `assertSameOrigin` from one of the
// mutating routes, this file fails fast even if the per-route tests don't
// trip — making the omission visible at single-file PR review time.

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NextRequest } from 'next/server';

// Mock auth — every route under test calls requireRole (via resolveOwnerScope).
// Returning a valid owner makes the test reach the assertSameOrigin check. In
// EVERY route the flag (503) check runs first, then assertSameOrigin runs
// BEFORE auth, so a wrong Origin trips the 403 regardless of auth/scope state.
const { requireRoleMock } = vi.hoisted(() => ({
  requireRoleMock: vi.fn(async () => ({
    id: 'user-1',
    name: 'Test',
    email: 'owner@example.com',
    role: 'owner',
    accountId: 'acct-1',
  })),
}));

vi.mock('@/lib/db/auth', () => ({
  requireRole: requireRoleMock,
  AuthError: class AuthError extends Error {
    constructor(message: string, public readonly statusCode: number) {
      super(message);
      this.name = 'AuthError';
    }
  },
}));

// resolveOwnerScope delegates to getRequestScope, which otherwise opens a real
// DB connection. Mock it so the GET /draft-status exemption case can reach its
// own (non-403) response without hitting Postgres. The mutating routes never
// reach this point — assertSameOrigin 403s them first.
vi.mock('@/lib/auth/get-request-scope', () => ({
  getRequestScope: vi.fn(async () => ({
    accountId: 'acct-1',
    currentLocationId: 'loc-1',
  })),
}));

// resolveOwnerScope now reads accounts.subscription_status. Mock sql so that
// lookup returns an ACTIVE account (otherwise the GET exemption case would 403
// on subscription_inactive). All other top-level queries resolve to [].
vi.mock('@/lib/db/server', () => ({
  sql: vi.fn(async (strings?: TemplateStringsArray) => {
    const text = Array.isArray(strings) ? strings.join('') : String(strings ?? '');
    if (text.includes('subscription_status')) {
      return [{ subscription_status: 'active' }];
    }
    return [];
  }),
  jsonb: (v: unknown) => v,
}));

beforeEach(() => {
  process.env.EDIT_REPLIES_ENABLED = 'true';
  process.env.NEXT_PUBLIC_APP_URL = 'http://localhost:3000';
  requireRoleMock.mockClear();
});

function reqWithOrigin(method: 'POST' | 'PATCH' | 'DELETE' | 'GET', url: string, origin: string) {
  return new NextRequest(`http://localhost:3000${url}`, {
    method,
    headers: { Origin: origin, 'Content-Type': 'application/json' },
    body: method === 'GET' || method === 'DELETE' ? undefined : JSON.stringify({}),
  });
}

const WRONG_ORIGIN = 'https://evil.example.com';

describe('Past Replies routes — cross-origin enforcement (consolidated regression)', () => {
  it('POST /draft returns 403 on wrong Origin', async () => {
    const { POST } = await import('../draft/route');
    const res = await POST(reqWithOrigin('POST', '/api/dashboard/past-replies/draft', WRONG_ORIGIN));
    expect(res.status).toBe(403);
  });

  it('PATCH /draft/:id returns 403 on wrong Origin', async () => {
    const mod = await import('../draft/[responseId]/route');
    const res = await mod.PATCH(
      reqWithOrigin('PATCH', '/api/dashboard/past-replies/draft/00000000-0000-7000-8000-000000000001', WRONG_ORIGIN),
      { params: Promise.resolve({ responseId: '00000000-0000-7000-8000-000000000001' }) },
    );
    expect(res.status).toBe(403);
  });

  it('DELETE /draft/:id returns 403 on wrong Origin', async () => {
    const mod = await import('../draft/[responseId]/route');
    const res = await mod.DELETE(
      reqWithOrigin('DELETE', '/api/dashboard/past-replies/draft/00000000-0000-7000-8000-000000000001', WRONG_ORIGIN),
      { params: Promise.resolve({ responseId: '00000000-0000-7000-8000-000000000001' }) },
    );
    expect(res.status).toBe(403);
  });

  it('POST /publish returns 403 on wrong Origin', async () => {
    const { POST } = await import('../publish/route');
    const res = await POST(reqWithOrigin('POST', '/api/dashboard/past-replies/publish', WRONG_ORIGIN));
    expect(res.status).toBe(403);
  });

  it('POST /:id/retry returns 403 on wrong Origin', async () => {
    const mod = await import('../[responseId]/retry/route');
    const res = await mod.POST(
      reqWithOrigin('POST', '/api/dashboard/past-replies/00000000-0000-7000-8000-000000000001/retry', WRONG_ORIGIN),
      { params: Promise.resolve({ responseId: '00000000-0000-7000-8000-000000000001' }) },
    );
    expect(res.status).toBe(403);
  });

  it('POST /:id/restore-original returns 403 on wrong Origin', async () => {
    const mod = await import('../[responseId]/restore-original/route');
    const res = await mod.POST(
      reqWithOrigin('POST', '/api/dashboard/past-replies/00000000-0000-7000-8000-000000000001/restore-original', WRONG_ORIGIN),
      { params: Promise.resolve({ responseId: '00000000-0000-7000-8000-000000000001' }) },
    );
    expect(res.status).toBe(403);
  });

  it('GET /draft-status is EXEMPT from cross-origin check (CSRF does not apply to GETs)', async () => {
    const { GET } = await import('../draft-status/route');
    // Use a valid same-origin URL but wrong Origin header — should NOT 403.
    // Returns 400 (missing outbox_id) because no query string is set, but the
    // critical assertion is that it is NOT 403.
    const res = await GET(reqWithOrigin('GET', '/api/dashboard/past-replies/draft-status', WRONG_ORIGIN));
    expect(res.status).not.toBe(403);
  });
});
