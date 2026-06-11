// src/app/api/admin/locations/csv-import/__tests__/route.test.ts
//
// TDD assertions for POST /api/admin/locations/csv-import.
// Validation contract: VAL-ADMIN-008 through VAL-ADMIN-014.

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

// Mock auth — admin and owner roles
const { mockRequireRole } = vi.hoisted(() => ({
  mockRequireRole: vi.fn(),
}));

vi.mock('@/lib/db/auth', () => ({
  requireRole: mockRequireRole,
  AuthError: class AuthError extends Error {
    constructor(message: string, public readonly statusCode: number) {
      super(message);
    }
  },
}));

// Mock quota check
const { mockAssertCanAddLocation } = vi.hoisted(() => ({
  mockAssertCanAddLocation: vi.fn(),
}));

vi.mock('@/lib/accounts/quota', () => ({
  assertCanAddLocation: mockAssertCanAddLocation,
}));

// Mock accounts repo
const { mockGetAccountById, mockGetAccountOwnerUser, mockGetAccountOwnerUserId } = vi.hoisted(() => ({
  mockGetAccountById: vi.fn(),
  mockGetAccountOwnerUser: vi.fn(),
  mockGetAccountOwnerUserId: vi.fn(),
}));

vi.mock('@/lib/accounts/repo', () => ({
  getAccountById: mockGetAccountById,
  getAccountOwnerUser: mockGetAccountOwnerUser,
  getAccountOwnerUserId: mockGetAccountOwnerUserId,
}));

// Mock locations repo
const { mockGetActiveLocationCount } = vi.hoisted(() => ({
  mockGetActiveLocationCount: vi.fn(),
}));

vi.mock('@/lib/locations/repo', () => ({
  getActiveLocationCount: mockGetActiveLocationCount,
}));

// Mock add-location-tx
const { mockAddLocationTransaction } = vi.hoisted(() => ({
  mockAddLocationTransaction: vi.fn(),
}));

vi.mock('@/lib/locations/add-location-tx', () => ({
  addLocationTransaction: mockAddLocationTransaction,
}));

process.env.MULTI_LOCATION_ENABLED = 'true';

import { POST } from '../route';

// ── Helpers ────────────────────────────────────────────────────────────────

const APP_URL = 'http://localhost:3000';

function mockAdminUser() {
  return { id: 'admin-1', role: 'admin', email: 'admin@test.com', name: 'Admin' };
}

