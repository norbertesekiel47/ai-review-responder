import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest, NextResponse } from 'next/server';
import { NO_STORE_HEADERS } from '@/lib/shared/constants';

const {
  mockRequireOwnerWithAccount,
  mockListOpenEscalations,
  mockReportCaughtError,
} = vi.hoisted(() => ({
  mockRequireOwnerWithAccount: vi.fn(),
  mockListOpenEscalations: vi.fn(),
  mockReportCaughtError: vi.fn(),
}));

vi.mock('@/lib/db/server', () => ({ sql: vi.fn() }));

vi.mock('@/lib/shared/report-caught-error', () => ({
  reportCaughtError: (...args: unknown[]) => mockReportCaughtError(...args),
}));

vi.mock('@/lib/auth/route-helpers', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/auth/route-helpers')>();
  return {
    ...actual,
    requireOwnerWithAccount: (...args: unknown[]) => mockRequireOwnerWithAccount(...args),
  };
});

vi.mock('@/lib/escalations/list', () => ({
  listOpenEscalations: (...args: unknown[]) => mockListOpenEscalations(...args),
}));

import { GET } from '../route';

const ACCOUNT_ID = 'a0000000-0000-0000-0000-000000000001';

function request(): NextRequest {
  return new NextRequest('http://localhost:3000/api/dashboard/escalations');
}

describe('GET /api/dashboard/escalations', () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  it.each([401, 403])('returns the canonical %s owner-auth response without listing data', async (status) => {
    const authResponse = NextResponse.json(
      { error: status === 401 ? 'Unauthorized' : 'No account associated with this user' },
      { status, headers: NO_STORE_HEADERS },
    );
    mockRequireOwnerWithAccount.mockResolvedValue({ ok: false, response: authResponse });

    const response = await GET(request());

    expect(response).toBe(authResponse);
    expect(mockListOpenEscalations).not.toHaveBeenCalled();
  });

  it('returns the account-scoped open-escalation list unchanged', async () => {
    const result = {
      totalOpen: 1,
      items: [
        {
          id: 'escalation-1',
          status: 'escalated',
          severity: 'high',
          suggestedAction: 'escalate',
          createdAt: '2026-07-12T10:00:00.000Z',
          reviewId: 'review-1',
          businessName: 'Corner Cafe',
          reviewRating: 1,
        },
        {
          id: 'escalation-2',
          status: 'escalated',
          severity: 'medium',
          suggestedAction: 'escalate',
          createdAt: '2026-07-12T11:00:00.000Z',
          reviewId: 'review-2',
          businessName: 'Harbor Roasters',
          reviewRating: null,
        },
      ],
    };
    mockRequireOwnerWithAccount.mockResolvedValue({
      ok: true,
      user: { id: 'user-1', accountId: ACCOUNT_ID },
      accountId: ACCOUNT_ID,
    });
    mockListOpenEscalations.mockResolvedValue(result);

    const response = await GET(request());

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual(result);
    expect(response.headers.get('Cache-Control')).toBe('no-store, private');
    expect(mockListOpenEscalations).toHaveBeenCalledWith(expect.any(Function), {
      accountId: ACCOUNT_ID,
    });
  });

  it('maps an unexpected listing failure to the shared 500 dashboard-read boundary', async () => {
    mockRequireOwnerWithAccount.mockResolvedValue({
      ok: true,
      user: { id: 'user-1', accountId: ACCOUNT_ID },
      accountId: ACCOUNT_ID,
    });
    const failure = new Error('connection reset');
    mockListOpenEscalations.mockRejectedValue(failure);

    const response = await GET(request());

    expect(response.status).toBe(500);
    await expect(response.json()).resolves.toEqual({ error: 'Failed to fetch escalations' });
    expect(mockReportCaughtError).toHaveBeenCalledWith(
      'api/dashboard/escalations',
      failure,
      { accountId: ACCOUNT_ID },
    );
  });

  it('preserves requireOwnerWithAccount rethrows outside the 500 boundary', async () => {
    const authInfraFailure = new Error('auth infrastructure down');
    mockRequireOwnerWithAccount.mockRejectedValue(authInfraFailure);

    await expect(GET(request())).rejects.toBe(authInfraFailure);
    expect(mockListOpenEscalations).not.toHaveBeenCalled();
    expect(mockReportCaughtError).not.toHaveBeenCalled();
  });
});
