import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NextRequest } from 'next/server';

// ── Hoisted shared state ────────────────────────────────────────────

const {
  mockRequireRole,
  mockSqlResults,
  sqlCallCounter,
  mockApproveBySession,
  mockEditBySession,
  mockRegenerateBySession,
  mockBeginCallback,
} = vi.hoisted(() => ({
  mockRequireRole: vi.fn(),
  mockSqlResults: [] as unknown[][],
  sqlCallCounter: { value: 0 },
  mockApproveBySession: vi.fn(),
  mockEditBySession: vi.fn(),
  mockRegenerateBySession: vi.fn(),
  mockBeginCallback: { fn: null as ((tx: unknown) => Promise<void>) | null },
}));

// ── Mock Auth ───────────────────────────────────────────────────────

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
        return async (callback: (tx: unknown) => Promise<void>) => {
          mockBeginCallback.fn = callback;
          return callback(sqlProxy);
        };
      }
      return undefined;
    },
  }) as unknown;
  return { sql: sqlProxy , jsonb: (v: unknown) => v };
});

// ── Mock Approval Service ───────────────────────────────────────────

vi.mock('@/lib/approval/service', () => ({
  approveBySession: (...args: unknown[]) => mockApproveBySession(...args),
  editBySession: (...args: unknown[]) => mockEditBySession(...args),
  regenerateBySession: (...args: unknown[]) => mockRegenerateBySession(...args),
}));

vi.mock('@/lib/approval/errors', () => ({
  EmptyEditedResponseError: class EmptyEditedResponseError extends Error {
    constructor() {
      super('editedText is required');
      this.name = 'EmptyEditedResponseError';
    }
  },
  ResponseNotPendingError: class ResponseNotPendingError extends Error {
    currentStatus: string;
    constructor(status: string) {
      super(`Response is no longer pending approval (current status: ${status})`);
      this.name = 'ResponseNotPendingError';
      this.currentStatus = status;
    }
  },
}));

// ── Helpers ─────────────────────────────────────────────────────────

const BUSINESS_ID = '01234567-0000-0000-0000-000000000001';
const OTHER_BUSINESS_ID = '01234567-0000-0000-0000-000000000099';
const REVIEW_ID = 'rev-001';
const RESPONSE_ID = 'resp-001';
const APP_URL = 'http://localhost:3000';

function ownerUser(overrides?: { accountId?: string | null; locationId?: string | null }) {
  return {
    id: 'user-1',
    name: 'Test Owner',
    email: 'owner@test.com',
    role: 'owner',
    accountId: overrides && 'accountId' in overrides ? overrides.accountId : 'a0000000-0000-0000-0000-000000000001',
    locationId: overrides && 'locationId' in overrides ? overrides.locationId : BUSINESS_ID,
  };
}

function makeRequest(
  url: string,
  body?: unknown,
  rawBody?: string,
  opts: { origin?: string | null } = {},
): NextRequest {
  const bodyStr = rawBody ?? (body != null ? JSON.stringify(body) : undefined);
  const headers: Record<string, string> = {};
  const origin = opts.origin === undefined ? APP_URL : opts.origin;
  if (origin !== null) headers.Origin = origin;
  if (bodyStr != null) headers['Content-Type'] = 'application/json';

  return new NextRequest(`http://localhost:3000${url}`, {
    method: 'POST',
    body: bodyStr,
    headers,
  });
}

function makeParams(reviewId: string): { params: Promise<{ reviewId: string }> } {
  return { params: Promise.resolve({ reviewId }) };
}

function setResponseLookup(
  rows: unknown[],
  accountRow: unknown = {
    subscription_status: 'active',
    past_due_at: null,
    flags: {},
  },
) {
  mockSqlResults.length = 0;
  sqlCallCounter.value = 0;
  mockSqlResults.push([accountRow]);
  mockSqlResults.push(rows);
  // runDashboardReviewAction locks the response (SELECT ... FOR UPDATE) and
  // checks for an open moderation flag (hasOpenFlag) before recovering the
  // correlation id. Empty results = not held, so the action proceeds.
  mockSqlResults.push([]); // SELECT id ... FOR UPDATE
  mockSqlResults.push([]); // hasOpenFlag → no open flag
}

// ── Tests ───────────────────────────────────────────────────────────

