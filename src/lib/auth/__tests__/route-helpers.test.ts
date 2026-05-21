// src/lib/auth/__tests__/route-helpers.test.ts
//
// TDD assertions for composable route wrappers: withRateLimit, withSameOrigin,
// withSession. Mocks are hoisted so module-under-test can be imported cleanly.

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NextRequest } from 'next/server';

// ── Hoisted mock state ───────────────────────────────────────────────────────

const { mockCheckRateLimit } = vi.hoisted(() => ({
  mockCheckRateLimit: vi.fn(),
}));

const { mockGetUser } = vi.hoisted(() => ({
  mockGetUser: vi.fn(),
}));

// ── Module mocks (hoisted before imports) ────────────────────────────────────

vi.mock('@/lib/shared/rate-limit', () => ({
  checkRateLimit: mockCheckRateLimit,
}));

vi.mock('@supabase/ssr', () => ({
  createServerClient: vi.fn(() => ({
    auth: { getUser: mockGetUser },
  })),
}));

// ── Import AFTER mocks ───────────────────────────────────────────────────────

import { withRateLimit, withSameOrigin, withSession } from '../route-helpers';

// ── Helpers ──────────────────────────────────────────────────────────────────

const APP_URL = 'https://app.example.com';

function makeReq(
  url = 'https://app.example.com/api/auth/signup',
  opts: { origin?: string; method?: string; secFetchSite?: string } = {},
): NextRequest {
  const headers: Record<string, string> = {};
  if (opts.origin !== undefined) headers['origin'] = opts.origin;
  if (opts.secFetchSite !== undefined) headers['sec-fetch-site'] = opts.secFetchSite;
  return new NextRequest(url, {
    method: opts.method ?? 'POST',
    headers,
  });
}

const okHandler = vi.fn().mockResolvedValue(new Response(null, { status: 200 }));

// ── withRateLimit ─────────────────────────────────────────────────────────────

describe('withRateLimit', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    process.env.REDIS_CACHE_URL = 'redis://localhost:6379/0';
    okHandler.mockResolvedValue(new Response(null, { status: 200 }));
  });

  it('calls handler when rate limit is not exceeded', async () => {
    mockCheckRateLimit.mockResolvedValue({ allowed: true, remaining: 4 });

    const wrapped = withRateLimit((_req) => 'rl:test', 5, 60)(okHandler);
    const res = await wrapped(makeReq());

    expect(res.status).toBe(200);
    expect(okHandler).toHaveBeenCalledOnce();
    expect(mockCheckRateLimit).toHaveBeenCalledWith('rl:test', 5, 60, { strict: true });
  });

  it('returns 429 when rate limit is exceeded', async () => {
    mockCheckRateLimit.mockResolvedValue({ allowed: false, remaining: 0 });

    const wrapped = withRateLimit((_req) => 'rl:test', 5, 60)(okHandler);
    const res = await wrapped(makeReq());

    expect(res.status).toBe(429);
    const body = await res.json();
    expect(body).toEqual({ error: 'rate_limited' });
    expect(okHandler).not.toHaveBeenCalled();
  });

  it('returns 503 when checkRateLimit throws (strict Redis failure)', async () => {
    mockCheckRateLimit.mockRejectedValue(new Error('ECONNREFUSED'));

    const wrapped = withRateLimit((_req) => 'rl:test', 5, 60)(okHandler);
    const res = await wrapped(makeReq());

    expect(res.status).toBe(503);
    const body = await res.json();
    expect(body).toEqual({ error: 'rate_limit_unavailable' });
    expect(okHandler).not.toHaveBeenCalled();
  });

  it('passes the request to the keyFn', async () => {
    mockCheckRateLimit.mockResolvedValue({ allowed: true, remaining: 9 });

    const keyFn = vi.fn((_req: NextRequest) => 'computed:key');
    const wrapped = withRateLimit(keyFn, 10, 30)(okHandler);
    const req = makeReq();
    await wrapped(req);

    expect(keyFn).toHaveBeenCalledWith(req);
    expect(mockCheckRateLimit).toHaveBeenCalledWith('computed:key', 10, 30, { strict: true });
  });
});

// ── withSameOrigin ────────────────────────────────────────────────────────────

