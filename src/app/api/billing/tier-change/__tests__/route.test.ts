import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';

const {
  mockRequireRole,
  mockGetOffboardingState,
  mockValidateTierChange,
  mockApplyTierChange,
} = vi.hoisted(() => ({
  mockRequireRole: vi.fn(),
  mockGetOffboardingState: vi.fn(),
  mockValidateTierChange: vi.fn(),
  mockApplyTierChange: vi.fn(),
}));

vi.mock('@/lib/db/auth', () => {
  class AuthError extends Error {
    constructor(message: string, public readonly statusCode: number) {
      super(message);
      this.name = 'AuthError';
    }
  }
  return {
    AuthError,
    requireRole: (...args: unknown[]) => mockRequireRole(...args),
  };
});

vi.mock('@/lib/db/server', () => ({ sql: { marker: 'sql' } }));

vi.mock('@/lib/account-offboarding/gate', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/account-offboarding/gate')>()),
  getOffboardingState: (...args: unknown[]) => mockGetOffboardingState(...args),
}));

vi.mock('@/lib/accounts/tier-change', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/accounts/tier-change')>()),
  validateTierChange: mockValidateTierChange,
  applyTierChange: mockApplyTierChange,
}));

import { POST } from '../route';
import { AuthError } from '@/lib/db/auth';
import { TierNotPurchasableError } from '@/lib/payments/tier-purchasability';

const ACCOUNT_ID = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
const OTHER_ACCOUNT_ID = '99999999-8888-7777-6666-555555555555';
const APP_URL = 'http://localhost:3000';

function request(
  body: Record<string, unknown>,
  extraHeaders: Record<string, string> = {},
): NextRequest {
  return new NextRequest(`${APP_URL}/api/billing/tier-change`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      Origin: APP_URL,
      'Idempotency-Key': 'route-operation',
      ...extraHeaders,
    },
    body: JSON.stringify(body),
  });
}

function owner(overrides: Record<string, unknown> = {}) {
  return {
    id: '11111111-2222-3333-4444-555555555555',
    name: 'Owner',
    email: 'owner@example.com',
    role: 'owner',
    accountId: ACCOUNT_ID,
    locationId: 'bbbbbbbb-0000-0000-0000-000000000001',
    ...overrides,
  };
}

const preview = {
  basePriceCents: 4900,
  includedLocations: 1,
  overagePriceCents: 2000,
  overageUnits: 2,
  totalCents: 8900,
};

beforeEach(() => {
  mockRequireRole.mockReset();
  mockGetOffboardingState.mockReset();
  mockValidateTierChange.mockReset();
  mockApplyTierChange.mockReset();
  process.env.NEXT_PUBLIC_APP_URL = APP_URL;
  mockRequireRole.mockResolvedValue(owner());
  mockGetOffboardingState.mockResolvedValue(null);
  mockValidateTierChange.mockResolvedValue({ allowed: true, newBillingPreview: preview });
  mockApplyTierChange.mockResolvedValue({ ok: true, newBilling: preview });
});

