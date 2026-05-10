// src/app/api/locations/__tests__/archive.test.ts
//
// TDD assertions for POST /api/locations/archive.
// Validation contract: VAL-LOC-043, VAL-LOC-044, VAL-LOC-047.
// Security: requires owner auth, validates body.accountId === user.accountId.
//
// Feature spec:
//   - Archive attempt on primary with other active locations: 409 'promote first'
//   - Archive attempt on last active location: 409
//   - Archive of non-primary succeeds: sets archived_at, inserts audit,
//     enqueues Stripe quantity decrement

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NextRequest } from 'next/server';

// ── Hoisted mocks ──────────────────────────────────────────────────────────

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

const { mockAssertCanArchiveLocation } = vi.hoisted(() => ({
  mockAssertCanArchiveLocation: vi.fn(),
}));

vi.mock('@/lib/locations/archive-location-tx', () => ({
  assertCanArchiveLocation: mockAssertCanArchiveLocation,
  archiveLocationTransaction: vi.fn(),
}));

const { mockGetAccountOwnerUserId } = vi.hoisted(() => ({
  mockGetAccountOwnerUserId: vi.fn(),
}));

vi.mock('@/lib/accounts/repo', () => ({
  getAccountOwnerUserId: mockGetAccountOwnerUserId,
}));

const { mockGetActiveLocationCount } = vi.hoisted(() => ({
  mockGetActiveLocationCount: vi.fn(),
}));

vi.mock('@/lib/locations/repo', () => ({
  getActiveLocationCount: mockGetActiveLocationCount,
}));

process.env.MULTI_LOCATION_ENABLED = 'true';

import { POST } from '../archive/route';
import { archiveLocationTransaction } from '@/lib/locations/archive-location-tx';
import { AuthError } from '@/lib/db/auth';

// ── Helpers ────────────────────────────────────────────────────────────────

const ACCOUNT_ID = 'aaaaaaaa-0000-0000-0000-000000000001';
const OTHER_ACCOUNT_ID = '99999999-8888-7777-6666-555555555555';
const PRIMARY_LOCATION_ID = 'bbbbbbbb-0000-0000-0000-000000000001';
const SECONDARY_LOCATION_ID = 'bbbbbbbb-0000-0000-0000-000000000002';
const ACTOR_USER_ID = 'uuuuuuuu-0000-0000-0000-000000000001';

