// POST /api/approve/[token]/veto — outcome-to-status mapping + guard parity
// with the sibling token actions (same-origin, CSRF, token errors, device
// binding). The veto transition itself is covered by src/lib/approval's
// veto tests; here the contract under test is the ROUTE's HTTP surface:
//   'cancelled'          → 200 { result: 'cancelled' }
//   'already_cancelled'  → 200 { result: 'already_cancelled' }  (double-tap safe)
//   'too_late'           → 409 { result: 'too_late' }           (tx rolled back)
// Uses the REAL handleApprovalError + verifyDevice so the mapping is the
// production one, not a mock.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { NextRequest } from 'next/server';
import {
  ConsumedTokenError,
  ExpiredTokenError,
  InvalidTokenError,
} from '@/lib/approval/errors';

const {
  mockSqlResults,
  sqlCallCounter,
  mockLockValidLink,
  mockVetoAutoPost,
  mockRecoverCorrelationId,
  mockValidateCsrf,
  mockVerifyDeviceCookie,
  mockGetDeviceCookieHash,
  mockCheckRateLimit,
} = vi.hoisted(() => ({
  mockSqlResults: [] as unknown[][],
  sqlCallCounter: { value: 0 },
  mockLockValidLink: vi.fn(),
  mockVetoAutoPost: vi.fn(),
  mockRecoverCorrelationId: vi.fn(),
  mockValidateCsrf: vi.fn(),
  mockVerifyDeviceCookie: vi.fn(),
  mockGetDeviceCookieHash: vi.fn(),
  mockCheckRateLimit: vi.fn(),
}));

vi.mock('@/lib/db/server', () => {
  const sqlProxy = new Proxy(() => {}, {
    apply: () => {
      const result = mockSqlResults[sqlCallCounter.value] ?? [];
      sqlCallCounter.value++;
      return Promise.resolve(result);
    },
    get: (_target, prop) => {
      if (prop === 'begin') {
        return async (callback: (tx: unknown) => Promise<void>) => callback(sqlProxy);
      }
      return undefined;
    },
  }) as unknown;
  return { sql: sqlProxy, jsonb: (v: unknown) => v };
});

vi.mock('@/lib/approval/service', () => ({
  lockValidLink: (...args: unknown[]) => mockLockValidLink(...args),
}));

vi.mock('@/lib/approval/veto', () => ({
  vetoAutoPost: (...args: unknown[]) => mockVetoAutoPost(...args),
}));

vi.mock('@/lib/approval/correlation', () => ({
  recoverCorrelationId: (...args: unknown[]) => mockRecoverCorrelationId(...args),
}));

vi.mock('@/lib/approval/cookies', () => ({
  validateCsrf: (...args: unknown[]) => mockValidateCsrf(...args),
  verifyDeviceCookie: (...args: unknown[]) => mockVerifyDeviceCookie(...args),
  getDeviceCookieHash: (...args: unknown[]) => mockGetDeviceCookieHash(...args),
}));

vi.mock('@/lib/shared/rate-limit', () => ({
  checkRateLimit: (...args: unknown[]) => mockCheckRateLimit(...args),
}));

const RAW_TOKEN = 'veto-raw-token';
const RESPONSE_ID = 'resp-001';
const BUSINESS_ID = 'biz-001';
const APP_URL = 'http://localhost:3000';

function validLink() {
  return {
    id: 'link-1',
    response_id: RESPONSE_ID,
    business_id: BUSINESS_ID,
    token_hash: 'hash-abc',
    channel: 'email',
    expires_at: new Date(Date.now() + 86_400_000),
    consumed_at: null,
    revoked_at: null,
    device_cookie_hash: 'device-hash-abc',
    created_at: new Date(),
  };
}

function makeRequest(origin: string | null = APP_URL): NextRequest {
  return new NextRequest(`${APP_URL}/api/approve/${RAW_TOKEN}/veto`, {
    method: 'POST',
    headers: origin ? { origin } : {},
  });
}

function tokenParams(): { params: Promise<{ token: string }> } {
  return { params: Promise.resolve({ token: RAW_TOKEN }) };
}

