import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NextResponse } from 'next/server';

const requireAdminMock = vi.fn();
vi.mock('@/lib/auth/admin-mfa-gate', () => ({
  requireAdminWithAal2: (...a: unknown[]) => requireAdminMock(...(a as [])),
}));

const requireRoleMock = vi.fn();
vi.mock('@/lib/db/auth', () => ({
  requireRole: (...a: unknown[]) => requireRoleMock(...(a as [])),
  AuthError: class extends Error { statusCode = 401; },
}));

const resolveWritableMock = vi.fn();
vi.mock('@/lib/shared/writable-subscription', () => ({
  resolveWritableAccountForLocation: (...a: unknown[]) => resolveWritableMock(...(a as [])),
}));

// The MOCKED AuthError (from the factory above), not a local look-alike:
// requireRoleOr401 branches on `err instanceof AuthError` and deliberately
// re-throws anything else, so a structurally-identical stub class would surface
// as a 5xx instead of the role-gate response this suite is pinning.
import { AuthError } from '@/lib/db/auth';
import { resolveAdminActor, resolveOwnerActor } from '../resolve-actor';

/** Queue-backed sql double: each push is consumed by the next query, in order. */
function mkSql(rows: unknown[][]) {
  const queue = [...rows];
  const calls: Array<{ raw: string; values: unknown[] }> = [];
  const sql = (strings: TemplateStringsArray, ...values: unknown[]) => {
    calls.push({ raw: strings.join('?'), values });
    return Promise.resolve(queue.shift() ?? []);
  };
  return { sql: sql as never, calls };
}

function mkReq(body: unknown, url = 'http://localhost/api/admin/channels/telegram/start') {
  return new Request(url, {
    method: 'POST',
    body: JSON.stringify(body),
    headers: { 'Content-Type': 'application/json', Origin: 'http://localhost' },
  }) as never;
}

beforeEach(() => {
  requireAdminMock.mockReset();
  requireRoleMock.mockReset();
  resolveWritableMock.mockReset();
  requireAdminMock.mockResolvedValue({ ok: true, admin: { id: 'admin-1' } });
  requireRoleMock.mockResolvedValue({ userId: 'owner-1', id: 'owner-1', role: 'owner', locationId: 'biz-1' });
});

describe('resolveAdminActor', () => {
  it('resolveAdminActor returns the admin gate response when requireAdminWithAal2 fails', async () => {
    const gateResponse = NextResponse.json({ error: 'mfa_required' }, { status: 401 });
    requireAdminMock.mockResolvedValue({ ok: false, response: gateResponse });
    const { sql } = mkSql([]);

    const result = await resolveAdminActor(sql, mkReq({ businessId: 'biz-1' }), { requireFullAccess: true });

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('unreachable');
    expect(result.response).toBe(gateResponse);
  });

  it('resolveAdminActor returns 400 businessId required when the body has no businessId', async () => {
    const { sql } = mkSql([]);

    const result = await resolveAdminActor(sql, mkReq({}), { requireFullAccess: true });

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('unreachable');
    expect(result.response.status).toBe(400);
    expect(await result.response.json()).toEqual({ error: 'businessId required' });
  });

  it('resolveAdminActor returns 404 not_found when the businessId matches no business', async () => {
    const { sql } = mkSql([[]]);

    const result = await resolveAdminActor(sql, mkReq({ businessId: 'nope' }), { requireFullAccess: true });

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('unreachable');
    expect(result.response.status).toBe(404);
    expect(await result.response.json()).toEqual({ error: 'not_found' });
  });

  it('resolveAdminActor returns 403 subscription_not_active when full access is required and the account lacks it', async () => {
    const { sql } = mkSql([[{ id: 'acct-1', subscription_status: 'cancelled' }]]);

    const result = await resolveAdminActor(sql, mkReq({ businessId: 'biz-1' }), { requireFullAccess: true });

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('unreachable');
    expect(result.response.status).toBe(403);
    expect(await result.response.json()).toEqual({ error: 'subscription_not_active' });
  });

  it('resolveAdminActor resolves the account without a subscription gate when full access is not required', async () => {
    const { sql } = mkSql([[{ id: 'acct-1', subscription_status: 'cancelled' }]]);

    const result = await resolveAdminActor(sql, mkReq({ businessId: 'biz-1' }), { requireFullAccess: false });

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('unreachable');
    expect(result.actor).toEqual({
      businessId: 'biz-1',
      accountId: 'acct-1',
      actorUserId: 'admin-1',
      surface: 'admin',
    });
  });

  it('resolveAdminActor reads businessId from the body and never from the session', async () => {
    requireAdminMock.mockResolvedValue({ ok: true, admin: { id: 'admin-1', locationId: 'session-biz' } });
    const { sql, calls } = mkSql([[{ id: 'acct-1', subscription_status: 'active' }]]);

    const result = await resolveAdminActor(sql, mkReq({ businessId: 'body-biz' }), { requireFullAccess: true });

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('unreachable');
    expect(result.actor.businessId).toBe('body-biz');
    expect(calls[0]!.values).toContain('body-biz');
    expect(calls[0]!.values).not.toContain('session-biz');
  });
});

