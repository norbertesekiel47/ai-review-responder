// src/app/api/locations/__tests__/add.test.ts
//
// TDD assertions for POST /api/locations/add.
// Validation contract: VAL-BILLING-072.

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
    subscription_tier: 'standard',
    subscription_status: 'active',
    locations_included: 1,
    locations_paid: 0,
    ...overrides,
  };
}

beforeEach(() => {
  mockSql.mockReset();
  mockSql.mockResolvedValue([]);
  mockSql.begin = vi.fn(async (cb: (tx: any) => Promise<unknown>) => cb(mockSql));
});

// ── Tests ──────────────────────────────────────────────────────────────────

describe('POST /api/locations/add', () => {
  // VAL-BILLING-072: Add-location endpoint uses outbox worker for active accounts
  it('returns 404 when MULTI_LOCATION_ENABLED is not true', async () => {
    process.env.MULTI_LOCATION_ENABLED = 'false';
    const req = mkRequest({
      accountId: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
      displayLabel: 'Downtown Cafe',
    });
    const res = await POST(req);
    expect(res.status).toBe(404);
    process.env.MULTI_LOCATION_ENABLED = 'true';
  });

  it('creates location and enqueues outbox job for active account', async () => {
    const accountId = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
    mockSql.mockResolvedValueOnce([mockAccountRow()]); // account lookup
    mockSql.mockResolvedValueOnce([{ count: 1 }]); // location count
    // Inside tx: businesses INSERT, audit_log INSERT, outbox INSERT
    // These all use the tx (mockSql) so no separate mock needed

    const req = mkRequest({
      accountId,
      displayLabel: 'Downtown Cafe',
    });
    const res = await POST(req);
    const body = await res.json();

    expect(res.status).toBe(201);
    expect(body.displayLabel).toBe('Downtown Cafe');
    expect(body.activeLocations).toBe(2); // 1 + 1

    // Verify the tx was called (businesses + audit + outbox INSERTs)
    expect(mockSql.begin).toHaveBeenCalled();
    const txCalls = mockSql.mock.calls;
    const insertCalls = txCalls.filter(
      (c: any[]) => (c[0] as TemplateStringsArray).join('?').includes('INSERT INTO'),
    );
    // Should have 3 INSERT calls (businesses, audit_log, outbox)
    expect(insertCalls.length).toBeGreaterThanOrEqual(3);
  });

  it('returns 403 for inactive subscription', async () => {
    const accountId = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
    mockSql.mockResolvedValueOnce([mockAccountRow({ subscription_status: 'pending_payment' })]);

    const req = mkRequest({
      accountId,
      displayLabel: 'Downtown Cafe',
    });
    const res = await POST(req);

    expect(res.status).toBe(403);
  });

  it('returns 403 for basic tier (no multi-location allowed)', async () => {
    const accountId = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
    mockSql.mockResolvedValueOnce([mockAccountRow({ subscription_tier: 'basic' })]);

    const req = mkRequest({
      accountId,
      displayLabel: 'Downtown Cafe',
    });
    const res = await POST(req);

    expect(res.status).toBe(403);
  });

  it('returns 404 when account not found', async () => {
    const accountId = '00000000-0000-7f00-8000-000000000000';
    mockSql.mockResolvedValueOnce([]); // no account

    const req = mkRequest({
      accountId,
      displayLabel: 'Downtown Cafe',
    });
    const res = await POST(req);

    expect(res.status).toBe(404);
  });

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

  it('enqueues update_stripe_overage_quantity outbox job (no Checkout redirect)', async () => {
    const accountId = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
    mockSql.mockResolvedValueOnce([mockAccountRow()]);
    mockSql.mockResolvedValueOnce([{ count: 1 }]);

    const req = mkRequest({
      accountId,
      displayLabel: 'Westside Bakery',
    });
    const res = await POST(req);

    expect(res.status).toBe(201);
    // Verify the outbox INSERT uses the correct topic
    const outboxCall = mockSql.mock.calls.find(
      (c: any[]) => (c[0] as TemplateStringsArray).join('?').includes('INSERT INTO job_outbox'),
    );
    expect(outboxCall).toBeDefined();
    const outboxTemplate = (outboxCall![0] as TemplateStringsArray).join('?');
    expect(outboxTemplate).toContain('update_stripe_overage_quantity');
  });
});
