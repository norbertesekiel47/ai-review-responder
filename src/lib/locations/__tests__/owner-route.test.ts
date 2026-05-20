import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';

const { mockRequireRole } = vi.hoisted(() => ({
  mockRequireRole: vi.fn(),
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

import {
  ownerAccountMismatchResponse,
  readOwnerForMultiLocationRoute,
} from '@/lib/locations/owner-route';
import { AuthError } from '@/lib/db/auth';

const ACCOUNT_ID = 'aaaaaaaa-0000-0000-0000-000000000001';

function req() {
  return new NextRequest('http://localhost:3000/api/locations/test', { method: 'POST' });
}

describe('location owner route helpers', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockRequireRole.mockReset();
    process.env.MULTI_LOCATION_ENABLED = 'true';
  });

  it('returns 404 before auth when multi-location is disabled', async () => {
    process.env.MULTI_LOCATION_ENABLED = 'false';

    const result = await readOwnerForMultiLocationRoute(req());

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.response.status).toBe(404);
      expect(await result.response.json()).toEqual({ error: 'not_found' });
    }
    expect(mockRequireRole).not.toHaveBeenCalled();
  });

  it('maps AuthError to the route response status and message', async () => {
    mockRequireRole.mockRejectedValueOnce(new AuthError('Forbidden', 403));

    const result = await readOwnerForMultiLocationRoute(req());

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.response.status).toBe(403);
      expect(await result.response.json()).toEqual({ error: 'Forbidden' });
    }
  });

  it('returns an owner when auth succeeds and account is scoped', async () => {
    mockRequireRole.mockResolvedValueOnce({ id: 'user-1', accountId: ACCOUNT_ID, role: 'owner' });

    const result = await readOwnerForMultiLocationRoute(req());

    expect(result.ok).toBe(true);
    if (result.ok) expect(result.user.accountId).toBe(ACCOUNT_ID);
  });

  it('builds the standard account mismatch response', async () => {
    const response = ownerAccountMismatchResponse();

    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({ error: 'Account ID mismatch' });
  });
});