describe('POST /api/dashboard/reviews/[reviewId]/approve', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockSqlResults.length = 0;
    sqlCallCounter.value = 0;
    mockBeginCallback.fn = null;
    process.env.NEXT_PUBLIC_APP_URL = APP_URL;
  });

  it('returns 403 when Origin header is absent', async () => {
    mockRequireRole.mockResolvedValue(ownerUser());

    const { POST } = await import('../[reviewId]/approve/route');
    const res = await POST(
      makeRequest(`/api/dashboard/reviews/${REVIEW_ID}/approve`, undefined, undefined, { origin: null }),
      makeParams(REVIEW_ID),
    );

    expect(res.status).toBe(403);
    expect(mockRequireRole).not.toHaveBeenCalled();
  });

  it('returns 403 when Origin does not match the app origin', async () => {
    mockRequireRole.mockResolvedValue(ownerUser());

    const { POST } = await import('../[reviewId]/approve/route');
    const res = await POST(
      makeRequest(`/api/dashboard/reviews/${REVIEW_ID}/approve`, undefined, undefined, {
        origin: 'https://evil.example.com',
      }),
      makeParams(REVIEW_ID),
    );

    expect(res.status).toBe(403);
    expect(mockRequireRole).not.toHaveBeenCalled();
  });

  it('returns 200 when owner approves their own review response', async () => {
    mockRequireRole.mockResolvedValue(ownerUser());
    setResponseLookup([{ id: RESPONSE_ID, business_id: BUSINESS_ID, status: 'pending_approval' }]);
    mockSqlResults.push([{ correlation_id: 'upstream-corr-abc' }]);
    mockApproveBySession.mockResolvedValue(undefined);

    const { POST } = await import('../[reviewId]/approve/route');
    const res = await POST(
      makeRequest(`/api/dashboard/reviews/${REVIEW_ID}/approve`),
      makeParams(REVIEW_ID),
    );

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.success).toBe(true);
    expect(res.headers.get('Cache-Control')).toBe('no-store, private');
    expect(mockApproveBySession).toHaveBeenCalledOnce();
    // Signature: approveBySession(tx, responseId, businessId, audit, correlationId)
    const callArgs = mockApproveBySession.mock.calls[0];
    expect(callArgs?.[4]).toBe('upstream-corr-abc');
  });

  it('returns 402 when the account is past-due read-only', async () => {
    mockRequireRole.mockResolvedValue(ownerUser());
    setResponseLookup(
      [{ id: RESPONSE_ID, business_id: BUSINESS_ID, status: 'pending_approval' }],
      {
        subscription_status: 'past_due',
        past_due_at: new Date('2026-05-01T00:00:00.000Z'),
        flags: {},
      },
    );

    const { POST } = await import('../[reviewId]/approve/route');
    const res = await POST(
      makeRequest(`/api/dashboard/reviews/${REVIEW_ID}/approve`),
      makeParams(REVIEW_ID),
    );

    expect(res.status).toBe(402);
    expect(await res.json()).toEqual({ error: 'past_due_read_only' });
    expect(mockApproveBySession).not.toHaveBeenCalled();
    expect(sqlCallCounter.value).toBe(1);
  });

  it('returns 404 when no response found for review', async () => {
    mockRequireRole.mockResolvedValue(ownerUser());
    setResponseLookup([]);

    const { POST } = await import('../[reviewId]/approve/route');
    const res = await POST(
      makeRequest(`/api/dashboard/reviews/${REVIEW_ID}/approve`),
      makeParams(REVIEW_ID),
    );

    expect(res.status).toBe(404);
    const body = await res.json();
    expect(body.error).toContain('No actionable response');
  });

  it('returns 404 when response belongs to a different business (query scoped by business_id)', async () => {
    mockRequireRole.mockResolvedValue(ownerUser());
    setResponseLookup([]); // Query filters by owner's business_id, so wrong-business review returns empty

    const { POST } = await import('../[reviewId]/approve/route');
    const res = await POST(
      makeRequest(`/api/dashboard/reviews/${REVIEW_ID}/approve`),
      makeParams(REVIEW_ID),
    );

    expect(res.status).toBe(404);
  });

  it('returns 401 when not authenticated', async () => {
    const { AuthError } = await import('@/lib/db/auth');
    mockRequireRole.mockRejectedValue(new AuthError('Unauthorized', 401));

    const { POST } = await import('../[reviewId]/approve/route');
    const res = await POST(
      makeRequest(`/api/dashboard/reviews/${REVIEW_ID}/approve`),
      makeParams(REVIEW_ID),
    );

    expect(res.status).toBe(401);
  });

  it('returns 403 when user has no accountId', async () => {
    mockRequireRole.mockResolvedValue(ownerUser({ accountId: null, locationId: null }));

    const { POST } = await import('../[reviewId]/approve/route');
    const res = await POST(
      makeRequest(`/api/dashboard/reviews/${REVIEW_ID}/approve`),
      makeParams(REVIEW_ID),
    );

    expect(res.status).toBe(403);
    const body = await res.json();
    expect(body.error).toContain('No account');
  });

  it('returns 409 when response is no longer pending', async () => {
    mockRequireRole.mockResolvedValue(ownerUser());
    setResponseLookup([{ id: RESPONSE_ID, business_id: BUSINESS_ID, status: 'pending_approval' }]);
    mockSqlResults.push([{ correlation_id: 'upstream-corr-abc' }]);

    const { ResponseNotPendingError } = await import('@/lib/approval/errors');
    mockApproveBySession.mockRejectedValue(new ResponseNotPendingError('approved'));

    const { POST } = await import('../[reviewId]/approve/route');
    const res = await POST(
      makeRequest(`/api/dashboard/reviews/${REVIEW_ID}/approve`),
      makeParams(REVIEW_ID),
    );

    expect(res.status).toBe(409);
  });
});

