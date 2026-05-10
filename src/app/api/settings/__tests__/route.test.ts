import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NextRequest } from 'next/server';

// ── Hoisted shared state ────────────────────────────────────────────

const { mockRequireRole, mockSqlUnsafe } = vi.hoisted(() => ({
  mockRequireRole: vi.fn(),
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
  const sqlProxy = Object.assign(() => {}, {
    unsafe: (...args: unknown[]) => mockSqlUnsafe(...args),
  });
  return { sql: sqlProxy , jsonb: (v: unknown) => v };
});

// Import AFTER mocks
import { PUT } from '../route';
import { AuthError } from '@/lib/db/auth';

// ── Helpers ─────────────────────────────────────────────────────────

const BUSINESS_ID = '01234567-0000-0000-0000-000000000001';

function makeRequest(body: unknown): NextRequest {
  return new NextRequest('http://localhost:3000/api/settings', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

function ownerUser(overrides?: { locationId?: string | null }) {
  return {
    id: 'user-1',
    name: 'Test Owner',
    email: 'owner@test.com',
    role: 'owner',
    accountId: 'a0000000-0000-0000-0000-000000000001',
    locationId:
      overrides && 'locationId' in overrides
        ? overrides.locationId
        : BUSINESS_ID,
  };
}

// ── Tests ────────────────────────────────────────────────────────────

describe('PUT /api/settings', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockSqlUnsafe.mockResolvedValue({ count: 1 });
  });

  it('returns 403 when user has no locationId', async () => {
    mockRequireRole.mockResolvedValue(ownerUser({ locationId: null }));

    const res = await PUT(makeRequest({ tone: 'friendly' }));
    expect(res.status).toBe(403);

    const body = await res.json();
    expect(body.error).toBe('No business associated with this account');
  });

  it('returns 400 for empty body {}', async () => {
    mockRequireRole.mockResolvedValue(ownerUser());

    const res = await PUT(makeRequest({}));
    expect(res.status).toBe(400);

    const body = await res.json();
    expect(body.error).toBe('At least one field must be provided');
  });

  it('returns 200 for updating tone', async () => {
    mockRequireRole.mockResolvedValue(ownerUser());

    const res = await PUT(makeRequest({ tone: 'professional' }));
    expect(res.status).toBe(200);

    const body = await res.json();
    expect(body.success).toBe(true);

    expect(mockSqlUnsafe).toHaveBeenCalledOnce();
    const [query, values] = mockSqlUnsafe.mock.calls[0] as [string, unknown[]];
    expect(query).toContain('tone = $2');
    expect(query).toContain('updated_at = NOW()');
    expect(values[0]).toBe(BUSINESS_ID);
    expect(values[1]).toBe('professional');
  });

  it('returns 200 for toggling weeklySummaryEnabled to false', async () => {
    mockRequireRole.mockResolvedValue(ownerUser());

    const res = await PUT(makeRequest({ weeklySummaryEnabled: false }));
    expect(res.status).toBe(200);

    const [query, values] = mockSqlUnsafe.mock.calls[0] as [string, unknown[]];
    expect(query).toContain('weekly_summary_enabled = $2');
    expect(values[1]).toBe(false);
  });

  it('returns 200 for toggling monthlyImpactEnabled to false', async () => {
    mockRequireRole.mockResolvedValue(ownerUser());

    const res = await PUT(makeRequest({ monthlyImpactEnabled: false }));
    expect(res.status).toBe(200);

    const [query, values] = mockSqlUnsafe.mock.calls[0] as [string, unknown[]];
    expect(query).toContain('monthly_impact_enabled = $2');
    expect(values[1]).toBe(false);
  });

  it('ignores business_id in body and uses user.locationId', async () => {
    mockRequireRole.mockResolvedValue(ownerUser());

    const res = await PUT(
      makeRequest({ tone: 'warm', business_id: 'attacker-id-999' }),
    );
    expect(res.status).toBe(200);

    const [query, values] = mockSqlUnsafe.mock.calls[0] as [string, unknown[]];
    expect(query).toContain('WHERE id = $1');
    expect(values[0]).toBe(BUSINESS_ID);
    // business_id from body never appears in values
    expect(values).not.toContain('attacker-id-999');
  });

  it('returns 404 when business not found (count=0)', async () => {
    mockRequireRole.mockResolvedValue(ownerUser());
    mockSqlUnsafe.mockResolvedValue({ count: 0 });

    const res = await PUT(makeRequest({ tone: 'casual' }));
    expect(res.status).toBe(404);

    const body = await res.json();
    expect(body.error).toBe('Business not found');
  });

  it('returns no-store Cache-Control header on success', async () => {
    mockRequireRole.mockResolvedValue(ownerUser());

    const res = await PUT(makeRequest({ tone: 'friendly' }));
    expect(res.headers.get('Cache-Control')).toBe('no-store, private');
  });

  it('returns 401 when requireRole throws AuthError(401)', async () => {
    mockRequireRole.mockRejectedValue(new AuthError('Unauthorized', 401));

    const res = await PUT(makeRequest({ tone: 'test' }));
    expect(res.status).toBe(401);
  });
});
