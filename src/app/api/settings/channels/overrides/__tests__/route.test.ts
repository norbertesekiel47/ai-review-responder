import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';

const { mockRequireRole, mockSql, mockGetLocationsForAccount } = vi.hoisted(() => ({
  mockRequireRole: vi.fn(),
  mockSql: vi.fn(),
  mockGetLocationsForAccount: vi.fn(),
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

vi.mock('@/lib/db/server', () => ({
  sql: (...args: unknown[]) => mockSql(...args),
}));

vi.mock('@/lib/locations/repo', () => ({
  getLocationsForAccount: (...args: unknown[]) => mockGetLocationsForAccount(...args),
}));

import { GET } from '../route';

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

describe('GET /api/settings/channels/overrides', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockRequireRole.mockResolvedValue(ownerUser());
  });

  it('maps per-location overrides to display labels', async () => {
    mockSql.mockResolvedValueOnce([
      {
        id: 'enrollment-1',
        channel: 'telegram',
        handle: '@downtown',
        status: 'verified',
        verified_at: new Date('2026-01-02T03:04:05.000Z'),
        location_id: LOCATION_ID,
      },
    ]);
    mockGetLocationsForAccount.mockResolvedValueOnce([
      {
        id: LOCATION_ID,
        account_id: ACCOUNT_ID,
        name: 'Downtown Cafe',
        display_label: 'Downtown',
        is_primary: true,
        archived_at: null,
        google_place_id: 'place-1',
        google_place_address: null,
        created_at: new Date('2026-01-01T00:00:00.000Z'),
      },
    ]);

    const res = await GET(makeRequest());

    expect(res.status).toBe(200);
    expect(mockSql).toHaveBeenCalledTimes(1);
    expect(mockGetLocationsForAccount).toHaveBeenCalledWith(ACCOUNT_ID);
    await expect(res.json()).resolves.toEqual({
      overrides: [
        {
          enrollmentId: 'enrollment-1',
          locationId: LOCATION_ID,
          locationName: 'Downtown',
          channel: 'telegram',
          handle: '@downtown',
          status: 'verified',
          verified_at: '2026-01-02T03:04:05.000Z',
        },
      ],
    });
  });
});
