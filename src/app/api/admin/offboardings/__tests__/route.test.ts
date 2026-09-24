import { adminBearerRequest } from '@/lib/auth/__tests__/helpers/admin-gate-mocks';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';

const {
  mockRequireRole,
  mockRequireCurrentAal2FromSupabase,
  mockLoadAppUser,
  mockResolveAdminApiIdentity,
  mockRecordProviderDisposition,
  mockRetryAccountOffboardingPurge,
  mockSql,
  sqlCalls,
} = await vi.hoisted(async () => {
  const { makeAdminGateMocks } = await import('@/lib/auth/__tests__/helpers/admin-gate-mocks');
  const sqlCalls: { text: string; values: unknown[] }[] = [];
  const mockSql: any = vi.fn((strings: TemplateStringsArray, ...values: unknown[]) => {
    const text = strings.join('?');
    sqlCalls.push({ text, values });
    if (text.includes('COUNT(*)')) return Promise.resolve([{ total: 1 }]);
    return Promise.resolve([{
      id: '22222222-2222-4222-8222-222222222222',
      account_id: '11111111-1111-4111-8111-111111111111',
      account_name: 'Acme Dental',
      subscription_status: 'cancelled',
      mode: 'delete_data',
      status: 'failed',
      failed_step: 'teardown',
      last_error: 'zernio token=secret-token-1234567890 {"client_secret":"raw-client-secret","api_key":"raw-api-key"} failed for Bearer live-secret',
      requested_at: '2026-06-01T12:00:00.000Z',
      access_ends_at: null,
      teardown_started_at: '2026-06-02T12:00:00.000Z',
      teardown_completed_at: null,
      purge_after: '2026-07-01T12:00:00.000Z',
      purge_started_at: null,
      purge_cancelled_at: null,
      purged_at: null,
      terminal_at: null,
      retry_count: 1,
      is_stuck: true,
      stripe_step: 'success',
      zernio_accounts_step: 'failed',
      zernio_profiles_step: 'not_applicable',
      location_archival_step: 'success',
      job_terminalization_step: 'success',
      provider_dispositions: [{
        type: 'admin_provider_disposition',
        provider: 'zernio',
        resource_type: 'account',
        scrubbed_resource_reference: 'sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
        admin_actor_user_id: '33333333-3333-4333-8333-333333333333',
        reason: 'Provider support confirmed teardown.',
        recorded_at: '2026-06-07T12:00:00.000Z',
        ticket: 'SUP-123',
      }],
    }]);
  });

  return {
    ...makeAdminGateMocks(),
    mockRecordProviderDisposition: vi.fn(),
    mockRetryAccountOffboardingPurge: vi.fn(),
    mockSql,
    sqlCalls,
  };
});

vi.mock('@supabase/ssr', () => ({
  createServerClient: vi.fn(() => ({ auth: { mfa: {} } })),
}));

vi.mock('@/lib/db/auth', () => ({
  requireRole: mockRequireRole,
  loadAppUser: mockLoadAppUser,
  cookieBackedServerClient: () => ({ auth: { mfa: {} } }),
  AuthError: class AuthError extends Error {
    constructor(message: string, public readonly statusCode: number) {
      super(message);
    }
  },
}));

vi.mock('@/lib/auth/mfa', () => ({
  requireCurrentAal2FromSupabase: mockRequireCurrentAal2FromSupabase,
}));

// #1184: the gate's dependency stand-ins have one owner —
// src/lib/auth/__tests__/helpers/admin-gate-mocks.ts.
vi.mock('@/lib/auth/verified-identity', () => ({
  resolveAdminApiIdentity: mockResolveAdminApiIdentity,
}));

vi.mock('@/lib/db/server', () => ({
  sql: mockSql,
}));

vi.mock('@/lib/account-offboarding/provider-disposition', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/account-offboarding/provider-disposition')>();
  return {
    ...actual,
    recordProviderDisposition: mockRecordProviderDisposition,
  };
});

