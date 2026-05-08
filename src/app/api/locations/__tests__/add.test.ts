// src/app/api/locations/__tests__/add.test.ts
//
// TDD assertions for POST /api/locations/add.
// Validation contract: VAL-BILLING-072, VAL-LOC-041, VAL-LOC-031.

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NextRequest } from 'next/server';

// ── Hoisted mocks ──────────────────────────────────────────────────────────

const { mockSql } = vi.hoisted(() => {
  const sqlFn: any = vi.fn();
  sqlFn.begin = vi.fn(async (cb: (tx: any) => Promise<unknown>) => cb(sqlFn));
  return { mockSql: sqlFn };
});

vi.mock('@/lib/db/server', () => ({
  sql: mockSql,
  jsonb: (v: unknown) => v,
}));

// Mock the quota module
const { mockAssertCanAddLocation } = vi.hoisted(() => ({
  mockAssertCanAddLocation: vi.fn(),
}));

vi.mock('@/lib/accounts/quota', () => ({
  assertCanAddLocation: mockAssertCanAddLocation,
}));

// Mock the accounts repo
const { mockGetAccountById, mockGetAccountOwnerUserId } = vi.hoisted(() => ({
  mockGetAccountById: vi.fn(),
  mockGetAccountOwnerUserId: vi.fn(),
}));

vi.mock('@/lib/accounts/repo', () => ({
  getAccountById: mockGetAccountById,
  getAccountOwnerUserId: mockGetAccountOwnerUserId,
}));

// Mock the locations repo
const { mockGetActiveLocationCount } = vi.hoisted(() => ({
  mockGetActiveLocationCount: vi.fn(),
}));

vi.mock('@/lib/locations/repo', () => ({
  getActiveLocationCount: mockGetActiveLocationCount,
}));

// Mock the add-location-tx module
const { mockAddLocationTransaction } = vi.hoisted(() => ({
  mockAddLocationTransaction: vi.fn(),
}));

vi.mock('@/lib/locations/add-location-tx', () => ({
  addLocationTransaction: mockAddLocationTransaction,
}));

process.env.MULTI_LOCATION_ENABLED = 'true';

import { POST } from '../add/route';

// ── Helpers ────────────────────────────────────────────────────────────────

