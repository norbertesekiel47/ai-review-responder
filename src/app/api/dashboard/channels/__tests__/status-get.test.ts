import { describe, it, expect, vi, beforeEach } from 'vitest';

const { sqlQueue, sqlCalls, mockSql } = vi.hoisted(() => {
  const sqlQueue: unknown[] = [];
  const sqlCalls: Array<{ raw: string; values: unknown[] }> = [];
  const mockSql = (strings: TemplateStringsArray, ...values: unknown[]) => {
    sqlCalls.push({ raw: strings.join('?'), values });
    const next = sqlQueue.shift();
    return Promise.resolve(Array.isArray(next) ? next : []);
  };
  return { sqlQueue, sqlCalls, mockSql };
});
vi.mock('@/lib/db/server', () => ({ sql: mockSql, jsonb: (v: unknown) => v }));
const requireRoleMock = vi.fn();
vi.mock('@/lib/db/auth', () => ({
  requireRole: (...a: unknown[]) => requireRoleMock(...(a as [])),
  AuthError: class extends Error { statusCode = 401; },
}));

import { GET } from '../route';

beforeEach(() => {
  sqlQueue.length = 0;
  sqlCalls.length = 0;
  requireRoleMock.mockResolvedValue({ userId: 'o1', role: 'owner', locationId: 'L2', accountId: 'acct-1' });
  process.env.NEXT_PUBLIC_APP_URL = 'http://localhost';
});

describe('GET /api/dashboard/channels — account-scoped read', () => {
  it('reads enrollments by account_id + location_id IS NULL (requester at L2, org-default created under L1)', async () => {
    sqlQueue.push([{ id: 'acct-1', subscription_status: 'active' }]); // accounts lookup
    sqlQueue.push([{ channel: 'telegram', handle: '@x', status: 'verified', verified_at: null, disabled_at: null, unsubscribed_at: null, unsubscribed_reason: null, expires_at: null }]); // enrollment rows
    const res = await GET(new Request('http://localhost/api/dashboard/channels') as any);
    expect(res.status).toBe(200);
    const enrollQuery = sqlCalls.find((c) => c.raw.includes('FROM channel_enrollments'));
    expect(enrollQuery).toBeDefined();
    expect(enrollQuery!.raw).toMatch(/account_id = /);
    expect(enrollQuery!.raw).toMatch(/location_id IS NULL/);
    expect(enrollQuery!.raw).not.toMatch(/business_id = /);
    expect(enrollQuery!.values).toContain('acct-1');
    expect(enrollQuery!.values).not.toContain('L2');
  });
});
