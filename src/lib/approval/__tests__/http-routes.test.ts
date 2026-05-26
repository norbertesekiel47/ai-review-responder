import { createHash } from 'node:crypto';
import { describe, expect, it, beforeEach, vi } from 'vitest';
import { NextRequest, NextResponse } from 'next/server';
import { ResponseNotPendingError } from '../errors';

const {
  sqlCalls,
  sqlResults,
  mockSql,
  mockRequireRole,
  mockCheckRateLimit,
  mockValidateCsrf,
  mockVerifyDeviceCookie,
  mockGetDeviceCookieHash,
  mockLockValidLink,
  mockRecoverCorrelationId,
  mockHandleApprovalError,
} = vi.hoisted(() => {
  const sqlCalls: { raw: string; values: unknown[] }[] = [];
  const sqlResults: unknown[][] = [];
  const mockSql = vi.fn((strings: TemplateStringsArray, ...values: unknown[]) => {
    sqlCalls.push({ raw: strings.raw.join(''), values });
    return Promise.resolve(sqlResults.shift() ?? []);
  }) as unknown as ReturnType<typeof vi.fn> & {
    begin: ReturnType<typeof vi.fn>;
  };
  mockSql.begin = vi.fn(async (callback: (tx: unknown) => Promise<unknown>) => callback(mockSql));

  return {
    sqlCalls,
    sqlResults,
    mockSql,
    mockRequireRole: vi.fn(),
    mockCheckRateLimit: vi.fn(),
    mockValidateCsrf: vi.fn(),
    mockVerifyDeviceCookie: vi.fn(),
    mockGetDeviceCookieHash: vi.fn(),
    mockLockValidLink: vi.fn(),
    mockRecoverCorrelationId: vi.fn(),
    mockHandleApprovalError: vi.fn(),
  };
});

