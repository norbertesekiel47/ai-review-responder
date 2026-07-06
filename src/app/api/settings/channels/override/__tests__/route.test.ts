// Route-level tests: auth gates, body parsing, and status-mapping of the
// override module's result unions. The business-logic contract (pre-checks,
// revive-vs-insert, audit, cache invalidation) is owned by
// src/lib/channels/__tests__/override.test.ts.

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NextRequest } from 'next/server';

const { mockRequireRole, mockAssertWritableSubscriptionForAccount, mockCreateOrRevive, mockRemove } =
  vi.hoisted(() => ({
    mockRequireRole: vi.fn(),
    mockAssertWritableSubscriptionForAccount: vi.fn(),
    mockCreateOrRevive: vi.fn(),
    mockRemove: vi.fn(),
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

vi.mock('@/lib/shared/writable-subscription', () => ({
  assertWritableSubscriptionForAccount: (...args: unknown[]) =>
    mockAssertWritableSubscriptionForAccount(...args),
}));

vi.mock('@/lib/channels/override', () => ({
  createOrReviveOverride: (...args: unknown[]) => mockCreateOrRevive(...args),
  removeOverride: (...args: unknown[]) => mockRemove(...args),
}));

// Import AFTER mocks
import { POST, DELETE } from '../route';
import { AuthError } from '@/lib/db/auth';

const ACCOUNT_ID = 'a0000000-0000-4000-8000-000000000001';
const LOCATION_ID = 'b1111111-0000-4000-8000-000000000001';
const OVERRIDE_ID = 'e0000000-0000-4000-8000-000000000002';
const APP_URL = 'http://localhost:3000';

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

function makeRequest(method: 'POST' | 'DELETE', body: unknown): NextRequest {
  return new NextRequest('http://localhost:3000/api/settings/channels/override', {
    method,
    headers: { 'Content-Type': 'application/json', Origin: APP_URL },
    body: JSON.stringify(body),
  });
}

const VALID_BODY = { locationId: LOCATION_ID, channel: 'telegram' };

beforeEach(() => {
  vi.clearAllMocks();
  mockRequireRole.mockResolvedValue(ownerUser());
  mockAssertWritableSubscriptionForAccount.mockResolvedValue({ ok: true });
  process.env.NEXT_PUBLIC_APP_URL = APP_URL;
});

describe('POST /api/settings/channels/override — auth + parsing', () => {
  it('returns 401 when not authenticated, without calling the module', async () => {
    mockRequireRole.mockRejectedValue(new AuthError('Unauthorized', 401));
    const res = await POST(makeRequest('POST', VALID_BODY));
    expect(res.status).toBe(401);
    expect(mockCreateOrRevive).not.toHaveBeenCalled();
  });

  it('returns 403 when the user has no account', async () => {
    mockRequireRole.mockResolvedValue({ ...ownerUser(), accountId: null });
    const res = await POST(makeRequest('POST', VALID_BODY));
    expect(res.status).toBe(403);
    expect(mockCreateOrRevive).not.toHaveBeenCalled();
  });

  it('returns 402 without touching the module when the account is past-due read-only', async () => {
    mockAssertWritableSubscriptionForAccount.mockResolvedValueOnce({
      ok: false,
      status: 402,
      error: 'past_due_read_only',
    });
    const res = await POST(makeRequest('POST', VALID_BODY));
    expect(res.status).toBe(402);
    expect(await res.json()).toEqual({ error: 'past_due_read_only' });
    expect(mockAssertWritableSubscriptionForAccount).toHaveBeenCalledWith(ACCOUNT_ID, expect.anything());
    expect(mockCreateOrRevive).not.toHaveBeenCalled();
  });

  it('returns 400 for an invalid channel', async () => {
    const res = await POST(makeRequest('POST', { locationId: LOCATION_ID, channel: 'invalid_channel' }));
    expect(res.status).toBe(400);
    expect(mockCreateOrRevive).not.toHaveBeenCalled();
  });

  it('rejects channel "sms" with 400 (channel removed)', async () => {
    const res = await POST(makeRequest('POST', { locationId: LOCATION_ID, channel: 'sms' }));
    expect(res.status).toBe(400);
  });

  it('forwards accountId/actorUserId/locationId/channel to the module', async () => {
    mockCreateOrRevive.mockResolvedValue({
      kind: 'created',
      override: { id: OVERRIDE_ID, locationId: LOCATION_ID, channel: 'telegram', handle: '@h', status: 'verified' },
    });
    await POST(makeRequest('POST', VALID_BODY));
    expect(mockCreateOrRevive).toHaveBeenCalledWith(expect.any(Function), {
      accountId: ACCOUNT_ID,
      actorUserId: 'user-1',
      locationId: LOCATION_ID,
      channel: 'telegram',
    });
  });
});

describe('POST /api/settings/channels/override — status mapping', () => {
  it.each([
    ['not_eligible', 403, 'not_eligible'],
    ['location_not_found', 404, 'Location not found or not accessible'],
    ['no_org_default', 404, 'No org-default enrollment found for this channel'],
    ['conflict', 409, 'Override already exists for this location and channel'],
  ] as const)('%s → %i', async (kind, status, error) => {
    mockCreateOrRevive.mockResolvedValue({ kind });
    const res = await POST(makeRequest('POST', VALID_BODY));
    expect(res.status).toBe(status);
    expect(await res.json()).toEqual({ error });
  });

  it.each(['created', 'revived'] as const)('%s → 201 with the override payload', async (kind) => {
    const override = {
      id: OVERRIDE_ID,
      locationId: LOCATION_ID,
      channel: 'telegram',
      handle: '@org_bot',
      status: 'verified',
    };
    mockCreateOrRevive.mockResolvedValue({ kind, override });
    const res = await POST(makeRequest('POST', VALID_BODY));
    expect(res.status).toBe(201);
    expect(await res.json()).toEqual({ success: true, override });
  });

  it('module throw → 500', async () => {
    mockCreateOrRevive.mockRejectedValue(new Error('db down'));
    const res = await POST(makeRequest('POST', VALID_BODY));
    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ error: 'Failed to create override' });
  });
});

describe('DELETE /api/settings/channels/override — status mapping', () => {
  it('ok → 200 { success: true }', async () => {
    mockRemove.mockResolvedValue({ kind: 'ok' });
    const res = await DELETE(makeRequest('DELETE', VALID_BODY));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ success: true });
    expect(mockRemove).toHaveBeenCalledWith(expect.any(Function), {
      accountId: ACCOUNT_ID,
      actorUserId: 'user-1',
      locationId: LOCATION_ID,
      channel: 'telegram',
    });
  });

  it('not_found → 404', async () => {
    mockRemove.mockResolvedValue({ kind: 'not_found' });
    const res = await DELETE(makeRequest('DELETE', VALID_BODY));
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: 'No override found for this location and channel' });
  });

  it('module throw → 500', async () => {
    mockRemove.mockRejectedValue(new Error('db down'));
    const res = await DELETE(makeRequest('DELETE', VALID_BODY));
    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ error: 'Failed to remove override' });
  });

  it('returns 401 when not authenticated', async () => {
    mockRequireRole.mockRejectedValue(new AuthError('Unauthorized', 401));
    const res = await DELETE(makeRequest('DELETE', VALID_BODY));
    expect(res.status).toBe(401);
    expect(mockRemove).not.toHaveBeenCalled();
  });

  it('returns 400 for an invalid channel', async () => {
    const res = await DELETE(makeRequest('DELETE', { locationId: LOCATION_ID, channel: 'invalid' }));
    expect(res.status).toBe(400);
  });

  it('returns 402 without touching the module when the account is past-due read-only', async () => {
    mockAssertWritableSubscriptionForAccount.mockResolvedValueOnce({
      ok: false,
      status: 402,
      error: 'past_due_read_only',
    });
    const res = await DELETE(makeRequest('DELETE', VALID_BODY));
    expect(res.status).toBe(402);
    expect(await res.json()).toEqual({ error: 'past_due_read_only' });
    expect(mockRemove).not.toHaveBeenCalled();
  });
});
