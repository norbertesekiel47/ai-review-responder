import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';

const { mockRequireRole, mockGetChannelOverridesView } = vi.hoisted(() => ({
  mockRequireRole: vi.fn(),
  mockGetChannelOverridesView: vi.fn(),
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

// The route is a pure parse → auth → call → respond shell; the view module
// owns the query + DTO mapping contract (see overrides-view.test.ts).
vi.mock('@/lib/channels/overrides-view', () => ({
  getChannelOverridesView: (...args: unknown[]) => mockGetChannelOverridesView(...args),
}));

import { GET } from '../route';
import { AuthError } from '@/lib/db/auth';

const ACCOUNT_ID = 'a0000000-0000-4000-8000-000000000001';
const LOCATION_ID = 'b1111111-0000-4000-8000-000000000001';

function makeRequest(): NextRequest {
  return new NextRequest('http://localhost:3000/api/settings/channels/overrides');
}

function ownerUser() {
  return {
    id: 'user-1',
    name: 'Test Owner',
    email: 'owner@test.com',
    role: 'owner',
    accountId: ACCOUNT_ID,
    locationId: LOCATION_ID,
  };
}

const FULL_VIEW = {
  overrides: [
    {
      enrollmentId: 'enrollment-1',
      locationId: LOCATION_ID,
      locationName: 'Downtown',
      archived: false,
      channel: 'telegram',
      handle: '@downtown',
      status: 'verified',
      verified_at: '2026-01-02T03:04:05.000Z',
    },
  ],
  locations: [
    { id: LOCATION_ID, displayName: 'Downtown', isPrimary: true, archived: false },
  ],
  verifiedOrgChannels: ['email', 'telegram'],
};

describe('GET /api/settings/channels/overrides', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockRequireRole.mockResolvedValue(ownerUser());
    mockGetChannelOverridesView.mockResolvedValue(FULL_VIEW);
  });

  it('returns the FULL override view for the authed account (overrides + locations + verifiedOrgChannels)', async () => {
    const res = await GET(makeRequest());

    expect(res.status).toBe(200);
    expect(mockGetChannelOverridesView).toHaveBeenCalledExactlyOnceWith(expect.any(Function), ACCOUNT_ID);
    await expect(res.json()).resolves.toEqual(FULL_VIEW);
  });

  it('returns 401 without calling the view when auth fails', async () => {
    mockRequireRole.mockRejectedValue(new AuthError('Unauthorized', 401));

    const res = await GET(makeRequest());

    expect(res.status).toBe(401);
    expect(mockGetChannelOverridesView).not.toHaveBeenCalled();
  });

  it('returns 403 without calling the view when the owner has no account', async () => {
    mockRequireRole.mockResolvedValue({ ...ownerUser(), accountId: null });

    const res = await GET(makeRequest());

    expect(res.status).toBe(403);
    expect(mockGetChannelOverridesView).not.toHaveBeenCalled();
  });
});
