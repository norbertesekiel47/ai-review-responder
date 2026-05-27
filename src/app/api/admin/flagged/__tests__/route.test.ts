import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';

const { mockRequireRole, mockSql } = vi.hoisted(() => {
  const mockSql: any = vi.fn(() => Promise.resolve([]));
  return { mockRequireRole: vi.fn(), mockSql };
});

vi.mock('@/lib/db/auth', () => ({
  requireRole: mockRequireRole,
  AuthError: class AuthError extends Error {
    constructor(message: string, public readonly statusCode: number) {
      super(message);
    }
  },
}));

vi.mock('@/lib/db/server', () => ({ sql: mockSql, jsonb: (v: unknown) => ({ __jsonb: v }) }));

import { GET } from '../route';

function getReq(): NextRequest {
  return new NextRequest('https://app.example.com/api/admin/flagged?limit=20&offset=0');
}

describe('GET /api/admin/flagged', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockRequireRole.mockResolvedValue({ id: 'admin-1', role: 'admin' });
  });

  it('returns 403 for non-admins', async () => {
    const { AuthError } = await import('@/lib/db/auth');
    mockRequireRole.mockRejectedValueOnce(new AuthError('Forbidden', 403));
    const res = await GET(getReq());
    expect(res.status).toBe(403);
  });

  it('lists open flags mapped to the display shape', async () => {
    mockSql.mockResolvedValueOnce([
      {
        id: 'flag-1', response_id: 'resp-1', business_id: 'biz-1', account_id: 'acct-1',
        review_id: 'rev-1', source: 'local_regex', reason: 'refund_discount', severity: 'high',
        status: 'open', created_at: '2026-05-26T00:00:00.000Z', response_text: 'Here is a full refund.',
        version: 1, reviewer_name: 'Jane', star_rating: 2, business_name: 'Bella Italia',
      },
    ]);

    const res = await GET(getReq());
    expect(res.status).toBe(200);
    const body = (await res.json()) as { flagged: Array<Record<string, unknown>> };
    expect(body.flagged).toHaveLength(1);
    expect(body.flagged[0]).toMatchObject({
      id: 'flag-1',
      responseId: 'resp-1',
      businessName: 'Bella Italia',
      severity: 'high',
      reason: 'refund_discount',
      responseText: 'Here is a full refund.',
      reviewerName: 'Jane',
      starRating: 2,
    });
  });
});