describe('POST /api/dashboard/reviews/[reviewId]/edit', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockSqlResults.length = 0;
    sqlCallCounter.value = 0;
    mockBeginCallback.fn = null;
    process.env.NEXT_PUBLIC_APP_URL = APP_URL;
  });

  it('returns 403 when Origin header is absent', async () => {
    mockRequireRole.mockResolvedValue(ownerUser());

    const { POST } = await import('../[reviewId]/edit/route');
    const res = await POST(
      makeRequest(`/api/dashboard/reviews/${REVIEW_ID}/edit`, { editedText: 'Thanks!' }, undefined, { origin: null }),
      makeParams(REVIEW_ID),
    );

    expect(res.status).toBe(403);
    expect(mockRequireRole).not.toHaveBeenCalled();
  });

  it('returns 403 when Origin does not match the app origin', async () => {
    mockRequireRole.mockResolvedValue(ownerUser());

    const { POST } = await import('../[reviewId]/edit/route');
    const res = await POST(
      makeRequest(`/api/dashboard/reviews/${REVIEW_ID}/edit`, { editedText: 'Thanks!' }, undefined, {
        origin: 'https://evil.example.com',
      }),
      makeParams(REVIEW_ID),
    );

    expect(res.status).toBe(403);
    expect(mockRequireRole).not.toHaveBeenCalled();
  });

  it('returns 200 with valid edited text', async () => {
    mockRequireRole.mockResolvedValue(ownerUser());
    setResponseLookup([{ id: RESPONSE_ID, business_id: BUSINESS_ID, status: 'pending_approval' }]);
    mockSqlResults.push([{ correlation_id: 'upstream-corr-abc' }]);
    mockEditBySession.mockResolvedValue(undefined);

    const { POST } = await import('../[reviewId]/edit/route');
    const res = await POST(
      makeRequest(`/api/dashboard/reviews/${REVIEW_ID}/edit`, { editedText: 'Thank you for your feedback!' }),
      makeParams(REVIEW_ID),
    );

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.success).toBe(true);
    expect(mockEditBySession).toHaveBeenCalledOnce();
    // Signature: editBySession(tx, responseId, businessId, editedText, audit, correlationId)
    const callArgs = mockEditBySession.mock.calls[0];
    expect(callArgs?.[5]).toBe('upstream-corr-abc');
  });

  it('passes sanitized edited text to the session edit service', async () => {
    mockRequireRole.mockResolvedValue(ownerUser());
    setResponseLookup([{ id: RESPONSE_ID, business_id: BUSINESS_ID, status: 'pending_approval' }]);
    mockSqlResults.push([{ correlation_id: 'upstream-corr-abc' }]);
    mockEditBySession.mockResolvedValue(undefined);

    const { POST } = await import('../[reviewId]/edit/route');
    const res = await POST(
      makeRequest(`/api/dashboard/reviews/${REVIEW_ID}/edit`, {
        editedText: '  Thank\t\tyou\u200B\n\n\nCome\u202E back!  ',
      }),
      makeParams(REVIEW_ID),
    );

    expect(res.status).toBe(200);
    const callArgs = mockEditBySession.mock.calls[0];
    expect(callArgs?.[3]).toBe('Thank you\n\nCome back!');
  });

  it('does not count leading or trailing whitespace against the 2000 character limit', async () => {
    mockRequireRole.mockResolvedValue(ownerUser());
    setResponseLookup([{ id: RESPONSE_ID, business_id: BUSINESS_ID, status: 'pending_approval' }]);
    mockSqlResults.push([{ correlation_id: 'upstream-corr-abc' }]);
    mockEditBySession.mockResolvedValue(undefined);
    const content = 'x'.repeat(2000);

    const { POST } = await import('../[reviewId]/edit/route');
    const res = await POST(
      makeRequest(`/api/dashboard/reviews/${REVIEW_ID}/edit`, { editedText: `   ${content}   ` }),
      makeParams(REVIEW_ID),
    );

    expect(res.status).toBe(200);
    const callArgs = mockEditBySession.mock.calls[0];
    expect(callArgs?.[3]).toBe(content);
  });

  it('returns 400 when editedText is empty', async () => {
    mockRequireRole.mockResolvedValue(ownerUser());

    const { POST } = await import('../[reviewId]/edit/route');
    const res = await POST(
      makeRequest(`/api/dashboard/reviews/${REVIEW_ID}/edit`, { editedText: '' }),
      makeParams(REVIEW_ID),
    );

    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toBe('Validation failed');
  });

  it('returns 400 when editedText is empty after sanitization', async () => {
    mockRequireRole.mockResolvedValue(ownerUser());

    const { POST } = await import('../[reviewId]/edit/route');
    const res = await POST(
      makeRequest(`/api/dashboard/reviews/${REVIEW_ID}/edit`, { editedText: '\x00\x01\x7F\u200B\u202E\u2066\uFEFF' }),
      makeParams(REVIEW_ID),
    );

    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toBe('Validation failed');
    expect(mockEditBySession).not.toHaveBeenCalled();
    expect(sqlCallCounter.value).toBe(0);
  });

  it('returns 400 when editedText exceeds 2000 chars', async () => {
    mockRequireRole.mockResolvedValue(ownerUser());

    const { POST } = await import('../[reviewId]/edit/route');
    const res = await POST(
      makeRequest(`/api/dashboard/reviews/${REVIEW_ID}/edit`, { editedText: 'x'.repeat(2001) }),
      makeParams(REVIEW_ID),
    );

    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toBe('Validation failed');
  });

  it('returns 400 when body is not valid JSON', async () => {
    mockRequireRole.mockResolvedValue(ownerUser());

    const { POST } = await import('../[reviewId]/edit/route');
    const res = await POST(
      makeRequest(`/api/dashboard/reviews/${REVIEW_ID}/edit`, undefined, 'not json'),
      makeParams(REVIEW_ID),
    );

    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toBe('Invalid JSON body');
  });

  it('returns 404 when no response found', async () => {
    mockRequireRole.mockResolvedValue(ownerUser());
    setResponseLookup([]);

    const { POST } = await import('../[reviewId]/edit/route');
    const res = await POST(
      makeRequest(`/api/dashboard/reviews/${REVIEW_ID}/edit`, { editedText: 'Some edit' }),
      makeParams(REVIEW_ID),
    );

    expect(res.status).toBe(404);
  });

  it('returns 404 when response belongs to a different business (query scoped by business_id)', async () => {
    mockRequireRole.mockResolvedValue(ownerUser());
    setResponseLookup([]); // Query filters by owner's business_id, so wrong-business review returns empty

    const { POST } = await import('../[reviewId]/edit/route');
    const res = await POST(
      makeRequest(`/api/dashboard/reviews/${REVIEW_ID}/edit`, { editedText: 'Some edit' }),
      makeParams(REVIEW_ID),
    );

    expect(res.status).toBe(404);
  });

  it('returns 409 when response is no longer pending', async () => {
    mockRequireRole.mockResolvedValue(ownerUser());
    setResponseLookup([{ id: RESPONSE_ID, business_id: BUSINESS_ID, status: 'pending_approval' }]);
    mockSqlResults.push([{ correlation_id: 'upstream-corr-abc' }]);

    const { ResponseNotPendingError } = await import('@/lib/approval/errors');
    mockEditBySession.mockRejectedValue(new ResponseNotPendingError('posted'));

    const { POST } = await import('../[reviewId]/edit/route');
    const res = await POST(
      makeRequest(`/api/dashboard/reviews/${REVIEW_ID}/edit`, { editedText: 'Edited response' }),
      makeParams(REVIEW_ID),
    );

    expect(res.status).toBe(409);
  });
});