vi.mock('@/lib/account-offboarding/retry-purge', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/account-offboarding/retry-purge')>();
  return {
    ...actual,
    retryAccountOffboardingPurge: mockRetryAccountOffboardingPurge,
  };
});

process.env.NEXT_PUBLIC_APP_URL = 'https://app.example.com';
process.env.NEXT_PUBLIC_SUPABASE_URL = 'https://supabase.example.com';
process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = 'anon-key';

const OFFBOARDING_ID = '22222222-2222-4222-8222-222222222222';
const ADMIN_ID = '33333333-3333-4333-8333-333333333333';

function adminUser() {
  return {
    id: ADMIN_ID,
    role: 'admin',
    email: 'admin@example.com',
    name: 'Admin',
    accountId: null,
    locationId: null,
  };
}

function getReq(path = '/api/admin/offboardings'): NextRequest {
  return adminBearerRequest(`https://app.example.com${path}`);
}

function postReq(body: unknown, headers: Record<string, string> = {}): NextRequest {
  return adminBearerRequest(
    `https://app.example.com/api/admin/offboardings/${OFFBOARDING_ID}/provider-disposition`,
    {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        origin: 'https://app.example.com',
        'x-forwarded-for': '203.0.113.10',
        'user-agent': 'vitest',
        ...headers,
      },
      body: JSON.stringify(body),
    },
  );
}

function postPurgeRetryReq(
  offboardingId: string = OFFBOARDING_ID,
  headers: Record<string, string> = {},
): NextRequest {
  return adminBearerRequest(
    `https://app.example.com/api/admin/offboardings/${offboardingId}/retry-purge`,
    {
      method: 'POST',
      headers: {
        origin: 'https://app.example.com',
        'x-forwarded-for': '203.0.113.10',
        'user-agent': 'vitest',
        ...headers,
      },
    },
  );
}

const ctx = { params: Promise.resolve({ offboardingId: OFFBOARDING_ID }) };

describe('GET /api/admin/offboardings', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    sqlCalls.length = 0;
    mockRequireRole.mockResolvedValue(adminUser());
    mockRequireCurrentAal2FromSupabase.mockResolvedValue({ ok: true });
    mockRecordProviderDisposition.mockResolvedValue({
      disposition: {
        provider: 'zernio',
        resource_type: 'account',
        scrubbed_resource_reference: 'sha256:abc',
      },
    });
  });

  it('requires admin role and returns active or failed offboardings with scrubbed operational fields', async () => {
    const { GET } = await import('../route');

    const res = await GET(getReq());

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.offboardings).toHaveLength(1);
    expect(body.offboardings[0]).toMatchObject({
      id: OFFBOARDING_ID,
      accountId: '11111111-1111-4111-8111-111111111111',
      accountName: 'Acme Dental',
      mode: 'delete_data',
      status: 'failed',
      failedStep: 'teardown',
      providerSteps: {
        stripe: 'success',
        zernioAccounts: 'failed',
        zernioProfiles: 'not_applicable',
        locationArchival: 'success',
        jobTerminalization: 'success',
      },
    });
    expect(body.offboardings[0].lastError).toContain('[redacted]');
    expect(body.offboardings[0].lastError).not.toContain('secret-token');
    expect(body.offboardings[0].lastError).not.toContain('raw-client-secret');
    expect(body.offboardings[0].lastError).not.toContain('raw-api-key');
    expect(body.offboardings[0].lastError).not.toContain('live-secret');
    expect(body.offboardings[0].providerDispositions[0]).toMatchObject({
      provider: 'zernio',
      resource_type: 'account',
      scrubbed_resource_reference: 'sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
      ticket: 'SUP-123',
    });
    expect(JSON.stringify(body)).not.toContain('response_text');
    expect(sqlCalls[0]!.text).toContain('terminal_at IS NULL');
  });

  it('returns auth rejection before querying', async () => {
    const { AuthError } = await import('@/lib/db/auth');
    const { GET } = await import('../route');
    mockRequireRole.mockRejectedValueOnce(new AuthError('Forbidden', 403));

    const res = await GET(getReq());

    expect(res.status).toBe(403);
    expect(mockSql).not.toHaveBeenCalled();
  });
});

