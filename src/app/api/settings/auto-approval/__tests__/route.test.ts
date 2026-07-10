import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';

const {
  mockRequireRole,
  mockGetAutoApprovalSettings,
  mockPatchAutoApprovalSettings,
  mockGetOffboardingState,
} = vi.hoisted(() => ({
  mockRequireRole: vi.fn(),
  mockGetAutoApprovalSettings: vi.fn(),
  mockPatchAutoApprovalSettings: vi.fn(),
  mockGetOffboardingState: vi.fn(),
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

vi.mock('@/lib/auto-approval/settings', () => {
  class AutoApprovalConfirmationRequiredError extends Error {
    constructor(readonly confirmationLevel: 'standard' | 'all_ratings') {
      super('auto_approval_confirmation_required');
      this.name = 'AutoApprovalConfirmationRequiredError';
    }
  }
  class AutoApprovalExpansionBlockedError extends Error {
    constructor(readonly blockReasons: string[]) {
      super('auto_approval_expansion_blocked');
      this.name = 'AutoApprovalExpansionBlockedError';
    }
  }
  class AutoApprovalSettingsError extends Error {
    constructor(readonly code: string, readonly status = 400) {
      super(code);
      this.name = 'AutoApprovalSettingsError';
    }
  }
  return {
    getAutoApprovalSettings: (...args: unknown[]) => mockGetAutoApprovalSettings(...args),
    patchAutoApprovalSettings: (...args: unknown[]) => mockPatchAutoApprovalSettings(...args),
    AutoApprovalConfirmationRequiredError,
    AutoApprovalExpansionBlockedError,
    AutoApprovalSettingsError,
  };
});

vi.mock('@/lib/account-offboarding/gate', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/account-offboarding/gate')>();
  return {
    ...actual,
    getOffboardingState: (...args: unknown[]) => mockGetOffboardingState(...args),
  };
});

import { AutoApprovalConfirmationRequiredError, AutoApprovalExpansionBlockedError } from '@/lib/auto-approval/settings';
import { GET, PATCH } from '../route';

const APP_URL = 'http://localhost:3000';
const ACCOUNT_ID = 'aaaaaaaa-0000-0000-0000-000000000001';
const USER_ID = '11111111-0000-0000-0000-000000000001';

function ownerUser() {
  return {
    id: USER_ID,
    name: 'Owner',
    email: 'owner@example.com',
    role: 'owner',
    accountId: ACCOUNT_ID,
    locationId: 'bbbbbbbb-0000-4000-8000-000000000001',
  };
}

function settingsResponse() {
  return {
    accountDefault: { policyId: null, threshold: null, exists: false },
    locations: [],
    readiness: {
      runtimeEnabled: false,
      providerModerationEnabled: false,
      providerModerationValidated: false,
      accountWritable: true,
      canExpand: false,
      blockReasons: ['auto_approval_disabled'],
    },
  };
}

function makeRequest(
  method: 'GET' | 'PATCH',
  body?: unknown,
  opts: { origin?: string | null; cookie?: string; url?: string } = {},
): NextRequest {
  const headers: Record<string, string> = {};
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  const origin = opts.origin === undefined ? APP_URL : opts.origin;
  if (origin !== null) headers.Origin = origin;
  if (opts.cookie) headers.cookie = opts.cookie;

  return new NextRequest(opts.url ?? `${APP_URL}/api/settings/auto-approval`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

describe('/api/settings/auto-approval', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    process.env.NEXT_PUBLIC_APP_URL = APP_URL;
    mockRequireRole.mockResolvedValue(ownerUser());
    mockGetOffboardingState.mockResolvedValue(null);
    mockGetAutoApprovalSettings.mockResolvedValue(settingsResponse());
    mockPatchAutoApprovalSettings.mockResolvedValue(settingsResponse());
  });

  it('GET derives account scope from the owner session and returns no-store state', async () => {
    const res = await GET(makeRequest('GET'));

    expect(res.status).toBe(200);
    expect(res.headers.get('Cache-Control')).toBe('no-store, private');
    expect(mockGetAutoApprovalSettings).toHaveBeenCalledWith(expect.anything(), {
      accountId: ACCOUNT_ID,
      impersonated: false,
    });
    expect(await res.json()).toEqual(settingsResponse());
  });

  it('GET blocks settings during delete-data offboarding', async () => {
    mockGetOffboardingState.mockResolvedValueOnce({
      id: 'offboarding-1',
      accountId: ACCOUNT_ID,
      mode: 'delete_data',
      status: 'pending',
      failedStep: null,
      terminalAt: null,
      accessEndsAt: null,
      teardownStartedAt: null,
      purgeAfter: null,
      purgeStartedAt: null,
      purgeCancelledAt: null,
    });

    const res = await GET(makeRequest('GET'));

    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: 'account_offboarding_blocked' });
    expect(mockGetAutoApprovalSettings).not.toHaveBeenCalled();
  });

  it('rejects accountId in GET query', async () => {
    const res = await GET(makeRequest('GET', undefined, {
      url: `${APP_URL}/api/settings/auto-approval?accountId=attacker`,
    }));

    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: 'account_id_not_allowed' });
    expect(mockGetAutoApprovalSettings).not.toHaveBeenCalled();
  });

  it('PATCH rejects missing Origin before auth', async () => {
    const res = await PATCH(makeRequest('PATCH', { operation: 'set_account_manual' }, { origin: null }));

    expect(res.status).toBe(403);
    expect(mockRequireRole).not.toHaveBeenCalled();
    expect(mockPatchAutoApprovalSettings).not.toHaveBeenCalled();
  });

  it('PATCH rejects accountId in the body', async () => {
    const res = await PATCH(makeRequest('PATCH', {
      operation: 'set_account_manual',
      accountId: 'attacker',
    }));

    expect(res.status).toBe(400);
    expect(mockPatchAutoApprovalSettings).not.toHaveBeenCalled();
  });

  it('PATCH rejects active impersonation cookies', async () => {
    const res = await PATCH(makeRequest('PATCH', { operation: 'set_account_manual' }, {
      cookie: 'rw_impersonation=signed-session',
    }));

    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({
      error: 'auto_approval_expansion_blocked',
      blockReasons: ['impersonation_not_allowed'],
    });
    expect(mockPatchAutoApprovalSettings).not.toHaveBeenCalled();
  });

  it('PATCH blocks settings during tearing-down offboarding before parsing mutations', async () => {
    mockGetOffboardingState.mockResolvedValueOnce({
      id: 'offboarding-1',
      accountId: ACCOUNT_ID,
      mode: 'cancel_only',
      status: 'tearing_down',
      failedStep: null,
      terminalAt: null,
      accessEndsAt: new Date('2026-07-01T00:00:00.000Z'),
      teardownStartedAt: new Date('2026-07-01T00:00:00.000Z'),
      purgeAfter: null,
      purgeStartedAt: null,
      purgeCancelledAt: null,
    });

    const res = await PATCH(makeRequest('PATCH', { operation: 'set_account_manual' }));

    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: 'account_offboarding_blocked' });
    expect(mockPatchAutoApprovalSettings).not.toHaveBeenCalled();
  });

  it('PATCH maps confirmation errors to the spec body', async () => {
    mockPatchAutoApprovalSettings.mockRejectedValue(
      new AutoApprovalConfirmationRequiredError('standard'),
    );

    const res = await PATCH(makeRequest('PATCH', {
      operation: 'set_account_default',
      threshold: 4,
    }));

    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({
      error: 'auto_approval_confirmation_required',
      confirmationLevel: 'standard',
    });
  });

  it('PATCH maps readiness blocks to the spec body', async () => {
    mockPatchAutoApprovalSettings.mockRejectedValue(
      new AutoApprovalExpansionBlockedError(['auto_approval_disabled']),
    );

    const res = await PATCH(makeRequest('PATCH', {
      operation: 'set_account_default',
      threshold: 4,
      confirmationLevel: 'standard',
    }));

    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({
      error: 'auto_approval_expansion_blocked',
      blockReasons: ['auto_approval_disabled'],
    });
  });

  it('PATCH rejects an unknown operation with 400 before calling the module', async () => {
    const res = await PATCH(makeRequest('PATCH', { operation: 'nuke_everything' }));

    expect(res.status).toBe(400);
    expect(mockPatchAutoApprovalSettings).not.toHaveBeenCalled();
  });

  it('PATCH rejects an out-of-range threshold with 400 before calling the module', async () => {
    const res = await PATCH(makeRequest('PATCH', {
      operation: 'set_account_default',
      threshold: 9,
    }));

    expect(res.status).toBe(400);
    expect(mockPatchAutoApprovalSettings).not.toHaveBeenCalled();
  });

  it('PATCH rejects a sub-4 threshold with 400 (positive quadrant only)', async () => {
    const res = await PATCH(makeRequest('PATCH', {
      operation: 'set_account_default',
      threshold: 3,
    }));

    expect(res.status).toBe(400);
    expect(mockPatchAutoApprovalSettings).not.toHaveBeenCalled();
  });

  it.each([
    { operation: 'set_account_veto_window', minutes: 20 },
    { operation: 'set_account_daily_cap', cap: 0 },
    { operation: 'set_account_daily_cap', cap: 51 },
    { operation: 'set_account_daily_cap', cap: 10.5 },
    { operation: 'set_location_veto_window', locationId: 'bbbbbbbb-0000-4000-8000-000000000001', minutes: 45 },
    { operation: 'set_location_daily_cap', locationId: 'bbbbbbbb-0000-4000-8000-000000000001', cap: -1 },
  ])('PATCH rejects an out-of-domain dial value with 400: %o', async (body) => {
    const res = await PATCH(makeRequest('PATCH', body));

    expect(res.status).toBe(400);
    expect(mockPatchAutoApprovalSettings).not.toHaveBeenCalled();
  });

  it.each([
    { operation: 'set_account_veto_window', minutes: 30 },
    { operation: 'set_account_daily_cap', cap: null },
    { operation: 'set_account_daily_cap', cap: 25 },
    { operation: 'set_location_veto_window', locationId: 'bbbbbbbb-0000-4000-8000-000000000001', minutes: 15 },
    { operation: 'set_location_daily_cap', locationId: 'bbbbbbbb-0000-4000-8000-000000000001', cap: 1 },
  ])('PATCH forwards a valid dial operation to the module: %o', async (body) => {
    const res = await PATCH(makeRequest('PATCH', body));

    expect(res.status).toBe(200);
    expect(mockPatchAutoApprovalSettings).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ ...body, accountId: ACCOUNT_ID }),
    );
  });

  it('PATCH still accepts a stale all_ratings confirmation level (one-release tolerance)', async () => {
    const res = await PATCH(makeRequest('PATCH', {
      operation: 'set_account_default',
      threshold: 4,
      confirmationLevel: 'all_ratings',
    }));

    expect(res.status).toBe(200);
    expect(mockPatchAutoApprovalSettings).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ confirmationLevel: 'all_ratings' }),
    );
  });
});
