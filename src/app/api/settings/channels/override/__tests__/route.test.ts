import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NextRequest } from 'next/server';

// ── Hoisted shared state ────────────────────────────────────────────

const { mockRequireRole, mockSql, mockSqlUnsafe } = vi.hoisted(() => ({
  mockRequireRole: vi.fn(),
  mockSql: vi.fn(),
  mockSqlUnsafe: vi.fn(),
}));

// ── Mock Auth ───────────────────────────────────────────────────────

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

// ── Mock DB ─────────────────────────────────────────────────────────

vi.mock('@/lib/db/server', () => {
  const sqlProxy = Object.assign((...args: unknown[]) => mockSql(...args), {
    unsafe: (...args: unknown[]) => mockSqlUnsafe(...args),
  });
  return { sql: sqlProxy };
});

// ── Mock uuid ───────────────────────────────────────────────────────

vi.mock('uuid', () => ({
  v7: () => 'mock-uuid-v7',
}));

// Import AFTER mocks
import { POST, DELETE } from '../route';
import { AuthError } from '@/lib/db/auth';

// ── Helpers ─────────────────────────────────────────────────────────

const ACCOUNT_ID = 'a0000000-0000-4000-8000-000000000001';
const LOCATION_ID_1 = 'b1111111-0000-4000-8000-000000000001';
const ENROLLMENT_ID_ORG = 'e0000000-0000-4000-8000-000000000001';
const ENROLLMENT_ID_OVERRIDE = 'e0000000-0000-4000-8000-000000000002';

function ownerUser() {
  return {
    id: 'user-1',
    name: 'Test Owner',
    email: 'owner@test.com',
    role: 'owner',
    accountId: ACCOUNT_ID,
    locationId: LOCATION_ID_1,
  };
}