vi.mock('@/lib/db/server', () => ({
  sql: mockSql,
  jsonb: (value: unknown) => value,
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

vi.mock('@/lib/shared/rate-limit', () => ({
  checkRateLimit: (...args: unknown[]) => mockCheckRateLimit(...args),
}));

vi.mock('@/lib/approval/cookies', () => ({
  validateCsrf: (...args: unknown[]) => mockValidateCsrf(...args),
  verifyDeviceCookie: (...args: unknown[]) => mockVerifyDeviceCookie(...args),
  getDeviceCookieHash: (...args: unknown[]) => mockGetDeviceCookieHash(...args),
}));

vi.mock('@/lib/approval/service', () => ({
  lockValidLink: (...args: unknown[]) => mockLockValidLink(...args),
}));

vi.mock('@/lib/approval/correlation', () => ({
  recoverCorrelationId: (...args: unknown[]) => mockRecoverCorrelationId(...args),
}));

vi.mock('@/lib/approval/http-errors', () => ({
  handleApprovalError: (...args: unknown[]) => mockHandleApprovalError(...args),
}));

import {
  requireDashboardReviewOwner,
  runDashboardReviewAction,
  runTokenApprovalAction,
} from '../http-routes';

const RAW_TOKEN = 'raw-token-123';
const TOKEN_HASH = createHash('sha256').update(RAW_TOKEN).digest('hex');
const ACTIVE_ACCOUNT_ROW = {
  subscription_status: 'active',
  past_due_at: null,
  flags: {},
};
const READ_ONLY_ACCOUNT_ROW = {
  subscription_status: 'past_due',
  past_due_at: '2020-01-01T00:00:00.000Z',
  flags: {},
};
const LINK = {
  id: 'link-1',
  response_id: 'resp-1',
  business_id: 'biz-1',
  token_hash: 'stored-token-hash',
  channel: 'email',
  expires_at: new Date(Date.now() + 60_000),
  consumed_at: null,
  revoked_at: null,
  device_cookie_hash: 'device-hash',
  created_at: new Date(),
};

function request(path = '/api/test'): NextRequest {
  return new NextRequest(`http://localhost:3000${path}`, {
    method: 'POST',
    headers: { 'x-forwarded-for': '203.0.113.10' },
  });
}

function requestWithLegacyIp(path = '/api/test'): NextRequest {
  const req = new NextRequest(`http://localhost:3000${path}`, {
    method: 'POST',
  });
  Object.defineProperty(req, 'ip', {
    value: '203.0.113.42',
    configurable: true,
  });
  return req;
}

function owner(overrides?: { accountId?: string | null; locationId?: string | null }) {
  return {
    id: 'owner-1',
    role: 'owner',
    accountId: overrides && 'accountId' in overrides ? overrides.accountId : 'a0000000-0000-0000-0000-000000000001',
    locationId: overrides && 'locationId' in overrides ? overrides.locationId : 'biz-1',
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  sqlCalls.length = 0;
  sqlResults.length = 0;
  mockCheckRateLimit.mockResolvedValue({ allowed: true });
  mockValidateCsrf.mockReturnValue(true);
  mockVerifyDeviceCookie.mockReturnValue(true);
  mockGetDeviceCookieHash.mockReturnValue('device-hash');
  mockLockValidLink.mockResolvedValue(LINK);
  mockRecoverCorrelationId.mockResolvedValue('corr-1');
  mockHandleApprovalError.mockImplementation((err: unknown) => {
    if (err instanceof Error && err.name === 'SubscriptionReadOnlyError') {
      return NextResponse.json(
        { error: err.message },
        { status: 402, headers: { 'Cache-Control': 'no-store, private' } },
      );
    }
    throw err;
  });
});

describe('runTokenApprovalAction', () => {
  it('rate-limits by hashed token before CSRF, device, transaction, or action work', async () => {
    mockCheckRateLimit.mockResolvedValueOnce({ allowed: false });
    const action = vi.fn();

    const res = await runTokenApprovalAction(
      request(),
      RAW_TOKEN,
      'approve',
      { success: true },
      action,
    );

    expect(mockCheckRateLimit).toHaveBeenCalledWith(`approve:post:${TOKEN_HASH}`, 3, 60);
    expect(res.status).toBe(429);
    expect(await res.json()).toEqual({ error: 'Rate limit exceeded' });
    expect(mockValidateCsrf).not.toHaveBeenCalled();
    expect(mockVerifyDeviceCookie).not.toHaveBeenCalled();
    expect(mockSql.begin).not.toHaveBeenCalled();
    expect(action).not.toHaveBeenCalled();
  });

  it('short-circuits prepare responses after token guards and before the transaction', async () => {
    const action = vi.fn();
    const prepareResponse = NextResponse.json(
      { error: 'invalid_body' },
      { status: 400 },
    );

    const res = await runTokenApprovalAction(
      request(),
      RAW_TOKEN,
      'edit',
      { success: true },
      action,
      { prepare: () => prepareResponse },
    );

    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: 'invalid_body' });
    expect(mockValidateCsrf).toHaveBeenCalledOnce();
    expect(mockVerifyDeviceCookie).toHaveBeenCalledOnce();
    expect(mockSql.begin).not.toHaveBeenCalled();
    expect(action).not.toHaveBeenCalled();
  });

  it('recovers token-action correlation and passes audit context to the action', async () => {
    sqlResults.push([ACTIVE_ACCOUNT_ROW]);
    sqlResults.push([{ review_id: 'rev-1' }]);
    const action = vi.fn();

    const res = await runTokenApprovalAction(
      request(),
      RAW_TOKEN,
      'approve',
      { success: true },
      action,
    );

    expect(res.status).toBe(200);
    expect(mockLockValidLink).toHaveBeenCalledWith(mockSql, RAW_TOKEN);
    expect(mockRecoverCorrelationId).toHaveBeenCalledWith(mockSql, {
      reviewId: 'rev-1',
      responseId: 'resp-1',
    });
    expect(action).toHaveBeenCalledWith(expect.objectContaining({
      tx: mockSql,
      link: LINK,
      deviceCookieHash: 'device-hash',
      audit: {
        tokenHash: 'stored-token-hash',
        deviceCookieHash: 'device-hash',
        ipAddress: '203.0.113.10',
      },
      correlationId: 'corr-1',
    }));
  });

  it('preserves legacy request.ip fallback for token-action audit context', async () => {
    sqlResults.push([ACTIVE_ACCOUNT_ROW]);
    sqlResults.push([{ review_id: 'rev-1' }]);
    const action = vi.fn();

    const res = await runTokenApprovalAction(
      requestWithLegacyIp(),
      RAW_TOKEN,
      'approve',
      { success: true },
      action,
    );

    expect(res.status).toBe(200);
    expect(action).toHaveBeenCalledWith(expect.objectContaining({
      audit: expect.objectContaining({
        ipAddress: '203.0.113.42',
      }),
    }));
  });

  it('can establish a token session without requiring a pre-existing verified device cookie', async () => {
    sqlResults.push([ACTIVE_ACCOUNT_ROW]);
    const action = vi.fn();

    const res = await runTokenApprovalAction(
      request(),
      RAW_TOKEN,
      'session',
      { success: true },
      action,
      { requireVerifiedDeviceCookie: false, recoverResponseCorrelation: false },
    );

    expect(res.status).toBe(200);
    expect(mockVerifyDeviceCookie).not.toHaveBeenCalled();
    expect(mockRecoverCorrelationId).not.toHaveBeenCalled();
    expect(action).toHaveBeenCalledWith(expect.objectContaining({
      correlationId: 'resp-1',
      audit: expect.objectContaining({
        tokenHash: 'stored-token-hash',
        deviceCookieHash: 'device-hash',
      }),
    }));
  });

  it('returns 402 before token approval work when the link account is read-only', async () => {
    sqlResults.push([READ_ONLY_ACCOUNT_ROW]);
    const action = vi.fn();

    const res = await runTokenApprovalAction(
      request(),
      RAW_TOKEN,
      'approve',
      { success: true },
      action,
    );

    expect(res.status).toBe(402);
    expect(await res.json()).toEqual({ error: 'past_due_read_only' });
    expect(mockLockValidLink).toHaveBeenCalledWith(mockSql, RAW_TOKEN);
    expect(mockRecoverCorrelationId).not.toHaveBeenCalled();
    expect(action).not.toHaveBeenCalled();
  });
});

describe('requireDashboardReviewOwner', () => {
  it('maps auth failures and owner rows without an account to no-store responses', async () => {
    const { AuthError } = await import('@/lib/db/auth');
    mockRequireRole.mockRejectedValueOnce(new AuthError('Nope', 403));

    const authRes = await requireDashboardReviewOwner(request());
    expect(authRes).toBeInstanceOf(NextResponse);
    expect((authRes as NextResponse).status).toBe(403);
    expect((authRes as NextResponse).headers.get('Cache-Control')).toBe('no-store, private');

    mockRequireRole.mockResolvedValueOnce(owner({ accountId: null, locationId: null }));
    const noAccountRes = await requireDashboardReviewOwner(request());
    expect(noAccountRes).toBeInstanceOf(NextResponse);
    expect((noAccountRes as NextResponse).status).toBe(403);
    expect(await (noAccountRes as NextResponse).json()).toEqual({
      error: 'No account associated with this user',
    });
  });
});

describe('runDashboardReviewAction', () => {
  it('scopes the response lookup by owner account and passes the review location to the action', async () => {
    sqlResults.push([ACTIVE_ACCOUNT_ROW]);
    sqlResults.push([{ id: 'resp-1', business_id: 'biz-secondary', status: 'pending_approval' }]);
    const action = vi.fn();

    const res = await runDashboardReviewAction(
      request(),
      'rev-1',
      { id: 'owner-1', accountId: 'acct-1' },
      'approve',
      'Response approved.',
      action,
    );

    expect(res.status).toBe(200);
    const responseLookup = sqlCalls.find((call) => call.raw.includes('FROM responses r'));
    expect(responseLookup?.values).toEqual(['rev-1', 'acct-1']);
    expect(mockRecoverCorrelationId).toHaveBeenCalledWith(mockSql, {
      reviewId: 'rev-1',
      responseId: 'resp-1',
    });
    expect(action).toHaveBeenCalledWith(expect.objectContaining({
      tx: mockSql,
      responseId: 'resp-1',
      businessId: 'biz-secondary',
      audit: { actorUserId: 'owner-1', ipAddress: '203.0.113.10' },
      correlationId: 'corr-1',
    }));
  });

  it('returns no-store 404 when no actionable response is visible to the owner', async () => {
    sqlResults.push([ACTIVE_ACCOUNT_ROW]);
    sqlResults.push([]);
    const action = vi.fn();

    const res = await runDashboardReviewAction(
      request(),
      'rev-1',
      { id: 'owner-1', accountId: 'acct-1' },
      'approve',
      'Response approved.',
      action,
    );

    expect(res.status).toBe(404);
    expect(res.headers.get('Cache-Control')).toBe('no-store, private');
    expect(await res.json()).toEqual({ error: 'No actionable response found for this review' });
    expect(action).not.toHaveBeenCalled();
  });

  it('maps stale response and unexpected action errors without leaking internals', async () => {
    sqlResults.push([ACTIVE_ACCOUNT_ROW]);
    sqlResults.push([{ id: 'resp-1', business_id: 'biz-1', status: 'pending_approval' }]);
    const staleRes = await runDashboardReviewAction(
      request(),
      'rev-1',
      { id: 'owner-1', accountId: 'acct-1' },
      'approve',
      'Response approved.',
      () => {
        throw new ResponseNotPendingError('approved');
      },
    );
    expect(staleRes.status).toBe(409);

    sqlResults.push([ACTIVE_ACCOUNT_ROW]);
    sqlResults.push([{ id: 'resp-1', business_id: 'biz-1', status: 'pending_approval' }]);
    const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const unexpectedRes = await runDashboardReviewAction(
      request(),
      'rev-1',
      { id: 'owner-1', accountId: 'acct-1' },
      'approve',
      'Response approved.',
      () => {
        throw new Error('database details');
      },
    );
    consoleSpy.mockRestore();

    expect(unexpectedRes.status).toBe(500);
    expect(await unexpectedRes.json()).toEqual({ error: 'Internal server error' });
  });
});
