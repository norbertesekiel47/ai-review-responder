import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest, NextResponse } from 'next/server';

const {
  mockRequireWritableOwner,
  mockRequireOwnerWithAccount,
  mockRequireDeleteDataDestructiveAuth,
  mockConfirmCancelOnlyOffboarding,
  mockConfirmDeleteDataOffboarding,
  mockRequestCancelOnlyReactivation,
  mockGetAccountOffboardingStatus,
} = vi.hoisted(() => ({
  mockRequireWritableOwner: vi.fn(),
  mockRequireOwnerWithAccount: vi.fn(),
  mockRequireDeleteDataDestructiveAuth: vi.fn(),
  mockConfirmCancelOnlyOffboarding: vi.fn(),
  mockConfirmDeleteDataOffboarding: vi.fn(),
  mockRequestCancelOnlyReactivation: vi.fn(),
  mockGetAccountOffboardingStatus: vi.fn(),
}));

vi.mock('@/lib/auth/route-helpers', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/auth/route-helpers')>();
  return {
    ...actual,
    requireWritableOwner: mockRequireWritableOwner,
    requireOwnerWithAccount: mockRequireOwnerWithAccount,
  };
});

vi.mock('@/lib/account-offboarding/confirm', () => ({
  confirmCancelOnlyOffboarding: mockConfirmCancelOnlyOffboarding,
  confirmDeleteDataOffboarding: mockConfirmDeleteDataOffboarding,
}));

vi.mock('@/lib/account-offboarding/destructive-auth', () => ({
  requireDeleteDataDestructiveAuth: mockRequireDeleteDataDestructiveAuth,
}));

vi.mock('@/lib/account-offboarding/reactivation-request', () => ({
  requestCancelOnlyReactivation: mockRequestCancelOnlyReactivation,
}));

vi.mock('@/lib/account-offboarding/status', () => ({
  getAccountOffboardingStatus: mockGetAccountOffboardingStatus,
}));

const ACCOUNT_ID = 'aaaaaaaa-bbbb-7ccc-8ddd-eeeeeeeeeeee';
const USER_ID = '11111111-2222-7333-8444-555555555555';
const APP_URL = 'http://localhost:3000';

function ownerUser() {
  return {
    id: USER_ID,
    name: 'Owner',
    email: 'owner@example.com',
    role: 'owner',
    accountId: ACCOUNT_ID,
    locationId: '99999999-8888-7777-8666-555555555555',
  };
}

function makePost(
  body: Record<string, unknown> = { mode: 'cancel_only' },
  headers: Record<string, string> = {},
): NextRequest {
  return new NextRequest(`${APP_URL}/api/account/offboarding/confirm`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      Origin: APP_URL,
      'Idempotency-Key': 'confirm-key-1',
      ...headers,
    },
    body: JSON.stringify(body),
  });
}

function makeReactivatePost(headers: Record<string, string> = {}): NextRequest {
  return new NextRequest(`${APP_URL}/api/account/offboarding/reactivate`, {
    method: 'POST',
    headers: {
      Origin: APP_URL,
      'Idempotency-Key': 'reactivate-key-1',
      ...headers,
    },
  });
}

function makeGet(headers: Record<string, string> = { Origin: APP_URL }): NextRequest {
  return new NextRequest(`${APP_URL}/api/account/offboarding/status`, {
    method: 'GET',
    headers,
  });
}

async function importRoutes() {
  vi.resetModules();
  const confirmRoute = await import('../confirm/route');
  const reactivateRoute = await import('../reactivate/route');
  const statusRoute = await import('../status/route');
  return { confirmRoute, reactivateRoute, statusRoute };
}

