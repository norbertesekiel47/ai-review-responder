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

// Admin/sales_partner auth: stub requireRole to a no-op so the handler
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

describe('GET /api/admin/businesses/[id]/channels — archived rows', () => {
  beforeEach(() => {
    mockSql.mockClear();
    sqlReturnQueue.length = 0;
  });

  it('filters query by archived_at IS NULL (query shape assertion)', async () => {
    sqlReturnQueue.push([]); // no enrollments
    const req = new NextRequest('http://localhost/api/admin/businesses/biz-1/channels');
    await GET(req, { params: Promise.resolve({ id: 'biz-1' }) });

    expect(mockSql).toHaveBeenCalled();
    const [template] = mockSql.mock.calls[0] as [TemplateStringsArray, ...unknown[]];
    const queryText = template.join('?');
    expect(queryText).toMatch(/channel_enrollments/);
    expect(queryText).toMatch(/e\.archived_at IS NULL/);
  });
});
