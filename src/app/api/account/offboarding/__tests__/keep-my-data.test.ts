import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';

const {
  mockRequireOwnerWithAccount,
  mockRequireWritableOwner,
  mockKeepMyDataForAccount,
  mockKeepMyDataWithToken,
} = vi.hoisted(() => ({
  mockRequireOwnerWithAccount: vi.fn(),
  mockRequireWritableOwner: vi.fn(),
  mockKeepMyDataForAccount: vi.fn(),
  mockKeepMyDataWithToken: vi.fn(),
}));

vi.mock('@/lib/auth/route-helpers', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/auth/route-helpers')>();
  return {
    ...actual,
    requireOwnerWithAccount: mockRequireOwnerWithAccount,
    requireWritableOwner: mockRequireWritableOwner,
  };
});

vi.mock('@/lib/account-offboarding/keep-my-data', () => ({
  keepMyDataForAccount: mockKeepMyDataForAccount,
  keepMyDataWithToken: mockKeepMyDataWithToken,
}));

const ACCOUNT_ID = 'aaaaaaaa-bbbb-7ccc-8ddd-eeeeeeeeeeee';
const USER_ID = '11111111-2222-7333-8444-555555555555';
const OFFBOARDING_ID = '22222222-2222-7333-8444-555555555555';
const APP_URL = 'http://localhost:3000';
const RAW_TOKEN = 'raw-keep-my-data-token';

function ownerUser() {
  return {
    id: USER_ID,
    name: 'Owner',
    email: 'owner@example.com',
    role: 'owner',
    accountId: ACCOUNT_ID,
    locationId: '99999999-8888-7777-8666-555555555555',
  };
}

function successResult(status: 'purge_scheduled' | 'churned' = 'purge_scheduled') {
  return {
    ok: true,
    status: 'kept',
    offboarding: {
      id: OFFBOARDING_ID,
      accountId: ACCOUNT_ID,
      mode: 'delete_data',
      status,
    },
  };
}

function makeEmptyPost(headers: Record<string, string> = {}): NextRequest {
  return new NextRequest(`${APP_URL}/api/account/offboarding/keep-my-data`, {
    method: 'POST',
    headers: {
      Origin: APP_URL,
      'Idempotency-Key': 'keep-data-key-1',
      ...headers,
    },
  });
}

function makeJsonPost(
  body: unknown,
  headers: Record<string, string> = {},
): NextRequest {
  return new NextRequest(`${APP_URL}/api/account/offboarding/keep-my-data`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      Origin: APP_URL,
      ...headers,
    },
    body: JSON.stringify(body),
  });
}

function makeFormPost(
  body: Record<string, string>,
  headers: Record<string, string> = {},
): NextRequest {
  return new NextRequest(`${APP_URL}/api/account/offboarding/keep-my-data`, {
    method: 'POST',
    headers: {
      'content-type': 'application/x-www-form-urlencoded',
      Origin: APP_URL,
      ...headers,
    },
    body: new URLSearchParams(body),
  });
}

function makeGet(token: string): NextRequest {
  return new NextRequest(
    `${APP_URL}/api/account/offboarding/keep-my-data?token=${encodeURIComponent(token)}`,
    { method: 'GET' },
  );
}

async function importRoute() {
  vi.resetModules();
  return import('../keep-my-data/route');
}

