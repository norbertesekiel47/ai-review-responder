import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Sql } from 'postgres';

// Module tests for the GET /api/dashboard read (#1368) — no route, no auth,
// no NextResponse: a queued fake `sql` plus the two payload services mocked.

const { mockGetActive, mockGetAggregate, mockReport, mockDemoEnabled } = vi.hoisted(() => ({
  mockGetActive: vi.fn(),
  mockGetAggregate: vi.fn(),
  mockReport: vi.fn(),
  mockDemoEnabled: vi.fn(() => false),
}));

vi.mock('@/lib/dashboard/service', () => ({
  getActiveDashboardData: (...args: unknown[]) => mockGetActive(...args),
  BusinessNotFoundError: class BusinessNotFoundError extends Error {},
}));
vi.mock('@/lib/dashboard/aggregate-service', () => ({
  getAggregateDashboardData: (...args: unknown[]) => mockGetAggregate(...args),
}));
vi.mock('@/lib/shared/report-caught-error', () => ({
  reportCaughtError: (...args: unknown[]) => mockReport(...args),
}));
vi.mock('@/lib/onboarding/flags', () => ({
  onboardingDemoEnabled: () => mockDemoEnabled(),
}));

import { BusinessNotFoundError } from '@/lib/dashboard/service';
import {
  classifySubscriptionGate,
  readGatedDashboard,
} from '../subscription-gate';

const ACCOUNT = 'a0000000-0000-0000-0000-000000000001';
const OTHER_ACCOUNT = 'a0000000-0000-0000-0000-000000000002';
const LOC = '01234567-0000-0000-0000-000000000001';
const PRIMARY = '01234567-0000-0000-0000-000000000002';

function fakeSql(results: unknown[][]): { sql: Sql; calls: string[] } {
  const calls: string[] = [];
  const fn = (strings: TemplateStringsArray) => {
    calls.push(strings.join('?'));
    return Promise.resolve(results.shift() ?? []);
  };
  return { sql: fn as unknown as Sql, calls };
}

function locationRow(overrides: Record<string, unknown> = {}) {
  return {
    account_id: ACCOUNT,
    name: 'Cafe',
    subscription_status: 'active',
    subscription_tier: 'starter',
    owner_email: null,
    place_id_verified: true,
    google_maps_url: null,
    onboarding_wizard_completed_at: null,
    archived_at: null,
    past_due_at: null,
    trial_ends_at: null,
    flags: {},
    stripe_customer_id: null,
    ...overrides,
  };
}

function aggregateRow(overrides: Record<string, unknown> = {}) {
  return {
    subscription_status: 'active',
    past_due_at: null,
    trial_ends_at: null,
    flags: {},
    stripe_customer_id: null,
    onboarding_wizard_completed_at: null,
    place_id_verified: true,
    google_maps_url: null,
    ...overrides,
  };
}

const window = '30d' as const;

beforeEach(() => {
  mockGetActive.mockReset().mockResolvedValue({ kpis: 'active' });
  mockGetAggregate.mockReset().mockResolvedValue({ kpis: 'aggregate' });
  mockReport.mockReset();
  mockDemoEnabled.mockReset().mockReturnValue(false);
});

describe('classifySubscriptionGate — the one ladder', () => {
  it.each([
    ['pending_payment', 'pending_payment'],
    ['cancelled', 'cancelled'],
    ['past_due', 'past_due'],
    ['active', 'full_access'],
    ['trialing', 'full_access'],
    ['something_else', 'no_access'],
  ])('%s → %s', (status, rung) => {
    expect(classifySubscriptionGate(status)).toBe(rung);
  });
});

