import { NextRequest, NextResponse } from 'next/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { gate, disconnect, publishingEnabled, sql } = vi.hoisted(() => ({
  gate: vi.fn(), disconnect: vi.fn(), publishingEnabled: vi.fn(), sql: {},
}));
vi.mock('@/lib/auth/admin-mfa-gate', () => ({
  requireAdminWithAal2: gate,
  internalError: () => NextResponse.json({ error: 'internal_error' }, {
    status: 500, headers: { 'Cache-Control': 'no-store, private' },
  }),
}));
vi.mock('@/lib/db/server', () => ({ sql }));
vi.mock('@/lib/publishing/flags', () => ({ zernioPublishingEnabled: publishingEnabled }));
vi.mock('@/lib/zernio/disconnect', () => ({ disconnectZernioConnection: disconnect }));

import { POST } from '../route';

const businessId = '11111111-1111-4111-8111-111111111111';
const context = (id = businessId) => ({ params: Promise.resolve({ id }) });
function request(headers: Record<string, string> = { authorization: 'Bearer fixture-token' }) {
  return new NextRequest(`https://staging.repworth.net/api/admin/businesses/${businessId}/disconnect`, {
    method: 'POST', headers,
  });
}

describe('Admin business Disconnect transport', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    vi.stubEnv('NEXT_PUBLIC_APP_URL', 'https://staging.repworth.net');
    gate.mockResolvedValue({ ok: true, user: { role: 'admin' } });
    publishingEnabled.mockReturnValue(true);
    disconnect.mockResolvedValue({ status: 200, body: { ok: true } });
  });
  afterEach(() => vi.unstubAllEnvs());

  it('accepts bearer transport only after the canonical gate and uses the route target', async () => {
    const req = request();
    const res = await POST(req, context());
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
    expect(res.headers.get('cache-control')).toContain('no-store');
    expect(gate).toHaveBeenCalledExactlyOnceWith(req);
    expect(disconnect).toHaveBeenCalledExactlyOnceWith(sql, businessId, 'admin');
    expect(gate.mock.invocationCallOrder[0]).toBeLessThan(disconnect.mock.invocationCallOrder[0] ?? -1);
  });

  it.each([401, 403])('returns the exact canonical %i refusal before any operation', async (status) => {
    const refusal = NextResponse.json({ error: status === 403 ? 'mfa_required' : 'Unauthorized' }, { status });
    gate.mockResolvedValueOnce({ ok: false, response: refusal });
    expect(await POST(request(), context())).toBe(refusal);
    expect(publishingEnabled).not.toHaveBeenCalled();
    expect(disconnect).not.toHaveBeenCalled();
  });

  it.each<Record<string, string>>([
    { authorization: 'Bearer ', cookie: 'admin-session=fixture' },
    { origin: 'https://staging.repworth.net', cookie: 'admin-session=fixture' },
  ])('passes rejected credentials to the canonical gate before any operation', async (headers) => {
    // Composition proof; the real SDK seam owns credential validation.
    const refusal = NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    gate.mockResolvedValueOnce({ ok: false, response: refusal });
    const req = request(headers);
    expect(await POST(req, context())).toBe(refusal);
    expect(gate).toHaveBeenCalledExactlyOnceWith(req);
    expect(publishingEnabled).not.toHaveBeenCalled();
    expect(disconnect).not.toHaveBeenCalled();
  });

  it('retains the publishing flag refusal without a database or provider operation', async () => {
    publishingEnabled.mockReturnValue(false);
    const res = await POST(request(), context());
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ error: 'feature_disabled' });
    expect(disconnect).not.toHaveBeenCalled();
  });

  it('rejects malformed route IDs before the operation', async () => {
    const res = await POST(request(), context('not-a-uuid'));
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: 'invalid_business_id' });
    expect(disconnect).not.toHaveBeenCalled();
  });

  it.each([
    { status: 403, body: { error: 'account_offboarding_blocked' } },
    { status: 404, body: { error: 'no_active_connection' } },
    { status: 200, body: { ok: true, note: 'connection_already_disconnected' } },
  ])('preserves the shared operation outcome $status $body', async (result) => {
    disconnect.mockResolvedValueOnce(result);
    const res = await POST(request(), context());
    expect(res.status).toBe(result.status);
    expect(await res.json()).toEqual(result.body);
    expect(res.headers.get('cache-control')).toContain('no-store');
  });

  it('maps unexpected failures to the canonical internal-error response', async () => {
    disconnect.mockRejectedValueOnce(new Error('database unavailable'));
    const res = await POST(request(), context());
    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ error: 'internal_error' });
  });
});
