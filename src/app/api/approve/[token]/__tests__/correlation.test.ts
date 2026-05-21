// Token-based approval route correlation tests.
//
// Verifies that approve/edit/regenerate POST handlers:
// 1. Look up the response's review_id inside the transaction
// 2. Call recoverCorrelationId to get the upstream chain correlation ID
// 3. Pass that recovered value (NOT link.response_id) to the approval service

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NextRequest } from 'next/server';

// ── Hoisted shared state ────────────────────────────────────────────

const {
  mockSqlResults,
  sqlCallCounter,
  mockLockValidLink,
  mockApprove,
  mockEdit,
  mockRegenerate,
  mockRecoverCorrelationId,
  mockValidateCsrf,
  mockVerifyDeviceCookie,
  mockGetDeviceCookieHash,
  mockCheckRateLimit,
} = vi.hoisted(() => ({
  mockSqlResults: [] as unknown[][],
  sqlCallCounter: { value: 0 },
  mockLockValidLink: vi.fn(),
  mockApprove: vi.fn(),
  mockEdit: vi.fn(),
  mockRegenerate: vi.fn(),
  mockRecoverCorrelationId: vi.fn(),
  mockValidateCsrf: vi.fn(),
  mockVerifyDeviceCookie: vi.fn(),
  mockGetDeviceCookieHash: vi.fn(),
  mockCheckRateLimit: vi.fn(),
}));

// ── Mock DB ─────────────────────────────────────────────────────────

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
  return { sql: sqlProxy , jsonb: (v: unknown) => v };
});

// ── Mock Approval Service ───────────────────────────────────────────

vi.mock('@/lib/approval/service', () => ({
  lockValidLink: (...args: unknown[]) => mockLockValidLink(...args),
  approve: (...args: unknown[]) => mockApprove(...args),
  edit: (...args: unknown[]) => mockEdit(...args),
  regenerate: (...args: unknown[]) => mockRegenerate(...args),
}));

// ── Mock correlation helper ─────────────────────────────────────────

vi.mock('@/lib/approval/correlation', () => ({
  recoverCorrelationId: (...args: unknown[]) => mockRecoverCorrelationId(...args),
}));

// ── Mock cookies + CSRF ─────────────────────────────────────────────

vi.mock('@/lib/approval/cookies', () => ({
  validateCsrf: (...args: unknown[]) => mockValidateCsrf(...args),
  verifyDeviceCookie: (...args: unknown[]) => mockVerifyDeviceCookie(...args),
  getDeviceCookieHash: (...args: unknown[]) => mockGetDeviceCookieHash(...args),
}));

// ── Mock rate limit ─────────────────────────────────────────────────

vi.mock('@/lib/shared/rate-limit', () => ({
  checkRateLimit: (...args: unknown[]) => mockCheckRateLimit(...args),
}));

// ── Mock error handler to pass errors through ───────────────────────

vi.mock('@/lib/approval/http-errors', () => ({
  handleApprovalError: (err: unknown) => {
    throw err;
  },
}));

// ── Helpers ─────────────────────────────────────────────────────────

const RAW_TOKEN = 'test-raw-token-xyz';
const RESPONSE_ID = 'resp-001';
const REVIEW_ID = 'rev-001';
const BUSINESS_ID = 'biz-001';
const UPSTREAM_CORRELATION_ID = 'upstream-corr-abc';

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

function makeRequest(url: string, body?: unknown): NextRequest {
  return new NextRequest(`http://localhost:3000${url}`, {
    method: 'POST',
    body: body != null ? JSON.stringify(body) : undefined,
    headers: body != null ? { 'Content-Type': 'application/json' } : undefined,
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
  // SQL query inside tx: SELECT review_id FROM responses WHERE id = link.response_id
  mockSqlResults.length = 0;
  sqlCallCounter.value = 0;
  mockSqlResults.push([{ review_id: REVIEW_ID }]);
  mockRecoverCorrelationId.mockResolvedValue(UPSTREAM_CORRELATION_ID);
}

// ── Tests ───────────────────────────────────────────────────────────

describe('POST /api/approve/[token]/approve — correlation recovery', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockSqlResults.length = 0;
    sqlCallCounter.value = 0;
  });

  it('passes the recovered upstream correlation ID to approve(), not link.response_id', async () => {
    setupHappyPath();
    mockApprove.mockResolvedValue(undefined);

    const { POST } = await import('../approve/route');
    const res = await POST(makeRequest('/api/approve/test-raw-token-xyz/approve'), tokenParams());

    expect(res.status).toBe(200);

    // recoverCorrelationId called with the right input shape
    expect(mockRecoverCorrelationId).toHaveBeenCalledOnce();
    const corrArgs = mockRecoverCorrelationId.mock.calls[0];
    expect(corrArgs?.[1]).toEqual({ reviewId: REVIEW_ID, responseId: RESPONSE_ID });

    // approve() received the RECOVERED ID as its 5th argument, NOT link.response_id
    expect(mockApprove).toHaveBeenCalledOnce();
    const approveArgs = mockApprove.mock.calls[0];
    // Signature: approve(tx, link, deviceCookieHash, audit, correlationId)
    expect(approveArgs?.[4]).toBe(UPSTREAM_CORRELATION_ID);
    expect(approveArgs?.[4]).not.toBe(RESPONSE_ID);
  });

  it('falls back to responseId when response row is not found (defensive path)', async () => {
    setupHappyPath();
    // Override: SELECT review_id returns empty — response was deleted between
    // lockValidLink and this query (shouldn't happen but defensive)
    mockSqlResults.length = 0;
    sqlCallCounter.value = 0;
    mockSqlResults.push([]); // no review_id row
    mockApprove.mockResolvedValue(undefined);

    const { POST } = await import('../approve/route');
    const res = await POST(makeRequest('/api/approve/test-raw-token-xyz/approve'), tokenParams());

    expect(res.status).toBe(200);
    // recoverCorrelationId NOT called — route took the fallback branch
    expect(mockRecoverCorrelationId).not.toHaveBeenCalled();
    // approve() received link.response_id as the fallback correlation ID
    const approveArgs = mockApprove.mock.calls[0];
    expect(approveArgs?.[4]).toBe(RESPONSE_ID);
  });
});