describe('readGatedDashboard — per-location scope', () => {
  it('403 when no location resolves, with no query', async () => {
    const { sql, calls } = fakeSql([]);
    const r = await readGatedDashboard(sql, {
      accountId: ACCOUNT, window, scope: { mode: 'location', locationId: null },
    });
    expect(r).toEqual({ status: 403, body: { error: 'No business associated with this account' } });
    expect(calls).toHaveLength(0);
  });

  it('400 on a non-uuid location before any query', async () => {
    const { sql, calls } = fakeSql([]);
    const r = await readGatedDashboard(sql, {
      accountId: ACCOUNT, window, scope: { mode: 'location', locationId: 'nope' },
    });
    expect(r.status).toBe(400);
    expect(calls).toHaveLength(0);
  });

  it('active: renders the payload from the preflight row, trialEndsAt null', async () => {
    const row = locationRow();
    const { sql } = fakeSql([[row]]);
    const r = await readGatedDashboard(sql, {
      accountId: ACCOUNT, window, scope: { mode: 'location', locationId: LOC },
    });
    expect(r).toEqual({ status: 200, body: { kpis: 'active', trialEndsAt: null } });
    expect(mockGetActive).toHaveBeenCalledWith(sql, LOC, {
      includeReputationMetrics: true, window, business: row,
    });
  });

  it('trialing: trialEndsAt serialized to ISO', async () => {
    const { sql } = fakeSql([[locationRow({
      subscription_status: 'trialing', trial_ends_at: '2026-10-01T00:00:00Z',
    })]]);
    const r = await readGatedDashboard(sql, {
      accountId: ACCOUNT, window, scope: { mode: 'location', locationId: LOC },
    });
    expect(r.body.trialEndsAt).toBe('2026-10-01T00:00:00.000Z');
  });

  it('403 on a foreign location (IDOR)', async () => {
    const { sql } = fakeSql([[locationRow({ account_id: OTHER_ACCOUNT })]]);
    const r = await readGatedDashboard(sql, {
      accountId: ACCOUNT, window, scope: { mode: 'location', locationId: LOC },
    });
    expect(r).toEqual({ status: 403, body: { error: 'Not authorized to access this location' } });
  });

  it('not found → falls back to the primary with a scopeFallback marker', async () => {
    const { sql } = fakeSql([[], [{ id: PRIMARY }], [locationRow()]]);
    const r = await readGatedDashboard(sql, {
      accountId: ACCOUNT, window, scope: { mode: 'location', locationId: LOC },
    });
    expect(r).toEqual({
      status: 200,
      body: {
        kpis: 'active',
        trialEndsAt: null,
        scopeFallback: { reason: 'location_not_found', fallbackLocationId: PRIMARY },
      },
    });
  });

  it('archived with no other primary → 404 No active location available', async () => {
    const { sql } = fakeSql([[locationRow({ archived_at: new Date() })], [{ id: LOC }]]);
    const r = await readGatedDashboard(sql, {
      accountId: ACCOUNT, window, scope: { mode: 'location', locationId: LOC },
    });
    expect(r).toEqual({ status: 404, body: { error: 'No active location available' } });
  });

  it('pending_payment: funnel entry, no payload read', async () => {
    const { sql } = fakeSql([[locationRow({ subscription_status: 'pending_payment' })]]);
    const r = await readGatedDashboard(sql, {
      accountId: ACCOUNT, window, scope: { mode: 'location', locationId: LOC },
    });
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({
      subscriptionStatus: 'pending_payment', locationId: LOC, businessName: 'Cafe',
    });
    expect(typeof r.body.funnelUrl).toBe('string');
    expect(mockGetActive).not.toHaveBeenCalled();
  });

  it('cancelled: grace window from cancelled_at', async () => {
    const cancelledAt = new Date(Date.now() - 86_400_000);
    const { sql } = fakeSql([[locationRow({ subscription_status: 'cancelled' })], [{ cancelled_at: cancelledAt }]]);
    const r = await readGatedDashboard(sql, {
      accountId: ACCOUNT, window, scope: { mode: 'location', locationId: LOC },
    });
    expect(r.body).toEqual({
      subscriptionStatus: 'cancelled',
      businessName: 'Cafe',
      gracePeriodEndDate: new Date(cancelledAt.getTime() + 30 * 86_400_000).toISOString(),
      readAccess: true,
    });
  });

  it('past_due: payload + billing portal + recovery fields', async () => {
    const { sql } = fakeSql([[locationRow({
      subscription_status: 'past_due', stripe_customer_id: 'cus_1', past_due_at: new Date(),
    })]]);
    const r = await readGatedDashboard(sql, {
      accountId: ACCOUNT, window, scope: { mode: 'location', locationId: LOC },
    });
    expect(r.body).toMatchObject({
      kpis: 'active', subscriptionStatus: 'past_due', accountId: ACCOUNT,
      businessName: 'Cafe', billingPortalUrl: '/api/billing/portal', isReadOnly: false,
    });
    expect(Object.keys(r.body).slice(0, 5)).toEqual([
      'kpis', 'subscriptionStatus', 'accountId', 'businessName', 'billingPortalUrl',
    ]);
  });

  it('active with no place → active_pending_business', async () => {
    const { sql } = fakeSql([[locationRow({ place_id_verified: false })]]);
    const r = await readGatedDashboard(sql, {
      accountId: ACCOUNT, window, scope: { mode: 'location', locationId: LOC },
    });
    expect(r.body).toEqual({
      subscriptionStatus: 'active_pending_business', locationId: LOC, businessName: 'Cafe',
    });
  });

  it('an off-vocabulary status renders the payload (per-location has no no_access rung)', async () => {
    const { sql } = fakeSql([[locationRow({ subscription_status: 'weird', place_id_verified: false })]]);
    const r = await readGatedDashboard(sql, {
      accountId: ACCOUNT, window, scope: { mode: 'location', locationId: LOC },
    });
    expect(r.body).toEqual({ kpis: 'active', trialEndsAt: null });
  });

  it('fallback render BusinessNotFoundError → 404, unreported', async () => {
    mockGetActive.mockRejectedValue(new BusinessNotFoundError(PRIMARY));
    const { sql } = fakeSql([[], [{ id: PRIMARY }], [locationRow()]]);
    const r = await readGatedDashboard(sql, {
      accountId: ACCOUNT, window, scope: { mode: 'location', locationId: LOC },
    });
    expect(r).toEqual({ status: 404, body: { error: 'Business not found' } });
    expect(mockReport).not.toHaveBeenCalled();
  });

  it('preflight failure → reported 500', async () => {
    const boom = new Error('boom');
    const sql = (() => Promise.reject(boom)) as unknown as Sql;
    const r = await readGatedDashboard(sql, {
      accountId: ACCOUNT, window, scope: { mode: 'location', locationId: LOC },
    });
    expect(r).toEqual({ status: 500, body: { error: 'Failed to fetch dashboard data' } });
    expect(mockReport).toHaveBeenCalledWith('api/dashboard', boom, { accountId: ACCOUNT, locationId: LOC });
  });

  it('direct render failure is caught: reported, JSON 500 (#1475)', async () => {
    const boom = new Error('boom');
    mockGetActive.mockRejectedValue(boom);
    const { sql } = fakeSql([[locationRow()]]);
    const r = await readGatedDashboard(sql, {
      accountId: ACCOUNT, window, scope: { mode: 'location', locationId: LOC },
    });
    expect(r).toEqual({ status: 500, body: { error: 'Failed to fetch dashboard data' } });
    expect(mockReport).toHaveBeenCalledWith('api/dashboard', boom, { accountId: ACCOUNT, locationId: LOC });
  });

  it('direct render BusinessNotFoundError maps to 404 (#1475)', async () => {
    mockGetActive.mockRejectedValue(new BusinessNotFoundError(LOC));
    const { sql } = fakeSql([[locationRow()]]);
    const r = await readGatedDashboard(sql, {
      accountId: ACCOUNT, window, scope: { mode: 'location', locationId: LOC },
    });
    expect(r).toEqual({ status: 404, body: { error: 'Business not found' } });
    expect(mockReport).not.toHaveBeenCalled();
  });
});

