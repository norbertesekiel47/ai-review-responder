import { describe, expect, it, vi, beforeEach } from 'vitest';
import { NextRequest } from 'next/server';

// ── Hoisted mocks ──────────────────────────────────────────────────────

const { mockRequireRole } = vi.hoisted(() => ({
  mockRequireRole: vi.fn(),
}));

const { mockAssertWritableSubscriptionForAccount } = vi.hoisted(() => ({
  mockAssertWritableSubscriptionForAccount: vi.fn(),
}));

const { mockGetOffboardingState } = vi.hoisted(() => ({
  mockGetOffboardingState: vi.fn(),
}));

vi.mock('@/lib/account-offboarding/gate', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/account-offboarding/gate')>();
  return {
    ...actual,
    getOffboardingState: (...args: unknown[]) => mockGetOffboardingState(...args),
    createOffboardingGate: () => {
      const cache = new Map<string, Promise<unknown>>();
      return {
        getOffboardingState: (accountId: string) => {
          const cached = cache.get(accountId);
          if (cached) return cached;
          const loaded = Promise.resolve(mockGetOffboardingState(accountId));
          cache.set(accountId, loaded);
          return loaded;
        },
        isBlocked: actual.isOffboardingIntentBlocked,
      };
    },
  };
});

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
  assertWritableSubscriptionForAccount: (...args: unknown[]) => mockAssertWritableSubscriptionForAccount(...args),
}));

const {
  mockAssertCanAddLocation,
  mockReactivateLocationTransaction,
  mockGetAccountOwnerUserId,
  mockGetLocationById,
  mockSql,
} = vi.hoisted(() => ({
  mockAssertCanAddLocation: vi.fn(),
  mockReactivateLocationTransaction: vi.fn(),
  mockGetAccountOwnerUserId: vi.fn(),
  mockGetLocationById: vi.fn(),
  mockSql: vi.fn(),
}));

vi.mock('@/lib/accounts/quota', () => ({
  assertCanAddLocation: mockAssertCanAddLocation,
}));

vi.mock('@/lib/locations/archive-location-tx', () => ({
  reactivateLocationTransaction: mockReactivateLocationTransaction,
}));

vi.mock('@/lib/accounts/repo', () => ({
  getAccountOwnerUserId: mockGetAccountOwnerUserId,
}));

vi.mock('@/lib/locations/repo', () => ({
  getLocationById: mockGetLocationById,
}));

vi.mock('@/lib/db/server', () => ({
  sql: mockSql,
}));

process.env.MULTI_LOCATION_ENABLED = 'true';

import { POST } from '../route';
import { AuthError } from '@/lib/db/auth';

// ── Helpers ────────────────────────────────────────────────────────────

const ACCOUNT_ID = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
const OTHER_ACCOUNT_ID = '99999999-8888-7777-6666-555555555555';
const LOCATION_ID = '11111111-2222-3333-4444-555555555555';
const USER_ID = 'uuuuuuuu-0000-0000-0000-000000000001';
const APP_URL = 'http://localhost:3000';

function mkRequest(body: Record<string, unknown>): NextRequest {
  return new NextRequest('http://localhost:3000/api/locations/reactivate', {
    method: 'POST',
    headers: { 'content-type': 'application/json', Origin: APP_URL },
    body: JSON.stringify(body),
  });
}

function ownerUser(overrides: Record<string, unknown> = {}) {
  return {
    id: USER_ID,
    name: 'Test Owner',
    email: 'owner@test.com',
    role: 'owner',
    accountId: ACCOUNT_ID,
    locationId: LOCATION_ID,
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  mockRequireRole.mockReset();
  mockAssertWritableSubscriptionForAccount.mockReset();
  mockAssertCanAddLocation.mockReset();
  mockReactivateLocationTransaction.mockReset();
  mockGetAccountOwnerUserId.mockReset();
  mockGetLocationById.mockReset();
  mockSql.mockReset();
  process.env.NEXT_PUBLIC_APP_URL = APP_URL;
  mockAssertWritableSubscriptionForAccount.mockResolvedValue({ ok: true });
  mockGetOffboardingState.mockReturnValue(null);

  // Default happy-path mocks (individual tests override as needed)
  mockRequireRole.mockResolvedValue(ownerUser());
  mockGetLocationById.mockResolvedValue({
    id: LOCATION_ID,
    account_id: ACCOUNT_ID,
    archived_at: new Date('2026-05-01'),
  });
  mockAssertCanAddLocation.mockResolvedValue({ allowed: true, overageUnits: 0 });
  mockGetAccountOwnerUserId.mockResolvedValue(USER_ID);
  mockReactivateLocationTransaction.mockResolvedValue({
    locationId: LOCATION_ID,
    reactivated: true,
    selfPromoted: false,
  });
});

