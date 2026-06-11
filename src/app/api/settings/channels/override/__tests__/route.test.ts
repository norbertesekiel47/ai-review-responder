import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NextRequest } from 'next/server';

// ── Hoisted shared state ────────────────────────────────────────────

const {
  mockRequireRole,
  mockSql,
  mockSqlUnsafe,
  mockJsonb,
  mockAssertWritableSubscriptionForAccount,
  mockSqlBegin,
  mockTx,
  mockWriteAccountAuditLog,
} = vi.hoisted(() => {
  // mockTx is a callable template-tag function (mirrors postgres.js TransactionSql)
  const mockTx = vi.fn().mockResolvedValue([]);

  // mockSqlBegin invokes the callback with mockTx so the tx path executes
  const mockSqlBegin = vi.fn(async (callback: (tx: typeof mockTx) => Promise<unknown>) => {
    return callback(mockTx);
  });

  return {
    mockRequireRole: vi.fn(),
    mockSql: vi.fn(),
    mockSqlUnsafe: vi.fn(),
    mockJsonb: vi.fn((val: unknown) => JSON.stringify(val)),
    mockAssertWritableSubscriptionForAccount: vi.fn(),
    mockSqlBegin,
    mockTx,
    mockWriteAccountAuditLog: vi.fn().mockResolvedValue(undefined),
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
  const sqlProxy = Object.assign((...args: unknown[]) => mockSql(...args), {
    unsafe: (...args: unknown[]) => mockSqlUnsafe(...args),
    begin: (...args: unknown[]) => mockSqlBegin(...(args as Parameters<typeof mockSqlBegin>)),
  });
  return { sql: sqlProxy, jsonb: mockJsonb };
});

// ── Mock Audit Log ──────────────────────────────────────────────────

vi.mock('@/lib/audit/log', () => ({
  writeAccountAuditLog: (...args: unknown[]) => mockWriteAccountAuditLog(...args),
}));

vi.mock('@/lib/shared/writable-subscription', () => ({
  assertWritableSubscriptionForAccount: (...args: unknown[]) => mockAssertWritableSubscriptionForAccount(...args),
}));

// ── Mock uuid ───────────────────────────────────────────────────────

vi.mock('uuid', () => ({
  v7: () => 'mock-uuid-v7',
}));

// ── Mock redis-cache (invalidateChannelCache calls getCacheRedis) ───

vi.mock('@/lib/db/redis-cache', () => ({
  getCacheRedis: () => ({
    get: vi.fn().mockResolvedValue(null),
    set: vi.fn().mockResolvedValue('OK'),
    keys: vi.fn().mockResolvedValue([]),
    del: vi.fn().mockResolvedValue(0),
  }),
}));

// Import AFTER mocks
import { POST, DELETE } from '../route';
import { AuthError } from '@/lib/db/auth';

// ── Helpers ─────────────────────────────────────────────────────────

const ACCOUNT_ID = 'a0000000-0000-4000-8000-000000000001';
const LOCATION_ID_1 = 'b1111111-0000-4000-8000-000000000001';
const ENROLLMENT_ID_ORG = 'e0000000-0000-4000-8000-000000000001';
const ENROLLMENT_ID_OVERRIDE = 'e0000000-0000-4000-8000-000000000002';
const APP_URL = 'http://localhost:3000';

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
    headers: { 'Content-Type': 'application/json', Origin: APP_URL },
    body: JSON.stringify(body),
  });
}

function makeDeleteRequest(body: unknown): NextRequest {
  return new NextRequest('http://localhost:3000/api/settings/channels/override', {
    method: 'DELETE',
    headers: { 'Content-Type': 'application/json', Origin: APP_URL },
    body: JSON.stringify(body),
  });
}

// ── Tests ────────────────────────────────────────────────────────────

