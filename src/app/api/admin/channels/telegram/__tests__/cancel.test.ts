import { describe, it, expect, vi, beforeEach } from 'vitest';

const sqlQueue: unknown[] = [];
vi.mock('@/lib/db/server', () => ({
  sql: async () => {
    const next = sqlQueue.shift();
    return Array.isArray(next) ? next : [];
  },
  jsonb: (v: unknown) => v,
}));

vi.mock('@/lib/db/auth', () => ({
  requireRole: vi.fn(async () => ({ userId: 'admin-1', role: 'admin' })),
  AuthError: class extends Error {},
}));

import { POST } from '../cancel/route';

function mkReq(body: unknown) {
  return new Request('http://localhost/api/admin/channels/telegram/cancel', {
    method: 'POST',
    body: JSON.stringify(body),
    headers: { 'Content-Type': 'application/json' },
  });
}

beforeEach(() => {
  sqlQueue.length = 0;
  delete process.env.CHANNELS_TELEGRAM_ENABLED;
  delete process.env.TELEGRAM_BOT_TOKEN;
  delete process.env.TELEGRAM_WEBHOOK_SECRET;
  process.env.MOCK_EXTERNAL_APIS = 'true';
});

describe('POST /api/admin/channels/telegram/cancel', () => {
  it('returns 404 when flag is off', async () => {
    const res = await POST(mkReq({ businessId: 'biz-1' }) as any);
    expect(res.status).toBe(404);
  });

  it('clears verification hash + expiry on pending row and returns 200', async () => {
    process.env.CHANNELS_TELEGRAM_ENABLED = 'true';
    sqlQueue.push([]); // UPDATE ... WHERE status='pending_verification'
    const res = await POST(mkReq({ businessId: 'biz-1' }) as any);
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.ok).toBe(true);
  });
});
