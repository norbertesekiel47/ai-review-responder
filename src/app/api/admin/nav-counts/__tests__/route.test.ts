import { NextRequest, NextResponse } from 'next/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const { mockRequireRoleOr401, mockGetAdminNavCounts } = vi.hoisted(() => ({
  mockRequireRoleOr401: vi.fn(),
  mockGetAdminNavCounts: vi.fn(),
}));

vi.mock('@/lib/db/server', () => ({ sql: vi.fn() }));
vi.mock('@/lib/auth/route-helpers', () => ({ requireRoleOr401: mockRequireRoleOr401 }));
vi.mock('@/lib/admin/nav-counts-service', () => ({ getAdminNavCounts: mockGetAdminNavCounts }));
vi.mock('@/lib/shared/report-caught-error', () => ({ reportCaughtError: vi.fn() }));

import { GET } from '../route';

function request(): NextRequest {
  return new NextRequest('http://localhost/api/admin/nav-counts');
}

describe('GET /api/admin/nav-counts', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns 401 when the admin gate rejects', async () => {
    mockRequireRoleOr401.mockResolvedValue({
      ok: false,
      response: NextResponse.json({ error: 'unauthorized' }, { status: 401 }),
    });

    const response = await GET(request());

    expect(response.status).toBe(401);
    expect(mockGetAdminNavCounts).not.toHaveBeenCalled();
  });

  it('returns the counts with no-store caching', async () => {
    mockRequireRoleOr401.mockResolvedValue({ ok: true, user: { id: 'admin-1' } });
    mockGetAdminNavCounts.mockResolvedValue({ flaggedOpen: 3, failedJobs: 1 });

    const response = await GET(request());

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ flaggedOpen: 3, failedJobs: 1 });
    expect(response.headers.get('Cache-Control')).toBe('no-store, private');
  });

  it('returns 500 when the service throws', async () => {
    mockRequireRoleOr401.mockResolvedValue({ ok: true, user: { id: 'admin-1' } });
    mockGetAdminNavCounts.mockRejectedValue(new Error('db down'));

    const response = await GET(request());

    expect(response.status).toBe(500);
  });
});