function mkRequest(body: Record<string, unknown>): NextRequest {
  return new NextRequest('http://localhost:3000/api/locations/add', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

function mockAccountRow(overrides: Record<string, unknown> = {}) {
  return {
    id: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
    owner_user_id: 'uuuuuuuu-0000-0000-0000-000000000001',
    display_name: 'Test Account',
    subscription_tier: 'standard',
    subscription_status: 'active',
    stripe_customer_id: 'cus_test123',
    stripe_subscription_id: 'sub_test123',
    trial_ends_at: null,
    subscription_activated_at: new Date('2026-01-01'),
    locations_included: 1,
    locations_paid: 0,
    locations_overage_price_cents: 2500,
    flags: {},
    created_at: new Date('2026-01-01'),
    updated_at: new Date('2026-01-01'),
    ...overrides,
  };
}

function setupHappyPathMocks(overrides: Record<string, unknown> = {}) {
  mockAssertCanAddLocation.mockResolvedValueOnce({ allowed: true, overageUnits: 1 });
  mockGetActiveLocationCount.mockResolvedValueOnce(1);
  mockGetAccountById.mockResolvedValueOnce(mockAccountRow(overrides));
  mockGetAccountOwnerUserId.mockResolvedValueOnce('uuuuuuuu-0000-0000-0000-000000000001');
  mockAddLocationTransaction.mockResolvedValueOnce({
    businessId: 'new-biz-id-0000-0000-0000-000000000001',
    displayLabel: 'Downtown Cafe',
    voiceClonedFromPrimary: true,
  });
}

beforeEach(() => {
  vi.clearAllMocks();
});

// ── Tests ──────────────────────────────────────────────────────────────────

describe('POST /api/locations/add', () => {
  // VAL-LOC-041: Returns 404 when MULTI_LOCATION_ENABLED is not true
  it('returns 404 when MULTI_LOCATION_ENABLED is not true', async () => {
    process.env.MULTI_LOCATION_ENABLED = 'false';
    const req = mkRequest({
      accountId: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
      displayLabel: 'Downtown Cafe',
    });
    const res = await POST(req);
    expect(res.status).toBe(404);
    const body = await res.json();
    expect(body.error).toBe('not_found');
    process.env.MULTI_LOCATION_ENABLED = 'true';
  });

  // Happy path: creates location and returns 201
  it('creates location and returns 201 with result', async () => {
    setupHappyPathMocks();

    const req = mkRequest({
      accountId: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
      displayLabel: 'Downtown Cafe',
    });
    const res = await POST(req);
    const body = await res.json();

    expect(res.status).toBe(201);
    expect(body.displayLabel).toBe('Downtown Cafe');
    expect(body.businessId).toBe('new-biz-id-0000-0000-0000-000000000001');
    expect(body.voiceClonedFromPrimary).toBe(true);
    expect(body.activeLocations).toBe(2); // 1 + 1
    expect(body.overageUnits).toBe(1);
  });

  // VAL-BILLING-072: Uses addLocationTransaction (outbox pattern, no Checkout redirect)
  it('calls addLocationTransaction with correct parameters', async () => {
    setupHappyPathMocks();

    const req = mkRequest({
      accountId: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
      displayLabel: 'Downtown Cafe',
      googlePlaceId: 'ChIJN1t_tDeuEmsRUsoyG83frY4',
      placeIdVerified: true,
    });
    await POST(req);

    expect(mockAddLocationTransaction).toHaveBeenCalledTimes(1);
    const txInput = mockAddLocationTransaction.mock.calls[0]![0];
    expect(txInput.accountId).toBe('aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee');
    expect(txInput.displayLabel).toBe('Downtown Cafe');
    expect(txInput.googlePlaceId).toBe('ChIJN1t_tDeuEmsRUsoyG83frY4');
    expect(txInput.placeIdVerified).toBe(true);
    expect(txInput.actorUserId).toBe('uuuuuuuu-0000-0000-0000-000000000001');
    expect(txInput.subscriptionTier).toBe('standard');
    expect(txInput.subscriptionStatus).toBe('active');
    expect(txInput.activeLocationsBefore).toBe(1);
  });

  // Delegates to assertCanAddLocation for quota checks
  it('returns 403 for inactive subscription', async () => {
    mockAssertCanAddLocation.mockResolvedValueOnce({
      allowed: false,
      reason: 'subscription_inactive',
    });

    const req = mkRequest({
      accountId: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
      displayLabel: 'Downtown Cafe',
    });
    const res = await POST(req);

    expect(res.status).toBe(403);
    const body = await res.json();
    expect(body.error).toBe('subscription_inactive');
  });

  it('returns 403 for basic tier (no multi-location allowed)', async () => {
    mockAssertCanAddLocation.mockResolvedValueOnce({
      allowed: false,
      reason: 'tier_disallows_multi_location',
    });

    const req = mkRequest({
      accountId: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
      displayLabel: 'Downtown Cafe',
    });
    const res = await POST(req);

    expect(res.status).toBe(403);
    const body = await res.json();
    expect(body.error).toBe('tier_disallows_multi_location');
  });

  it('returns 404 when account not found (quota check)', async () => {
    mockAssertCanAddLocation.mockResolvedValueOnce({
      allowed: false,
      reason: 'account_not_found',
    });

    const req = mkRequest({
      accountId: '00000000-0000-7f00-8000-000000000000',
      displayLabel: 'Downtown Cafe',
    });
    const res = await POST(req);

    expect(res.status).toBe(404);
    const body = await res.json();
    expect(body.error).toBe('account_not_found');
  });

  it('returns 404 when account not found (after quota check passes)', async () => {
    mockAssertCanAddLocation.mockResolvedValueOnce({ allowed: true, overageUnits: 1 });
    mockGetActiveLocationCount.mockResolvedValueOnce(1);
    mockGetAccountById.mockResolvedValueOnce(null); // account not found

    const req = mkRequest({
      accountId: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
      displayLabel: 'Downtown Cafe',
    });
    const res = await POST(req);

    expect(res.status).toBe(404);
  });

  // Input validation
  it('returns 400 for invalid accountId format', async () => {
    const req = mkRequest({
      accountId: 'not-a-uuid',
      displayLabel: 'Downtown Cafe',
    });
    const res = await POST(req);

    expect(res.status).toBe(400);
  });

  it('returns 400 for missing displayLabel', async () => {
    const req = mkRequest({
      accountId: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
    });
    const res = await POST(req);

    expect(res.status).toBe(400);
  });

  it('returns 400 for empty displayLabel', async () => {
    const req = mkRequest({
      accountId: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
      displayLabel: '',
    });
    const res = await POST(req);

    expect(res.status).toBe(400);
  });

  // Transaction failure
  it('returns 500 when addLocationTransaction throws', async () => {
    mockAssertCanAddLocation.mockResolvedValueOnce({ allowed: true, overageUnits: 1 });
    mockGetActiveLocationCount.mockResolvedValueOnce(1);
    mockGetAccountById.mockResolvedValueOnce(mockAccountRow());
    mockGetAccountOwnerUserId.mockResolvedValueOnce('uuuuuuuu-0000-0000-0000-000000000001');
    mockAddLocationTransaction.mockRejectedValueOnce(new Error('Transaction failed: constraint violation'));

    const req = mkRequest({
      accountId: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
      displayLabel: 'Downtown Cafe',
    });
    const res = await POST(req);

    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body.error).toBe('add_location_failed');
  });

  // VAL-LOC-031: Voice cloning info returned in response
  it('returns voiceClonedFromPrimary from transaction result', async () => {
    mockAssertCanAddLocation.mockResolvedValueOnce({ allowed: true, overageUnits: 0 });
    mockGetActiveLocationCount.mockResolvedValueOnce(0);
    mockGetAccountById.mockResolvedValueOnce(mockAccountRow({ subscription_tier: 'premium' }));
    mockGetAccountOwnerUserId.mockResolvedValueOnce('uuuuuuuu-0000-0000-0000-000000000001');
    mockAddLocationTransaction.mockResolvedValueOnce({
      businessId: 'new-biz-id-0000-0000-0000-000000000001',
      displayLabel: 'Northside Grill',
      voiceClonedFromPrimary: false, // no primary existed
    });

    const req = mkRequest({
      accountId: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
      displayLabel: 'Northside Grill',
    });
    const res = await POST(req);
    const body = await res.json();

    expect(res.status).toBe(201);
    expect(body.voiceClonedFromPrimary).toBe(false);
  });
});
