import { describe, it, expect, vi, beforeEach } from 'vitest';

const { mockSql, sqlReturnQueue, resetMockSql } = await vi.hoisted(async () => {
  const { createMockSql } = await import('../../../../../../../worker/__tests__/helpers/mock-sql');
  return { ...createMockSql() };
});
// The route delegates to disconnectChannel, which opens sql.begin; the mock tx
// shares the same tagged-template fn so every UPDATE/audit INSERT pulls from
// sqlReturnQueue in order.
vi.mock('@/lib/db/server', () => ({ sql: mockSql, jsonb: (v: unknown) => v }));

vi.mock('@/lib/db/auth', () => ({
  requireRole: vi.fn(async () => ({ id: 'admin-1', role: 'admin' })),
  AuthError: class extends Error {},
}));

vi.mock('@/lib/db/redis-cache', () => ({
  getCacheRedis: () => ({
    keys: vi.fn(async () => []),
    del: vi.fn(async () => 0),
  }),
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
  resetMockSql();
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
    sqlReturnQueue.push([{ account_id: 'acct-1' }]); // businesses → account_id lookup
    sqlReturnQueue.push([{ id: 'enrl-1' }]); // org-default UPDATE RETURNING
    sqlReturnQueue.push([]); // override cascade UPDATE
    const res = await POST(mkReq({ businessId: 'biz-1' }) as any);
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.ok).toBe(true);
  });

  it('returns 404 when no verified row and no live override matches', async () => {
    process.env.CHANNELS_TELEGRAM_ENABLED = 'true';
    sqlReturnQueue.push([{ account_id: 'acct-1' }]); // businesses → account_id lookup
    sqlReturnQueue.push([]); // org-default UPDATE matches nothing
    sqlReturnQueue.push([]); // override cascade UPDATE matches nothing
    const res = await POST(mkReq({ businessId: 'biz-1' }) as any);
    expect(res.status).toBe(404);
  });

  it('returns 404 when the business does not exist', async () => {
    process.env.CHANNELS_TELEGRAM_ENABLED = 'true';
    sqlReturnQueue.push([]); // businesses → account_id lookup returns nothing
    const res = await POST(mkReq({ businessId: 'biz-1' }) as any);
    expect(res.status).toBe(404);
  });
});
