import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';

const BUSINESS_ID = '11111111-1111-4111-8111-111111111111';
const ACCOUNT_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';

const {
  mockRequireRole,
  mockDeleteAccount,
  mockSql,
  mockTx,
  mockBegin,
  mockAccountRows,
  sqlCalls,
  txCalls,
} = vi.hoisted(() => {
  const sqlCalls: Array<{ raw: string; values: unknown[] }> = [];
  const txCalls: Array<{ raw: string; values: unknown[] }> = [];
  const mockAccountRows: {
    value: Array<{
      subscription_status: string;
      past_due_at: string | null;
      flags: Record<string, unknown>;
    }>;
  } = {
    value: [
      {
        subscription_status: 'active',
        past_due_at: null,
        flags: {},
      },
    ],
  };
  const mockTx = vi.fn((strings: TemplateStringsArray, ...values: unknown[]) => {
    txCalls.push({ raw: strings.join('?'), values });
    return Promise.resolve({ count: 1 });
  });
  const mockBegin = vi.fn(async (callback: (tx: typeof mockTx) => Promise<void>) => {
    await callback(mockTx);
  });
  const mockSql = vi.fn((strings: TemplateStringsArray, ...values: unknown[]) => {
    const raw = strings.join('?');
    sqlCalls.push({ raw, values });
    if (/JOIN accounts/.test(raw)) {
      return Promise.resolve(mockAccountRows.value);
    }
    if (/FROM zernio_connections/.test(raw)) {
      return Promise.resolve([{ zernio_account_id: 'zernio-account-1' }]);
    }
    return Promise.resolve([]);
  });

  return {
    mockRequireRole: vi.fn(),
    mockDeleteAccount: vi.fn(async (_accountId: unknown) => undefined),
    mockSql,
    mockTx,
    mockBegin,
    mockAccountRows,
    sqlCalls,
    txCalls,
  };
});

vi.mock('@sentry/nextjs', () => ({
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
  sql: Object.assign(mockSql, { begin: mockBegin }),
}));

vi.mock('@/lib/zernio/client', () => ({
  zernioClient: {
    deleteAccount: (accountId: unknown) => mockDeleteAccount(accountId),
  },
}));

process.env.ZERNIO_PUBLISHING_ENABLED = 'true';

import { POST } from '../route';

function makeRequest(): NextRequest {
  return new NextRequest('http://localhost:3000/api/zernio/disconnect', {
    method: 'POST',
  });
}

describe('POST /api/zernio/disconnect', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    sqlCalls.length = 0;
    txCalls.length = 0;
    mockAccountRows.value = [
      {
        subscription_status: 'active',
        past_due_at: null,
        flags: {},
      },
    ];
    mockRequireRole.mockResolvedValue({
      id: 'user-1',
      role: 'owner',
      accountId: ACCOUNT_ID,
      locationId: BUSINESS_ID,
    });
  });

  it('rejects read-only past-due owner disconnect before mutating connection state', async () => {
    mockAccountRows.value = [
      {
        subscription_status: 'past_due',
        past_due_at: '2024-01-01T00:00:00.000Z',
        flags: {},
      },
    ];

    const res = await POST(makeRequest());

    expect(res.status).toBe(402);
    expect(await res.json()).toEqual({ error: 'past_due_read_only' });
    expect(sqlCalls.some((call) => /FROM zernio_connections/.test(call.raw))).toBe(false);
    expect(mockBegin).not.toHaveBeenCalled();
    expect(mockTx).not.toHaveBeenCalled();
    expect(mockDeleteAccount).not.toHaveBeenCalled();
  });
});