function makePostRequest(body: unknown): NextRequest {
  return new NextRequest('http://localhost:3000/api/settings/channels/override', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

function makeDeleteRequest(body: unknown): NextRequest {
  return new NextRequest('http://localhost:3000/api/settings/channels/override', {
    method: 'DELETE',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

// ── Tests ────────────────────────────────────────────────────────────

describe('POST /api/settings/channels/override', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockRequireRole.mockResolvedValue(ownerUser());
  });

  it('creates per-location override cloning org-default values', async () => {
    // Mock: location belongs to account and is active
    mockSql.mockResolvedValueOnce([{
      id: LOCATION_ID_1,
      name: 'Downtown Cafe',
      display_label: 'Downtown Cafe',
    }]);
    // Mock: org-default enrollment exists
    mockSql.mockResolvedValueOnce([{
      id: ENROLLMENT_ID_ORG,
      handle: '@org_bot',
      status: 'verified',
      verified_at: new Date('2025-01-01'),
    }]);
    // Mock: no existing override
    mockSql.mockResolvedValueOnce([]);
    // Mock: INSERT succeeds
    mockSql.mockResolvedValueOnce([{ id: ENROLLMENT_ID_OVERRIDE }]);

    const res = await POST(makePostRequest({
      locationId: LOCATION_ID_1,
      channel: 'telegram',
    }));
    expect(res.status).toBe(201);

    const body = await res.json();
    expect(body.success).toBe(true);
    expect(body.override.handle).toBe('@org_bot');
    expect(body.override.locationId).toBe(LOCATION_ID_1);
    expect(body.override.channel).toBe('telegram');
  });

  it('returns 409 when override already exists', async () => {
    // Mock: location validation
    mockSql.mockResolvedValueOnce([{
      id: LOCATION_ID_1,
      name: 'Downtown Cafe',
      display_label: 'Downtown Cafe',
    }]);
    // Mock: org-default exists
    mockSql.mockResolvedValueOnce([{
      id: ENROLLMENT_ID_ORG,
      handle: '@org_bot',
      status: 'verified',
      verified_at: new Date(),
    }]);
    // Mock: existing override found
    mockSql.mockResolvedValueOnce([{ id: ENROLLMENT_ID_OVERRIDE }]);

    const res = await POST(makePostRequest({
      locationId: LOCATION_ID_1,
      channel: 'telegram',
    }));
    expect(res.status).toBe(409);

    const body = await res.json();
    expect(body.error).toContain('already exists');
  });

  it('returns 404 when no org-default enrollment exists', async () => {
    // Mock: location validation
    mockSql.mockResolvedValueOnce([{
      id: LOCATION_ID_1,
      name: 'Downtown Cafe',
      display_label: null,
    }]);
    // Mock: no org-default
    mockSql.mockResolvedValueOnce([]);

    const res = await POST(makePostRequest({
      locationId: LOCATION_ID_1,
      channel: 'telegram',
    }));
    expect(res.status).toBe(404);

    const body = await res.json();
    expect(body.error).toContain('No org-default enrollment');
  });

  it('returns 404 when location not found or not accessible', async () => {
    // Mock: location not found
    mockSql.mockResolvedValueOnce([]);

    const res = await POST(makePostRequest({
      locationId: '99999999-0000-4000-8000-000000000001',
      channel: 'telegram',
    }));
    expect(res.status).toBe(404);
  });

  it('returns 400 for invalid channel', async () => {
    const res = await POST(makePostRequest({
      locationId: LOCATION_ID_1,
      channel: 'invalid_channel',
    }));
    expect(res.status).toBe(400);
  });

  it('returns 403 when user has no account', async () => {
    mockRequireRole.mockResolvedValue({
      ...ownerUser(),
      accountId: null,
    });

    const res = await POST(makePostRequest({
      locationId: LOCATION_ID_1,
      channel: 'telegram',
    }));
    expect(res.status).toBe(403);
  });

  it('handles unique constraint violation gracefully', async () => {
    // Mock: location validation
    mockSql.mockResolvedValueOnce([{
      id: LOCATION_ID_1,
      name: 'Test',
      display_label: null,
    }]);
    // Mock: org-default exists
    mockSql.mockResolvedValueOnce([{
      id: ENROLLMENT_ID_ORG,
      handle: '@org_bot',
      status: 'verified',
      verified_at: new Date(),
    }]);
    // Mock: no existing override check
    mockSql.mockResolvedValueOnce([]);
    // Mock: INSERT fails with unique violation
    mockSql.mockRejectedValueOnce({ code: '23505', constraint: 'test_uniq' });

    const res = await POST(makePostRequest({
      locationId: LOCATION_ID_1,
      channel: 'telegram',
    }));
    expect(res.status).toBe(409);
  });
});

describe('DELETE /api/settings/channels/override', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockRequireRole.mockResolvedValue(ownerUser());
  });

  it('soft-deletes per-location override', async () => {
    // Mock: override found and archived
    mockSql.mockResolvedValueOnce([{ id: ENROLLMENT_ID_OVERRIDE }]);

    const res = await DELETE(makeDeleteRequest({
      locationId: LOCATION_ID_1,
      channel: 'telegram',
    }));
    expect(res.status).toBe(200);

    const body = await res.json();
    expect(body.success).toBe(true);
  });

  it('returns 404 when no override found', async () => {
    // Mock: no override found
    mockSql.mockResolvedValueOnce([]);

    const res = await DELETE(makeDeleteRequest({
      locationId: '99999999-0000-4000-8000-000000000001',
      channel: 'telegram',
    }));
    expect(res.status).toBe(404);
  });

  it('returns 401 when not authenticated', async () => {
    mockRequireRole.mockRejectedValue(new AuthError('Unauthorized', 401));

    const res = await DELETE(makeDeleteRequest({
      locationId: LOCATION_ID_1,
      channel: 'telegram',
    }));
    expect(res.status).toBe(401);
  });

  it('returns 400 for invalid channel', async () => {
    const res = await DELETE(makeDeleteRequest({
      locationId: LOCATION_ID_1,
      channel: 'invalid',
    }));
    expect(res.status).toBe(400);
  });
});
