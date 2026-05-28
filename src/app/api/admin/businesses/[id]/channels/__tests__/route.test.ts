// src/app/api/admin/businesses/[id]/channels/__tests__/route.test.ts
//
// Follows the mock-based pattern in src/lib/notifications/__tests__/enrollments.test.ts
// — hoists the sql mock so the module import in the route sees it.
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NextRequest } from 'next/server';

const { sqlReturnQueue, mockSql } = vi.hoisted(() => {
  const sqlReturnQueue: unknown[] = [];
  const mockSql: any = vi.fn((_s: TemplateStringsArray, ..._v: unknown[]) => {
    const result = sqlReturnQueue.shift() ?? [];
    return Promise.resolve(result);
  });
  return { sqlReturnQueue, mockSql };
});

vi.mock('@/lib/db/server', () => ({
  sql: mockSql,
}));

// Admin auth: stub requireRole to a no-op so the handler
// proceeds to the query we want to inspect. AuthError is still exported
// because the route references it in the catch block.
vi.mock('@/lib/db/auth', () => ({
  requireRole: vi.fn().mockResolvedValue(undefined),
  AuthError: class AuthError extends Error {
    statusCode: number;
    constructor(message: string, statusCode = 401) {
      super(message);
      this.statusCode = statusCode;
    }
  },
}));

import { GET } from '../route';

const ACCOUNT_ID = '00000000-0000-0000-0000-0000000000ac';
const L1 = '00000000-0000-0000-0000-0000000000a1';
const L2 = '00000000-0000-0000-0000-0000000000a2';

/** Returns the joined query text for the Nth sql call (0-indexed). */
function queryText(callIndex: number): string {
  const [template] = mockSql.mock.calls[callIndex] as [TemplateStringsArray, ...unknown[]];
  return template.join('?');
}

describe('GET /api/admin/businesses/[id]/channels — archived rows', () => {
  beforeEach(() => {
    mockSql.mockClear();
    sqlReturnQueue.length = 0;
  });

  it('filters query by archived_at IS NULL (query shape assertion)', async () => {
    sqlReturnQueue.push([{ account_id: ACCOUNT_ID }]); // account resolution
    sqlReturnQueue.push([]); // no enrollments
    const req = new NextRequest('http://localhost/api/admin/businesses/biz-1/channels');
    await GET(req, { params: Promise.resolve({ id: 'biz-1' }) });

    // The enrollment query is the LAST sql call.
    const enrollmentQuery = queryText(mockSql.mock.calls.length - 1);
    expect(enrollmentQuery).toMatch(/channel_enrollments/);
    expect(enrollmentQuery).toMatch(/e\.archived_at IS NULL/);
  });
});

describe('GET /api/admin/businesses/[id]/channels — account-scoped org-default', () => {
  beforeEach(() => {
    mockSql.mockClear();
    sqlReturnQueue.length = 0;
  });

  it('keys the enrollment read by account_id with org-default + per-location predicate', async () => {
    sqlReturnQueue.push([{ account_id: ACCOUNT_ID }]); // account resolution
    sqlReturnQueue.push([]); // enrollments

    const req = new NextRequest(`http://localhost/api/admin/businesses/${L2}/channels`);
    await GET(req, { params: Promise.resolve({ id: L2 }) });

    const enrollmentQuery = queryText(mockSql.mock.calls.length - 1);
    expect(enrollmentQuery).toMatch(/account_id\s*=/);
    expect(enrollmentQuery).toMatch(/location_id\s*=/);
    expect(enrollmentQuery).toMatch(/location_id IS NULL/);
  });

  it('surfaces an org-default row created under L1 when viewing L2 detail', async () => {
    // Org-default row was created under location L1 (location_id IS NULL,
    // account-scoped). Viewing L2's detail page must still surface it — admin
    // start/disable act on this exact row regardless of which location is open.
    sqlReturnQueue.push([{ account_id: ACCOUNT_ID }]); // account resolution
    sqlReturnQueue.push([
      {
        channel: 'telegram',
        handle: '123456789',
        status: 'verified',
        verified_at: new Date('2026-01-01T00:00:00Z'),
        disabled_at: null,
        unsubscribed_at: null,
        unsubscribed_reason: null,
        expires_at: null,
        last_activity_at: null,
        location_id: null, // org-default
      },
    ]);

    const req = new NextRequest(`http://localhost/api/admin/businesses/${L2}/channels`);
    const res = await GET(req, { params: Promise.resolve({ id: L2 }) });
    const body = (await res.json()) as {
      enrollments: Array<{ channel: string; status: string }>;
    };

    expect(body.enrollments).toHaveLength(1);
    const [enrollment] = body.enrollments;
    expect(enrollment).toBeDefined();
    expect(enrollment?.channel).toBe('telegram');
    expect(enrollment?.status).toBe('verified');
  });

  it('prefers a per-location L2 override over the org-default for the same channel', async () => {
    sqlReturnQueue.push([{ account_id: ACCOUNT_ID }]); // account resolution
    // Both rows exist for the SAME channel: org-default (NULL) + L2 override.
    // The route's ORDER BY places overrides first, so the override row arrives
    // first in this mocked result set.
    sqlReturnQueue.push([
      {
        channel: 'telegram',
        handle: '111111111',
        status: 'verified',
        verified_at: new Date('2026-01-01T00:00:00Z'),
        disabled_at: null,
        unsubscribed_at: null,
        unsubscribed_reason: null,
        expires_at: null,
        last_activity_at: null,
        location_id: L2, // per-location override — must win
      },
      {
        channel: 'telegram',
        handle: '999999999',
        status: 'verified',
        verified_at: new Date('2025-12-01T00:00:00Z'),
        disabled_at: null,
        unsubscribed_at: null,
        unsubscribed_reason: null,
        expires_at: null,
        last_activity_at: null,
        location_id: null, // org-default — must lose
      },
    ]);

    const req = new NextRequest(`http://localhost/api/admin/businesses/${L2}/channels`);
    const res = await GET(req, { params: Promise.resolve({ id: L2 }) });
    const body = (await res.json()) as {
      enrollments: Array<{ channel: string; handle: string }>;
    };

    // One effective enrollment per channel, and it's the per-location override.
    expect(body.enrollments).toHaveLength(1);
    const [enrollment] = body.enrollments;
    expect(enrollment).toBeDefined();
    expect(enrollment?.channel).toBe('telegram');
    // telegram handle is masked to last 4 digits: 111111111 -> '••• 1111'
    expect(enrollment?.handle).toBe('••• 1111');
  });

  it('returns empty enrollments and skips the enrollment query when the location is unknown', async () => {
    sqlReturnQueue.push([]); // account resolution: no row

    const req = new NextRequest(`http://localhost/api/admin/businesses/${L1}/channels`);
    const res = await GET(req, { params: Promise.resolve({ id: L1 }) });
    const body = (await res.json()) as { enrollments: unknown[] };

    expect(body.enrollments).toEqual([]);
    // Only the account-resolution query ran.
    expect(mockSql).toHaveBeenCalledTimes(1);
  });
});
