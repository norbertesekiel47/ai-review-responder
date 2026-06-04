import { describe, it, expect, vi, beforeEach } from 'vitest';

const { sqlQueue, sqlCalls, mockSql } = vi.hoisted(() => {
  const sqlQueue: unknown[] = [];
  const sqlCalls: Array<{ raw: string; values: unknown[] }> = [];
  const mockSql = Object.assign(
    (strings: TemplateStringsArray, ...values: unknown[]) => {
      sqlCalls.push({ raw: strings.join('?'), values });
      const next = sqlQueue.shift();
      return Promise.resolve(Array.isArray(next) ? next : []);
    },
    {
      begin: async (fn: (tx: unknown) => Promise<unknown>) => fn(
        Object.assign(
          (strings: TemplateStringsArray, ...values: unknown[]) => {
            sqlCalls.push({ raw: strings.join('?'), values });
            const next = sqlQueue.shift();
            return Promise.resolve(Array.isArray(next) ? next : []);
          },
          { begin: undefined },
        ),
      ),
    },
  );
  return { sqlQueue, sqlCalls, mockSql };
});
vi.mock('@/lib/db/server', () => ({ sql: mockSql, jsonb: (v: unknown) => v }));
const requireRoleMock = vi.fn();
vi.mock('@/lib/db/auth', () => ({
  requireRole: (...a: unknown[]) => requireRoleMock(...(a as [])),
  AuthError: class extends Error { statusCode = 401; },
}));
vi.mock('@/lib/auth/route-helpers', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/auth/route-helpers')>();
  return { ...actual, withSameOrigin: () => (h: unknown) => h };
});
vi.mock('@/lib/notifications/resolve-channels', () => ({ safeInvalidateChannelCache: vi.fn(async () => {}) }));

import { POST } from '../disable/route';

function mkReq() {
  return new Request('http://localhost/api/dashboard/channels/telegram/disable', {
    method: 'POST',
    body: JSON.stringify({}),
    headers: { 'Content-Type': 'application/json', Origin: 'http://localhost' },
  });
}

beforeEach(() => {
  sqlQueue.length = 0;
  sqlCalls.length = 0;
  // Requester is at location L2; the org-default enrollment row was created
  // under L1. The route must key by account_id, not locationId.
  requireRoleMock.mockResolvedValue({ userId: 'owner-1', role: 'owner', locationId: 'L2', accountId: 'acct-1' });
  process.env.MOCK_EXTERNAL_APIS = 'true';
  delete process.env.CHANNELS_TELEGRAM_ENABLED;
});

describe('POST /api/dashboard/channels/telegram/disable', () => {
  it('404 when flag off', async () => {
    expect((await POST(mkReq() as any)).status).toBe(404);
  });

  it('404 when no verified row to disable', async () => {
    process.env.CHANNELS_TELEGRAM_ENABLED = 'true';
    sqlQueue.push([{ id: 'acct-1', subscription_status: 'active' }]); // accounts lookup
    sqlQueue.push([]);                                                  // disableTelegramEnrollment UPDATE → no rows
    const res = await POST(mkReq() as any);
    expect(res.status).toBe(404);
  });

  it('200 ok when a verified row is disabled', async () => {
    process.env.CHANNELS_TELEGRAM_ENABLED = 'true';
    sqlQueue.push([{ id: 'acct-1', subscription_status: 'active' }]); // accounts lookup
    sqlQueue.push([{ id: 'e1' }]);                                      // disableTelegramEnrollment UPDATE RETURNING
    const res = await POST(mkReq() as any);
    expect(res.status).toBe(200);
    expect((await res.json()).ok).toBe(true);
  });

  it('disables by account_id + location_id IS NULL, NOT by locationId (cross-location regression)', async () => {
    // Requester is at L2; the enrollment was created under L1 (business_id = L1).
    // The UPDATE predicate must use account_id = acct-1 and location_id IS NULL,
    // never business_id = L2.
    process.env.CHANNELS_TELEGRAM_ENABLED = 'true';
    sqlQueue.push([{ id: 'acct-1', subscription_status: 'active' }]); // accounts lookup
    sqlQueue.push([{ id: 'e1' }]);                                      // disableTelegramEnrollment UPDATE RETURNING
    await POST(mkReq() as any);

    const disableQuery = sqlCalls.find(
      (c) => c.raw.includes('UPDATE channel_enrollments') || c.raw.includes('channel_enrollments'),
    );
    expect(disableQuery).toBeDefined();
    expect(disableQuery!.raw).toMatch(/account_id = /);
    expect(disableQuery!.raw).toMatch(/location_id IS NULL/);
    expect(disableQuery!.raw).not.toMatch(/business_id = /);
    // Must key by account id, never the requester's location id (L2)
    expect(disableQuery!.values).toContain('acct-1');
    expect(disableQuery!.values).not.toContain('L2');
  });
});