describe('POST /api/billing/tier-change', () => {
  it.each([
    [new AuthError('Unauthorized', 401), 401],
    [new AuthError('Forbidden', 403), 403],
  ])('maps auth failures', async (error, status) => {
    mockRequireRole.mockRejectedValueOnce(error);
    const response = await POST(request({ accountId: ACCOUNT_ID, newTier: 'autopilot' }));
    expect(response.status).toBe(status);
    expect(mockValidateTierChange).not.toHaveBeenCalled();
  });

  it('requires an owner account and matching body account', async () => {
    mockRequireRole.mockResolvedValueOnce(owner({ accountId: null }));
    const missing = await POST(request({ accountId: ACCOUNT_ID, newTier: 'autopilot' }));
    expect(missing.status).toBe(403);

    mockRequireRole.mockResolvedValueOnce(owner());
    const crossAccount = await POST(request({ accountId: OTHER_ACCOUNT_ID, newTier: 'autopilot' }));
    expect(crossAccount.status).toBe(403);
    expect(await crossAccount.json()).toEqual({ error: 'Account ID mismatch' });
    expect(mockValidateTierChange).not.toHaveBeenCalled();
  });

  it.each(['enterprise', 'free']) (
    'rejects a non-launch target %s before business logic',
    async (newTier) => {
      const response = await POST(request({ accountId: ACCOUNT_ID, newTier }));
      expect(response.status).toBe(400);
      expect(mockValidateTierChange).not.toHaveBeenCalled();
      expect(mockApplyTierChange).not.toHaveBeenCalled();
    },
  );

  it('rejects malformed account IDs before business logic', async () => {
    const response = await POST(request({ accountId: 'not-a-uuid', newTier: 'copilot' }));
    expect(response.status).toBe(400);
    expect(mockValidateTierChange).not.toHaveBeenCalled();
  });

  it('blocks offboarding before validation or execution', async () => {
    mockGetOffboardingState.mockResolvedValueOnce({
      id: 'offboarding-1',
      accountId: ACCOUNT_ID,
      mode: 'cancel_only',
      status: 'scheduled',
      failedStep: null,
      terminalAt: null,
      accessEndsAt: new Date(),
      teardownStartedAt: null,
      purgeAfter: null,
      purgeStartedAt: null,
      purgeCancelledAt: null,
    });
    const response = await POST(request({ accountId: ACCOUNT_ID, newTier: 'autopilot' }));
    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({ error: 'account_offboarding_blocked' });
    expect(mockValidateTierChange).not.toHaveBeenCalled();
    expect(mockApplyTierChange).not.toHaveBeenCalled();
  });

  it.each(['subscription_inactive'] as const)(
    'maps validation rejection %s to 409',
    async (reason) => {
      mockValidateTierChange.mockResolvedValueOnce({ allowed: false, reason });
      const response = await POST(request({
        accountId: ACCOUNT_ID,
        newTier: 'autopilot',
        preview: true,
      }));
      expect(response.status).toBe(409);
      expect(await response.json()).toEqual({ error: reason });
      expect(mockApplyTierChange).not.toHaveBeenCalled();
    },
  );

  it('returns the founder-aware server preview without execution', async () => {
    const response = await POST(request({
      accountId: ACCOUNT_ID,
      newTier: 'autopilot',
      preview: true,
    }));
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      success: true,
      preview: true,
      newTier: 'autopilot',
      newBilling: preview,
    });
    expect(mockValidateTierChange).toHaveBeenCalledWith(
      expect.anything(),
      ACCOUNT_ID,
      'autopilot',
    );
    expect(mockApplyTierChange).not.toHaveBeenCalled();
  });

  it('maps a preview gate closure to tier_not_purchasable', async () => {
    mockValidateTierChange.mockRejectedValueOnce(new TierNotPurchasableError());
    const response = await POST(request({ accountId: ACCOUNT_ID, newTier: 'autopilot', preview: true }));
    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({ error: 'tier_not_purchasable' });
  });

  it('executes with a normalized stable caller key and returns the fresh locked result', async () => {
    const freshExecution = { ...preview, overageUnits: 3, totalCents: 10900 };
    mockApplyTierChange.mockResolvedValueOnce({ ok: true, newBilling: freshExecution });
    const response = await POST(request(
      { accountId: ACCOUNT_ID, newTier: 'autopilot' },
      { 'Idempotency-Key': ' owner-op-123 ' },
    ));

    expect(response.status).toBe(200);
    expect(mockApplyTierChange).toHaveBeenCalledWith(expect.anything(), {
      accountId: ACCOUNT_ID,
      tier: 'autopilot',
      operationKey: 'owner-op-123',
    });
    expect(await response.json()).toEqual({
      success: true,
      newTier: 'autopilot',
      newBilling: freshExecution,
    });
  });

  it('requires an explicit operation key for execution but not preview', async () => {
    const noKey = (previewOnly: boolean) => new NextRequest(
      `${APP_URL}/api/billing/tier-change`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json', Origin: APP_URL },
        body: JSON.stringify({ accountId: ACCOUNT_ID, newTier: 'autopilot', preview: previewOnly }),
      },
    );
    const execution = await POST(noKey(false));
    expect(execution.status).toBe(400);
    expect(await execution.json()).toEqual({ error: 'missing_idempotency_key' });
    expect(mockValidateTierChange).not.toHaveBeenCalled();

    const previewResponse = await POST(noKey(true));
    expect(previewResponse.status).toBe(200);
    expect(mockValidateTierChange).toHaveBeenCalledTimes(1);
  });

  it('allows execution to recover a projected same-tier operation', async () => {
    mockValidateTierChange.mockResolvedValueOnce({ allowed: false, reason: 'same_tier' });
    const response = await POST(request({ accountId: ACCOUNT_ID, newTier: 'autopilot' }, {
      'Idempotency-Key': 'projected-operation',
    }));
    expect(response.status).toBe(200);
    expect(mockApplyTierChange).toHaveBeenCalledWith(expect.anything(), {
      accountId: ACCOUNT_ID,
      tier: 'autopilot',
      operationKey: 'projected-operation',
    });
    expect(mockValidateTierChange).not.toHaveBeenCalled();
  });

  it('keeps same-tier preview semantics as a 409', async () => {
    mockValidateTierChange.mockResolvedValueOnce({ allowed: false, reason: 'same_tier' });
    const response = await POST(request({
      accountId: ACCOUNT_ID,
      newTier: 'autopilot',
      preview: true,
    }));
    expect(response.status).toBe(409);
    expect(mockApplyTierChange).not.toHaveBeenCalled();
  });

  it('rechecks purchasability at execution and maps a closed gate', async () => {
    mockApplyTierChange.mockRejectedValueOnce(new TierNotPurchasableError());
    const response = await POST(request({ accountId: ACCOUNT_ID, newTier: 'autopilot' }));
    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({ error: 'tier_not_purchasable' });
  });

  it.each([
    ['no_stripe_subscription', 400],
    ['subscription_inactive', 409],
    ['same_tier', 409],
    ['operation_conflict', 409],
    ['missing_price_config', 500],
    ['base_item_not_found', 500],
    ['ambiguous_overage_item', 500],
    ['tier_change_failed', 502],
  ] as const)('maps execution failure %s to %i', async (code, status) => {
    mockApplyTierChange.mockResolvedValueOnce({ ok: false, code, detail: 'failure detail' });
    const response = await POST(request({ accountId: ACCOUNT_ID, newTier: 'autopilot' }));
    expect(response.status).toBe(status);
    expect(await response.json()).toEqual({ error: code, detail: 'failure detail' });
  });
});
