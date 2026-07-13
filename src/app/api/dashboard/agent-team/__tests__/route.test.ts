import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest, NextResponse } from 'next/server';
import { NO_STORE_HEADERS } from '@/lib/shared/constants';
import { DASHBOARD_WINDOWS } from '@/lib/kpi/types';

const {
  mockRequireOwnerWithAccount,
  mockGetLocationById,
  mockGetAgentTeamSummary,
} = vi.hoisted(() => ({
  mockRequireOwnerWithAccount: vi.fn(),
  mockGetLocationById: vi.fn(),
  mockGetAgentTeamSummary: vi.fn(),
}));

vi.mock('@/lib/db/server', () => ({ sql: vi.fn() }));

vi.mock('@/lib/auth/route-helpers', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/auth/route-helpers')>();
  return {
    ...actual,
    requireOwnerWithAccount: (...args: unknown[]) => mockRequireOwnerWithAccount(...args),
  };
});

vi.mock('@/lib/locations/repo', () => ({
  getLocationById: (...args: unknown[]) => mockGetLocationById(...args),
}));

vi.mock('@/lib/agents/read', () => ({
  getAgentTeamSummary: (...args: unknown[]) => mockGetAgentTeamSummary(...args),
}));

import { GET } from '../route';

const BUSINESS_ID = '01234567-0000-0000-0000-000000000001';
const ACCOUNT_ID = 'a0000000-0000-0000-0000-000000000001';

function request(path = '/api/dashboard/agent-team'): NextRequest {
  return new NextRequest(`http://localhost:3000${path}`);
}