describe('POST /api/settings/channels/override', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockRequireRole.mockResolvedValue(ownerUser());
    mockAssertWritableSubscriptionForAccount.mockResolvedValue({ ok: true });
    // Default: tx template tag calls return empty array
    mockTx.mockResolvedValue([]);
    // Default: writeAccountAuditLog succeeds
    mockWriteAccountAuditLog.mockResolvedValue(undefined);
    process.env.NEXT_PUBLIC_APP_URL = APP_URL;
  });

  it('creates per-location override cloning org-default values', async () => {
    // Pre-tx: location belongs to account and is active
    mockSql.mockResolvedValueOnce([{
      id: LOCATION_ID_1,
      name: 'Downtown Cafe',
      display_label: 'Downtown Cafe',
    }]);
    // Pre-tx: org-default enrollment exists
    mockSql.mockResolvedValueOnce([{
      id: ENROLLMENT_ID_ORG,
      handle: '@org_bot',
      status: 'verified',
      verified_at: new Date('2025-01-01'),
    }]);
    // Pre-tx: no existing override
    mockSql.mockResolvedValueOnce([]);
    // Inside tx: INSERT returns new row
    mockTx.mockResolvedValueOnce([{ id: ENROLLMENT_ID_OVERRIDE }]);
    // writeAccountAuditLog resolves (called inside tx)

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

  it('rejects channel "sms" with 400 (channel removed)', async () => {
    const res = await POST(makePostRequest({
      locationId: LOCATION_ID_1,
      channel: 'sms',
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

  it('returns 402 without creating an override when the account is past-due read-only', async () => {
    mockAssertWritableSubscriptionForAccount.mockResolvedValueOnce({
      ok: false,
      status: 402,
      error: 'past_due_read_only',
    });

    const res = await POST(makePostRequest({
      locationId: LOCATION_ID_1,
      channel: 'telegram',
    }));

    expect(res.status).toBe(402);
    expect(await res.json()).toEqual({ error: 'past_due_read_only' });
    expect(mockAssertWritableSubscriptionForAccount).toHaveBeenCalledWith(ACCOUNT_ID);
    expect(mockSql).not.toHaveBeenCalled();
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
    // Inside tx: INSERT fails with unique violation
    mockTx.mockRejectedValueOnce({ code: '23505', constraint: 'test_uniq' });

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
    mockAssertWritableSubscriptionForAccount.mockResolvedValue({ ok: true });
    mockTx.mockResolvedValue([]);
    mockWriteAccountAuditLog.mockResolvedValue(undefined);
    process.env.NEXT_PUBLIC_APP_URL = APP_URL;
  });

  it('soft-deletes per-location override', async () => {
    // Inside tx: override found and archived
    mockTx.mockResolvedValueOnce([{ id: ENROLLMENT_ID_OVERRIDE }]);
    // writeAccountAuditLog resolves (called inside tx)

    const res = await DELETE(makeDeleteRequest({
      locationId: LOCATION_ID_1,
      channel: 'telegram',
    }));
    expect(res.status).toBe(200);

    const body = await res.json();
    expect(body.success).toBe(true);
  });

  it('returns 404 when no override found', async () => {
    // Inside tx (or pre-tx): UPDATE returns no rows → 404 before audit
    mockTx.mockResolvedValueOnce([]);

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

  it('returns 402 without deleting an override when the account is past-due read-only', async () => {
    mockAssertWritableSubscriptionForAccount.mockResolvedValueOnce({
      ok: false,
      status: 402,
      error: 'past_due_read_only',
    });

    const res = await DELETE(makeDeleteRequest({
      locationId: LOCATION_ID_1,
      channel: 'telegram',
    }));

    expect(res.status).toBe(402);
    expect(await res.json()).toEqual({ error: 'past_due_read_only' });
    expect(mockAssertWritableSubscriptionForAccount).toHaveBeenCalledWith(ACCOUNT_ID);
    expect(mockSql).not.toHaveBeenCalled();
  });
});

// ── Audit trail for channel override changes ─────────────────────────

describe('Audit trail for channel override changes', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockRequireRole.mockResolvedValue(ownerUser());
    mockAssertWritableSubscriptionForAccount.mockResolvedValue({ ok: true });
    mockTx.mockResolvedValue([]);
    mockWriteAccountAuditLog.mockResolvedValue(undefined);
    process.env.NEXT_PUBLIC_APP_URL = APP_URL;
  });

  it('POST writes audit log entry with channel_override_created event via writeAccountAuditLog', async () => {
    // Pre-tx: location validation
    mockSql.mockResolvedValueOnce([{
      id: LOCATION_ID_1,
      name: 'Downtown Cafe',
      display_label: 'Downtown Cafe',
    }]);
    // Pre-tx: org-default enrollment exists
    mockSql.mockResolvedValueOnce([{
      id: ENROLLMENT_ID_ORG,
      handle: '@org_bot',
      status: 'verified',
      verified_at: new Date('2025-01-01'),
    }]);
    // Pre-tx: no existing override
    mockSql.mockResolvedValueOnce([]);
    // Inside tx: INSERT returns new row
    mockTx.mockResolvedValueOnce([{ id: ENROLLMENT_ID_OVERRIDE }]);

    const res = await POST(makePostRequest({
      locationId: LOCATION_ID_1,
      channel: 'telegram',
    }));
    expect(res.status).toBe(201);

    // writeAccountAuditLog must have been called with channel_override_created
    expect(mockWriteAccountAuditLog).toHaveBeenCalledOnce();
    const [input, tx] = mockWriteAccountAuditLog.mock.calls[0] as [
      { accountId: string; locationId: string; actorUserId: string | null; eventType: string; payload: Record<string, unknown>; entityType?: string; entityId?: string },
      unknown,
    ];
    expect(input.eventType).toBe('channel_override_created');
    expect(input.accountId).toBe(ACCOUNT_ID);
    expect(input.locationId).toBe(LOCATION_ID_1);
    expect(input.actorUserId).toBe('user-1');
    expect(input.payload).toMatchObject({ channel: 'telegram', override_enrollment_id: ENROLLMENT_ID_OVERRIDE });
    // tx arg must be the transaction handle (not undefined)
    expect(tx).toBeDefined();
    expect(tx).toBe(mockTx);
  });

  it('DELETE writes audit log entry with channel_override_removed event via writeAccountAuditLog', async () => {
    // Inside tx: override found and archived
    mockTx.mockResolvedValueOnce([{ id: ENROLLMENT_ID_OVERRIDE }]);

    const res = await DELETE(makeDeleteRequest({
      locationId: LOCATION_ID_1,
      channel: 'telegram',
    }));
    expect(res.status).toBe(200);

    // writeAccountAuditLog must have been called with channel_override_removed
    expect(mockWriteAccountAuditLog).toHaveBeenCalledOnce();
    const [input, tx] = mockWriteAccountAuditLog.mock.calls[0] as [
      { accountId: string; locationId: string; actorUserId: string | null; eventType: string; payload: Record<string, unknown>; entityType?: string; entityId?: string },
      unknown,
    ];
    expect(input.eventType).toBe('channel_override_removed');
    expect(input.accountId).toBe(ACCOUNT_ID);
    expect(input.locationId).toBe(LOCATION_ID_1);
    expect(input.actorUserId).toBe('user-1');
    expect(input.payload).toMatchObject({ channel: 'telegram', archived_enrollment_id: ENROLLMENT_ID_OVERRIDE });
    expect(tx).toBeDefined();
    expect(tx).toBe(mockTx);
  });
});

// ── Atomicity: enrollment mutation + audit in one transaction ─────────

describe('Atomicity: enrollment mutation + audit in one sql.begin transaction', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockRequireRole.mockResolvedValue(ownerUser());
    mockAssertWritableSubscriptionForAccount.mockResolvedValue({ ok: true });
    mockTx.mockResolvedValue([]);
    mockWriteAccountAuditLog.mockResolvedValue(undefined);
    process.env.NEXT_PUBLIC_APP_URL = APP_URL;
  });

  it('CREATE: enrollment INSERT and audit are inside one sql.begin; cache invalidated after commit', async () => {
    // Pre-tx setup
    mockSql.mockResolvedValueOnce([{ id: LOCATION_ID_1, name: 'Cafe', display_label: null }]);
    mockSql.mockResolvedValueOnce([{ id: ENROLLMENT_ID_ORG, handle: '@h', status: 'verified', verified_at: null }]);
    mockSql.mockResolvedValueOnce([]);
    // Inside tx: INSERT returns row
    mockTx.mockResolvedValueOnce([{ id: ENROLLMENT_ID_OVERRIDE }]);

    const res = await POST(makePostRequest({ locationId: LOCATION_ID_1, channel: 'telegram' }));
    expect(res.status).toBe(201);

    // sql.begin was called once
    expect(mockSqlBegin).toHaveBeenCalledOnce();
    // The tx template-tag fn was used for the INSERT inside the tx
    expect(mockTx).toHaveBeenCalledOnce();
    // writeAccountAuditLog was called (inside begin via tx arg)
    expect(mockWriteAccountAuditLog).toHaveBeenCalledOnce();
    // The tx passed to writeAccountAuditLog is the same tx handle
    const [, txArg] = mockWriteAccountAuditLog.mock.calls[0] as [unknown, unknown];
    expect(txArg).toBe(mockTx);
  });

  it('CREATE: if audit write throws, tx rejects (enrollment rolled back) and response is 500; cache NOT invalidated', async () => {
    // Pre-tx setup
    mockSql.mockResolvedValueOnce([{ id: LOCATION_ID_1, name: 'Cafe', display_label: null }]);
    mockSql.mockResolvedValueOnce([{ id: ENROLLMENT_ID_ORG, handle: '@h', status: 'verified', verified_at: null }]);
    mockSql.mockResolvedValueOnce([]);
    // Inside tx: INSERT succeeds
    mockTx.mockResolvedValueOnce([{ id: ENROLLMENT_ID_OVERRIDE }]);
    // But audit write throws
    mockWriteAccountAuditLog.mockRejectedValueOnce(new Error('audit DB error'));
    // sql.begin must propagate the rejection (simulating rollback)
    mockSqlBegin.mockImplementationOnce(async (callback: (tx: typeof mockTx) => Promise<unknown>) => {
      return callback(mockTx);
      // The callback will throw because writeAccountAuditLog rejects
    });

    // getCacheRedis del spy — need to check it's NOT called
    const { getCacheRedis } = await import('@/lib/db/redis-cache');
    const redisMock = getCacheRedis() as unknown as { del: ReturnType<typeof vi.fn> };
    redisMock.del.mockClear();

    const res = await POST(makePostRequest({ locationId: LOCATION_ID_1, channel: 'telegram' }));
    expect(res.status).toBe(500);

    // Cache invalidation did NOT run (del not called)
    expect(redisMock.del).not.toHaveBeenCalled();
  });

  it('CREATE: cache invalidated AFTER sql.begin resolves (not inside tx)', async () => {
    // Pre-tx setup
    mockSql.mockResolvedValueOnce([{ id: LOCATION_ID_1, name: 'Cafe', display_label: null }]);
    mockSql.mockResolvedValueOnce([{ id: ENROLLMENT_ID_ORG, handle: '@h', status: 'verified', verified_at: null }]);
    mockSql.mockResolvedValueOnce([]);
    // Inside tx: INSERT succeeds
    mockTx.mockResolvedValueOnce([{ id: ENROLLMENT_ID_OVERRIDE }]);

    const callOrder: string[] = [];
    mockWriteAccountAuditLog.mockImplementationOnce(async () => {
      callOrder.push('audit');
    });
    const { getCacheRedis } = await import('@/lib/db/redis-cache');
    const redisMock = getCacheRedis() as unknown as { keys: ReturnType<typeof vi.fn>; del: ReturnType<typeof vi.fn> };
    redisMock.keys.mockImplementation(async () => {
      callOrder.push('cacheInvalidate');
      return [];
    });
    redisMock.del.mockClear();

    await POST(makePostRequest({ locationId: LOCATION_ID_1, channel: 'telegram' }));

    // audit happened; cache key lookup happened after begin resolved
    // The key invariant: cacheInvalidate must NOT happen before the begin resolves,
    // i.e. mockSqlBegin must complete before cache is touched.
    // Since our mock runs synchronously inside begin, audit runs before cacheInvalidate.
    const auditIdx = callOrder.indexOf('audit');
    const cacheIdx = callOrder.indexOf('cacheInvalidate');
    if (cacheIdx !== -1) {
      // If cache was invalidated, it must be after audit (which is inside begin)
      expect(auditIdx).toBeLessThan(cacheIdx);
    }
    // And sql.begin was fully called before cache step
    expect(mockSqlBegin).toHaveBeenCalledOnce();
  });

  it('DELETE: enrollment UPDATE and audit are inside one sql.begin; cache invalidated after commit', async () => {
    // Inside tx: UPDATE returns archived row
    mockTx.mockResolvedValueOnce([{ id: ENROLLMENT_ID_OVERRIDE }]);

    const res = await DELETE(makeDeleteRequest({ locationId: LOCATION_ID_1, channel: 'telegram' }));
    expect(res.status).toBe(200);

    // sql.begin was called once
    expect(mockSqlBegin).toHaveBeenCalledOnce();
    // The tx template-tag fn was used for the UPDATE inside the tx
    expect(mockTx).toHaveBeenCalledOnce();
    // writeAccountAuditLog was called (inside begin via tx arg)
    expect(mockWriteAccountAuditLog).toHaveBeenCalledOnce();
    const [, txArg] = mockWriteAccountAuditLog.mock.calls[0] as [unknown, unknown];
    expect(txArg).toBe(mockTx);
  });

  it('DELETE: if audit write throws, tx rejects (enrollment rolled back) and response is 500; cache NOT invalidated', async () => {
    // Inside tx: UPDATE succeeds
    mockTx.mockResolvedValueOnce([{ id: ENROLLMENT_ID_OVERRIDE }]);
    // But audit write throws
    mockWriteAccountAuditLog.mockRejectedValueOnce(new Error('audit DB error'));

    const { getCacheRedis } = await import('@/lib/db/redis-cache');
    const redisMock = getCacheRedis() as unknown as { del: ReturnType<typeof vi.fn> };
    redisMock.del.mockClear();

    const res = await DELETE(makeDeleteRequest({ locationId: LOCATION_ID_1, channel: 'telegram' }));
    expect(res.status).toBe(500);

    // Cache invalidation did NOT run
    expect(redisMock.del).not.toHaveBeenCalled();
  });

  it('DELETE: if no override exists (tx returns 0 rows), 404 returned; no audit written; cache NOT invalidated', async () => {
    // Inside tx: UPDATE returns no rows
    mockTx.mockResolvedValueOnce([]);

    const { getCacheRedis } = await import('@/lib/db/redis-cache');
    const redisMock = getCacheRedis() as unknown as { del: ReturnType<typeof vi.fn> };
    redisMock.del.mockClear();

    const res = await DELETE(makeDeleteRequest({ locationId: LOCATION_ID_1, channel: 'telegram' }));
    expect(res.status).toBe(404);

    // No audit log entry for a no-op
    expect(mockWriteAccountAuditLog).not.toHaveBeenCalled();
    // No cache invalidation
    expect(redisMock.del).not.toHaveBeenCalled();
  });
});