describe('POST /api/approve/[token]/edit — correlation recovery', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockSqlResults.length = 0;
    sqlCallCounter.value = 0;
  });

  it('passes the recovered upstream correlation ID to edit()', async () => {
    setupHappyPath();
    mockEdit.mockResolvedValue(undefined);

    const { POST } = await import('../edit/route');
    const res = await POST(
      makeRequest('/api/approve/test-raw-token-xyz/edit', { editedText: 'My edited response' }),
      tokenParams(),
    );

    expect(res.status).toBe(200);
    expect(mockRecoverCorrelationId).toHaveBeenCalledOnce();
    expect(mockEdit).toHaveBeenCalledOnce();
    const editArgs = mockEdit.mock.calls[0];
    // Signature: edit(tx, link, editedText, deviceCookieHash, audit, correlationId)
    expect(editArgs?.[5]).toBe(UPSTREAM_CORRELATION_ID);
    expect(editArgs?.[5]).not.toBe(RESPONSE_ID);
  });

  it('passes sanitized edited text to edit()', async () => {
    setupHappyPath();
    mockEdit.mockResolvedValue(undefined);

    const { POST } = await import('../edit/route');
    const res = await POST(
      makeRequest('/api/approve/test-raw-token-xyz/edit', {
        editedText: '  My\t\tedited\u200B response\x00  ',
      }),
      tokenParams(),
    );

    expect(res.status).toBe(200);
    expect(mockEdit).toHaveBeenCalledOnce();
    const editArgs = mockEdit.mock.calls[0];
    // Signature: edit(tx, link, editedText, deviceCookieHash, audit, correlationId)
    expect(editArgs?.[2]).toBe('My edited response');
  });

  it('returns 400 when editedText is empty after sanitization', async () => {
    setupHappyPath();
    mockEdit.mockResolvedValue(undefined);

    const { POST } = await import('../edit/route');
    const res = await POST(
      makeRequest('/api/approve/test-raw-token-xyz/edit', {
        editedText: '\x00\x01\x7F\u200B\u202E\u2066\uFEFF',
      }),
      tokenParams(),
    );

    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toBe('editedText is required');
    expect(mockLockValidLink).not.toHaveBeenCalled();
    expect(mockEdit).not.toHaveBeenCalled();
  });

  it('keeps the token route raw 2000 character length guard', async () => {
    setupHappyPath();
    mockEdit.mockResolvedValue(undefined);

    const { POST } = await import('../edit/route');
    const res = await POST(
      makeRequest('/api/approve/test-raw-token-xyz/edit', {
        editedText: `   ${'x'.repeat(2000)}   `,
      }),
      tokenParams(),
    );

    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toBe('editedText exceeds 2000 characters');
    expect(mockLockValidLink).not.toHaveBeenCalled();
    expect(mockEdit).not.toHaveBeenCalled();
  });
});

describe('POST /api/approve/[token]/regenerate — correlation recovery', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockSqlResults.length = 0;
    sqlCallCounter.value = 0;
  });

  it('passes the recovered upstream correlation ID to regenerate()', async () => {
    setupHappyPath();
    mockRegenerate.mockResolvedValue(undefined);

    const { POST } = await import('../regenerate/route');
    const res = await POST(makeRequest('/api/approve/test-raw-token-xyz/regenerate'), tokenParams());

    expect(res.status).toBe(200);
    expect(mockRecoverCorrelationId).toHaveBeenCalledOnce();
    expect(mockRegenerate).toHaveBeenCalledOnce();
    const regenArgs = mockRegenerate.mock.calls[0];
    // Signature: regenerate(tx, link, deviceCookieHash, audit, correlationId)
    expect(regenArgs?.[4]).toBe(UPSTREAM_CORRELATION_ID);
    expect(regenArgs?.[4]).not.toBe(RESPONSE_ID);
  });

  it('returns a clean regenerate success message without mojibake', async () => {
    setupHappyPath();
    mockRegenerate.mockResolvedValue(undefined);

    const { POST } = await import('../regenerate/route');
    const res = await POST(makeRequest('/api/approve/test-raw-token-xyz/regenerate'), tokenParams());
    const body = await res.json();

    expect(body.message).toBe('Generating a new response - check your email in a few minutes.');
    expect(body.message).not.toMatch(/[Ãâ]/);
  });
});
