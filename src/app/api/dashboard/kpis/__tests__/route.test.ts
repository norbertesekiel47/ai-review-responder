import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NextRequest } from 'next/server';

// ── Hoisted shared state ──────────────────────────────────────────────────

const { mockRequireRole, mockAccountRows } = vi.hoisted(() => ({
  mockRequireRole: vi.fn(),
  // Rows returned by the route's `SELECT subscription_status FROM accounts`.
  // Defaulted to an active account in beforeEach so existing tests pass the gate.
  mockAccountRows: { value: [] as Array<{ subscription_status: string }> },
}));

// ── Mock db (subscription-status gate query) ───────────────────────────────

vi.mock('@/lib/db/server', () => ({
  sql: (first: unknown) => {
    // Tagged-template call → the route's accounts query. Return the seeded rows.
    if (first != null && typeof first === 'object' && 'raw' in (first as object)) {
      return Promise.resolve(mockAccountRows.value);
    }
    return { __helper: true };
  },
  jsonb: (v: unknown) => v,
}));

// ── Mock Auth ─────────────────────────────────────────────────────────────

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

// ── Mock KPI service ──────────────────────────────────────────────────────

const { mockGetLocationKpiSummary, mockGetAccountKpiSummary } = vi.hoisted(() => ({
  mockGetLocationKpiSummary: vi.fn(),
  mockGetAccountKpiSummary: vi.fn(),
}));

vi.mock('@/lib/kpi/service', () => ({
  getLocationKpiSummary: (...args: unknown[]) => mockGetLocationKpiSummary(...args),
  getAccountKpiSummary: (...args: unknown[]) => mockGetAccountKpiSummary(...args),
}));

// ── Mock location repo ────────────────────────────────────────────────────

const { mockGetLocationById } = vi.hoisted(() => ({
  mockGetLocationById: vi.fn<(id: string) => Promise<import('@/lib/locations/repo').LocationRow | null>>(async () => null),
}));

vi.mock('@/lib/locations/repo', () => ({
  getActiveLocationCount: vi.fn(async () => 1),
  getLocationsForAccount: vi.fn(async () => []),
  getLocationById: (id: string) => mockGetLocationById(id),
}));

// Import AFTER mocks are set up
import { GET } from '../route';
import { AuthError } from '@/lib/db/auth';

// ── Helpers ───────────────────────────────────────────────────────────────

function makeRequest(path = '/api/dashboard/kpis'): NextRequest {
  return new NextRequest(`http://localhost:3000${path}`);
}

const BUSINESS_ID = '01234567-0000-0000-0000-000000000001';
const ACCOUNT_ID = 'a0000000-0000-0000-0000-000000000001';
const OTHER_ACCOUNT_ID = 'b0000000-0000-0000-0000-000000000099';

function ownerUser(overrides?: { locationId?: string | null; accountId?: string }) {
  return {
    id: 'user-1',
    name: 'Test Owner',
    email: 'owner@test.com',
    role: 'owner',
    accountId: overrides?.accountId ?? ACCOUNT_ID,
    locationId: overrides && 'locationId' in overrides ? overrides.locationId : BUSINESS_ID,
  };
}

const MOCK_LOCATION_SUMMARY = {
  scope: { kind: 'location', businessId: BUSINESS_ID },
  windowDays: 30,
  responseRate: { handled: 10, received: 20, ratePct: 50 },
  averageStarRating: 4.25,
  reviewVolume: { currentMonth: 8, priorMonth: 6, deltaPct: 33 },
  averageTimeToRespondHours: 2.5,
  sentimentTrend: [],
};

const MOCK_ACCOUNT_SUMMARY = {
  scope: { kind: 'account', accountId: ACCOUNT_ID },
  windowDays: 30,
  responseRate: { handled: 30, received: 50, ratePct: 60 },
  averageStarRating: 4.1,
  reviewVolume: { currentMonth: 20, priorMonth: 15, deltaPct: 33 },
  averageTimeToRespondHours: 3.0,
  sentimentTrend: [],
};

function ownedActiveLocation(overrides?: { account_id?: string; archived_at?: Date | null }): import('@/lib/locations/repo').LocationRow {
  return {
    id: BUSINESS_ID,
    account_id: overrides?.account_id ?? ACCOUNT_ID,
    name: 'Test Biz',
    display_label: null,
    is_primary: true,
    archived_at: overrides?.archived_at !== undefined ? overrides.archived_at : null,
    google_place_id: 'gp1',
    google_place_address: null,
    created_at: new Date(),
  };
}