describe('GET /api/dashboard/agent-team', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    process.env.MULTI_LOCATION_ENABLED = 'false';
  });

  it('returns the location-scoped agent summary using the default dashboard window', async () => {
    mockRequireOwnerWithAccount.mockResolvedValue({
      ok: true,
      user: { id: 'user-1', accountId: ACCOUNT_ID, locationId: BUSINESS_ID },
      accountId: ACCOUNT_ID,
    });
    mockGetLocationById.mockResolvedValue({
      id: BUSINESS_ID,
      account_id: ACCOUNT_ID,
      archived_at: null,
    });
    mockGetAgentTeamSummary.mockResolvedValue({ reply: 4, guardian: 2, insights: 1 });

    const response = await GET(request());

    expect(response.status).toBe(200);
    expect(response.headers.get('Cache-Control')).toBe('no-store, private');
    await expect(response.json()).resolves.toEqual({
      window: '30d',
      reply: 4,
      guardian: 2,
      insights: 1,
    });
    expect(mockGetAgentTeamSummary).toHaveBeenCalledWith(expect.any(Function), {
      kind: 'location',
      accountId: ACCOUNT_ID,
      businessId: BUSINESS_ID,
    }, '30d');
  });

  it.each([401, 403])('returns the canonical %s owner-auth response without reading data', async (status) => {
    const authResponse = NextResponse.json(
      { error: status === 401 ? 'Unauthorized' : 'No account associated with this user' },
      { status, headers: NO_STORE_HEADERS },
    );
    mockRequireOwnerWithAccount.mockResolvedValue({ ok: false, response: authResponse });

    const response = await GET(request());

    expect(response).toBe(authResponse);
    expect(mockGetLocationById).not.toHaveBeenCalled();
    expect(mockGetAgentTeamSummary).not.toHaveBeenCalled();
  });

  it('clamps an invalid window to 30d before it reaches the read module', async () => {
    mockRequireOwnerWithAccount.mockResolvedValue({
      ok: true,
      user: { id: 'user-1', accountId: ACCOUNT_ID, locationId: BUSINESS_ID },
      accountId: ACCOUNT_ID,
    });
    mockGetLocationById.mockResolvedValue({
      id: BUSINESS_ID,
      account_id: ACCOUNT_ID,
      archived_at: null,
    });
    mockGetAgentTeamSummary.mockResolvedValue({ reply: 0, guardian: 0, insights: 0 });

    const response = await GET(request('/api/dashboard/agent-team?window=invalid'));

    expect(response.status).toBe(200);
    expect(mockGetAgentTeamSummary).toHaveBeenCalledWith(
      expect.any(Function),
      expect.any(Object),
      '30d',
    );
    await expect(response.json()).resolves.toMatchObject({ window: '30d' });
  });

  it.each(DASHBOARD_WINDOWS)('accepts the canonical %s dashboard window', async (window) => {
    mockRequireOwnerWithAccount.mockResolvedValue({
      ok: true,
      user: { id: 'user-1', accountId: ACCOUNT_ID, locationId: BUSINESS_ID },
      accountId: ACCOUNT_ID,
    });
    mockGetLocationById.mockResolvedValue({
      id: BUSINESS_ID,
      account_id: ACCOUNT_ID,
      archived_at: null,
    });
    mockGetAgentTeamSummary.mockResolvedValue({ reply: 1, guardian: 0, insights: 0 });

    const response = await GET(request(`/api/dashboard/agent-team?window=${window}`));

    expect(response.status).toBe(200);
    expect(mockGetAgentTeamSummary).toHaveBeenCalledWith(
      expect.any(Function),
      expect.any(Object),
      window,
    );
  });

  it('returns an account-wide summary for aggregate scope and preserves a valid window', async () => {
    process.env.MULTI_LOCATION_ENABLED = 'true';
    mockRequireOwnerWithAccount.mockResolvedValue({
      ok: true,
      user: { id: 'user-1', accountId: ACCOUNT_ID, locationId: BUSINESS_ID },
      accountId: ACCOUNT_ID,
    });
    mockGetAgentTeamSummary.mockResolvedValue({ reply: 8, guardian: 3, insights: 2 });

    const response = await GET(request('/api/dashboard/agent-team?scope=all&window=90d'));

    expect(response.status).toBe(200);
    expect(mockGetLocationById).not.toHaveBeenCalled();
    expect(mockGetAgentTeamSummary).toHaveBeenCalledWith(
      expect.any(Function),
      { kind: 'account', accountId: ACCOUNT_ID },
      '90d',
    );
    await expect(response.json()).resolves.toEqual({
      window: '90d',
      reply: 8,
      guardian: 3,
      insights: 2,
    });
  });

  it('returns 404 without reading outcomes when a requested location belongs to another account', async () => {
    process.env.MULTI_LOCATION_ENABLED = 'true';
    mockRequireOwnerWithAccount.mockResolvedValue({
      ok: true,
      user: { id: 'user-1', accountId: ACCOUNT_ID, locationId: BUSINESS_ID },
      accountId: ACCOUNT_ID,
    });
    mockGetLocationById.mockResolvedValue({
      id: BUSINESS_ID,
      account_id: 'b0000000-0000-0000-0000-000000000099',
      archived_at: null,
    });

    const response = await GET(request(`/api/dashboard/agent-team?scope=${BUSINESS_ID}`));

    expect(response.status).toBe(404);
    expect(response.headers.get('Cache-Control')).toBe('no-store, private');
    await expect(response.json()).resolves.toEqual({ error: 'Business not found' });
    expect(mockGetLocationById).toHaveBeenCalledWith(expect.any(Function), BUSINESS_ID);
    expect(mockGetAgentTeamSummary).not.toHaveBeenCalled();
  });

  it('returns the uniform 404 without reading outcomes when the location does not exist', async () => {
    mockRequireOwnerWithAccount.mockResolvedValue({
      ok: true,
      user: { id: 'user-1', accountId: ACCOUNT_ID, locationId: BUSINESS_ID },
      accountId: ACCOUNT_ID,
    });
    mockGetLocationById.mockResolvedValue(null);

    const response = await GET(request());

    expect(response.status).toBe(404);
    expect(response.headers.get('Cache-Control')).toBe('no-store, private');
    await expect(response.json()).resolves.toEqual({ error: 'Business not found' });
    expect(mockGetAgentTeamSummary).not.toHaveBeenCalled();
  });

  it('returns the uniform 404 without reading outcomes when the location is archived', async () => {
    mockRequireOwnerWithAccount.mockResolvedValue({
      ok: true,
      user: { id: 'user-1', accountId: ACCOUNT_ID, locationId: BUSINESS_ID },
      accountId: ACCOUNT_ID,
    });
    mockGetLocationById.mockResolvedValue({
      id: BUSINESS_ID,
      account_id: ACCOUNT_ID,
      archived_at: new Date('2026-07-01T00:00:00.000Z'),
    });

    const response = await GET(request());

    expect(response.status).toBe(404);
    expect(response.headers.get('Cache-Control')).toBe('no-store, private');
    await expect(response.json()).resolves.toEqual({ error: 'Business not found' });
    expect(mockGetAgentTeamSummary).not.toHaveBeenCalled();
  });

  it('rejects a malformed location scope before the location or outcomes reads', async () => {
    process.env.MULTI_LOCATION_ENABLED = 'true';
    mockRequireOwnerWithAccount.mockResolvedValue({
      ok: true,
      user: { id: 'user-1', accountId: ACCOUNT_ID, locationId: BUSINESS_ID },
      accountId: ACCOUNT_ID,
    });

    const response = await GET(request('/api/dashboard/agent-team?scope=not-a-uuid'));

    expect(response.status).toBe(400);
    expect(response.headers.get('Cache-Control')).toBe('no-store, private');
    expect(mockGetLocationById).not.toHaveBeenCalled();
    expect(mockGetAgentTeamSummary).not.toHaveBeenCalled();
  });
});