describe('resolveOwnerActor', () => {
  it('resolveOwnerActor returns the role gate response when requireRoleOr401 fails', async () => {
    requireRoleMock.mockRejectedValue(new AuthError('Unauthorized', 401));
    const { sql } = mkSql([]);

    const result = await resolveOwnerActor(sql, mkReq({}));

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('unreachable');
    expect(result.response.status).toBe(401);
  });

  it('resolveOwnerActor returns 403 no_business when the session carries no locationId', async () => {
    requireRoleMock.mockResolvedValue({ userId: 'owner-1', id: 'owner-1', role: 'owner', locationId: null });
    const { sql, calls } = mkSql([]);

    const result = await resolveOwnerActor(sql, mkReq({}));

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('unreachable');
    expect(result.response.status).toBe(403);
    expect(await result.response.json()).toEqual({ error: 'no_business' });
    expect(calls).toHaveLength(0);
    expect(resolveWritableMock).not.toHaveBeenCalled();
  });

  it('resolveOwnerActor returns 404 not_found when the location has no billing account', async () => {
    resolveWritableMock.mockResolvedValue({ kind: 'no_account' });
    const { sql } = mkSql([]);

    const result = await resolveOwnerActor(sql, mkReq({}));

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('unreachable');
    expect(result.response.status).toBe(404);
    expect(await result.response.json()).toEqual({ error: 'not_found' });
  });

  it('resolveOwnerActor surfaces a blocked subscription verbatim with its own status', async () => {
    resolveWritableMock.mockResolvedValue({ kind: 'blocked', status: 402, error: 'past_due_read_only' });
    const { sql } = mkSql([]);

    const result = await resolveOwnerActor(sql, mkReq({}));

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('unreachable');
    expect(result.response.status).toBe(402);
    expect(await result.response.json()).toEqual({ error: 'past_due_read_only' });
  });

  it('resolveOwnerActor reads locationId from the session and never from the body', async () => {
    requireRoleMock.mockResolvedValue({ userId: 'owner-1', id: 'owner-1', role: 'owner', locationId: 'session-biz' });
    resolveWritableMock.mockResolvedValue({ kind: 'ok', accountId: 'acct-1' });
    const { sql } = mkSql([]);

    const result = await resolveOwnerActor(sql, mkReq({ businessId: 'body-biz', locationId: 'body-biz' }));

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('unreachable');
    expect(result.actor).toEqual({
      businessId: 'session-biz',
      accountId: 'acct-1',
      actorUserId: 'owner-1',
      surface: 'dashboard',
    });
    expect(resolveWritableMock).toHaveBeenCalledWith('session-biz', expect.anything());
  });
});