// ── Tests ──────────────────────────────────────────────────────────────

describe('POST /api/locations/reactivate', () => {
  // ── Auth & ownership ──────────────────────────────────────────────────

  it('returns 401 when not authenticated', async () => {
    mockRequireRole.mockRejectedValueOnce(new AuthError('Unauthorized', 401));

    const req = mkRequest({ locationId: LOCATION_ID, accountId: ACCOUNT_ID });
    const res = await POST(req);
    expect(res.status).toBe(401);
  });

  it('returns 403 when non-owner role', async () => {
    mockRequireRole.mockRejectedValueOnce(new AuthError('Forbidden', 403));

    const req = mkRequest({ locationId: LOCATION_ID, accountId: ACCOUNT_ID });
    const res = await POST(req);
    expect(res.status).toBe(403);
  });

  it('returns 403 when user has no accountId', async () => {
    mockRequireRole.mockResolvedValueOnce(ownerUser({ accountId: null }));

    const req = mkRequest({ locationId: LOCATION_ID, accountId: ACCOUNT_ID });
    const res = await POST(req);
    expect(res.status).toBe(403);
    const body = await res.json();
    expect(body.error).toBe('No account associated with this user');
  });

  it('returns 402 before location lookup when the account is past-due read-only', async () => {
    mockAssertWritableSubscriptionForAccount.mockResolvedValueOnce({
      ok: false,
      status: 402,
      error: 'past_due_read_only',
    });

    const req = mkRequest({ locationId: LOCATION_ID, accountId: ACCOUNT_ID });
    const res = await POST(req);

    expect(res.status).toBe(402);
    expect(await res.json()).toEqual({ error: 'past_due_read_only' });
    expect(mockGetLocationById).not.toHaveBeenCalled();
    expect(mockReactivateLocationTransaction).not.toHaveBeenCalled();
  });

  it('returns 403 when body.accountId does not match authenticated user', async () => {
    // mockRequireRole returns ownerUser with ACCOUNT_ID
    // but body.accountId is OTHER_ACCOUNT_ID
    const req = mkRequest({ locationId: LOCATION_ID, accountId: OTHER_ACCOUNT_ID });
    const res = await POST(req);
    expect(res.status).toBe(403);
    const body = await res.json();
    expect(body.error).toBe('Account ID mismatch');
  });

  it('does not call getLocationById when accountId mismatches', async () => {
    const req = mkRequest({ locationId: LOCATION_ID, accountId: OTHER_ACCOUNT_ID });
    await POST(req);
    expect(mockGetLocationById).not.toHaveBeenCalled();
  });

  // ── Existing behavior ─────────────────────────────────────────────────

  it('reactivates an archived location successfully', async () => {
    const req = mkRequest({ locationId: LOCATION_ID, accountId: ACCOUNT_ID });
    const res = await POST(req);
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.reactivated).toBe(true);
    expect(mockReactivateLocationTransaction).toHaveBeenCalledWith(
      expect.objectContaining({
        locationId: LOCATION_ID,
        accountId: ACCOUNT_ID,
        actorUserId: USER_ID,
      }),
    );
  });

  // B3: the self-heal flag from the transaction must surface in the response.
  it('surfaces selfPromoted in the response body', async () => {
    mockReactivateLocationTransaction.mockResolvedValue({
      locationId: LOCATION_ID,
      reactivated: true,
      selfPromoted: true,
    });
    const req = mkRequest({ locationId: LOCATION_ID, accountId: ACCOUNT_ID });
    const res = await POST(req);
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.selfPromoted).toBe(true);
  });

  it('surfaces selfPromoted=false when no self-heal occurred', async () => {
    const req = mkRequest({ locationId: LOCATION_ID, accountId: ACCOUNT_ID });
    const res = await POST(req);
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.selfPromoted).toBe(false);
  });

  it('returns 404 when MULTI_LOCATION_ENABLED is false', async () => {
    process.env.MULTI_LOCATION_ENABLED = 'false';
    const req = mkRequest({ locationId: LOCATION_ID, accountId: ACCOUNT_ID });
    const res = await POST(req);
    expect(res.status).toBe(404);
    process.env.MULTI_LOCATION_ENABLED = 'true';
  });

  it('returns 404 for non-existent location', async () => {
    mockGetLocationById.mockResolvedValue(null);
    const req = mkRequest({ locationId: LOCATION_ID, accountId: ACCOUNT_ID });
    const res = await POST(req);
    expect(res.status).toBe(404);
  });

  it('returns 403 for location not owned by account', async () => {
    mockGetLocationById.mockResolvedValue({
      id: LOCATION_ID,
      account_id: OTHER_ACCOUNT_ID,
      archived_at: new Date('2026-05-01'),
    });
    const req = mkRequest({ locationId: LOCATION_ID, accountId: ACCOUNT_ID });
    const res = await POST(req);
    expect(res.status).toBe(403);
  });

  it('returns 409 for non-archived location', async () => {
    mockGetLocationById.mockResolvedValue({
      id: LOCATION_ID,
      account_id: ACCOUNT_ID,
      archived_at: null,
    });
    const req = mkRequest({ locationId: LOCATION_ID, accountId: ACCOUNT_ID });
    const res = await POST(req);
    expect(res.status).toBe(409);
  });

  // H2: reactivation re-adds billable capacity, so it must be frozen as a
  // billing-expanding mutation while offboarding forbids it.
  it('returns 403 before reactivation when offboarding blocks billing expansion', async () => {
    mockGetOffboardingState.mockReturnValue({
      id: '018ff6f0-97b2-7b80-9e1d-58d50c717e63',
      accountId: ACCOUNT_ID,
      mode: 'cancel_only',
      status: 'scheduled',
      failedStep: null,
      terminalAt: null,
      accessEndsAt: new Date('2026-07-01'),
      teardownStartedAt: null,
      purgeAfter: null,
      purgeStartedAt: null,
      purgeCancelledAt: null,
    });

    const req = mkRequest({ locationId: LOCATION_ID, accountId: ACCOUNT_ID });
    const res = await POST(req);

    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: 'account_offboarding_blocked' });
    expect(mockAssertCanAddLocation).not.toHaveBeenCalled();
    expect(mockReactivateLocationTransaction).not.toHaveBeenCalled();
  });

  it('returns 403 when quota check rejects reactivation', async () => {
    mockAssertCanAddLocation.mockResolvedValue({
      allowed: false,
      reason: 'subscription_inactive',
    });
    const req = mkRequest({ locationId: LOCATION_ID, accountId: ACCOUNT_ID });
    const res = await POST(req);
    expect(res.status).toBe(403);
  });

  it('returns 403 for basic tier (multi-location not allowed)', async () => {
    mockAssertCanAddLocation.mockResolvedValue({
      allowed: false,
      reason: 'tier_disallows_multi_location',
    });
    const req = mkRequest({ locationId: LOCATION_ID, accountId: ACCOUNT_ID });
    const res = await POST(req);
    expect(res.status).toBe(403);
  });

  // VAL-LOC-072: Reactivation always succeeds for active multi-location accounts
  it('allows reactivation with overage billing for active multi-location account', async () => {
    mockAssertCanAddLocation.mockResolvedValue({
      allowed: true,
      overageUnits: 1,
    });
    const req = mkRequest({ locationId: LOCATION_ID, accountId: ACCOUNT_ID });
    const res = await POST(req);
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.overageUnits).toBe(1);
  });

  it('returns 400 for invalid location ID format', async () => {
    const req = mkRequest({ locationId: 'not-a-uuid', accountId: ACCOUNT_ID });
    const res = await POST(req);
    expect(res.status).toBe(400);
  });

  it('returns 500 when transaction fails', async () => {
    mockReactivateLocationTransaction.mockRejectedValue(new Error('DB error'));
    const req = mkRequest({ locationId: LOCATION_ID, accountId: ACCOUNT_ID });
    const res = await POST(req);
    expect(res.status).toBe(500);
  });
});