describe('POST /api/account/offboarding/confirm', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubEnv('NEXT_PUBLIC_APP_URL', APP_URL);
    vi.stubEnv('ACCOUNT_OFFBOARDING_ENABLED', 'true');
    mockRequireWritableOwner.mockResolvedValue({
      ok: true,
      user: ownerUser(),
      accountId: ACCOUNT_ID,
    });
    mockRequireDeleteDataDestructiveAuth.mockResolvedValue({
      ok: true,
      user: ownerUser(),
      accountId: ACCOUNT_ID,
    });
  });

  it('returns 404 and does not auth or start work when the feature flag is off', async () => {
    vi.stubEnv('ACCOUNT_OFFBOARDING_ENABLED', 'false');
    const { confirmRoute } = await importRoutes();

    const res = await confirmRoute.POST(makePost());

    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: 'account_offboarding_disabled' });
    expect(mockRequireWritableOwner).not.toHaveBeenCalled();
    expect(mockRequireDeleteDataDestructiveAuth).not.toHaveBeenCalled();
    expect(mockConfirmCancelOnlyOffboarding).not.toHaveBeenCalled();
    expect(mockConfirmDeleteDataOffboarding).not.toHaveBeenCalled();
  });

  it('keeps delete_data disabled when the server flag is off', async () => {
    vi.stubEnv('ACCOUNT_OFFBOARDING_ENABLED', 'false');
    const { confirmRoute } = await importRoutes();

    const res = await confirmRoute.POST(makePost({
      mode: 'delete_data',
      reasonCode: 'switched_service',
      confirmationText: 'DELETE DATA',
    }));

    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: 'account_offboarding_disabled' });
    expect(mockRequireWritableOwner).not.toHaveBeenCalled();
    expect(mockRequireDeleteDataDestructiveAuth).not.toHaveBeenCalled();
    expect(mockConfirmCancelOnlyOffboarding).not.toHaveBeenCalled();
    expect(mockConfirmDeleteDataOffboarding).not.toHaveBeenCalled();
  });

  it('returns 403 for cross-origin requests before auth', async () => {
    const { confirmRoute } = await importRoutes();

    const res = await confirmRoute.POST(makePost(undefined, { Origin: 'https://evil.example.com' }));

    expect(res.status).toBe(403);
    expect(mockRequireWritableOwner).not.toHaveBeenCalled();
    expect(mockRequireDeleteDataDestructiveAuth).not.toHaveBeenCalled();
    expect(mockConfirmCancelOnlyOffboarding).not.toHaveBeenCalled();
    expect(mockConfirmDeleteDataOffboarding).not.toHaveBeenCalled();
  });

  it('returns 401 when unauthenticated', async () => {
    mockRequireWritableOwner.mockResolvedValueOnce({
      ok: false,
      response: NextResponse.json({ error: 'Unauthorized' }, { status: 401 }),
    });
    const { confirmRoute } = await importRoutes();

    const res = await confirmRoute.POST(makePost());

    expect(res.status).toBe(401);
    expect(mockConfirmCancelOnlyOffboarding).not.toHaveBeenCalled();
  });

  it('returns 400 when the idempotency key is missing', async () => {
    const { confirmRoute } = await importRoutes();

    const res = await confirmRoute.POST(makePost(
      { mode: 'cancel_only' },
      { 'Idempotency-Key': '' },
    ));

    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: 'missing_idempotency_key' });
    expect(mockConfirmCancelOnlyOffboarding).not.toHaveBeenCalled();
  });

  it('returns 400 when the idempotency key is too long', async () => {
    const { confirmRoute } = await importRoutes();

    const res = await confirmRoute.POST(makePost(
      { mode: 'cancel_only' },
      { 'Idempotency-Key': 'x'.repeat(256) },
    ));

    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: 'idempotency_key_too_long' });
    expect(mockConfirmCancelOnlyOffboarding).not.toHaveBeenCalled();
  });

  it('returns 400 for invalid delete_data confirmation text before destructive auth', async () => {
    const { confirmRoute } = await importRoutes();

    const res = await confirmRoute.POST(makePost({
      mode: 'delete_data',
      reasonCode: 'switched_service',
      confirmationText: 'delete data',
    }));

    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toBe('invalid_body');
    expect(mockRequireDeleteDataDestructiveAuth).not.toHaveBeenCalled();
    expect(mockConfirmDeleteDataOffboarding).not.toHaveBeenCalled();
  });

  it('requires delete_data reason code and rejects free-text feedback fields', async () => {
    const { confirmRoute } = await importRoutes();

    const res = await confirmRoute.POST(makePost({
      mode: 'delete_data',
      confirmationText: 'DELETE DATA',
      feedback: 'Please call me before deleting data.',
    }));

    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toBe('invalid_body');
    expect(mockRequireDeleteDataDestructiveAuth).not.toHaveBeenCalled();
    expect(mockConfirmDeleteDataOffboarding).not.toHaveBeenCalled();
  });

  it('uses the destructive auth guard for delete_data and does not use the writable-owner guard', async () => {
    mockConfirmDeleteDataOffboarding.mockResolvedValueOnce({
      ok: true,
      status: 'created',
      offboarding: {
        id: 'eeeeeeee-2222-7333-8444-555555555555',
        accountId: ACCOUNT_ID,
        mode: 'delete_data',
        status: 'pending',
      },
    });
    const { confirmRoute } = await importRoutes();

    const res = await confirmRoute.POST(makePost(
      {
        mode: 'delete_data',
        reasonCode: 'switched_service',
        confirmationText: 'DELETE DATA',
      },
      {
        'Idempotency-Key': ' delete-key ',
        'x-request-id': 'req-delete-1',
        'x-forwarded-for': '203.0.113.44, 10.0.0.1',
        'user-agent': 'vitest',
      },
    ));

    expect(res.status).toBe(202);
    expect(mockRequireDeleteDataDestructiveAuth).toHaveBeenCalledOnce();
    expect(mockRequireWritableOwner).not.toHaveBeenCalled();
    expect(mockConfirmCancelOnlyOffboarding).not.toHaveBeenCalled();
    expect(mockConfirmDeleteDataOffboarding).toHaveBeenCalledWith({
      accountId: ACCOUNT_ID,
      actorUserId: USER_ID,
      idempotencyKey: 'delete-key',
      reasonCode: 'switched_service',
      requestId: 'req-delete-1',
      ip: '203.0.113.44',
      userAgent: 'vitest',
    });
    expect(await res.json()).toEqual({
      ok: true,
      idempotent: false,
      offboarding: {
        id: 'eeeeeeee-2222-7333-8444-555555555555',
        mode: 'delete_data',
        status: 'pending',
      },
    });
  });

  it('returns the destructive-auth failure before delete_data service work', async () => {
    mockRequireDeleteDataDestructiveAuth.mockResolvedValueOnce({
      ok: false,
      response: NextResponse.json({ error: 'fresh_auth_required' }, { status: 403 }),
    });
    const { confirmRoute } = await importRoutes();

    const res = await confirmRoute.POST(makePost({
      mode: 'delete_data',
      reasonCode: 'switched_service',
      confirmationText: 'DELETE DATA',
    }));

    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: 'fresh_auth_required' });
    expect(mockConfirmDeleteDataOffboarding).not.toHaveBeenCalled();
    expect(mockRequireWritableOwner).not.toHaveBeenCalled();
  });

  it('returns a delete_data idempotent retry as an existing success', async () => {
    mockConfirmDeleteDataOffboarding.mockResolvedValueOnce({
      ok: true,
      status: 'idempotent',
      offboarding: {
        id: 'eeeeeeee-2222-7333-8444-555555555555',
        accountId: ACCOUNT_ID,
        mode: 'delete_data',
        status: 'pending',
      },
    });
    const { confirmRoute } = await importRoutes();

    const res = await confirmRoute.POST(makePost({
      mode: 'delete_data',
      reasonCode: 'switched_service',
      confirmationText: 'DELETE DATA',
    }));

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      ok: true,
      idempotent: true,
      offboarding: {
        id: 'eeeeeeee-2222-7333-8444-555555555555',
        mode: 'delete_data',
        status: 'pending',
      },
    });
  });

  it('returns 400 for an unsupported offboarding mode', async () => {
    const { confirmRoute } = await importRoutes();

    const res = await confirmRoute.POST(makePost({ mode: 'export_data' }));

    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toBe('invalid_body');
    expect(mockConfirmCancelOnlyOffboarding).not.toHaveBeenCalled();
    expect(mockConfirmDeleteDataOffboarding).not.toHaveBeenCalled();
  });

  it('rejects free-text feedback fields', async () => {
    const { confirmRoute } = await importRoutes();

    const res = await confirmRoute.POST(makePost({
      mode: 'cancel_only',
      feedback: 'Please call me about this cancellation.',
    }));

    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toBe('invalid_body');
    expect(mockConfirmCancelOnlyOffboarding).not.toHaveBeenCalled();
  });

  it('returns 409 when another active offboarding exists for a different idempotency key', async () => {
    mockConfirmCancelOnlyOffboarding.mockResolvedValueOnce({
      ok: false,
      reason: 'duplicate_active',
      activeOffboarding: {
        id: 'bbbbbbbb-2222-7333-8444-555555555555',
        accountId: ACCOUNT_ID,
        mode: 'cancel_only',
        status: 'pending',
      },
    });
    const { confirmRoute } = await importRoutes();

    const res = await confirmRoute.POST(makePost());

    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({
      error: 'account_offboarding_already_active',
      offboarding: {
        id: 'bbbbbbbb-2222-7333-8444-555555555555',
        mode: 'cancel_only',
        status: 'pending',
      },
    });
  });

  it('returns the existing active row for an idempotent retry', async () => {
    mockConfirmCancelOnlyOffboarding.mockResolvedValueOnce({
      ok: true,
      status: 'idempotent',
      offboarding: {
        id: 'bbbbbbbb-2222-7333-8444-555555555555',
        accountId: ACCOUNT_ID,
        mode: 'cancel_only',
        status: 'pending',
      },
    });
    const { confirmRoute } = await importRoutes();

    const res = await confirmRoute.POST(makePost());

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      ok: true,
      idempotent: true,
      offboarding: {
        id: 'bbbbbbbb-2222-7333-8444-555555555555',
        mode: 'cancel_only',
        status: 'pending',
      },
    });
  });

  it('returns a support-oriented error when snapshot capture fails', async () => {
    mockConfirmCancelOnlyOffboarding.mockResolvedValueOnce({
      ok: false,
      reason: 'snapshot_incomplete',
      missingFields: ['stripe_subscription_id'],
    });
    const { confirmRoute } = await importRoutes();

    const res = await confirmRoute.POST(makePost());

    expect(res.status).toBe(422);
    expect(await res.json()).toEqual({
      error: 'offboarding_snapshot_incomplete',
      detail: 'We could not safely prepare your cancellation. Please contact support so we can finish this for you.',
      missingFields: ['stripe_subscription_id'],
    });
  });

  it('passes only cancel_only mode, optional reason code, and the normalized idempotency key to the service', async () => {
    mockConfirmCancelOnlyOffboarding.mockResolvedValueOnce({
      ok: true,
      status: 'created',
      offboarding: {
        id: 'dddddddd-2222-7333-8444-555555555555',
        accountId: ACCOUNT_ID,
        mode: 'cancel_only',
        status: 'pending',
      },
    });
    const { confirmRoute } = await importRoutes();

    const res = await confirmRoute.POST(makePost(
      { mode: 'cancel_only', reasonCode: 'too_expensive' },
      { 'Idempotency-Key': ' key with spaces ' },
    ));

    expect(res.status).toBe(202);
    expect(mockConfirmCancelOnlyOffboarding).toHaveBeenCalledWith({
      accountId: ACCOUNT_ID,
      actorUserId: USER_ID,
      idempotencyKey: 'key with spaces',
      reasonCode: 'too_expensive',
      requestId: expect.any(String),
      ip: null,
      userAgent: null,
    });
  });
});