describe('POST /api/admin/offboardings/[offboardingId]/provider-disposition', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    sqlCalls.length = 0;
    mockRequireRole.mockResolvedValue(adminUser());
    mockRequireCurrentAal2FromSupabase.mockResolvedValue({ ok: true });
    mockRecordProviderDisposition.mockResolvedValue({
      offboardingId: OFFBOARDING_ID,
      accountId: '11111111-1111-4111-8111-111111111111',
      transitionedToPurgeScheduled: true,
      disposition: {
        type: 'admin_provider_disposition',
        provider: 'zernio',
        resource_type: 'account',
        scrubbed_resource_reference: 'sha256:abc',
        reason: 'Provider support confirmed teardown.',
        admin_actor_user_id: ADMIN_ID,
        recorded_at: '2026-06-07T12:00:00.000Z',
        ticket: null,
      },
    });
  });

  it('requires bearer admin AAL2 before recording a concrete provider disposition', async () => {
    const { AuthError } = await import('@/lib/db/auth');
    const { POST } = await import('../[offboardingId]/provider-disposition/route');

    mockRequireRole.mockRejectedValueOnce(new AuthError('Forbidden', 403));
    expect((await POST(postReq({
      provider: 'zernio',
      resourceType: 'account',
      resourceReference: 'zernio-secret-id',
      reason: 'Provider support confirmed teardown.',
    }), ctx)).status).toBe(403);

    mockRequireRole.mockResolvedValue(adminUser());
    mockRequireCurrentAal2FromSupabase.mockResolvedValueOnce({ ok: false, reason: 'mfa_required' });
    const aalRes = await POST(postReq({
      provider: 'zernio',
      resourceType: 'account',
      resourceReference: 'zernio-secret-id',
      reason: 'Provider support confirmed teardown.',
    }), ctx);
    expect(aalRes.status).toBe(403);

    mockRequireCurrentAal2FromSupabase.mockResolvedValue({ ok: true });
    const cookieRequest = postReq({
      provider: 'zernio',
      resourceType: 'account',
      resourceReference: 'zernio-secret-id',
      reason: 'Provider support confirmed teardown.',
    });
    cookieRequest.headers.delete('authorization');
    cookieRequest.headers.set('cookie', 'admin-session=fixture');
    const cookieResponse = await POST(cookieRequest, ctx);
    expect(cookieResponse.status).toBe(401);

    expect(mockRecordProviderDisposition).not.toHaveBeenCalled();
  });

  it('validates required concrete fields and passes actor/request metadata to the helper', async () => {
    const { POST } = await import('../[offboardingId]/provider-disposition/route');

    const invalidRes = await POST(postReq({
      provider: 'zernio',
      resourceType: 'account',
      reason: 'Missing resource reference.',
    }), ctx);
    expect(invalidRes.status).toBe(400);

    const res = await POST(postReq({
      provider: 'zernio',
      resourceType: 'account',
      resourceReference: 'zernio-secret-id',
      reason: 'Provider support confirmed teardown.',
      ticket: 'SUP-123',
    }), ctx);

    expect(res.status).toBe(200);
    expect(mockRecordProviderDisposition).toHaveBeenCalledWith({
      offboardingId: OFFBOARDING_ID,
      adminUserId: ADMIN_ID,
      provider: 'zernio',
      resourceType: 'account',
      resourceReference: 'zernio-secret-id',
      reason: 'Provider support confirmed teardown.',
      ticket: 'SUP-123',
      requestId: null,
      ip: '203.0.113.10',
      userAgent: 'vitest',
    }, mockSql);
    expect(JSON.stringify(await res.json())).not.toContain('zernio-secret-id');
  });
});

