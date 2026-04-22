// src/app/api/admin/channels/sms/__tests__/onconflict.test.ts
//
// Regression guard: Phase 0's two email enrollment upsert sites must carry
// the `WHERE archived_at IS NULL` predicate in their ON CONFLICT targets.
// Migration 022 replaced `UNIQUE (business_id, channel)` with a partial
// unique INDEX scoped to active rows, and Postgres ON CONFLICT inference
// requires the target to include the predicate verbatim. A future refactor
// that drops the predicate would crash business creation / owner-email edit
// in production; this test catches that regression at the query-shape layer.
//
// Follows the hoisted-mock pattern from
// src/lib/notifications/__tests__/enrollments.test.ts and
// src/app/api/admin/businesses/[id]/channels/__tests__/route.test.ts.
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NextRequest } from 'next/server';

const { sqlCalls, mockSql } = vi.hoisted(() => {
  const sqlCalls: string[] = [];
  // Tagged-template SQL captor: flattens the template to a string so we can
  // regex-match across interpolated values. Returns a promise that also
  // carries `count` (for callers that check result.count like PATCH does).
  const mockSql: any = vi.fn((strings: TemplateStringsArray, ..._values: unknown[]) => {
    if (Array.isArray(strings) && 'raw' in (strings as any)) {
      sqlCalls.push(strings.join('?'));
    }
    const promise: any = Promise.resolve([]);
    promise.count = 1; // non-zero so PATCH doesn't throw BusinessNotFoundError
    return promise;
  });
  // POST/PATCH both wrap their work in sql.begin(async tx => ...). The
  // callback expects `tx` to behave like `sql` itself (tagged-template +
  // .unsafe). Pass mockSql through so the inner tx`...` calls are captured
  // in the same sqlCalls array.
  mockSql.begin = vi.fn(async (cb: (tx: unknown) => Promise<unknown>) => cb(mockSql));
  // PATCH uses tx.unsafe(query, values) for the dynamic UPDATE. Record the
  // raw SQL string so the ON CONFLICT assertion below still runs against
  // the subsequent tagged-template upsert.
  mockSql.unsafe = vi.fn((query: string, _values: unknown[]) => {
    sqlCalls.push(query);
    const promise: any = Promise.resolve([]);
    promise.count = 1;
    return promise;
  });
  return { sqlCalls, mockSql };
});

vi.mock('@/lib/db/server', () => ({
  sql: mockSql,
  // The POST route uses jsonb() to wrap outbox payloads — identity stub is
  // fine because we never inspect payload shape.
  jsonb: (x: unknown) => x,
}));

vi.mock('@/lib/db/auth', () => ({
  requireRole: vi.fn().mockResolvedValue({
    id: 'admin-1',
    name: 'Admin',
    email: 'admin@example.com',
    role: 'admin',
    businessId: null,
  }),
  AuthError: class AuthError extends Error {
    statusCode: number;
    constructor(message: string, statusCode = 401) {
      super(message);
      this.statusCode = statusCode;
    }
  },
}));

describe('Phase 0 email enrollment upserts — ON CONFLICT regression', () => {
  beforeEach(() => {
    sqlCalls.length = 0;
    mockSql.mockClear();
    mockSql.begin.mockClear();
    mockSql.unsafe.mockClear();
  });

  it('POST /api/admin/businesses: email enrollment upsert uses partial unique index target', async () => {
    const { POST } = await import('@/app/api/admin/businesses/route');
    const req = new NextRequest('http://localhost/api/admin/businesses', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name: 'Test Biz',
        category: 'restaurant',
        ownerName: 'Test Owner',
        ownerEmail: 'owner@example.com',
        ownerPhone: '+15551234567',
        googlePlaceId: 'ChIJtest1234567890abcdef',
        tone: 'warm',
        productsServices: 'pizza',
        staffNames: '',
        highlightFacts: '',
        avoidFacts: '',
        sampleResponses: '',
        subscriptionTier: 'standard',
        website: null,
      }),
    });

    try {
      await POST(req);
    } catch {
      // Only the SQL shape matters; downstream errors (e.g. payment-link
      // side effects) should not fail the assertion below.
    }

    const upsertCall = sqlCalls.find(
      (q) => /INSERT INTO channel_enrollments/.test(q) && /'email'/.test(q),
    );
    expect(
      upsertCall,
      'expected an INSERT against channel_enrollments with email literal',
    ).toBeDefined();
    expect(upsertCall!).toMatch(
      /ON CONFLICT \(business_id, channel\) WHERE archived_at IS NULL/,
    );
  });

  it('PATCH /api/admin/businesses/[id]: owner_email edit upsert uses partial unique index target', async () => {
    const { PATCH } = await import('@/app/api/admin/businesses/[id]/route');
    const req = new NextRequest('http://localhost/api/admin/businesses/biz-1', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ownerEmail: 'new@example.com' }),
    });

    try {
      await PATCH(req, { params: Promise.resolve({ id: 'biz-1' }) });
    } catch {
      // Ignore — only the SQL shape matters.
    }

    const upsertCall = sqlCalls.find(
      (q) => /INSERT INTO channel_enrollments/.test(q) && /'email'/.test(q),
    );
    expect(
      upsertCall,
      'expected an INSERT against channel_enrollments with email literal',
    ).toBeDefined();
    expect(upsertCall!).toMatch(
      /ON CONFLICT \(business_id, channel\) WHERE archived_at IS NULL/,
    );
  });
});