describe('POST /api/account/offboarding/reactivate', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubEnv('NEXT_PUBLIC_APP_URL', APP_URL);
    vi.stubEnv('ACCOUNT_OFFBOARDING_ENABLED', 'true');
    mockRequireOwnerWithAccount.mockResolvedValue({
      ok: true,
      user: ownerUser(),
      accountId: ACCOUNT_ID,
    });
    mockRequestCancelOnlyReactivation.mockResolvedValue({
      ok: true,
      status: 'queued',
      offboarding: {
        id: 'bbbbbbbb-2222-7333-8444-555555555555',
        accountId: ACCOUNT_ID,
        mode: 'cancel_only',
        status: 'scheduled',
      },
    });
  });

  it('returns 404 and does not auth or reactivate when the feature flag is off', async () => {
    vi.stubEnv('ACCOUNT_OFFBOARDING_ENABLED', 'false');
    const { reactivateRoute } = await importRoutes();

    const res = await reactivateRoute.POST(makeReactivatePost());

    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: 'account_offboarding_disabled' });
    expect(mockRequireOwnerWithAccount).not.toHaveBeenCalled();
    expect(mockRequireWritableOwner).not.toHaveBeenCalled();
    expect(mockRequestCancelOnlyReactivation).not.toHaveBeenCalled();
  });

  it('returns 403 for cross-origin requests before auth', async () => {
    const { reactivateRoute } = await importRoutes();

    const res = await reactivateRoute.POST(makeReactivatePost({ Origin: 'https://evil.example.com' }));

    expect(res.status).toBe(403);
    expect(mockRequireOwnerWithAccount).not.toHaveBeenCalled();
    expect(mockRequestCancelOnlyReactivation).not.toHaveBeenCalled();
  });

  it('uses the read-only owner guard and enqueues reactivation instead of calling Stripe on Vercel', async () => {
    const { reactivateRoute } = await importRoutes();

    const res = await reactivateRoute.POST(makeReactivatePost({
      'x-request-id': 'req-reactivate-1',
      'x-forwarded-for': '203.0.113.20, 10.0.0.1',
      'user-agent': 'vitest',
    }));

    expect(res.status).toBe(202);
    expect(await res.json()).toEqual({
      ok: true,
      offboarding: {
        id: 'bbbbbbbb-2222-7333-8444-555555555555',
        mode: 'cancel_only',
        status: 'queued',
      },
    });
    expect(mockRequireOwnerWithAccount).toHaveBeenCalledOnce();
    expect(mockRequireWritableOwner).not.toHaveBeenCalled();
    expect(mockRequestCancelOnlyReactivation).toHaveBeenCalledWith({
      accountId: ACCOUNT_ID,
      actorUserId: USER_ID,
      idempotencyKey: 'reactivate-key-1',
      requestId: 'req-reactivate-1',
      ip: '203.0.113.20',
      userAgent: 'vitest',
    });
  });

  it('returns 400 when the reactivation idempotency key is missing', async () => {
    const { reactivateRoute } = await importRoutes();

    const res = await reactivateRoute.POST(makeReactivatePost({ 'Idempotency-Key': '' }));

    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: 'missing_idempotency_key' });
    expect(mockRequestCancelOnlyReactivation).not.toHaveBeenCalled();
  });

  it('returns 400 when the reactivation idempotency key is too long', async () => {
    const { reactivateRoute } = await importRoutes();

    const res = await reactivateRoute.POST(makeReactivatePost({
      'Idempotency-Key': 'x'.repeat(256),
    }));

    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: 'idempotency_key_too_long' });
    expect(mockRequestCancelOnlyReactivation).not.toHaveBeenCalled();
  });

  it('returns 409 when there is no scheduled cancel-only row to reactivate', async () => {
    mockRequestCancelOnlyReactivation.mockResolvedValueOnce({
      ok: false,
      reason: 'not_reactivatable',
    });
    const { reactivateRoute } = await importRoutes();

    const res = await reactivateRoute.POST(makeReactivatePost());

    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: 'account_offboarding_not_reactivatable' });
  });
});

