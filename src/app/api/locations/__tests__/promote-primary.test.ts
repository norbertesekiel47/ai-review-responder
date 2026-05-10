// src/app/api/locations/__tests__/promote-primary.test.ts
//
// TDD assertions for POST /api/locations/promote-primary.
// Security: requires owner auth, validates body.accountId === user.accountId,
// and verifies the target location belongs to the user's account.
// Feature spec: Primary promotion changes is_primary atomically from old to new.

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

const { mockPromotePrimaryTransaction } = vi.hoisted(() => ({
  mockPromotePrimaryTransaction: vi.fn(),
}));

vi.mock('@/lib/locations/promote-primary-tx', () => ({
  promotePrimaryTransaction: mockPromotePrimaryTransaction,
}));

const { mockGetLocationById } = vi.hoisted(() => ({
  mockGetLocationById: vi.fn(),
}));

vi.mock('@/lib/locations/repo', () => ({
  getLocationById: mockGetLocationById,
}));

process.env.MULTI_LOCATION_ENABLED = 'true';

import { POST } from '../promote-primary/route';
import { AuthError } from '@/lib/db/auth';

// ── Helpers ────────────────────────────────────────────────────────────────

const ACCOUNT_ID = 'aaaaaaaa-0000-0000-0000-000000000001';
const OTHER_ACCOUNT_ID = '99999999-8888-7777-6666-555555555555';
const OLD_PRIMARY_ID = 'bbbbbbbb-0000-0000-0000-000000000001';
const NEW_PRIMARY_ID = 'bbbbbbbb-0000-0000-0000-000000000002';
const ACTOR_USER_ID = 'uuuuuuuu-0000-0000-0000-000000000001';

