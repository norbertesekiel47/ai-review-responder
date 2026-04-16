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
  return { sql: sqlProxy };
});

// ── Mock Approval Service ───────────────────────────────────────────

vi.mock('@/lib/approval/service', () => ({
  approveBySession: (...args: unknown[]) => mockApproveBySession(...args),
  editBySession: (...args: unknown[]) => mockEditBySession(...args),
  regenerateBySession: (...args: unknown[]) => mockRegenerateBySession(...args),
}));

vi.mock('@/lib/approval/errors', () => ({
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

function ownerUser(overrides?: { businessId?: string | null }) {
  return {
    id: 'user-1',
    name: 'Test Owner',
    email: 'owner@test.com',
    role: 'owner',
    businessId: overrides && 'businessId' in overrides ? overrides.businessId : BUSINESS_ID,
  };
}

function makeRequest(url: string, body?: unknown, rawBody?: string): NextRequest {
  const bodyStr = rawBody ?? (body != null ? JSON.stringify(body) : undefined);
  return new NextRequest(`http://localhost:3000${url}`, {
    method: 'POST',
    body: bodyStr,
    headers: bodyStr != null ? { 'Content-Type': 'application/json' } : undefined,
  });
}

function makeParams(reviewId: string): { params: Promise<{ reviewId: string }> } {
  return { params: Promise.resolve({ reviewId }) };
}

function setResponseLookup(rows: unknown[]) {
  mockSqlResults.length = 0;
  sqlCallCounter.value = 0;
  mockSqlResults.push(rows);
}

// ── Tests ───────────────────────────────────────────────────────────

describe('POST /api/dashboard/reviews/[reviewId]/approve', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockSqlResults.length = 0;
    sqlCallCounter.value = 0;
    mockBeginCallback.fn = null;
  });

  it('returns 200 when owner approves their own review response', async () => {
    mockRequireRole.mockResolvedValue(ownerUser());
    setResponseLookup([{ id: RESPONSE_ID, business_id: BUSINESS_ID, status: 'pending_approval' }]);
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

  it('returns 403 when response belongs to a different business', async () => {
    mockRequireRole.mockResolvedValue(ownerUser());
    setResponseLookup([{ id: RESPONSE_ID, business_id: OTHER_BUSINESS_ID, status: 'pending_approval' }]);

    const { POST } = await import('../[reviewId]/approve/route');
    const res = await POST(
      makeRequest(`/api/dashboard/reviews/${REVIEW_ID}/approve`),
      makeParams(REVIEW_ID),
    );

    expect(res.status).toBe(403);
    const body = await res.json();
    expect(body.error).toBe('Forbidden');
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

  it('returns 403 when user has no businessId', async () => {
    mockRequireRole.mockResolvedValue(ownerUser({ businessId: null }));

    const { POST } = await import('../[reviewId]/approve/route');
    const res = await POST(
      makeRequest(`/api/dashboard/reviews/${REVIEW_ID}/approve`),
      makeParams(REVIEW_ID),
    );

    expect(res.status).toBe(403);
    const body = await res.json();
    expect(body.error).toContain('No business');
  });

  it('returns 409 when response is no longer pending', async () => {
    mockRequireRole.mockResolvedValue(ownerUser());
    setResponseLookup([{ id: RESPONSE_ID, business_id: BUSINESS_ID, status: 'pending_approval' }]);

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
  });

  it('returns 200 with valid edited text', async () => {
    mockRequireRole.mockResolvedValue(ownerUser());
    setResponseLookup([{ id: RESPONSE_ID, business_id: BUSINESS_ID, status: 'pending_approval' }]);
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

  it('returns 403 when response belongs to a different business', async () => {
    mockRequireRole.mockResolvedValue(ownerUser());
    setResponseLookup([{ id: RESPONSE_ID, business_id: OTHER_BUSINESS_ID, status: 'pending_approval' }]);

    const { POST } = await import('../[reviewId]/edit/route');
    const res = await POST(
      makeRequest(`/api/dashboard/reviews/${REVIEW_ID}/edit`, { editedText: 'Some edit' }),
      makeParams(REVIEW_ID),
    );

    expect(res.status).toBe(403);
  });

  it('returns 409 when response is no longer pending', async () => {
    mockRequireRole.mockResolvedValue(ownerUser());
    setResponseLookup([{ id: RESPONSE_ID, business_id: BUSINESS_ID, status: 'pending_approval' }]);

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
  });

  it('returns 200 on successful regeneration request', async () => {
    mockRequireRole.mockResolvedValue(ownerUser());
    setResponseLookup([{ id: RESPONSE_ID, business_id: BUSINESS_ID, status: 'pending_approval' }]);
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

  it('returns 403 when response belongs to a different business', async () => {
    mockRequireRole.mockResolvedValue(ownerUser());
    setResponseLookup([{ id: RESPONSE_ID, business_id: OTHER_BUSINESS_ID, status: 'pending_approval' }]);

    const { POST } = await import('../[reviewId]/regenerate/route');
    const res = await POST(
      makeRequest(`/api/dashboard/reviews/${REVIEW_ID}/regenerate`),
      makeParams(REVIEW_ID),
    );

    expect(res.status).toBe(403);
  });

  it('returns 409 when response is no longer pending', async () => {
    mockRequireRole.mockResolvedValue(ownerUser());
    setResponseLookup([{ id: RESPONSE_ID, business_id: BUSINESS_ID, status: 'pending_approval' }]);

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