describe('POST /api/dashboard/reviews/[reviewId]/regenerate', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockSqlResults.length = 0;
    sqlCallCounter.value = 0;
    mockBeginCallback.fn = null;
    process.env.NEXT_PUBLIC_APP_URL = APP_URL;
  });

  it('returns 403 when Origin header is absent', async () => {
    mockRequireRole.mockResolvedValue(ownerUser());

    const { POST } = await import('../[reviewId]/regenerate/route');
    const res = await POST(
      makeRequest(`/api/dashboard/reviews/${REVIEW_ID}/regenerate`, undefined, undefined, { origin: null }),
      makeParams(REVIEW_ID),
    );

    expect(res.status).toBe(403);
    expect(mockRequireRole).not.toHaveBeenCalled();
  });

  it('returns 403 when Origin does not match the app origin', async () => {
    mockRequireRole.mockResolvedValue(ownerUser());

    const { POST } = await import('../[reviewId]/regenerate/route');
    const res = await POST(
      makeRequest(`/api/dashboard/reviews/${REVIEW_ID}/regenerate`, undefined, undefined, {
        origin: 'https://evil.example.com',
      }),
      makeParams(REVIEW_ID),
    );

    expect(res.status).toBe(403);
    expect(mockRequireRole).not.toHaveBeenCalled();
  });

  it('returns 200 on successful regeneration request', async () => {
    mockRequireRole.mockResolvedValue(ownerUser());
    setResponseLookup([{ id: RESPONSE_ID, business_id: BUSINESS_ID, status: 'pending_approval' }]);
    mockSqlResults.push([{ correlation_id: 'upstream-corr-abc' }]);
    mockRegenerateBySession.mockResolvedValue(undefined);

    const { POST } = await import('../[reviewId]/regenerate/route');
    const res = await POST(
      makeRequest(`/api/dashboard/reviews/${REVIEW_ID}/regenerate`),
      makeParams(REVIEW_ID),
    );

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.success).toBe(true);
    expect(res.headers.get('Cache-Control')).toBe('no-store, private');
    expect(mockRegenerateBySession).toHaveBeenCalledOnce();
    // Signature: regenerateBySession(tx, responseId, businessId, audit, correlationId)
    const callArgs = mockRegenerateBySession.mock.calls[0];
    expect(callArgs?.[4]).toBe('upstream-corr-abc');
  });

  it('returns 404 when no response found', async () => {
    mockRequireRole.mockResolvedValue(ownerUser());
    setResponseLookup([]);

    const { POST } = await import('../[reviewId]/regenerate/route');
    const res = await POST(
      makeRequest(`/api/dashboard/reviews/${REVIEW_ID}/regenerate`),
      makeParams(REVIEW_ID),
    );

    expect(res.status).toBe(404);
  });

  it('returns 404 when response belongs to a different business (query scoped by business_id)', async () => {
    mockRequireRole.mockResolvedValue(ownerUser());
    setResponseLookup([]); // Query filters by owner's business_id, so wrong-business review returns empty

    const { POST } = await import('../[reviewId]/regenerate/route');
    const res = await POST(
      makeRequest(`/api/dashboard/reviews/${REVIEW_ID}/regenerate`),
      makeParams(REVIEW_ID),
    );

    expect(res.status).toBe(404);
  });

  it('returns 409 when response is no longer pending', async () => {
    mockRequireRole.mockResolvedValue(ownerUser());
    setResponseLookup([{ id: RESPONSE_ID, business_id: BUSINESS_ID, status: 'pending_approval' }]);
    mockSqlResults.push([{ correlation_id: 'upstream-corr-abc' }]);

    const { ResponseNotPendingError } = await import('@/lib/approval/errors');
    mockRegenerateBySession.mockRejectedValue(new ResponseNotPendingError('approved'));

    const { POST } = await import('../[reviewId]/regenerate/route');
    const res = await POST(
      makeRequest(`/api/dashboard/reviews/${REVIEW_ID}/regenerate`),
      makeParams(REVIEW_ID),
    );

    expect(res.status).toBe(409);
  });
});
