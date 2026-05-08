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
import { describe, it, expect, vi, beforeEach, afterAll } from 'vitest';
import { NextRequest } from 'next/server';

const { sqlCalls, mockSql } = vi.hoisted(() => {
  const sqlCalls: string[] = [];
  // Tagged-template SQL captor: flattens the template to a string so we can
  // regex-match across interpolated values. Returns a promise that also
  // carries `count` (for callers that check result.count like PATCH does).
  const mockSql: any = vi.fn((strings: TemplateStringsArray, ..._values: unknown[]) => {
    if (Array.isArray(strings) && 'raw' in (strings as any)) {
      const text = strings.join('?');
      sqlCalls.push(text);
      // After migration 034, business-detail-service queries account_id
      // from businesses before the channel_enrollments INSERT. Return a
      // row so the INSERT path is taken (not the error-throw path).
      if (/SELECT account_id FROM businesses/i.test(text)) {
        const promise: any = Promise.resolve([{ account_id: 'acct-1' }]);
        promise.count = 1;
        return promise;
      }
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
  // POST /api/admin/businesses now calls inviteUserByEmail after
  // createBusinessTx (B11). Stub a successful invite so the route reaches
  // the auth_id UPDATE, not the compensating-rollback branch (which would
  // delete the very INSERT we're asserting on).
  supabaseServer: {
    auth: {
      admin: {
        inviteUserByEmail: vi.fn(() =>
          Promise.resolve({
            data: { user: { id: 'invited-auth-1' } },
            error: null,
          }),
        ),
      },
    },
  },
}));

// The post-B11 route guards on NEXT_PUBLIC_APP_URL before createBusinessTx
// so we must populate it BEFORE importing the route (or the route's
// fail-fast 500 would short-circuit before any SQL fires). The assignment
// stays at module scope for that reason; the snapshot + afterAll below
// restores the prior value so this suite can't leak env state to other
// tests sharing the vitest worker.
const _origNextPublicAppUrl = process.env.NEXT_PUBLIC_APP_URL;
process.env.NEXT_PUBLIC_APP_URL = 'http://localhost:3000';

vi.mock('@/lib/db/auth', () => ({
  requireRole: vi.fn().mockResolvedValue({
    id: 'admin-1',
    name: 'Admin',
    email: 'admin@example.com',
    role: 'admin',
    accountId: null,
    locationId: null,
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
  // Restore the env var snapshot taken at module scope so this suite can't
  // leak NEXT_PUBLIC_APP_URL='http://localhost:3000' to subsequent tests
  // sharing the vitest worker. Branching on `undefined` matters: setting
  // process.env.X = undefined leaves the literal string "undefined" on the
  // var, which then trips downstream code that does Boolean checks. Use
  // delete for the originally-unset case.
  afterAll(() => {
    if (_origNextPublicAppUrl === undefined) {
      delete process.env.NEXT_PUBLIC_APP_URL;
    } else {
      process.env.NEXT_PUBLIC_APP_URL = _origNextPublicAppUrl;
    }
  });

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
    // After migration 034, the ON CONFLICT target changed from
    // (business_id, channel) to (account_id, channel, COALESCE(location_id, ...))
    // to support multi-location per-account overrides.
    expect(upsertCall!).toMatch(
      /ON CONFLICT \(account_id, channel, COALESCE\(location_id,/,
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
    // After migration 034, ON CONFLICT target uses account_id + location_id scope.
    expect(upsertCall!).toMatch(
      /ON CONFLICT \(account_id, channel, COALESCE\(location_id,/,
    );
  });
});
