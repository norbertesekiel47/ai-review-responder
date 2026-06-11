import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NextRequest } from 'next/server';

// ── Hoisted shared state ────────────────────────────────────────────

const {
  mockRequireRole,
  mockSqlUnsafe,
  mockTxUnsafe,
  mockSqlBegin,
  mockAssertWritableSubscriptionForAccount,
} = vi.hoisted(() => {
  const mockTxUnsafe = vi.fn();
  const mockSqlBegin = vi.fn(async (callback: (tx: { unsafe: typeof mockTxUnsafe }) => Promise<unknown>) => {
    return callback({ unsafe: mockTxUnsafe });
  });

  return {
    mockRequireRole: vi.fn(),
    mockSqlUnsafe: vi.fn(),
    mockTxUnsafe,
    mockSqlBegin,
    mockAssertWritableSubscriptionForAccount: vi.fn(),
  };
});

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
    begin: (...args: unknown[]) => mockSqlBegin(...(args as Parameters<typeof mockSqlBegin>)),
  });
  return { sql: sqlProxy, jsonb: (v: unknown) => v };
});

vi.mock('@/lib/shared/writable-subscription', () => ({
  assertWritableSubscriptionForAccount: (...args: unknown[]) => mockAssertWritableSubscriptionForAccount(...args),
}));

// Import AFTER mocks
import { PUT } from '../route';
import { AuthError } from '@/lib/db/auth';

// ── Helpers ─────────────────────────────────────────────────────────

const BUSINESS_ID = '01234567-0000-0000-0000-000000000001';
const ACCOUNT_ID = 'a0000000-0000-0000-0000-000000000001';
const APP_URL = 'http://localhost:3000';

function makeRequest(body: unknown, opts: { origin?: string | null } = {}): NextRequest {
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
  };
  const origin = opts.origin === undefined ? APP_URL : opts.origin;
  if (origin !== null) headers.Origin = origin;

  return new NextRequest('http://localhost:3000/api/settings', {
    method: 'PUT',
    headers,
    body: JSON.stringify(body),
  });
}

