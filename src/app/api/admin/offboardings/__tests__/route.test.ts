import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';

const {
  mockRequireRole,
  mockRequireCurrentAal2FromSupabase,
  mockRecordProviderDisposition,
  mockSql,
  sqlCalls,
} = vi.hoisted(() => {
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
    mockRequireRole: vi.fn(),
    mockRequireCurrentAal2FromSupabase: vi.fn(),
    mockRecordProviderDisposition: vi.fn(),
    mockSql,
    sqlCalls,
  };
});

vi.mock('@supabase/ssr', () => ({
  createServerClient: vi.fn(() => ({ auth: { mfa: {} } })),
}));

vi.mock('@/lib/db/auth', () => ({
  requireRole: mockRequireRole,
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
  return new NextRequest(`https://app.example.com${path}`);
}

function postReq(body: unknown, headers: Record<string, string> = {}): NextRequest {
  return new NextRequest(
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

  it('requires same-origin admin AAL2 before recording a concrete provider disposition', async () => {
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
    const crossOriginRes = await POST(postReq({
      provider: 'zernio',
      resourceType: 'account',
      resourceReference: 'zernio-secret-id',
      reason: 'Provider support confirmed teardown.',
    }, { origin: 'https://evil.example.com' }), ctx);
    expect(crossOriginRes.status).toBe(403);

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
    });
    expect(JSON.stringify(await res.json())).not.toContain('zernio-secret-id');
  });
});
