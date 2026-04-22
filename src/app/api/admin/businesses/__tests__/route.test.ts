import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NextRequest } from 'next/server';

// ── Hoisted shared state ────────────────────────────────────────────

const { mockRequireRole, mockTxCalls } = vi.hoisted(() => ({
  mockRequireRole: vi.fn(),
  mockTxCalls: [] as unknown[][],
}));

// ── Mock auth ───────────────────────────────────────────────────────

vi.mock('@/lib/db/auth', () => {
  class AuthError extends Error {
    constructor(message: string, public readonly statusCode: number) {
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
  const txProxy = new Proxy(() => {}, {
    apply: (_target, _thisArg, args) => {
      mockTxCalls.push(args);
      return Promise.resolve([]);
    },
  }) as unknown;

  const sqlProxy = Object.assign(
    (_strings: TemplateStringsArray, ..._values: unknown[]) => Promise.resolve([]),
    {
      begin: async (callback: (tx: unknown) => Promise<void>) => callback(txProxy),
    },
  );
  return { sql: sqlProxy, jsonb: (v: unknown) => v };
});

// Import AFTER mocks
import { POST } from '../route';

// ── Helpers ─────────────────────────────────────────────────────────

// Minimum valid Place ID: starts with letter, 20+ base64url chars
const VALID_PLACE_ID = 'ChIJgUbEo8cfqokR5lP9Wh_DaM';

function makeBody(overrides?: Record<string, unknown>): Record<string, unknown> {
  return {
    name: 'Test Cafe',
    ownerName: 'Jane Smith',
    ownerEmail: 'jane@testcafe.com',
    googlePlaceId: VALID_PLACE_ID,
    ...overrides,
  };
}

function makePostRequest(body: Record<string, unknown>): NextRequest {
  return new NextRequest('http://localhost/api/admin/businesses', {
    method: 'POST',
    body: JSON.stringify(body),
    headers: { 'content-type': 'application/json' },
  });
}

// ── Tests ────────────────────────────────────────────────────────────

describe('POST /api/admin/businesses — channel enrollment insert', () => {
  beforeEach(() => {
    mockRequireRole.mockReset();
    mockTxCalls.length = 0;
    mockRequireRole.mockResolvedValue({ role: 'admin' });
  });

  it('inserts business + email enrollment inside a single sql.begin transaction', async () => {
    const req = makePostRequest(makeBody());
    const res = await POST(req);

    expect(res.status).toBeLessThan(400);

    const strings = (args: unknown[]) => args[0] as string[];

    const businessInsert = mockTxCalls.find((args) =>
      strings(args).join('').includes('INSERT INTO businesses'),
    );
    const enrollmentInsert = mockTxCalls.find((args) =>
      strings(args).join('').includes('INSERT INTO channel_enrollments'),
    );

    expect(businessInsert).toBeDefined();
    expect(enrollmentInsert).toBeDefined();
  });

  it('returns 201 with id and paymentUrl on success', async () => {
    const req = makePostRequest(makeBody());
    const res = await POST(req);

    expect(res.status).toBe(201);
    const json = await res.json() as { id: string; paymentUrl: string | null };
    expect(typeof json.id).toBe('string');
    expect(json.id).toHaveLength(36); // UUIDv7
  });

  it('returns 401 when requireRole rejects', async () => {
    const { AuthError } = await import('@/lib/db/auth');
    mockRequireRole.mockRejectedValue(new AuthError('Unauthorized', 401));

    const req = makePostRequest(makeBody());
    const res = await POST(req);

    expect(res.status).toBe(401);
    expect(mockTxCalls).toHaveLength(0);
  });

  it('returns 400 for missing required fields', async () => {
    const req = makePostRequest({ name: 'Incomplete Biz' });
    const res = await POST(req);

    expect(res.status).toBe(400);
    expect(mockTxCalls).toHaveLength(0);
  });

  it('returns 400 for invalid Place ID format', async () => {
    const req = makePostRequest(makeBody({ googlePlaceId: 'bad-id' }));
    const res = await POST(req);

    expect(res.status).toBe(400);
    expect(mockTxCalls).toHaveLength(0);
  });

  it('enrollment insert uses same ownerEmail as business insert', async () => {
    const email = 'owner@example.com';
    const req = makePostRequest(makeBody({ ownerEmail: email }));
    await POST(req);

    const enrollmentInsert = mockTxCalls.find((args) =>
      (args[0] as string[]).join('').includes('INSERT INTO channel_enrollments'),
    );
    expect(enrollmentInsert).toBeDefined();
    // The email value should appear in the interpolated args
    expect(enrollmentInsert).toContain(email);
  });
});