// ── Tests ─────────────────────────────────────────────────────────────────

describe('GET /api/dashboard/kpis', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Default: active account passes the subscription gate.
    mockAccountRows.value = [{ subscription_status: 'active' }];
  });

  // ── Happy path: no scope param → location mode ────────────────────────

  it('no scope param → calls getLocationKpiSummary with user.locationId; returns 200 with summary', async () => {
    mockRequireRole.mockResolvedValue(ownerUser());
    mockGetLocationById.mockResolvedValue(ownedActiveLocation());
    mockGetLocationKpiSummary.mockResolvedValue(MOCK_LOCATION_SUMMARY);

    const res = await GET(makeRequest());
    expect(res.status).toBe(200);

    expect(mockGetLocationKpiSummary).toHaveBeenCalledOnce();
    expect(mockGetLocationKpiSummary).toHaveBeenCalledWith(BUSINESS_ID);
    expect(mockGetAccountKpiSummary).not.toHaveBeenCalled();

    const body = await res.json();
    expect(body.scope).toEqual({ kind: 'location', businessId: BUSINESS_ID });
    expect(body.responseRate.ratePct).toBe(50);

    // Must be no-store
    expect(res.headers.get('Cache-Control')).toBe('no-store, private');
  });

  // ── Happy path: scope=all + MULTI_LOCATION_ENABLED=true → aggregate ───

  it('scope=all + MULTI_LOCATION_ENABLED=true → calls getAccountKpiSummary; returns 200', async () => {
    const previous = process.env.MULTI_LOCATION_ENABLED;
    try {
      process.env.MULTI_LOCATION_ENABLED = 'true';

      mockRequireRole.mockResolvedValue(ownerUser());
      mockGetAccountKpiSummary.mockResolvedValue(MOCK_ACCOUNT_SUMMARY);

      const res = await GET(makeRequest('/api/dashboard/kpis?scope=all'));
      expect(res.status).toBe(200);

      expect(mockGetAccountKpiSummary).toHaveBeenCalledOnce();
      expect(mockGetAccountKpiSummary).toHaveBeenCalledWith(ACCOUNT_ID);
      expect(mockGetLocationKpiSummary).not.toHaveBeenCalled();

      const body = await res.json();
      expect(body.scope).toEqual({ kind: 'account', accountId: ACCOUNT_ID });
      expect(body.responseRate.ratePct).toBe(60);

      expect(res.headers.get('Cache-Control')).toBe('no-store, private');
    } finally {
      process.env.MULTI_LOCATION_ENABLED = previous;
    }
  });

  // ── IDOR: cross-tenant location → 403, no KPI service call ───────────

  it('scope=<uuid> where location.account_id !== user.accountId → 403 IDOR rejection; neither KPI service function called', async () => {
    mockRequireRole.mockResolvedValue(ownerUser());
    // Location exists but belongs to a different account
    mockGetLocationById.mockResolvedValue(
      ownedActiveLocation({ account_id: OTHER_ACCOUNT_ID }),
    );

    const res = await GET(makeRequest(`/api/dashboard/kpis?scope=${BUSINESS_ID}`));
    expect(res.status).toBe(403);

    const body = await res.json();
    expect(body.error).toBeDefined();

    // Neither KPI service function must have been called
    expect(mockGetLocationKpiSummary).not.toHaveBeenCalled();
    expect(mockGetAccountKpiSummary).not.toHaveBeenCalled();
  });

  // ── Unauthenticated: requireRole throws AuthError ──────────────────────

  it('requireRole throws AuthError(401) → returns mapped status; no KPI service call', async () => {
    mockRequireRole.mockRejectedValue(new AuthError('Unauthorized', 401));

    const res = await GET(makeRequest());
    expect(res.status).toBe(401);

    const body = await res.json();
    expect(body.error).toBe('Unauthorized');

    expect(mockGetLocationKpiSummary).not.toHaveBeenCalled();
    expect(mockGetAccountKpiSummary).not.toHaveBeenCalled();
  });

  it('requireRole throws AuthError(403) → returns 403; no KPI service call', async () => {
    mockRequireRole.mockRejectedValue(new AuthError('Forbidden', 403));

    const res = await GET(makeRequest());
    expect(res.status).toBe(403);

    const body = await res.json();
    expect(body.error).toBe('Forbidden');

    expect(mockGetLocationKpiSummary).not.toHaveBeenCalled();
    expect(mockGetAccountKpiSummary).not.toHaveBeenCalled();
  });

  // ── Additional edge cases ─────────────────────────────────────────────

  it('requireRole throws non-AuthError → re-throws (un-masked 5xx, not a clean 500)', async () => {
    // Adopting requireOwnerWithAccount aligns kpis with the Part A contract: an
    // unexpected (non-auth) failure surfaces as a real 5xx instead of being
    // masked behind a clean { error: 'Internal server error' } 500.
    mockRequireRole.mockRejectedValue(new Error('some internal error'));

    await expect(GET(makeRequest())).rejects.toThrow('some internal error');

    expect(mockGetLocationKpiSummary).not.toHaveBeenCalled();
    expect(mockGetAccountKpiSummary).not.toHaveBeenCalled();
  });

  it('user has no accountId → returns 403', async () => {
    mockRequireRole.mockResolvedValue({ ...ownerUser(), accountId: null });

    const res = await GET(makeRequest());
    expect(res.status).toBe(403);

    const body = await res.json();
    expect(body.error).toBe('No account associated with this user');
  });

  it('location mode but user.locationId is null → 403 no business', async () => {
    mockRequireRole.mockResolvedValue(ownerUser({ locationId: null }));

    const res = await GET(makeRequest());
    expect(res.status).toBe(403);

    const body = await res.json();
    expect(body.error).toBe('No business associated with this account');

    expect(mockGetLocationKpiSummary).not.toHaveBeenCalled();
    expect(mockGetAccountKpiSummary).not.toHaveBeenCalled();
  });

  it('getLocationById returns null → 404 Business not found; no KPI service call', async () => {
    mockRequireRole.mockResolvedValue(ownerUser());
    mockGetLocationById.mockResolvedValue(null);

    const res = await GET(makeRequest());
    expect(res.status).toBe(404);

    const body = await res.json();
    expect(body.error).toBe('Business not found');

    expect(mockGetLocationKpiSummary).not.toHaveBeenCalled();
    expect(mockGetAccountKpiSummary).not.toHaveBeenCalled();
  });

  it('location is archived → 404 No active location available; no KPI service call', async () => {
    mockRequireRole.mockResolvedValue(ownerUser());
    mockGetLocationById.mockResolvedValue(
      ownedActiveLocation({ archived_at: new Date('2026-01-01') }),
    );

    const res = await GET(makeRequest());
    expect(res.status).toBe(404);

    const body = await res.json();
    expect(body.error).toBe('No active location available');

    expect(mockGetLocationKpiSummary).not.toHaveBeenCalled();
    expect(mockGetAccountKpiSummary).not.toHaveBeenCalled();
  });

  it('scope=all without MULTI_LOCATION_ENABLED → falls back to location mode', async () => {
    const previous = process.env.MULTI_LOCATION_ENABLED;
    try {
      process.env.MULTI_LOCATION_ENABLED = 'false';

      mockRequireRole.mockResolvedValue(ownerUser());
      mockGetLocationById.mockResolvedValue(ownedActiveLocation());
      mockGetLocationKpiSummary.mockResolvedValue(MOCK_LOCATION_SUMMARY);

      const res = await GET(makeRequest('/api/dashboard/kpis?scope=all'));
      expect(res.status).toBe(200);

      // scope=all without multi-location → falls back to user's locationId
      expect(mockGetLocationKpiSummary).toHaveBeenCalledWith(BUSINESS_ID);
      expect(mockGetAccountKpiSummary).not.toHaveBeenCalled();
    } finally {
      process.env.MULTI_LOCATION_ENABLED = previous;
    }
  });

  // ── Error boundary: service-call throw → 500 ─────────────────────────

  it('getLocationKpiSummary throws → returns 500 with clean error message; not raw error', async () => {
    mockRequireRole.mockResolvedValue(ownerUser());
    mockGetLocationById.mockResolvedValue(ownedActiveLocation());
    mockGetLocationKpiSummary.mockRejectedValue(new Error('DB connection timeout'));

    const res = await GET(makeRequest());
    expect(res.status).toBe(500);

    const body = await res.json();
    expect(body.error).toBe('Failed to fetch KPIs');
    // Raw error message must not leak to the client
    expect(body.error).not.toContain('DB connection timeout');
  });

  it('getAccountKpiSummary throws → returns 500 with clean error message', async () => {
    const previous = process.env.MULTI_LOCATION_ENABLED;
    try {
      process.env.MULTI_LOCATION_ENABLED = 'true';

      mockRequireRole.mockResolvedValue(ownerUser());
      mockGetAccountKpiSummary.mockRejectedValue(new Error('unexpected DB failure'));

      const res = await GET(makeRequest('/api/dashboard/kpis?scope=all'));
      expect(res.status).toBe(500);

      const body = await res.json();
      expect(body.error).toBe('Failed to fetch KPIs');
      expect(body.error).not.toContain('unexpected DB failure');
    } finally {
      process.env.MULTI_LOCATION_ENABLED = previous;
    }
  });

  // ── Subscription gate (P1): only active/past_due accounts get KPI data ─────

  it('cancelled account → 403 subscription_inactive; no KPI service call', async () => {
    mockRequireRole.mockResolvedValue(ownerUser());
    mockGetLocationById.mockResolvedValue(ownedActiveLocation());
    mockAccountRows.value = [{ subscription_status: 'cancelled' }];

    const res = await GET(makeRequest());
    expect(res.status).toBe(403);

    const body = await res.json();
    expect(body.error).toBe('subscription_inactive');
    expect(body.subscriptionStatus).toBe('cancelled');

    expect(mockGetLocationKpiSummary).not.toHaveBeenCalled();
    expect(mockGetAccountKpiSummary).not.toHaveBeenCalled();
  });

  it('pending_payment account → 403; aggregate mode also gated, no KPI service call', async () => {
    const previous = process.env.MULTI_LOCATION_ENABLED;
    try {
      process.env.MULTI_LOCATION_ENABLED = 'true';
      mockRequireRole.mockResolvedValue(ownerUser());
      mockAccountRows.value = [{ subscription_status: 'pending_payment' }];

      const res = await GET(makeRequest('/api/dashboard/kpis?scope=all'));
      expect(res.status).toBe(403);

      const body = await res.json();
      expect(body.error).toBe('subscription_inactive');
      expect(mockGetAccountKpiSummary).not.toHaveBeenCalled();
      expect(mockGetLocationKpiSummary).not.toHaveBeenCalled();
    } finally {
      process.env.MULTI_LOCATION_ENABLED = previous;
    }
  });

  it('past_due account → 200 (features continue during grace); KPI returned', async () => {
    mockRequireRole.mockResolvedValue(ownerUser());
    mockGetLocationById.mockResolvedValue(ownedActiveLocation());
    mockGetLocationKpiSummary.mockResolvedValue(MOCK_LOCATION_SUMMARY);
    mockAccountRows.value = [{ subscription_status: 'past_due' }];

    const res = await GET(makeRequest());
    expect(res.status).toBe(200);
    expect(mockGetLocationKpiSummary).toHaveBeenCalledWith(BUSINESS_ID);
  });

  it('malformed scope (not a UUID) → 400 Invalid scope; no KPI service / location call', async () => {
    mockRequireRole.mockResolvedValue(ownerUser());

    const res = await GET(makeRequest('/api/dashboard/kpis?scope=not-a-uuid'));
    expect(res.status).toBe(400);

    const body = await res.json();
    expect(body.error).toContain('Invalid scope');

    expect(mockGetLocationById).not.toHaveBeenCalled();
    expect(mockGetLocationKpiSummary).not.toHaveBeenCalled();
    expect(mockGetAccountKpiSummary).not.toHaveBeenCalled();
  });

  it('account row not found → 404; no KPI service call', async () => {
    mockRequireRole.mockResolvedValue(ownerUser());
    mockAccountRows.value = [];

    const res = await GET(makeRequest());
    expect(res.status).toBe(404);

    const body = await res.json();
    expect(body.error).toBe('Account not found');
    expect(mockGetLocationKpiSummary).not.toHaveBeenCalled();
    expect(mockGetAccountKpiSummary).not.toHaveBeenCalled();
  });
});