function mkRequest(body: Record<string, unknown>): NextRequest {
  return new NextRequest('http://localhost:3000/api/locations/promote-primary', {
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
    locationId: OLD_PRIMARY_ID,
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  mockRequireRole.mockReset();
  mockPromotePrimaryTransaction.mockReset();
  mockGetLocationById.mockReset();
});

// ── Tests ──────────────────────────────────────────────────────────────────

describe('POST /api/locations/promote-primary', () => {
  // ── Auth & ownership ────────────────────────────────────────────────────

  it('returns 401 when not authenticated', async () => {
    mockRequireRole.mockRejectedValueOnce(new AuthError('Unauthorized', 401));

    const req = mkRequest({
      newPrimaryId: NEW_PRIMARY_ID,
      accountId: ACCOUNT_ID,
    });
    const res = await POST(req);
    expect(res.status).toBe(401);
  });

  it('returns 403 when non-owner role', async () => {
    mockRequireRole.mockRejectedValueOnce(new AuthError('Forbidden', 403));

    const req = mkRequest({
      newPrimaryId: NEW_PRIMARY_ID,
      accountId: ACCOUNT_ID,
    });
    const res = await POST(req);
    expect(res.status).toBe(403);
  });

  it('returns 403 when user has no accountId', async () => {
    mockRequireRole.mockResolvedValueOnce(ownerUser({ accountId: null }));

    const req = mkRequest({
      newPrimaryId: NEW_PRIMARY_ID,
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
      newPrimaryId: NEW_PRIMARY_ID,
      accountId: OTHER_ACCOUNT_ID,
    });
    const res = await POST(req);
    expect(res.status).toBe(403);
    const body = await res.json();
    expect(body.error).toBe('Account ID mismatch');
  });

  it('returns 404 when target location does not exist', async () => {
    mockRequireRole.mockResolvedValueOnce(ownerUser());
    mockGetLocationById.mockResolvedValueOnce(null);

    const req = mkRequest({
      newPrimaryId: NEW_PRIMARY_ID,
      accountId: ACCOUNT_ID,
    });
    const res = await POST(req);
    expect(res.status).toBe(404);
    const body = await res.json();
    expect(body.error).toBe('location_not_found');
  });

  it('returns 403 when target location belongs to different account', async () => {
    mockRequireRole.mockResolvedValueOnce(ownerUser());
    mockGetLocationById.mockResolvedValueOnce({
      id: NEW_PRIMARY_ID,
      account_id: OTHER_ACCOUNT_ID,
    });

    const req = mkRequest({
      newPrimaryId: NEW_PRIMARY_ID,
      accountId: ACCOUNT_ID,
    });
    const res = await POST(req);
    expect(res.status).toBe(403);
    const body = await res.json();
    expect(body.error).toBe('location_not_owned');
  });

  it('does not call promotePrimaryTransaction when location not owned', async () => {
    mockRequireRole.mockResolvedValueOnce(ownerUser());
    mockGetLocationById.mockResolvedValueOnce({
      id: NEW_PRIMARY_ID,
      account_id: OTHER_ACCOUNT_ID,
    });

    const req = mkRequest({
      newPrimaryId: NEW_PRIMARY_ID,
      accountId: ACCOUNT_ID,
    });
    await POST(req);
    expect(mockPromotePrimaryTransaction).not.toHaveBeenCalled();
  });

  // ── Returns 404 when MULTI_LOCATION_ENABLED is not true ───────────────

  it('returns 404 when MULTI_LOCATION_ENABLED is not true', async () => {
    process.env.MULTI_LOCATION_ENABLED = 'false';
    const req = mkRequest({
      newPrimaryId: NEW_PRIMARY_ID,
      accountId: ACCOUNT_ID,
    });
    const res = await POST(req);
    expect(res.status).toBe(404);
    process.env.MULTI_LOCATION_ENABLED = 'true';
  });

  // ── 200 on successful promotion ────────────────────────────────────────

  it('returns 200 on successful promotion', async () => {
    mockRequireRole.mockResolvedValueOnce(ownerUser());
    mockGetLocationById.mockResolvedValueOnce({
      id: NEW_PRIMARY_ID,
      account_id: ACCOUNT_ID,
    });
    mockPromotePrimaryTransaction.mockResolvedValueOnce({
      oldPrimaryId: OLD_PRIMARY_ID,
      newPrimaryId: NEW_PRIMARY_ID,
    });

    const req = mkRequest({
      newPrimaryId: NEW_PRIMARY_ID,
      accountId: ACCOUNT_ID,
    });
    const res = await POST(req);

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.oldPrimaryId).toBe(OLD_PRIMARY_ID);
    expect(body.newPrimaryId).toBe(NEW_PRIMARY_ID);
  });

  // ── Delegates to promotePrimaryTransaction ─────────────────────────────

  it('calls promotePrimaryTransaction with correct parameters', async () => {
    mockRequireRole.mockResolvedValueOnce(ownerUser());
    mockGetLocationById.mockResolvedValueOnce({
      id: NEW_PRIMARY_ID,
      account_id: ACCOUNT_ID,
    });
    mockPromotePrimaryTransaction.mockResolvedValueOnce({
      oldPrimaryId: OLD_PRIMARY_ID,
      newPrimaryId: NEW_PRIMARY_ID,
    });

    const req = mkRequest({
      newPrimaryId: NEW_PRIMARY_ID,
      accountId: ACCOUNT_ID,
    });
    await POST(req);

    expect(mockPromotePrimaryTransaction).toHaveBeenCalledTimes(1);
    const txInput = mockPromotePrimaryTransaction.mock.calls[0]![0];
    expect(txInput.newPrimaryId).toBe(NEW_PRIMARY_ID);
    expect(txInput.accountId).toBe(ACCOUNT_ID);
  });

  // ── 400 when new primary is already primary ───────────────────────────

  it('returns 400 when new primary is already primary', async () => {
    mockRequireRole.mockResolvedValueOnce(ownerUser());
    mockGetLocationById.mockResolvedValueOnce({
      id: NEW_PRIMARY_ID,
      account_id: ACCOUNT_ID,
    });
    mockPromotePrimaryTransaction.mockRejectedValueOnce(
      new Error('location bbbb...0002 is already the primary location'),
    );

    const req = mkRequest({
      newPrimaryId: NEW_PRIMARY_ID,
      accountId: ACCOUNT_ID,
    });
    const res = await POST(req);

    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toBe('already_primary');
  });

  // ── 404 when new primary not found ────────────────────────────────────

  it('returns 404 when new primary location not found', async () => {
    mockRequireRole.mockResolvedValueOnce(ownerUser());
    mockGetLocationById.mockResolvedValueOnce({
      id: NEW_PRIMARY_ID,
      account_id: ACCOUNT_ID,
    });
    mockPromotePrimaryTransaction.mockRejectedValueOnce(
      new Error('new primary location not found or not accessible: 0000...'),
    );

    const req = mkRequest({
      newPrimaryId: '00000000-0000-7f00-8000-000000000000',
      accountId: ACCOUNT_ID,
    });
    const res = await POST(req);

    expect(res.status).toBe(404);
    const body = await res.json();
    expect(body.error).toBe('location_not_found');
  });

  // ── 400 when new primary is archived ──────────────────────────────────

  it('returns 400 when new primary is archived', async () => {
    mockRequireRole.mockResolvedValueOnce(ownerUser());
    mockGetLocationById.mockResolvedValueOnce({
      id: NEW_PRIMARY_ID,
      account_id: ACCOUNT_ID,
    });
    mockPromotePrimaryTransaction.mockRejectedValueOnce(
      new Error('location bbbb...0002 is archived and cannot be promoted to primary'),
    );

    const req = mkRequest({
      newPrimaryId: NEW_PRIMARY_ID,
      accountId: ACCOUNT_ID,
    });
    const res = await POST(req);

    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toBe('location_archived');
  });

  // ── Input validation ───────────────────────────────────────────────────

  it('returns 400 for invalid newPrimaryId format', async () => {
    mockRequireRole.mockResolvedValueOnce(ownerUser());

    const req = mkRequest({
      newPrimaryId: 'not-a-uuid',
      accountId: ACCOUNT_ID,
    });
    const res = await POST(req);

    expect(res.status).toBe(400);
  });

  it('returns 400 for missing accountId', async () => {
    mockRequireRole.mockResolvedValueOnce(ownerUser());

    const req = mkRequest({
      newPrimaryId: NEW_PRIMARY_ID,
    });
    const res = await POST(req);

    expect(res.status).toBe(400);
  });

  // ── 500 on unexpected transaction failure ──────────────────────────────

  it('returns 500 on unexpected transaction failure', async () => {
    mockRequireRole.mockResolvedValueOnce(ownerUser());
    mockGetLocationById.mockResolvedValueOnce({
      id: NEW_PRIMARY_ID,
      account_id: ACCOUNT_ID,
    });
    mockPromotePrimaryTransaction.mockRejectedValueOnce(
      new Error('Unexpected: connection lost'),
    );

    const req = mkRequest({
      newPrimaryId: NEW_PRIMARY_ID,
      accountId: ACCOUNT_ID,
    });
    const res = await POST(req);

    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body.error).toBe('promote_primary_failed');
  });
});
