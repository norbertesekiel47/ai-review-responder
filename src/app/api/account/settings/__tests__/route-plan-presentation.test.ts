import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';

const mocks = vi.hoisted(() => ({
  sql: vi.fn(),
  requireOwnerWithAccount: vi.fn(),
  currentBillingSnapshot: vi.fn(),
  getActiveLocationCount: vi.fn(),
  autopilotPurchasable: vi.fn(),
}));

vi.mock('@/lib/db/server', () => ({ sql: mocks.sql }));
vi.mock('@/lib/auth/route-helpers', () => ({
  requireOwnerWithAccount: mocks.requireOwnerWithAccount,
  jsonResponse: (body: unknown, status = 200) => Response.json(body, { status }),
}));
vi.mock('@/lib/accounts/quota', () => ({
  currentBillingSnapshot: mocks.currentBillingSnapshot,
}));
vi.mock('@/lib/locations/repo', () => ({
  getActiveLocationCount: mocks.getActiveLocationCount,
}));
vi.mock('@/lib/payments/tier-purchasability', () => ({
  autopilotPurchasable: mocks.autopilotPurchasable,
}));

import { GET } from '@/app/api/account/settings/route';

const ACCOUNT_ID = '00000000-0000-4000-8000-000000000042';

describe('GET /api/account/settings plan presentation', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.requireOwnerWithAccount.mockResolvedValue({ ok: true, accountId: ACCOUNT_ID });
    mocks.sql.mockResolvedValue([{
      id: ACCOUNT_ID,
      display_name: 'Founding Co',
      subscription_tier: 'copilot',
      price_variant: 'founding',
      subscription_status: 'trialing',
      stripe_customer_id: 'cus_founder',
      subscription_activated_at: null,
      locations_included: 1,
      locations_paid: 0,
      trial_ends_at: new Date('2026-08-14T00:00:00Z'),
    }]);
    mocks.currentBillingSnapshot.mockResolvedValue({
      basePriceCents: 1900,
      overagePriceCents: 1500,
      overageUnits: 0,
      totalCents: 1900,
    });
    mocks.getActiveLocationCount.mockResolvedValue(1);
    mocks.autopilotPurchasable.mockReturnValue(false);
  });

  it('returns stored current cents plus founding targets and closed Autopilot', async () => {
    const response = await GET(new NextRequest('http://localhost/api/account/settings'));
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.subscription).toMatchObject({
      tier: 'copilot',
      priceVariant: 'founding',
      status: 'trialing',
    });
    expect(body.billing).toEqual({
      basePriceCents: 1900,
      overagePriceCents: 1500,
      overageUnits: 0,
      totalCents: 1900,
    });
    expect(body.planPresentation).toEqual({
      purchasable: { copilot: true, autopilot: false },
      prices: {
        copilot: {
          basePriceCents: 1900,
          listBasePriceCents: 2900,
          locationsOveragePriceCents: 1500,
          locationsIncluded: 1,
        },
        autopilot: {
          basePriceCents: 4900,
          listBasePriceCents: 6900,
          locationsOveragePriceCents: 2000,
          locationsIncluded: 1,
        },
      },
      priceVariant: 'founding',
      trialEnabled: true,
    });
    expect(mocks.sql).toHaveBeenCalledTimes(1);
    expect(mocks.currentBillingSnapshot).toHaveBeenCalledTimes(1);
    expect(mocks.getActiveLocationCount).toHaveBeenCalledTimes(1);
    expect(mocks.autopilotPurchasable).toHaveBeenCalledTimes(1);
  });

  it('fails closed before pricing reads when the stored variant is invalid', async () => {
    mocks.sql.mockResolvedValueOnce([{
      id: ACCOUNT_ID,
      display_name: 'Broken Co',
      subscription_tier: 'copilot',
      price_variant: 'unexpected',
      subscription_status: 'active',
      stripe_customer_id: 'cus_broken',
      subscription_activated_at: null,
      locations_included: 1,
      locations_paid: 0,
      trial_ends_at: null,
    }]);

    const response = await GET(new NextRequest('http://localhost/api/account/settings'));

    expect(response.status).toBe(500);
    await expect(response.json()).resolves.toEqual({ error: 'Account has an invalid price variant' });
    expect(mocks.sql).toHaveBeenCalledTimes(1);
    expect(mocks.currentBillingSnapshot).not.toHaveBeenCalled();
    expect(mocks.getActiveLocationCount).not.toHaveBeenCalled();
    expect(mocks.autopilotPurchasable).not.toHaveBeenCalled();
  });

  it('fails closed before pricing reads when the stored tier is unsupported', async () => {
    mocks.sql.mockResolvedValueOnce([{
      id: ACCOUNT_ID,
      display_name: 'Broken Co',
      subscription_tier: 'retired_tier',
      price_variant: 'list',
      subscription_status: 'active',
      stripe_customer_id: 'cus_broken',
      subscription_activated_at: null,
      locations_included: 1,
      locations_paid: 0,
      trial_ends_at: null,
    }]);

    const response = await GET(new NextRequest('http://localhost/api/account/settings'));

    expect(response.status).toBe(500);
    await expect(response.json()).resolves.toEqual({
      error: 'Account has an invalid subscription tier',
    });
    expect(mocks.sql).toHaveBeenCalledTimes(1);
    expect(mocks.currentBillingSnapshot).not.toHaveBeenCalled();
    expect(mocks.getActiveLocationCount).not.toHaveBeenCalled();
    expect(mocks.autopilotPurchasable).not.toHaveBeenCalled();
  });
});