describe('readGatedDashboard — aggregate scope', () => {
  const scope = { mode: 'aggregate' } as const;

  it('404 when the account row is missing', async () => {
    const { sql } = fakeSql([[]]);
    const r = await readGatedDashboard(sql, { accountId: ACCOUNT, window, scope });
    expect(r).toEqual({ status: 404, body: { error: 'Account not found' } });
  });

  it('active: aggregate payload + trialEndsAt', async () => {
    const { sql } = fakeSql([[aggregateRow()]]);
    const r = await readGatedDashboard(sql, { accountId: ACCOUNT, window, scope });
    expect(r).toEqual({ status: 200, body: { kpis: 'aggregate', trialEndsAt: null } });
    expect(mockGetAggregate).toHaveBeenCalledWith(sql, ACCOUNT, window);
  });

  it('pending_payment: businessName Account, no locationId; null primary reads as no place', async () => {
    const { sql } = fakeSql([[aggregateRow({
      subscription_status: 'pending_payment', place_id_verified: null,
    })]]);
    const r = await readGatedDashboard(sql, { accountId: ACCOUNT, window, scope });
    expect(Object.keys(r.body)).toEqual(['subscriptionStatus', 'businessName', 'funnelUrl']);
    expect(r.body.businessName).toBe('Account');
  });

  it('cancelled with no clock: indefinite grace', async () => {
    const { sql } = fakeSql([[aggregateRow({ subscription_status: 'cancelled' })], [{ cancelled_at: null }]]);
    const r = await readGatedDashboard(sql, { accountId: ACCOUNT, window, scope });
    expect(r.body).toEqual({
      subscriptionStatus: 'cancelled', businessName: 'Account', gracePeriodEndDate: null, readAccess: true,
    });
  });

  it('past_due: aggregate payload, key order businessName before accountId', async () => {
    const { sql } = fakeSql([[aggregateRow({ subscription_status: 'past_due' })]]);
    const r = await readGatedDashboard(sql, { accountId: ACCOUNT, window, scope });
    expect(Object.keys(r.body).slice(0, 5)).toEqual([
      'kpis', 'subscriptionStatus', 'businessName', 'accountId', 'billingPortalUrl',
    ]);
    expect(r.body.billingPortalUrl).toBeNull();
  });

  it('an off-vocabulary status is gated to its bare status', async () => {
    const { sql } = fakeSql([[aggregateRow({ subscription_status: 'weird' })]]);
    const r = await readGatedDashboard(sql, { accountId: ACCOUNT, window, scope });
    expect(r).toEqual({ status: 200, body: { subscriptionStatus: 'weird' } });
    expect(mockGetAggregate).not.toHaveBeenCalled();
  });

  it('failure → reported 500 with the aggregate context', async () => {
    const boom = new Error('boom');
    mockGetAggregate.mockRejectedValue(boom);
    const { sql } = fakeSql([[aggregateRow()]]);
    const r = await readGatedDashboard(sql, { accountId: ACCOUNT, window, scope });
    expect(r).toEqual({ status: 500, body: { error: 'Failed to fetch aggregate dashboard data' } });
    expect(mockReport).toHaveBeenCalledWith('api/dashboard', boom, { accountId: ACCOUNT, scope: 'aggregate' });
  });
});
