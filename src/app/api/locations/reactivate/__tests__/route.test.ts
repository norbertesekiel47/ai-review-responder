import { describe, expect, it, vi, beforeEach } from 'vitest';
import { NextRequest } from 'next/server';

// ── Hoisted mocks ──────────────────────────────────────────────────────

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

// ── Helpers ────────────────────────────────────────────────────────────

const ACCOUNT_ID = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
const LOCATION_ID = '11111111-2222-3333-4444-555555555555';

function mkRequest(body: Record<string, unknown>): NextRequest {
  return new NextRequest('http://localhost:3000/api/locations/reactivate', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  mockGetLocationById.mockResolvedValue({
    id: LOCATION_ID,
    account_id: ACCOUNT_ID,
    archived_at: new Date('2026-05-01'),
  });
  mockAssertCanAddLocation.mockResolvedValue({ allowed: true, overageUnits: 0 });
  mockGetAccountOwnerUserId.mockResolvedValue('user-id-123');
  mockReactivateLocationTransaction.mockResolvedValue({
    locationId: LOCATION_ID,
    reactivated: true,
  });
});

// ── Tests ──────────────────────────────────────────────────────────────

describe('POST /api/locations/reactivate', () => {
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
        actorUserId: 'user-id-123',
      }),
    );
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
      account_id: 'other-account-id',
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