function mkRequest(body: Record<string, unknown>): NextRequest {
  return new NextRequest('http://localhost:3000/api/locations/archive', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

function ownerUser(overrides: Record<string, unknown> = {}) {
  return {
    id: ACTOR_USER_ID,
    name: 'Test Owner',
    email: 'owner@test.com',
    role: 'owner',
    accountId: ACCOUNT_ID,
    locationId: PRIMARY_LOCATION_ID,
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  mockRequireRole.mockReset();
  mockAssertCanArchiveLocation.mockReset();
  mockGetAccountOwnerUserId.mockReset();
  mockGetActiveLocationCount.mockReset();
});

// ── Tests ──────────────────────────────────────────────────────────────────

describe('POST /api/locations/archive', () => {
  // ── Auth & ownership ────────────────────────────────────────────────────

  it('returns 401 when not authenticated', async () => {
    mockRequireRole.mockRejectedValueOnce(new AuthError('Unauthorized', 401));

    const req = mkRequest({
      locationId: SECONDARY_LOCATION_ID,
      accountId: ACCOUNT_ID,
    });
    const res = await POST(req);
    expect(res.status).toBe(401);
  });

  it('returns 403 when non-owner role', async () => {
    mockRequireRole.mockRejectedValueOnce(new AuthError('Forbidden', 403));

    const req = mkRequest({
      locationId: SECONDARY_LOCATION_ID,
      accountId: ACCOUNT_ID,
    });
    const res = await POST(req);
    expect(res.status).toBe(403);
  });

  it('returns 403 when user has no accountId', async () => {
    mockRequireRole.mockResolvedValueOnce(ownerUser({ accountId: null }));

    const req = mkRequest({
      locationId: SECONDARY_LOCATION_ID,
      accountId: ACCOUNT_ID,
    });
    const res = await POST(req);
    expect(res.status).toBe(403);
    const body = await res.json();
    expect(body.error).toBe('No account associated with this user');
  });

  it('returns 403 when body.accountId does not match authenticated user', async () => {
    mockRequireRole.mockResolvedValueOnce(ownerUser());

    const req = mkRequest({
      locationId: SECONDARY_LOCATION_ID,
      accountId: OTHER_ACCOUNT_ID,
    });
    const res = await POST(req);
    expect(res.status).toBe(403);
    const body = await res.json();
    expect(body.error).toBe('Account ID mismatch');
  });

  it('does not call assertCanArchiveLocation when accountId mismatches', async () => {
    mockRequireRole.mockResolvedValueOnce(ownerUser());

    const req = mkRequest({
      locationId: SECONDARY_LOCATION_ID,
      accountId: OTHER_ACCOUNT_ID,
    });
    await POST(req);
    expect(mockAssertCanArchiveLocation).not.toHaveBeenCalled();
  });

  // ── Returns 404 when MULTI_LOCATION_ENABLED is not true ───────────────

  it('returns 404 when MULTI_LOCATION_ENABLED is not true', async () => {
    process.env.MULTI_LOCATION_ENABLED = 'false';
    const req = mkRequest({
      locationId: SECONDARY_LOCATION_ID,
      accountId: ACCOUNT_ID,
    });
    const res = await POST(req);
    expect(res.status).toBe(404);
    const body = await res.json();
    expect(body.error).toBe('not_found');
    process.env.MULTI_LOCATION_ENABLED = 'true';
  });

  // ── 409 when primary with other active locations ("promote first") ─────

  it('returns 409 with promote_first when archiving primary with other active locations', async () => {
    mockRequireRole.mockResolvedValueOnce(ownerUser());
    mockAssertCanArchiveLocation.mockResolvedValueOnce({
      allowed: false,
      reason: 'promote_first',
    });

    const req = mkRequest({
      locationId: PRIMARY_LOCATION_ID,
      accountId: ACCOUNT_ID,
    });
    const res = await POST(req);

    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.error).toBe('promote_first');
  });

  // ── 409 when last active location ─────────────────────────────────────

  it('returns 409 when archiving the last active location', async () => {
    mockRequireRole.mockResolvedValueOnce(ownerUser());
    mockAssertCanArchiveLocation.mockResolvedValueOnce({
      allowed: false,
      reason: 'last_active_location',
    });

    const req = mkRequest({
      locationId: PRIMARY_LOCATION_ID,
      accountId: ACCOUNT_ID,
    });
    const res = await POST(req);

    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.error).toBe('last_active_location');
  });

  // ── 404 when location not found ────────────────────────────────────────

  it('returns 404 when location not found', async () => {
    mockRequireRole.mockResolvedValueOnce(ownerUser());
    mockAssertCanArchiveLocation.mockResolvedValueOnce({
      allowed: false,
      reason: 'location_not_found',
    });

    const req = mkRequest({
      locationId: '00000000-0000-7f00-8000-000000000000',
      accountId: ACCOUNT_ID,
    });
    const res = await POST(req);

    expect(res.status).toBe(404);
    const body = await res.json();
    expect(body.error).toBe('location_not_found');
  });

  // ── 403 when location not owned by account ────────────────────────────

  it('returns 403 when location not owned by account', async () => {
    mockRequireRole.mockResolvedValueOnce(ownerUser());
    mockAssertCanArchiveLocation.mockResolvedValueOnce({
      allowed: false,
      reason: 'location_not_owned',
    });

    const req = mkRequest({
      locationId: SECONDARY_LOCATION_ID,
      accountId: ACCOUNT_ID,
    });
    const res = await POST(req);

    expect(res.status).toBe(403);
    const body = await res.json();
    expect(body.error).toBe('location_not_owned');
  });

  // ── 409 when location already archived ─────────────────────────────────

  it('returns 409 when location already archived', async () => {
    mockRequireRole.mockResolvedValueOnce(ownerUser());
    mockAssertCanArchiveLocation.mockResolvedValueOnce({
      allowed: false,
      reason: 'location_already_archived',
    });

    const req = mkRequest({
      locationId: SECONDARY_LOCATION_ID,
      accountId: ACCOUNT_ID,
    });
    const res = await POST(req);

    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.error).toBe('location_already_archived');
  });

  // ── 200 when non-primary archived successfully ─────────────────────────

  it('returns 200 when non-primary archived successfully', async () => {
    mockRequireRole.mockResolvedValueOnce(ownerUser());
    mockAssertCanArchiveLocation.mockResolvedValueOnce({
      allowed: true,
      activeLocationsAfterArchive: 2,
    });
    mockGetAccountOwnerUserId.mockResolvedValueOnce(ACTOR_USER_ID);
    mockGetActiveLocationCount.mockResolvedValueOnce(3);
    (archiveLocationTransaction as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      locationId: SECONDARY_LOCATION_ID,
      archived: true,
    });

    const req = mkRequest({
      locationId: SECONDARY_LOCATION_ID,
      accountId: ACCOUNT_ID,
    });
    const res = await POST(req);

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.archived).toBe(true);
    expect(body.locationId).toBe(SECONDARY_LOCATION_ID);
    expect(body.activeLocations).toBe(2);
  });

  // ── Delegates to archiveLocationTransaction ────────────────────────────

  it('calls archiveLocationTransaction with correct parameters', async () => {
    mockRequireRole.mockResolvedValueOnce(ownerUser());
    mockAssertCanArchiveLocation.mockResolvedValueOnce({
      allowed: true,
      activeLocationsAfterArchive: 1,
    });
    mockGetAccountOwnerUserId.mockResolvedValueOnce(ACTOR_USER_ID);
    mockGetActiveLocationCount.mockResolvedValueOnce(2);
    (archiveLocationTransaction as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      locationId: SECONDARY_LOCATION_ID,
      archived: true,
    });

    const req = mkRequest({
      locationId: SECONDARY_LOCATION_ID,
      accountId: ACCOUNT_ID,
    });
    await POST(req);

    expect(archiveLocationTransaction).toHaveBeenCalledTimes(1);
    const txInput = (archiveLocationTransaction as ReturnType<typeof vi.fn>).mock.calls[0]![0];
    expect(txInput.locationId).toBe(SECONDARY_LOCATION_ID);
    expect(txInput.accountId).toBe(ACCOUNT_ID);
    expect(txInput.actorUserId).toBe(ACTOR_USER_ID);
    expect(txInput.activeLocationsBefore).toBe(2);
  });

  // ── Input validation ───────────────────────────────────────────────────

  it('returns 400 for invalid locationId format', async () => {
    mockRequireRole.mockResolvedValueOnce(ownerUser());

    const req = mkRequest({
      locationId: 'not-a-uuid',
      accountId: ACCOUNT_ID,
    });
    const res = await POST(req);

    expect(res.status).toBe(400);
  });

  it('returns 400 for missing accountId', async () => {
    mockRequireRole.mockResolvedValueOnce(ownerUser());

    const req = mkRequest({
      locationId: SECONDARY_LOCATION_ID,
    });
    const res = await POST(req);

    expect(res.status).toBe(400);
  });

  // ── Transaction failure ────────────────────────────────────────────────

  it('returns 500 when archiveLocationTransaction throws', async () => {
    mockRequireRole.mockResolvedValueOnce(ownerUser());
    mockAssertCanArchiveLocation.mockResolvedValueOnce({
      allowed: true,
      activeLocationsAfterArchive: 1,
    });
    mockGetAccountOwnerUserId.mockResolvedValueOnce(ACTOR_USER_ID);
    mockGetActiveLocationCount.mockResolvedValueOnce(2);
    (archiveLocationTransaction as ReturnType<typeof vi.fn>).mockRejectedValueOnce(
      new Error('Transaction failed: constraint violation'),
    );

    const req = mkRequest({
      locationId: SECONDARY_LOCATION_ID,
      accountId: ACCOUNT_ID,
    });
    const res = await POST(req);

    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body.error).toBe('archive_location_failed');
  });
});