describe('GET /api/account/offboarding/status', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubEnv('NEXT_PUBLIC_APP_URL', APP_URL);
    vi.stubEnv('ACCOUNT_OFFBOARDING_ENABLED', 'true');
    mockRequireOwnerWithAccount.mockResolvedValue({
      ok: true,
      user: ownerUser(),
      accountId: ACCOUNT_ID,
    });
    mockGetAccountOffboardingStatus.mockResolvedValue({
      activeOffboarding: null,
    });
  });

  it('uses the read-only owner guard for status', async () => {
    const { statusRoute } = await importRoutes();

    const res = await statusRoute.GET(makeGet());

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      enabled: true,
      accountTimeZone: 'UTC',
      activeOffboarding: null,
    });
    expect(mockRequireOwnerWithAccount).toHaveBeenCalledOnce();
    expect(mockRequireWritableOwner).not.toHaveBeenCalled();
  });

  it('does not require an Origin header for the read-only status route', async () => {
    const { statusRoute } = await importRoutes();

    const res = await statusRoute.GET(makeGet({}));

    expect(res.status).toBe(200);
    expect(mockRequireOwnerWithAccount).toHaveBeenCalledOnce();
  });

  it('returns only safe active offboarding status fields', async () => {
    const accessEndsAt = new Date('2026-06-30T12:00:00.000Z');
    mockGetAccountOffboardingStatus.mockResolvedValueOnce({
      activeOffboarding: {
        id: 'eeeeeeee-2222-7333-8444-555555555555',
        accountId: ACCOUNT_ID,
        mode: 'cancel_only',
        status: 'scheduled',
        failedStep: null,
        accessEndsAt,
        teardownStartedAt: null,
        purgeAfter: null,
        operationalUIBlocked: false,
        stripeSubscriptionId: 'sub_should_not_leak',
        recipientEmail: 'owner@example.com',
        businessName: 'Acme Reviews',
        reviewText: 'Loved the service',
      },
    });
    const { statusRoute } = await importRoutes();

    const res = await statusRoute.GET(makeGet());

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual({
      enabled: true,
      accountTimeZone: 'UTC',
      activeOffboarding: {
        id: 'eeeeeeee-2222-7333-8444-555555555555',
        accountId: ACCOUNT_ID,
        mode: 'cancel_only',
        status: 'scheduled',
        failedStep: null,
        accessEndsAt: accessEndsAt.toISOString(),
        teardownStartedAt: null,
        purgeAfter: null,
        operationalUIBlocked: false,
      },
    });
    expect(JSON.stringify(body)).not.toContain('sub_should_not_leak');
    expect(JSON.stringify(body)).not.toContain('owner@example.com');
    expect(JSON.stringify(body)).not.toContain('Acme Reviews');
    expect(JSON.stringify(body)).not.toContain('Loved the service');
  });
});
