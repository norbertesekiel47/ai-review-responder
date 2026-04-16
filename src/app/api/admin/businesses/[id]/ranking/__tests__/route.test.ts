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
}));

vi.mock('uuid', () => ({
  v7: () => 'mock-uuid-v7',
}));

import { POST } from '../route';

// ── Helpers ─────────────────────────────────────────────────────────

function makeRequest(body: unknown): NextRequest {
  return new NextRequest('http://localhost:3000/api/admin/businesses/biz-1/ranking', {
    method: 'POST',
    body: JSON.stringify(body),
    headers: { 'Content-Type': 'application/json' },
  });
}

const makeParams = () => Promise.resolve({ id: 'biz-1' });

// ── Tests ───────────────────────────────────────────────────────────

describe('POST /api/admin/businesses/[id]/ranking', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockRequireRole.mockResolvedValue({ id: 'u1', role: 'admin', businessId: null });
    mockSqlReturn.value = [{ id: 'mock-uuid-v7' }];
  });

  it('returns 400 for missing keyword', async () => {
    const res = await POST(
      makeRequest({ rankPosition: 3 }),
      { params: makeParams() },
    );
    expect(res.status).toBe(400);
  });

  it('returns 400 for rank_position out of range (0)', async () => {
    const res = await POST(
      makeRequest({ keyword: 'pizza', rankPosition: 0 }),
      { params: makeParams() },
    );
    expect(res.status).toBe(400);
  });

  it('returns 200 for valid input', async () => {
    const res = await POST(
      makeRequest({ keyword: 'pizza', rankPosition: 3, date: '2026-04-15' }),
      { params: makeParams() },
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.success).toBe(true);
    expect(body.id).toBe('mock-uuid-v7');
  });

  it('returns 200 when date is omitted (defaults to today)', async () => {
    const res = await POST(
      makeRequest({ keyword: 'pizza', rankPosition: 5 }),
      { params: makeParams() },
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.success).toBe(true);
    expect(body.id).toBe('mock-uuid-v7');
  });

  it('returns 200 when rankPosition is null', async () => {
    const res = await POST(
      makeRequest({ keyword: 'pizza', rankPosition: null, date: '2026-04-15' }),
      { params: makeParams() },
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.success).toBe(true);
  });

  it('returns 400 for invalid calendar date (2026-99-99)', async () => {
    const res = await POST(
      makeRequest({ keyword: 'pizza', rankPosition: 3, date: '2026-99-99' }),
      { params: makeParams() },
    );
    expect(res.status).toBe(400);
  });

  it('returns 400 for whitespace-only keyword', async () => {
    const res = await POST(
      makeRequest({ keyword: '   ', rankPosition: 3 }),
      { params: makeParams() },
    );
    expect(res.status).toBe(400);
  });
});