function setupHappyPath() {
  mockCheckRateLimit.mockResolvedValue({ allowed: true, remaining: 2 });
  mockValidateCsrf.mockReturnValue(true);
  mockVerifyDeviceCookie.mockReturnValue(true);
  mockGetDeviceCookieHash.mockReturnValue('device-hash-abc');
  mockLockValidLink.mockResolvedValue(validLink());
  mockSqlResults.length = 0;
  sqlCallCounter.value = 0;
  // 1st in-tx query: writable-subscription guard (assertWritableSubscriptionForBusiness)
  mockSqlResults.push([{ subscription_status: 'active', past_due_at: null, flags: {} }]);
  // 2nd in-tx query: recoverLinkCorrelationId SELECT review_id FROM responses
  mockSqlResults.push([{ review_id: 'rev-001' }]);
  mockRecoverCorrelationId.mockResolvedValue('corr-veto');
}

async function postVeto(origin: string | null = APP_URL) {
  const { POST } = await import('../veto/route');
  return POST(makeRequest(origin), tokenParams());
}

describe('POST /api/approve/[token]/veto', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubEnv('NEXT_PUBLIC_APP_URL', APP_URL);
    mockSqlResults.length = 0;
    sqlCallCounter.value = 0;
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('maps a cancelled veto to 200 { result: "cancelled" } and calls the module with the tx context', async () => {
    setupHappyPath();
    mockVetoAutoPost.mockResolvedValue('cancelled');

    const res = await postVeto();

    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual({ result: 'cancelled' });

    expect(mockVetoAutoPost).toHaveBeenCalledOnce();
    const [, link, audit, correlationId] = mockVetoAutoPost.mock.calls[0]!;
    expect(link).toMatchObject({ id: 'link-1', response_id: RESPONSE_ID });
    expect(audit).toMatchObject({
      tokenHash: 'hash-abc',
      deviceCookieHash: 'device-hash-abc',
    });
    expect(correlationId).toBe('corr-veto');
  });

  it('maps already_cancelled to 200 (idempotent double-tap posture)', async () => {
    setupHappyPath();
    mockVetoAutoPost.mockResolvedValue('already_cancelled');

    const res = await postVeto();

    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual({ result: 'already_cancelled' });
  });

  it('maps too_late to a 409 with the machine-readable result key', async () => {
    setupHappyPath();
    mockVetoAutoPost.mockResolvedValue('too_late');

    const res = await postVeto();

    expect(res.status).toBe(409);
    await expect(res.json()).resolves.toMatchObject({ result: 'too_late' });
  });

  it.each([
    ['invalid', new InvalidTokenError(), 404],
    ['expired', new ExpiredTokenError(), 410],
    ['consumed', new ConsumedTokenError(), 410],
  ])('maps a %s token exactly like the sibling actions (%i)', async (_label, err, status) => {
    setupHappyPath();
    mockLockValidLink.mockRejectedValue(err);

    const res = await postVeto();

    expect(res.status).toBe(status);
    expect(mockVetoAutoPost).not.toHaveBeenCalled();
  });

  it('rejects a device mismatch with the sibling 403 before running the veto', async () => {
    setupHappyPath();
    // Real verifyDevice: the request's device cookie hash does not match the
    // hash bound to the link at session time.
    mockGetDeviceCookieHash.mockReturnValue('a-different-device');

    const res = await postVeto();

    expect(res.status).toBe(403);
    expect(mockVetoAutoPost).not.toHaveBeenCalled();
  });

  it('rejects a failed CSRF check with 403 before any transaction work', async () => {
    setupHappyPath();
    mockValidateCsrf.mockReturnValue(false);

    const res = await postVeto();

    expect(res.status).toBe(403);
    expect(mockLockValidLink).not.toHaveBeenCalled();
    expect(mockVetoAutoPost).not.toHaveBeenCalled();
  });

  it('enforces same-origin: a cross-origin POST is refused before the wrapper runs', async () => {
    setupHappyPath();

    const res = await postVeto('https://evil.example');

    expect(res.status).toBe(403);
    await expect(res.json()).resolves.toEqual({ error: 'forbidden' });
    expect(mockCheckRateLimit).not.toHaveBeenCalled();
    expect(mockVetoAutoPost).not.toHaveBeenCalled();
  });

  it('rate-limits by hashed token like the sibling actions', async () => {
    setupHappyPath();
    mockCheckRateLimit.mockResolvedValue({ allowed: false });

    const res = await postVeto();

    expect(res.status).toBe(429);
    expect(mockVetoAutoPost).not.toHaveBeenCalled();
  });
});
