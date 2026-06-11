import { describe, it, expect, vi, beforeEach } from 'vitest';

const { sqlQueue, consume } = vi.hoisted(() => {
  const q: unknown[] = [];
  const c = async () => {
    const next = q.shift();
    return Array.isArray(next) ? next : [];
  };
  return { sqlQueue: q, consume: c };
});
vi.mock('@/lib/db/server', () => ({
  // The disable route now wraps the cascade in sql.begin; the tx shares the
  // same queued-result tagged-template fn so every UPDATE/audit INSERT pulls
  // from sqlQueue in order.
  sql: Object.assign(consume, { begin: async (fn: (tx: unknown) => Promise<unknown>) => fn(consume) }),
  jsonb: (v: unknown) => v,
}));

vi.mock('@/lib/db/auth', () => ({
  requireRole: vi.fn(async () => ({ id: 'admin-1', role: 'admin' })),
  AuthError: class extends Error {},
}));

import { POST } from '../disable/route';

const APP_URL = 'http://localhost';

function mkReq(body: unknown) {
  return new Request('http://localhost/api/admin/channels/telegram/disable', {
    method: 'POST',
    body: JSON.stringify(body),
    headers: { 'Content-Type': 'application/json', Origin: APP_URL },
  });
}

beforeEach(() => {
  sqlQueue.length = 0;
  process.env.NEXT_PUBLIC_APP_URL = APP_URL;
  delete process.env.CHANNELS_TELEGRAM_ENABLED;
  delete process.env.TELEGRAM_BOT_TOKEN;
  delete process.env.TELEGRAM_WEBHOOK_SECRET;
  process.env.MOCK_EXTERNAL_APIS = 'true';
});

describe('POST /api/admin/channels/telegram/disable', () => {
  it('returns 404 when flag is off', async () => {
    const res = await POST(mkReq({ businessId: 'biz-1' }) as any);
    expect(res.status).toBe(404);
  });

  it('flips verified → disabled and returns 200', async () => {
    process.env.CHANNELS_TELEGRAM_ENABLED = 'true';
    sqlQueue.push([{ account_id: 'acct-1' }]); // businesses → account_id lookup
    sqlQueue.push([{ id: 'enrl-1' }]); // UPDATE RETURNING
    const res = await POST(mkReq({ businessId: 'biz-1' }) as any);
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.ok).toBe(true);
  });

  it('returns 404 when no verified row matches', async () => {
    process.env.CHANNELS_TELEGRAM_ENABLED = 'true';
    sqlQueue.push([{ account_id: 'acct-1' }]); // businesses → account_id lookup
    sqlQueue.push([]); // UPDATE matches nothing
    const res = await POST(mkReq({ businessId: 'biz-1' }) as any);
    expect(res.status).toBe(404);
  });

  it('returns 404 when the business does not exist', async () => {
    process.env.CHANNELS_TELEGRAM_ENABLED = 'true';
    sqlQueue.push([]); // businesses → account_id lookup returns nothing
    const res = await POST(mkReq({ businessId: 'biz-1' }) as any);
    expect(res.status).toBe(404);
  });
});
