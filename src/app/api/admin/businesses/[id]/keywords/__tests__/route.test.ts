import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NextRequest } from 'next/server';

// ── Hoisted mocks ───────────────────────────────────────────────────

const { mockRequireRole, mockSqlReturn } = vi.hoisted(() => ({
  mockRequireRole: vi.fn(),
  mockSqlReturn: { value: [] as unknown[] },
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
  sql: new Proxy(() => {}, {
    apply: () => Promise.resolve(mockSqlReturn.value),
  }),
  jsonb: (v: unknown) => v,
}));

import { PUT } from '../route';

// ── Helpers ─────────────────────────────────────────────────────────

function makeRequest(body: unknown): NextRequest {
  return new NextRequest('http://localhost:3000/api/admin/businesses/biz-1/keywords', {
    method: 'PUT',
    body: JSON.stringify(body),
    headers: { 'Content-Type': 'application/json' },
  });
}

const makeParams = () => Promise.resolve({ id: 'biz-1' });

// ── Tests ───────────────────────────────────────────────────────────

describe('PUT /api/admin/businesses/[id]/keywords', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockRequireRole.mockResolvedValue({ id: 'u1', role: 'admin', accountId: null, locationId: null });
    mockSqlReturn.value = [{ id: 'biz-1' }];
  });

  it('returns 400 for non-array keywords', async () => {
    const res = await PUT(makeRequest({ keywords: 'not-an-array' }), { params: makeParams() });
    expect(res.status).toBe(400);
  });

  it('returns 400 for more than 5 keywords', async () => {
    const res = await PUT(
      makeRequest({ keywords: ['a', 'b', 'c', 'd', 'e', 'f'] }),
      { params: makeParams() },
    );
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toContain('Maximum 5 keywords');
  });

  it('returns 200 for valid input', async () => {
    const res = await PUT(
      makeRequest({ keywords: ['pizza', 'pasta'] }),
      { params: makeParams() },
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.success).toBe(true);
  });

  it('returns 200 for empty array (clearing keywords)', async () => {
    const res = await PUT(
      makeRequest({ keywords: [] }),
      { params: makeParams() },
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.success).toBe(true);
  });

  it('returns 404 when business not found', async () => {
    mockSqlReturn.value = [];
    const res = await PUT(
      makeRequest({ keywords: ['pizza'] }),
      { params: makeParams() },
    );
    expect(res.status).toBe(404);
  });

  it('returns 400 for whitespace-only keywords', async () => {
    const res = await PUT(
      makeRequest({ keywords: ['   ', '  \t  '] }),
      { params: makeParams() },
    );
    expect(res.status).toBe(400);
  });
});