describe('withSameOrigin', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    process.env.NEXT_PUBLIC_APP_URL = APP_URL;
    okHandler.mockResolvedValue(new Response(null, { status: 200 }));
  });

  it('calls handler when Origin matches APP_URL', async () => {
    const wrapped = withSameOrigin()(okHandler);
    const res = await wrapped(makeReq(undefined, { origin: APP_URL }));

    expect(res.status).toBe(200);
    expect(okHandler).toHaveBeenCalledOnce();
  });

  it('calls handler when Sec-Fetch-Site is same-origin and Origin matches APP_URL', async () => {
    const wrapped = withSameOrigin()(okHandler);
    const res = await wrapped(makeReq(undefined, {
      origin: APP_URL,
      secFetchSite: 'same-origin',
    }));

    expect(res.status).toBe(200);
    expect(okHandler).toHaveBeenCalledOnce();
  });

  it('returns 403 when Sec-Fetch-Site is cross-site', async () => {
    const wrapped = withSameOrigin()(okHandler);
    const res = await wrapped(makeReq(undefined, {
      origin: APP_URL,
      secFetchSite: 'cross-site',
    }));

    expect(res.status).toBe(403);
    expect(okHandler).not.toHaveBeenCalled();
  });

  it('returns 403 when Origin does not match', async () => {
    const wrapped = withSameOrigin()(okHandler);
    const res = await wrapped(makeReq(undefined, { origin: 'https://evil.example.com' }));

    expect(res.status).toBe(403);
    const body = await res.json();
    expect(body).toEqual({ error: 'forbidden' });
    expect(okHandler).not.toHaveBeenCalled();
  });

  it('returns 403 when Origin header is absent', async () => {
    const wrapped = withSameOrigin()(okHandler);
    // No origin header — missing Origin means SameOriginError
    const res = await wrapped(makeReq(undefined, {}));

    expect(res.status).toBe(403);
    expect(okHandler).not.toHaveBeenCalled();
  });

  it('returns 403 when NEXT_PUBLIC_APP_URL is unset', async () => {
    delete process.env.NEXT_PUBLIC_APP_URL;

    const wrapped = withSameOrigin()(okHandler);
    const res = await wrapped(makeReq(undefined, { origin: APP_URL }));

    expect(res.status).toBe(403);
    expect(okHandler).not.toHaveBeenCalled();
  });

  it('accepts trailing-slash variant of APP_URL', async () => {
    const wrapped = withSameOrigin()(okHandler);
    const res = await wrapped(makeReq(undefined, { origin: `${APP_URL}/` }));

    expect(res.status).toBe(200);
  });
});

// ── withSession ───────────────────────────────────────────────────────────────

describe('withSession', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    process.env.NEXT_PUBLIC_SUPABASE_URL = 'https://test.supabase.co';
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = 'anon-key-test';
  });

  it('returns 401 when no session', async () => {
    mockGetUser.mockResolvedValue({ data: { user: null }, error: null });

    const sessionHandler = vi.fn().mockResolvedValue(new Response(null, { status: 200 }));
    const wrapped = withSession(sessionHandler);
    const res = await wrapped(makeReq());

    expect(res.status).toBe(401);
    const body = await res.json();
    expect(body).toEqual({ error: 'unauthorized' });
    expect(sessionHandler).not.toHaveBeenCalled();
  });

  it('calls handler with { user } when session present', async () => {
    const fakeUser = { id: 'user-abc', email: 'owner@example.com' };
    mockGetUser.mockResolvedValue({ data: { user: fakeUser }, error: null });

    const sessionHandler = vi.fn().mockResolvedValue(new Response(null, { status: 200 }));
    const wrapped = withSession(sessionHandler);
    const req = makeReq();
    const res = await wrapped(req);

    expect(res.status).toBe(200);
    expect(sessionHandler).toHaveBeenCalledOnce();
    const [session, passedReq] = sessionHandler.mock.calls[0]!;
    expect(session).toEqual({ user: fakeUser });
    expect(passedReq).toBe(req);
  });

  it('passes cookies from the request to createServerClient', async () => {
    const { createServerClient } = await import('@supabase/ssr');
    const mockCreate = vi.mocked(createServerClient);
    mockCreate.mockClear();

    const fakeUser = { id: 'user-xyz', email: 'test@example.com' };
    mockGetUser.mockResolvedValue({ data: { user: fakeUser }, error: null });

    const req = new NextRequest('https://app.example.com/api/auth/signup', {
      method: 'POST',
      headers: { cookie: 'sb-access-token=tok123' },
    });

    const sessionHandler = vi.fn().mockResolvedValue(new Response(null, { status: 200 }));
    await withSession(sessionHandler)(req);

    expect(mockCreate).toHaveBeenCalledOnce();
    const [url, key, opts] = mockCreate.mock.calls[0]!;
    expect(url).toBe('https://test.supabase.co');
    expect(key).toBe('anon-key-test');
    // getAll() on the cookie adapter should return the request cookies
    const cookies = (opts as any).cookies.getAll();
    expect(Array.isArray(cookies)).toBe(true);
  });
});
