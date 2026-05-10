import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';

const PRIMARY_LOCATION_ID = '11111111-1111-4111-8111-111111111111';
const SECONDARY_LOCATION_ID = '22222222-2222-4222-8222-222222222222';
const ACCOUNT_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';

const {
  mockRequireRole,
  mockRedis,
  mockDeleteProfile,
  sqlCalls,
} = vi.hoisted(() => {
  const sqlCalls: Array<{ raw: string; values: unknown[] }> = [];
  const mockRedis = {
    get: vi.fn(async (key: string) => {
      if (key === `connect_pending:${SECONDARY_LOCATION_ID}`) {
        return JSON.stringify({
          flowId: 'flow-1',
          userId: 'user-1',
          status: 'oauth_in_progress',
          profileId: 'profile-secondary',
          state: 'state-secondary',
        });
      }
      return null;
    }),
    eval: vi.fn(async () => 1),
    del: vi.fn(async () => 1),
  };

  return {
    mockRequireRole: vi.fn(),
    mockRedis,
    mockDeleteProfile: vi.fn(async (_profileId: unknown) => undefined),
    sqlCalls,
  };
});

vi.mock('@sentry/nextjs', () => ({
  captureMessage: vi.fn(),
  captureException: vi.fn(),
}));

vi.mock('@/lib/shared/csrf', () => ({
  assertSameOrigin: vi.fn(),
  SameOriginError: class SameOriginError extends Error {},
}));

vi.mock('@/lib/db/auth', () => {
  class AuthError extends Error {
    constructor(
      message: string,
      public readonly statusCode: number,
    ) {
      super(message);
      this.name = 'AuthError';
    }
  }
  return {
    requireRole: (...args: unknown[]) => mockRequireRole(...args),
    AuthError,
  };
});

vi.mock('@/lib/db/server', () => ({
  sql: vi.fn((strings: TemplateStringsArray, ...values: unknown[]) => {
    const raw = strings.join('?');
    sqlCalls.push({ raw, values });
    if (/FROM businesses/.test(raw) && /account_id/.test(raw)) {
      return Promise.resolve([{ exists: 1 }]);
    }
    return Promise.resolve([]);
  }),
}));

vi.mock('@/lib/db/redis-cache', () => ({
  getCacheRedis: () => mockRedis,
}));

vi.mock('@/lib/zernio/connect-session-cookie', () => ({
  readConnectSessionCookie: () => null,
  clearConnectSessionCookie: vi.fn(),
}));

vi.mock('@/lib/zernio/client', () => ({
  zernioClient: {
    deleteProfile: (profileId: unknown) => mockDeleteProfile(profileId),
  },
}));

process.env.ZERNIO_PUBLISHING_ENABLED = 'true';

import { POST } from '../route';

function makeRequest(): NextRequest {
  return new NextRequest('http://localhost:3000/api/zernio/connect/cancel', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ locationId: SECONDARY_LOCATION_ID }),
  });
}

describe('POST /api/zernio/connect/cancel location targeting', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    sqlCalls.length = 0;
    mockRequireRole.mockResolvedValue({
      id: 'user-1',
      role: 'owner',
      accountId: ACCOUNT_ID,
      locationId: PRIMARY_LOCATION_ID,
    });
  });

  it('cancels the requested secondary location pending flow', async () => {
    const res = await POST(makeRequest());

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      cancelled: true,
      reason: 'flow_cancelled',
    });
    expect(mockRedis.get).toHaveBeenCalledWith(`connect_pending:${SECONDARY_LOCATION_ID}`);
    expect(sqlCalls[0]?.values).toContain(SECONDARY_LOCATION_ID);
    expect(sqlCalls[0]?.values).toContain(ACCOUNT_ID);
    expect(mockDeleteProfile).toHaveBeenCalledWith('profile-secondary');
  });
});