function mockOwnerUser() {
  return { id: 'owner-1', role: 'owner', email: 'owner@test.com', name: 'Owner' };
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

function mkCsvRequest(
  csvContent: string,
  accountId: string = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
): NextRequest {
  const formData = new FormData();
  const blob = new Blob([csvContent], { type: 'text/csv' });
  formData.append('file', blob, 'locations.csv');
  formData.append('accountId', accountId);

  return new NextRequest('http://localhost:3000/api/admin/locations/csv-import', {
    method: 'POST',
    headers: { Origin: APP_URL },
    body: formData,
  });
}

function setupHappyPathRow() {
  mockGetAccountById.mockResolvedValue(mockAccountRow());
  mockAssertCanAddLocation.mockResolvedValue({ allowed: true, overageUnits: 1 });
  mockGetActiveLocationCount.mockResolvedValue(1);
  mockGetAccountOwnerUser.mockResolvedValue({
    id: 'uuuuuuuu-0000-0000-0000-000000000001',
    name: 'Test Owner',
    email: 'owner@test.com',
  });
  mockGetAccountOwnerUserId.mockResolvedValue('uuuuuuuu-0000-0000-0000-000000000001');
  mockAddLocationTransaction.mockResolvedValue({
    businessId: 'new-biz-id-0000-0000-0000-000000000001',
    displayLabel: 'Downtown Cafe',
    voiceClonedFromPrimary: true,
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  mockSql.mockResolvedValue([]);
  mockRequireRole.mockResolvedValue(mockAdminUser());
  process.env.NEXT_PUBLIC_APP_URL = APP_URL;
});

// ── Tests ──────────────────────────────────────────────────────────────────

describe('POST /api/admin/locations/csv-import', () => {
  // ── VAL-ADMIN-011: Gated to admin role only ────────────────────────────

  it('returns 403 for non-admin (owner) users', async () => {
    // Simulate AuthError thrown by requireRole when user lacks admin role
    const AuthErrorClass = (await import('@/lib/db/auth')).AuthError;
    mockRequireRole.mockRejectedValueOnce(new AuthErrorClass('Forbidden', 403));

    const req = mkCsvRequest('name,placeId\nTest,ChIJ1234');
    const res = await POST(req);

    expect(res.status).toBe(403);
  });

  it('returns 401 for unauthenticated users', async () => {
    const AuthErrorClass = (await import('@/lib/db/auth')).AuthError;
    mockRequireRole.mockRejectedValueOnce(new AuthErrorClass('Unauthorized', 401));

    const req = mkCsvRequest('name,placeId\nTest,ChIJ1234');
    const res = await POST(req);

    expect(res.status).toBe(401);
  });

  // ── VAL-ADMIN-013: Rejects oversized files ─────────────────────────────

  it('rejects files larger than 5MB with 413', async () => {
    // Create a CSV content that's larger than 5MB
    const largeContent = 'name,placeId\n' + 'A,'.repeat(6_000_000);
    const req = mkCsvRequest(largeContent);
    const res = await POST(req);

    expect(res.status).toBe(413);
    const body = await res.json();
    expect(body.error).toContain('size');
  });

  it('rejects CSVs with more than 100 rows with 400', async () => {
    const rows = Array.from({ length: 101 }, (_, i) => `Location ${i + 1},ChIJ${i}`);
    const csv = 'name,placeId\n' + rows.join('\n');
    const req = mkCsvRequest(csv);
    const res = await POST(req);

    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toContain('rows');
  });

  // ── VAL-ADMIN-012: Required fields validation ──────────────────────────

  it('rejects rows missing name with validation error', async () => {
    mockGetAccountById.mockResolvedValue(mockAccountRow());
    const csv = 'name,placeId\n,ChIJ1234'; // empty name
    const req = mkCsvRequest(csv);
    const res = await POST(req);

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.created).toBe(0);
    expect(body.failed.length).toBe(1);
    expect(body.failed[0].row).toBe(1);
    expect(body.failed[0].reason).toContain('name');
  });

  it('rejects rows missing placeId with validation error', async () => {
    mockGetAccountById.mockResolvedValue(mockAccountRow());
    const csv = 'name,placeId\nDowntown Cafe,'; // empty placeId
    const req = mkCsvRequest(csv);
    const res = await POST(req);

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.created).toBe(0);
    expect(body.failed.length).toBe(1);
    expect(body.failed[0].row).toBe(1);
    expect(body.failed[0].reason).toContain('placeId');
  });

  it('rejects rows missing both name and placeId', async () => {
    mockGetAccountById.mockResolvedValue(mockAccountRow());
    const csv = 'name,placeId\n,'; // both empty
    const req = mkCsvRequest(csv);
    const res = await POST(req);

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.created).toBe(0);
    expect(body.failed.length).toBe(1);
    expect(body.failed[0].reason).toContain('name');
  });

  // ── VAL-ADMIN-008: Valid CSV with name, placeId, voice config ──────────

  it('creates 3 locations from valid 3-row CSV', async () => {
    mockGetAccountById.mockResolvedValue(mockAccountRow());
    setupHappyPathRow();
    // Make assertCanAddLocation succeed for all 3 rows
    mockAssertCanAddLocation.mockResolvedValue({ allowed: true, overageUnits: 1 });
    mockGetActiveLocationCount.mockResolvedValue(1);

    const csv = `name,placeId,tone,productsServices
Downtown Cafe,ChIJ1234,friendly,Coffee and pastries
Uptown Bistro,ChIJ5678,professional,Fine dining
Westside Grill,ChIJ9012,casual,Burgers and shakes`;

    const req = mkCsvRequest(csv);
    const res = await POST(req);

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.created).toBe(3);
    expect(body.failed.length).toBe(0);
  });

  // ── VAL-ADMIN-009: Each row processed through add-location flow ────────

  it('processes each row through assertCanAddLocation', async () => {
    mockGetAccountById.mockResolvedValue(mockAccountRow());
    setupHappyPathRow();
    // First 2 rows allowed, 3rd rejected (e.g. quota)
    mockAssertCanAddLocation
      .mockResolvedValueOnce({ allowed: true, overageUnits: 1 })
      .mockResolvedValueOnce({ allowed: true, overageUnits: 2 })
      .mockResolvedValueOnce({ allowed: false, reason: 'subscription_inactive' });

    const csv = `name,placeId
Downtown Cafe,ChIJ1234
Uptown Bistro,ChIJ5678
Westside Grill,ChIJ9012`;

    const req = mkCsvRequest(csv);
    const res = await POST(req);
    const body = await res.json();

    expect(mockAssertCanAddLocation).toHaveBeenCalledTimes(3);
    expect(body.created).toBe(2);
    expect(body.failed.length).toBe(1);
  });

  it('processes each valid row through addLocationTransaction', async () => {
    mockGetAccountById.mockResolvedValue(mockAccountRow());
    setupHappyPathRow();
    mockAssertCanAddLocation.mockResolvedValue({ allowed: true, overageUnits: 1 });
    mockGetActiveLocationCount.mockResolvedValue(1);

    const csv = `name,placeId
Downtown Cafe,ChIJ1234
Uptown Bistro,ChIJ5678`;

    const req = mkCsvRequest(csv);
    const res = await POST(req);

    expect(mockAddLocationTransaction).toHaveBeenCalledTimes(2);
  });

  it('suppresses per-row Stripe overage jobs and enqueues one aggregate job after successful rows', async () => {
    mockGetAccountById.mockResolvedValue(mockAccountRow());
    setupHappyPathRow();
    mockAssertCanAddLocation.mockResolvedValue({ allowed: true, overageUnits: 1 });
    mockGetActiveLocationCount.mockResolvedValue(1);

    const csv = `name,placeId
Downtown Cafe,ChIJ1234
Uptown Bistro,ChIJ5678
Westside Grill,ChIJ9012`;

    const req = mkCsvRequest(csv);
    await POST(req);

    expect(mockAddLocationTransaction).toHaveBeenCalledTimes(3);
    for (const [input] of mockAddLocationTransaction.mock.calls) {
      expect(input).toMatchObject({ enqueueStripeOverageUpdate: false });
    }

    // Topic is bound as a parameter by enqueueStripeOverageRecompute.
    const overageOutboxCalls = mockSql.mock.calls.filter((call: any[]) =>
      call.slice(1).includes('update_stripe_overage_quantity'),
    );
    expect(overageOutboxCalls).toHaveLength(1);
  });

  // ── VAL-ADMIN-010: Partial-success report ──────────────────────────────

  it('returns partial-success report with X created, Y failed with reasons', async () => {
    mockGetAccountById.mockResolvedValue(mockAccountRow());
    setupHappyPathRow();
    // Row 1: valid
    mockAssertCanAddLocation.mockResolvedValueOnce({ allowed: true, overageUnits: 1 });
    // Row 2: invalid (missing placeId) — validation catches before quota
    // Row 3: valid
    mockAssertCanAddLocation.mockResolvedValueOnce({ allowed: true, overageUnits: 2 });

    const csv = `name,placeId
Downtown Cafe,ChIJ1234
Invalid Row,
Westside Grill,ChIJ9012`;

    const req = mkCsvRequest(csv);
    const res = await POST(req);

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.created).toBe(2);
    expect(body.failed.length).toBe(1);
    expect(body.failed[0].row).toBe(2);
    expect(body.failed[0].reason).toContain('placeId');
  });

  // ── Best-effort: invalid rows don't block valid rows ────────────────────

  it('processes valid rows even when some rows fail validation', async () => {
    mockGetAccountById.mockResolvedValue(mockAccountRow());
    setupHappyPathRow();
    mockAssertCanAddLocation.mockResolvedValue({ allowed: true, overageUnits: 1 });
    mockGetActiveLocationCount.mockResolvedValue(1);

    const csv = `name,placeId
Downtown Cafe,ChIJ1234
,
Uptown Bistro,ChIJ5678
Missing Place,
Westside Grill,ChIJ9012`;

    const req = mkCsvRequest(csv);
    const res = await POST(req);

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.created).toBe(3); // 3 valid rows
    expect(body.failed.length).toBe(2); // 2 invalid rows
  });

  // ── Input validation: no file ──────────────────────────────────────────

  it('returns 400 when no file is provided', async () => {
    const formData = new FormData();
    formData.append('accountId', 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee');

    const req = new NextRequest('http://localhost:3000/api/admin/locations/csv-import', {
      method: 'POST',
      headers: { Origin: APP_URL },
      body: formData,
    });

    const res = await POST(req);
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toContain('file');
  });

  it('returns 400 when no accountId is provided', async () => {
    const formData = new FormData();
    const blob = new Blob(['name,placeId\nTest,ChIJ1234'], { type: 'text/csv' });
    formData.append('file', blob, 'locations.csv');

    const req = new NextRequest('http://localhost:3000/api/admin/locations/csv-import', {
      method: 'POST',
      headers: { Origin: APP_URL },
      body: formData,
    });

    const res = await POST(req);
    expect(res.status).toBe(400);
  });

  // ── Invalid CSV format ─────────────────────────────────────────────────

  it('returns 400 when CSV has no header row', async () => {
    const csv = 'Downtown Cafe,ChIJ1234\nUptown,ChIJ5678'; // no header
    const req = mkCsvRequest(csv);
    const res = await POST(req);

    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toContain('header');
  });

  it('returns 400 when CSV is missing name column', async () => {
    const csv = 'placeId,tone\nChIJ1234,friendly'; // no name column
    const req = mkCsvRequest(csv);
    const res = await POST(req);

    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toContain('name');
  });

  it('returns 400 when CSV is missing placeId column', async () => {
    const csv = 'name,tone\nDowntown Cafe,friendly'; // no placeId column
    const req = mkCsvRequest(csv);
    const res = await POST(req);

    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toContain('placeId');
  });

  // ── VAL-ADMIN-014: account_audit_log records csv_import event ──────────

  it('writes csv_bulk_import audit log entry with row counts', async () => {
    setupHappyPathRow();
    mockAssertCanAddLocation.mockResolvedValue({ allowed: true, overageUnits: 1 });
    mockGetActiveLocationCount.mockResolvedValue(1);

    const csv = `name,placeId
Downtown Cafe,ChIJ1234
Uptown Bistro,ChIJ5678`;

    const req = mkCsvRequest(csv);
    const res = await POST(req);

    expect(res.status).toBe(200);
    // writeCsvImportAuditLog uses sql (not sql.begin) for the INSERT.
    // We verify that sql was called at least once for the audit log.
    // The first sql calls are from getAccountById, then the audit log insert.
    expect(mockSql).toHaveBeenCalled();
    // Verify at least one call was for the audit log (csv_bulk_import event)
    const sqlCalls = mockSql.mock.calls as any[];
    const auditCall = sqlCalls.find((call: any[]) => {
      const raw = call?.[0]?.raw;
      if (raw) return raw.join('').includes('csv_bulk_import');
      return false;
    });
    expect(auditCall).toBeDefined();
  });

  // ── Voice config columns ───────────────────────────────────────────────

  it('writes csv_bulk_import audit log even when aggregate billing enqueue fails', async () => {
    setupHappyPathRow();
    mockAssertCanAddLocation.mockResolvedValue({ allowed: true, overageUnits: 1 });
    mockGetActiveLocationCount.mockResolvedValue(1);
    mockSql.mockImplementation((strings: TemplateStringsArray, ...values: unknown[]) => {
      const text = strings.raw.join('');
      if (text.includes('INSERT INTO job_outbox') && values.includes('update_stripe_overage_quantity')) {
        throw new Error('outbox unavailable');
      }
      return Promise.resolve([]);
    });

    const csv = `name,placeId
Downtown Cafe,ChIJ1234`;

    const req = mkCsvRequest(csv);
    const res = await POST(req);

    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body.error).toContain('Failed to enqueue billing update after import');
    expect(body.created).toBe(1);
    expect(body.failedCount).toBe(0);

    const auditCall = mockSql.mock.calls.find((call: any[]) => {
      const raw = call?.[0]?.raw;
      if (raw) return raw.join('').includes('csv_bulk_import');
      return false;
    });
    expect(auditCall).toBeDefined();
  });

  it('passes voice config columns from CSV to addLocationTransaction', async () => {
    mockGetAccountById.mockResolvedValue(mockAccountRow());
    setupHappyPathRow();
    mockAssertCanAddLocation.mockResolvedValue({ allowed: true, overageUnits: 1 });
    mockGetActiveLocationCount.mockResolvedValue(1);

    const csv = `name,placeId,tone,productsServices,avoidFacts
Downtown Cafe,ChIJ1234,friendly,"Coffee and pastries","Bad coffee|Overpriced"`;

    const req = mkCsvRequest(csv);
    const res = await POST(req);

    expect(res.status).toBe(200);
    expect(mockAddLocationTransaction).toHaveBeenCalledTimes(1);
    const txInput = mockAddLocationTransaction.mock.calls[0]![0];
    expect(txInput.voiceConfig).toBeDefined();
    expect(txInput.voiceConfig.tone).toBe('friendly');
    expect(txInput.voiceConfig.productsServices).toBe('Coffee and pastries');
    expect(txInput.voiceConfig.avoidFacts).toEqual(['Bad coffee', 'Overpriced']);
  });

  // ── Account not found ───────────────────────────────────────────────────

  it('returns 404 when accountId does not match any account', async () => {
    mockGetAccountById.mockResolvedValue(null);
    mockGetAccountOwnerUser.mockResolvedValue(null);
    mockGetAccountOwnerUserId.mockResolvedValue(null);

    const csv = 'name,placeId\nTest,ChIJ1234';
    const req = mkCsvRequest(csv, '00000000-0000-0000-0000-000000000000');
    const res = await POST(req);

    expect(res.status).toBe(404);
  });

  // ── Empty CSV (no data rows, header only) ──────────────────────────────

  it('returns 200 with 0 created, 0 failed for header-only CSV', async () => {
    mockGetAccountById.mockResolvedValue(mockAccountRow());
    const csv = 'name,placeId';
    const req = mkCsvRequest(csv);
    const res = await POST(req);

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.created).toBe(0);
    expect(body.failed.length).toBe(0);
  });

  // ── All rows fail ──────────────────────────────────────────────────────

  it('returns 200 with 0 created and all failures when all rows invalid', async () => {
    mockGetAccountById.mockResolvedValue(mockAccountRow());
    const csv = `name,placeId
,
,
,ChIJ1234`;
    const req = mkCsvRequest(csv);
    const res = await POST(req);

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.created).toBe(0);
    expect(body.failed.length).toBe(3);
  });

  // ── Quota rejection for a row ──────────────────────────────────────────

  it('reports subscription_inactive when assertCanAddLocation rejects a row', async () => {
    mockGetAccountById.mockResolvedValue(mockAccountRow());
    setupHappyPathRow();
    mockAssertCanAddLocation
      .mockResolvedValueOnce({ allowed: true, overageUnits: 1 })
      .mockResolvedValueOnce({ allowed: false, reason: 'subscription_inactive' });

    const csv = `name,placeId
Downtown Cafe,ChIJ1234
Bad Account Loc,ChIJ5678`;

    const req = mkCsvRequest(csv);
    const res = await POST(req);

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.created).toBe(1);
    expect(body.failed.length).toBe(1);
    expect(body.failed[0].reason).toContain('subscription_inactive');
  });

  // ── In-file duplicate place ids (Task C3, Change B) ───────────────────

  it('rejects the later occurrence of an in-file duplicate placeId without processing it', async () => {
    mockGetAccountById.mockResolvedValue(mockAccountRow());
    setupHappyPathRow();
    mockAssertCanAddLocation.mockResolvedValue({ allowed: true, overageUnits: 1 });
    mockGetActiveLocationCount.mockResolvedValue(1);

    const csv = `name,placeId
Downtown Cafe,ChIJsame
Westside Grill,ChIJother
Duplicate Cafe,ChIJsame`;

    const req = mkCsvRequest(csv);
    const res = await POST(req);

    expect(res.status).toBe(200);
    const body = await res.json();
    // First occurrence + the unique row succeed; the later duplicate fails.
    expect(body.created).toBe(2);
    expect(body.failed.length).toBe(1);
    expect(body.failed[0].row).toBe(3);
    expect(body.failed[0].reason).toBe('duplicate_location_in_file');
    // The later duplicate must NOT reach the add-location transaction.
    expect(mockAddLocationTransaction).toHaveBeenCalledTimes(2);
    for (const [input] of mockAddLocationTransaction.mock.calls) {
      expect(input.googlePlaceId).not.toBe(undefined);
    }
  });

  // Poisoning regression: only SUCCESSFULLY IMPORTED rows claim a place id.
  // A first occurrence that fails validation must not block a corrected later
  // row with the same place id (the admin's fix-and-keep-both-rows pattern).
  it('imports a later row whose placeId matched an earlier VALIDATION-FAILED row', async () => {
    mockGetAccountById.mockResolvedValue(mockAccountRow());
    setupHappyPathRow();
    mockAssertCanAddLocation.mockResolvedValue({ allowed: true, overageUnits: 1 });
    mockGetActiveLocationCount.mockResolvedValue(1);

    // Row 1: same placeId but missing name → validation failure (never imported).
    // Row 2: corrected row with the same placeId → must import.
    const csv = `name,placeId
,ChIJpoisoned
Fixed Cafe,ChIJpoisoned`;

    const req = mkCsvRequest(csv);
    const res = await POST(req);

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.created).toBe(1);
    expect(body.failed.length).toBe(1);
    expect(body.failed[0].row).toBe(1);
    expect(body.failed[0].reason).toContain('name');
    // The corrected row reached the transaction — it was NOT rejected as an
    // in-file duplicate of the failed first occurrence.
    expect(mockAddLocationTransaction).toHaveBeenCalledTimes(1);
    expect(mockAddLocationTransaction.mock.calls[0]![0].googlePlaceId).toBe('ChIJpoisoned');
  });

  it('attempts a later identical row when the first occurrence failed inside processRow', async () => {
    mockGetAccountById.mockResolvedValue(mockAccountRow());
    setupHappyPathRow();
    mockAssertCanAddLocation.mockResolvedValue({ allowed: true, overageUnits: 1 });
    mockGetActiveLocationCount.mockResolvedValue(1);

    // Row 1's transaction fails (transient DB error) → the place id is NOT
    // claimed; row 2 with the identical place id must be ATTEMPTED, not
    // rejected as duplicate_location_in_file.
    mockAddLocationTransaction
      .mockRejectedValueOnce(new Error('connection reset'))
      .mockResolvedValueOnce({
        businessId: 'new-biz-retry',
        displayLabel: 'Retry Cafe',
        voiceClonedFromPrimary: true,
      });

    const csv = `name,placeId
Retry Cafe,ChIJretry
Retry Cafe,ChIJretry`;

    const req = mkCsvRequest(csv);
    const res = await POST(req);

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.created).toBe(1);
    expect(body.failed.length).toBe(1);
    expect(body.failed[0].row).toBe(1);
    expect(body.failed[0].reason).toContain('Transaction error');
    expect(body.failed[0].reason).not.toBe('duplicate_location_in_file');
    // Both rows reached the transaction.
    expect(mockAddLocationTransaction).toHaveBeenCalledTimes(2);
  });

  it('reports a DB-level duplicate row as duplicate_location', async () => {
    mockGetAccountById.mockResolvedValue(mockAccountRow());
    setupHappyPathRow();
    mockAssertCanAddLocation.mockResolvedValue({ allowed: true, overageUnits: 1 });
    mockGetActiveLocationCount.mockResolvedValue(1);

    mockAddLocationTransaction
      .mockResolvedValueOnce({
        businessId: 'new-biz-1',
        displayLabel: 'Downtown Cafe',
        voiceClonedFromPrimary: true,
      })
      // C1: addLocationTransaction re-throws a plain Error('duplicate_location').
      .mockRejectedValueOnce(new Error('duplicate_location'));

    const csv = `name,placeId
Downtown Cafe,ChIJ1234
Existing Elsewhere,ChIJ5678`;

    const req = mkCsvRequest(csv);
    const res = await POST(req);

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.created).toBe(1);
    expect(body.failed.length).toBe(1);
    expect(body.failed[0].row).toBe(2);
    expect(body.failed[0].reason).toBe('duplicate_location');
  });

  // ── Transaction failure for a single row doesn't block others ─────────

  it('continues processing when addLocationTransaction throws for one row', async () => {
    mockAssertCanAddLocation.mockResolvedValue({ allowed: true, overageUnits: 1 });
    mockGetActiveLocationCount.mockResolvedValue(1);
    mockGetAccountById.mockResolvedValue(mockAccountRow());
    mockGetAccountOwnerUser.mockResolvedValue({
      id: 'uuuuuuuu-0000-0000-0000-000000000001',
      name: 'Test Owner',
      email: 'owner@test.com',
    });
    mockGetAccountOwnerUserId.mockResolvedValue('uuuuuuuu-0000-0000-0000-000000000001');

    mockAddLocationTransaction
      .mockResolvedValueOnce({
        businessId: 'new-biz-1',
        displayLabel: 'Downtown Cafe',
        voiceClonedFromPrimary: true,
      })
      .mockRejectedValueOnce(new Error('DB error: unique constraint'))
      .mockResolvedValueOnce({
        businessId: 'new-biz-3',
        displayLabel: 'Westside Grill',
        voiceClonedFromPrimary: true,
      });

    const csv = `name,placeId
Downtown Cafe,ChIJ1234
Bad Row,ChIJ5678
Westside Grill,ChIJ9012`;

    const req = mkCsvRequest(csv);
    const res = await POST(req);

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.created).toBe(2);
    expect(body.failed.length).toBe(1);
    expect(body.failed[0].reason).toContain('DB error');
  });
});
