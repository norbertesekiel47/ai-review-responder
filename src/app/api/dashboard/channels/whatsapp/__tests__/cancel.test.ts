import { describe, it, expect, vi, beforeEach } from 'vitest';

const { sqlQueue, consume } = vi.hoisted(() => {
  const q: unknown[] = [];
  const c = async () => (Array.isArray(q[0]) ? q.shift() : (q.shift(), []));
  return { sqlQueue: q, consume: c };
});
vi.mock('@/lib/db/server', () => ({
  sql: Object.assign(consume, { begin: async (fn: (tx: unknown) => Promise<unknown>) => fn(consume) }),
  jsonb: (v: unknown) => v,
}));
const requireRoleMock = vi.fn(async () => ({ userId: 'owner-1', role: 'owner', locationId: 'biz-1' }));
vi.mock('@/lib/db/auth', () => ({
  requireRole: (...a: unknown[]) => requireRoleMock(...(a as [])),
  AuthError: class extends Error { statusCode = 401; },
}));
vi.mock('@/lib/auth/route-helpers', () => ({ withSameOrigin: () => (h: unknown) => h }));
vi.mock('@/lib/notifications/resolve-channels', () => ({ safeInvalidateChannelCache: vi.fn(async () => {}) }));

import { POST } from '../cancel/route';

function mkReq() {
  return new Request('http://localhost/api/dashboard/channels/whatsapp/cancel', {
    method: 'POST', body: JSON.stringify({}), headers: { 'Content-Type': 'application/json', Origin: 'http://localhost' },
  });
}

beforeEach(() => {
  sqlQueue.length = 0;
  requireRoleMock.mockResolvedValue({ userId: 'owner-1', role: 'owner', locationId: 'biz-1' });
  process.env.MOCK_EXTERNAL_APIS = 'true';
  delete process.env.CHANNELS_WHATSAPP_ENABLED;
});

describe('POST /api/dashboard/channels/whatsapp/cancel', () => {
  it('404 when flag off', async () => {
    expect((await POST(mkReq() as any)).status).toBe(404);
  });

  it('200 ok on cancel of active subscription', async () => {
    process.env.CHANNELS_WHATSAPP_ENABLED = 'true';
    sqlQueue.push([{ id: 'acct-1', subscription_status: 'active' }]); // accounts lookup
    sqlQueue.push([]);                                                 // advisory lock
    sqlQueue.push([{ id: 'e1' }]);                                     // cancel UPDATE RETURNING
    const res = await POST(mkReq() as any);
    expect(res.status).toBe(200);
    expect((await res.json()).ok).toBe(true);
  });
});
