import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';

const {
  mockRequireRole,
  mockAssertWritableSubscriptionForAccount,
  mockUpdateDisplayLabel,
} = vi.hoisted(() => ({
  mockRequireRole: vi.fn(),
  mockAssertWritableSubscriptionForAccount: vi.fn(),
  mockUpdateDisplayLabel: vi.fn(),
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
  sql: vi.fn(),
}));

vi.mock('@/lib/shared/writable-subscription', () => ({
  assertWritableSubscriptionForAccount: (...args: unknown[]) => mockAssertWritableSubscriptionForAccount(...args),
}));

vi.mock('@/lib/locations/update-display-label', () => ({
  updateDisplayLabel: (...args: unknown[]) => mockUpdateDisplayLabel(...args),
}));

import { PUT } from '../route';

const ACCOUNT_ID = 'aaaaaaaa-0000-0000-0000-000000000001';
const LOCATION_ID = 'bbbbbbbb-0000-0000-0000-000000000001';
const USER_ID = 'uuuuuuuu-0000-0000-0000-000000000001';
const APP_URL = 'http://localhost:3000';

function request(): NextRequest {
  return new NextRequest('http://localhost:3000/api/locations/display-label', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json', Origin: APP_URL },
    body: JSON.stringify({
      locationId: LOCATION_ID,
      accountId: ACCOUNT_ID,
      displayLabel: 'Downtown',
    }),
  });
}

describe('PUT /api/locations/display-label', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    process.env.NEXT_PUBLIC_APP_URL = APP_URL;
    mockRequireRole.mockResolvedValue({
      id: USER_ID,
      role: 'owner',
      accountId: ACCOUNT_ID,
      locationId: LOCATION_ID,
    });
    mockAssertWritableSubscriptionForAccount.mockResolvedValue({ ok: true });
    mockUpdateDisplayLabel.mockResolvedValue({ updated: true, displayLabel: 'Downtown' });
  });

  it('updates the display label when the account is writable', async () => {
    const res = await PUT(request());

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ success: true, displayLabel: 'Downtown' });
    expect(mockUpdateDisplayLabel).toHaveBeenCalledWith(
      expect.anything(),
      LOCATION_ID,
      ACCOUNT_ID,
      'Downtown',
      USER_ID,
    );
  });

  it('returns 402 without updating when the account is past-due read-only', async () => {
    mockAssertWritableSubscriptionForAccount.mockResolvedValueOnce({
      ok: false,
      status: 402,
      error: 'past_due_read_only',
    });

    const res = await PUT(request());

    expect(res.status).toBe(402);
    expect(await res.json()).toEqual({ error: 'past_due_read_only' });
    expect(mockAssertWritableSubscriptionForAccount).toHaveBeenCalledWith(ACCOUNT_ID, expect.anything());
    expect(mockUpdateDisplayLabel).not.toHaveBeenCalled();
  });
});