function ownerUser(overrides?: { locationId?: string | null }) {
  return {
    id: 'user-1',
    name: 'Test Owner',
    email: 'owner@test.com',
    role: 'owner',
    accountId: ACCOUNT_ID,
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
    // Default: tx updates return count=1 (success)
    mockTxUnsafe.mockResolvedValue({ count: 1 });
    mockAssertWritableSubscriptionForAccount.mockResolvedValue({ ok: true });
    process.env.NEXT_PUBLIC_APP_URL = APP_URL;
  });

  it('returns 403 when Origin header is absent', async () => {
    mockRequireRole.mockResolvedValue(ownerUser());

    const res = await PUT(makeRequest({ tone: 'friendly' }, { origin: null }));
    expect(res.status).toBe(403);
    expect(mockRequireRole).not.toHaveBeenCalled();
  });

  it('returns 403 when Origin does not match the app origin', async () => {
    mockRequireRole.mockResolvedValue(ownerUser());

    const res = await PUT(makeRequest({ tone: 'friendly' }, { origin: 'https://evil.example.com' }));
    expect(res.status).toBe(403);
    expect(mockRequireRole).not.toHaveBeenCalled();
  });

  it('returns 403 when user has no locationId', async () => {
    mockRequireRole.mockResolvedValue(ownerUser({ locationId: null }));

    const res = await PUT(makeRequest({ tone: 'friendly' }));
    expect(res.status).toBe(403);

    const body = await res.json();
    expect(body.error).toBe('No business associated with this account');
  });

  it('returns 402 when the account is past-due read-only', async () => {
    mockRequireRole.mockResolvedValue(ownerUser());
    mockAssertWritableSubscriptionForAccount.mockResolvedValueOnce({
      ok: false,
      status: 402,
      error: 'past_due_read_only',
    });

    const res = await PUT(makeRequest({ tone: 'friendly' }));
    expect(res.status).toBe(402);
    expect(await res.json()).toEqual({ error: 'past_due_read_only' });
    expect(mockAssertWritableSubscriptionForAccount).toHaveBeenCalledWith(ACCOUNT_ID);
    expect(mockSqlBegin).not.toHaveBeenCalled();
  });

  it('returns 400 for empty body {}', async () => {
    mockRequireRole.mockResolvedValue(ownerUser());

    const res = await PUT(makeRequest({}));
    expect(res.status).toBe(400);

    const body = await res.json();
    expect(body.error).toBe('At least one field must be provided');
  });

  it('returns 200 for updating tone (business-only, issues only businesses UPDATE)', async () => {
    mockRequireRole.mockResolvedValue(ownerUser());

    const res = await PUT(makeRequest({ tone: 'professional' }));
    expect(res.status).toBe(200);

    const body = await res.json();
    expect(body.success).toBe(true);

    // One sql.begin call; one tx.unsafe call (businesses only)
    expect(mockSqlBegin).toHaveBeenCalledOnce();
    expect(mockTxUnsafe).toHaveBeenCalledOnce();
    const [query, values] = mockTxUnsafe.mock.calls[0] as [string, unknown[]];
    expect(query).toContain('UPDATE businesses');
    expect(query).toContain('tone = $2');
    expect(query).toContain('updated_at = NOW()');
    expect(values[0]).toBe(BUSINESS_ID);
    expect(values[1]).toBe('professional');
  });

  it('returns 200 for toggling weeklySummaryEnabled to false (account-only, issues only accounts UPDATE)', async () => {
    mockRequireRole.mockResolvedValue(ownerUser());

    const res = await PUT(makeRequest({ weeklySummaryEnabled: false }));
    expect(res.status).toBe(200);

    expect(mockSqlBegin).toHaveBeenCalledOnce();
    expect(mockTxUnsafe).toHaveBeenCalledOnce();
    const [query, values] = mockTxUnsafe.mock.calls[0] as [string, unknown[]];
    expect(query).toContain('UPDATE accounts');
    expect(query).not.toContain('UPDATE businesses');
    expect(query).toContain('weekly_summary_enabled = $2');
    expect(values[0]).toBe(ACCOUNT_ID);
    expect(values[1]).toBe(false);
  });

  it('returns 200 for toggling monthlyImpactEnabled to false (account-only, issues only accounts UPDATE)', async () => {
    mockRequireRole.mockResolvedValue(ownerUser());

    const res = await PUT(makeRequest({ monthlyImpactEnabled: false }));
    expect(res.status).toBe(200);

    expect(mockSqlBegin).toHaveBeenCalledOnce();
    expect(mockTxUnsafe).toHaveBeenCalledOnce();
    const [query, values] = mockTxUnsafe.mock.calls[0] as [string, unknown[]];
    expect(query).toContain('UPDATE accounts');
    expect(query).not.toContain('UPDATE businesses');
    expect(query).toContain('monthly_impact_enabled = $2');
    expect(values[0]).toBe(ACCOUNT_ID);
    expect(values[1]).toBe(false);
  });

  it('ignores business_id in body and uses user.locationId', async () => {
    mockRequireRole.mockResolvedValue(ownerUser());

    const res = await PUT(
      makeRequest({ tone: 'warm', business_id: 'attacker-id-999' }),
    );
    expect(res.status).toBe(200);

    expect(mockTxUnsafe).toHaveBeenCalledOnce();
    const [query, values] = mockTxUnsafe.mock.calls[0] as [string, unknown[]];
    expect(query).toContain('WHERE id = $1');
    expect(values[0]).toBe(BUSINESS_ID);
    // business_id from body never appears in values
    expect(values).not.toContain('attacker-id-999');
  });

  it('returns 404 when business not found (count=0)', async () => {
    mockRequireRole.mockResolvedValue(ownerUser());
    // businesses update returns count=0 → not found
    mockTxUnsafe.mockResolvedValue({ count: 0 });

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

  // ── New E2 tests ─────────────────────────────────────────────────

  it('both scopes in one tx: PUT { weeklySummaryEnabled, tone } issues accounts UPDATE AND businesses UPDATE inside one sql.begin', async () => {
    mockRequireRole.mockResolvedValue(ownerUser());

    const res = await PUT(makeRequest({ weeklySummaryEnabled: false, tone: 'warm' }));
    expect(res.status).toBe(200);
    expect((await res.json()).success).toBe(true);

    // Exactly one transaction
    expect(mockSqlBegin).toHaveBeenCalledOnce();
    // Exactly two tx.unsafe calls (accounts + businesses)
    expect(mockTxUnsafe).toHaveBeenCalledTimes(2);

    const queries = mockTxUnsafe.mock.calls.map(([q]) => q as string);
    const accountsQuery = queries.find((q) => q.includes('UPDATE accounts'));
    const businessesQuery = queries.find((q) => q.includes('UPDATE businesses'));

    expect(accountsQuery).toBeDefined();
    expect(businessesQuery).toBeDefined();

    // accounts update uses accountId and the toggle column
    const accountsCall = mockTxUnsafe.mock.calls.find(([q]) => (q as string).includes('UPDATE accounts')) as [string, unknown[]];
    expect(accountsCall[0]).toContain('weekly_summary_enabled = $2');
    expect(accountsCall[1][0]).toBe(ACCOUNT_ID);
    expect(accountsCall[1][1]).toBe(false);

    // businesses update uses locationId and tone
    const businessCall = mockTxUnsafe.mock.calls.find(([q]) => (q as string).includes('UPDATE businesses')) as [string, unknown[]];
    expect(businessCall[0]).toContain('tone = $2');
    expect(businessCall[1][0]).toBe(BUSINESS_ID);
    expect(businessCall[1][1]).toBe('warm');
  });

  it('account-only: PUT { monthlyImpactEnabled } issues ONLY accounts UPDATE, no businesses UPDATE', async () => {
    mockRequireRole.mockResolvedValue(ownerUser());

    const res = await PUT(makeRequest({ monthlyImpactEnabled: true }));
    expect(res.status).toBe(200);

    expect(mockSqlBegin).toHaveBeenCalledOnce();
    expect(mockTxUnsafe).toHaveBeenCalledOnce();

    const [query, values] = mockTxUnsafe.mock.calls[0] as [string, unknown[]];
    expect(query).toContain('UPDATE accounts');
    expect(query).not.toContain('UPDATE businesses');
    expect(query).toContain('monthly_impact_enabled = $2');
    expect(values[0]).toBe(ACCOUNT_ID);
    expect(values[1]).toBe(true);
  });

  it('business-only: PUT { tone } issues ONLY businesses UPDATE, no accounts UPDATE', async () => {
    mockRequireRole.mockResolvedValue(ownerUser());

    const res = await PUT(makeRequest({ tone: 'casual' }));
    expect(res.status).toBe(200);

    expect(mockSqlBegin).toHaveBeenCalledOnce();
    expect(mockTxUnsafe).toHaveBeenCalledOnce();

    const [query, values] = mockTxUnsafe.mock.calls[0] as [string, unknown[]];
    expect(query).toContain('UPDATE businesses');
    expect(query).not.toContain('UPDATE accounts');
    expect(query).toContain('tone = $2');
    expect(values[0]).toBe(BUSINESS_ID);
    expect(values[1]).toBe('casual');
  });

  it('business-not-found rolls back: businesses count=0 returns 404 and rolls back the tx', async () => {
    mockRequireRole.mockResolvedValue(ownerUser());

    // Route runs businesses UPDATE first, then accounts UPDATE.
    // Simulate businesses returning count=0 (not found); accounts would be
    // skipped because the sentinel throw rolls back the tx.
    mockTxUnsafe.mockResolvedValueOnce({ count: 0 }); // businesses call → not found

    // Send both scopes so both updates would be attempted if tx continued
    const res = await PUT(makeRequest({ weeklySummaryEnabled: true, tone: 'warm' }));
    expect(res.status).toBe(404);

    const body = await res.json();
    expect(body.error).toBe('Business not found');

    // The sql.begin was called; sentinel throw caused rollback before accounts UPDATE
    expect(mockSqlBegin).toHaveBeenCalledOnce();
    // Only one tx.unsafe call — businesses; accounts never reached
    expect(mockTxUnsafe).toHaveBeenCalledOnce();
  });
});