describe('POST /api/admin/offboardings/[offboardingId]/retry-purge', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    sqlCalls.length = 0;
    mockRequireRole.mockResolvedValue(adminUser());
    mockRequireCurrentAal2FromSupabase.mockResolvedValue({ ok: true });
    mockRetryAccountOffboardingPurge.mockResolvedValue({
      offboardingId: OFFBOARDING_ID,
      accountId: '11111111-1111-4111-8111-111111111111',
      status: 'purge_scheduled',
      retryCount: 2,
      outboxId: '44444444-4444-4444-8444-444444444444',
    });
  });

  it('requires bearer admin AAL2 before retrying', async () => {
    const { AuthError } = await import('@/lib/db/auth');
    const { POST } = await import('../[offboardingId]/retry-purge/route');

    mockRequireRole.mockRejectedValueOnce(new AuthError('Forbidden', 403));
    expect((await POST(postPurgeRetryReq(), ctx)).status).toBe(403);

    mockRequireRole.mockResolvedValue(adminUser());
    mockRequireCurrentAal2FromSupabase.mockResolvedValueOnce({ ok: false, reason: 'mfa_required' });
    expect((await POST(postPurgeRetryReq(), ctx)).status).toBe(403);

    mockRequireCurrentAal2FromSupabase.mockResolvedValue({ ok: true });
    const cookieRequest = postPurgeRetryReq();
    cookieRequest.headers.delete('authorization');
    cookieRequest.headers.set('cookie', 'admin-session=fixture');
    expect((await POST(cookieRequest, ctx)).status).toBe(401);

    expect(mockRetryAccountOffboardingPurge).not.toHaveBeenCalled();
  });

  it('rejects a malformed offboarding id without calling the helper', async () => {
    const { POST } = await import('../[offboardingId]/retry-purge/route');
    const badCtx = { params: Promise.resolve({ offboardingId: 'not-a-uuid' }) };

    const res = await POST(postPurgeRetryReq('not-a-uuid'), badCtx);

    expect(res.status).toBe(400);
    expect(mockRetryAccountOffboardingPurge).not.toHaveBeenCalled();
  });

  it('resets the row and re-enqueues on success, passing actor/request metadata', async () => {
    const { POST } = await import('../[offboardingId]/retry-purge/route');

    const res = await POST(postPurgeRetryReq(), ctx);

    expect(res.status).toBe(200);
    expect(mockRetryAccountOffboardingPurge).toHaveBeenCalledWith(mockSql, {
      offboardingId: OFFBOARDING_ID,
      adminUserId: ADMIN_ID,
      ip: '203.0.113.10',
      userAgent: 'vitest',
      requestId: null,
    });
    const body = await res.json();
    expect(body).toMatchObject({
      ok: true,
      offboardingId: OFFBOARDING_ID,
      status: 'purge_scheduled',
      retryCount: 2,
    });
  });

  it('maps a not-retryable row to 409 with the helper\'s code', async () => {
    const { PurgeRetryError } = await import('@/lib/account-offboarding/retry-purge');
    mockRetryAccountOffboardingPurge.mockRejectedValueOnce(
      new PurgeRetryError(409, 'account_offboarding_purge_not_retryable'),
    );
    const { POST } = await import('../[offboardingId]/retry-purge/route');

    const res = await POST(postPurgeRetryReq(), ctx);

    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: 'account_offboarding_purge_not_retryable' });
  });

  it('maps an unknown offboarding id to 404', async () => {
    const { PurgeRetryError } = await import('@/lib/account-offboarding/retry-purge');
    mockRetryAccountOffboardingPurge.mockRejectedValueOnce(
      new PurgeRetryError(404, 'offboarding_not_found'),
    );
    const { POST } = await import('../[offboardingId]/retry-purge/route');

    const res = await POST(postPurgeRetryReq(), ctx);

    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: 'offboarding_not_found' });
  });
});