describe('POST /api/account/offboarding/keep-my-data', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.unstubAllEnvs();
    vi.stubEnv('NEXT_PUBLIC_APP_URL', APP_URL);
    vi.stubEnv('ACCOUNT_OFFBOARDING_ENABLED', 'true');
    mockRequireOwnerWithAccount.mockResolvedValue({
      ok: true,
      user: ownerUser(),
      accountId: ACCOUNT_ID,
    });
    mockKeepMyDataForAccount.mockResolvedValue(successResult());
    mockKeepMyDataWithToken.mockResolvedValue(successResult());
  });

  it('returns 404 and does not auth or mutate when the feature flag is off', async () => {
    vi.stubEnv('ACCOUNT_OFFBOARDING_ENABLED', 'false');
    const route = await importRoute();

    const res = await route.POST(makeEmptyPost());

    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: 'account_offboarding_disabled' });
    expect(mockRequireOwnerWithAccount).not.toHaveBeenCalled();
    expect(mockRequireWritableOwner).not.toHaveBeenCalled();
    expect(mockKeepMyDataForAccount).not.toHaveBeenCalled();
    expect(mockKeepMyDataWithToken).not.toHaveBeenCalled();
  });

  it('uses the read-only owner guard for the authenticated keep-my-data path', async () => {
    const route = await importRoute();

    const res = await route.POST(makeEmptyPost({
      'Idempotency-Key': ' keep-key-1 ',
      'x-request-id': 'req-keep-1',
      'x-forwarded-for': '203.0.113.30, 10.0.0.1',
      'user-agent': 'vitest',
    }));

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      ok: true,
      offboarding: {
        id: OFFBOARDING_ID,
        mode: 'delete_data',
        status: 'purge_scheduled',
      },
    });
    expect(mockRequireOwnerWithAccount).toHaveBeenCalledOnce();
    expect(mockRequireWritableOwner).not.toHaveBeenCalled();
    expect(mockKeepMyDataWithToken).not.toHaveBeenCalled();
    expect(mockKeepMyDataForAccount).toHaveBeenCalledWith(expect.anything(), {
      accountId: ACCOUNT_ID,
      actorUserId: USER_ID,
      idempotencyKey: 'keep-key-1',
      requestId: 'req-keep-1',
      ip: '203.0.113.30',
      userAgent: 'vitest',
    });
  });

  it('requires an idempotency key on the authenticated path', async () => {
    const route = await importRoute();

    const res = await route.POST(makeEmptyPost({ 'Idempotency-Key': '' }));

    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: 'missing_idempotency_key' });
    expect(mockRequireOwnerWithAccount).toHaveBeenCalledOnce();
    expect(mockKeepMyDataForAccount).not.toHaveBeenCalled();
    expect(mockKeepMyDataWithToken).not.toHaveBeenCalled();
  });

  it('accepts a raw keep-my-data token from JSON without requiring owner auth', async () => {
    const route = await importRoute();

    const res = await route.POST(makeJsonPost(
      { token: RAW_TOKEN },
      {
        'x-request-id': 'req-token-1',
        'x-forwarded-for': '203.0.113.31, 10.0.0.1',
        'user-agent': 'vitest-token',
      },
    ));

    expect(res.status).toBe(200);
    expect(mockRequireOwnerWithAccount).not.toHaveBeenCalled();
    expect(mockRequireWritableOwner).not.toHaveBeenCalled();
    expect(mockKeepMyDataForAccount).not.toHaveBeenCalled();
    expect(mockKeepMyDataWithToken).toHaveBeenCalledWith(expect.anything(), {
      rawToken: RAW_TOKEN,
      requestId: 'req-token-1',
      ip: '203.0.113.31',
      userAgent: 'vitest-token',
    });
  });

  it('accepts a raw keep-my-data token from the same-origin email form', async () => {
    const route = await importRoute();

    const res = await route.POST(makeFormPost(
      { token: RAW_TOKEN },
      { 'x-request-id': 'req-token-form-1' },
    ));

    expect(res.status).toBe(200);
    expect(mockRequireOwnerWithAccount).not.toHaveBeenCalled();
    expect(mockKeepMyDataForAccount).not.toHaveBeenCalled();
    expect(mockKeepMyDataWithToken).toHaveBeenCalledWith(expect.anything(), {
      rawToken: RAW_TOKEN,
      requestId: 'req-token-form-1',
      ip: null,
      userAgent: null,
    });
  });

  it('rejects cross-origin token posts before auth or service work', async () => {
    const route = await importRoute();

    const res = await route.POST(makeJsonPost(
      { token: RAW_TOKEN },
      { Origin: 'https://evil.example.com' },
    ));

    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: 'forbidden' });
    expect(mockRequireOwnerWithAccount).not.toHaveBeenCalled();
    expect(mockKeepMyDataForAccount).not.toHaveBeenCalled();
    expect(mockKeepMyDataWithToken).not.toHaveBeenCalled();
  });

  it.each([
    ['token body with an extra field', { token: RAW_TOKEN, extra: true }],
    ['authenticated body with unexpected data', { keep: true }],
  ])('rejects a strict %s before auth or mutation', async (_label, body) => {
    const route = await importRoute();

    const res = await route.POST(makeJsonPost(body));

    expect(res.status).toBe(400);
    const json = await res.json();
    expect(json.error).toBe('invalid_body');
    expect(mockRequireOwnerWithAccount).not.toHaveBeenCalled();
    expect(mockKeepMyDataForAccount).not.toHaveBeenCalled();
    expect(mockKeepMyDataWithToken).not.toHaveBeenCalled();
  });

  it('maps unavailable and token lifecycle failures without leaking implementation details', async () => {
    const route = await importRoute();
    mockKeepMyDataForAccount.mockResolvedValueOnce({ ok: false, reason: 'not_available' });
    mockKeepMyDataWithToken.mockResolvedValueOnce({ ok: false, reason: 'token_expired' });

    const unavailable = await route.POST(makeEmptyPost());
    const expired = await route.POST(makeJsonPost({ token: RAW_TOKEN }));

    expect(unavailable.status).toBe(409);
    expect(await unavailable.json()).toEqual({ error: 'not_available' });
    expect(expired.status).toBe(410);
    expect(await expired.json()).toEqual({ error: 'token_expired' });
  });
});

describe('GET /api/account/offboarding/keep-my-data', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.unstubAllEnvs();
    vi.stubEnv('NEXT_PUBLIC_APP_URL', APP_URL);
    vi.stubEnv('ACCOUNT_OFFBOARDING_ENABLED', 'true');
  });

  it('renders a read-only same-origin confirmation form without consuming the token', async () => {
    const route = await importRoute();

    const res = await route.GET(makeGet('raw<&>token'));

    expect(res.status).toBe(200);
    expect(res.headers.get('cache-control')).toContain('no-store');
    const html = await res.text();
    expect(html).toContain('Keep RepWorth data?');
    expect(html).toContain('method="post"');
    expect(html).toContain('action="/api/account/offboarding/keep-my-data"');
    expect(html).toContain('value="raw&lt;&amp;&gt;token"');
    expect(mockRequireOwnerWithAccount).not.toHaveBeenCalled();
    expect(mockKeepMyDataForAccount).not.toHaveBeenCalled();
    expect(mockKeepMyDataWithToken).not.toHaveBeenCalled();
  });
});
