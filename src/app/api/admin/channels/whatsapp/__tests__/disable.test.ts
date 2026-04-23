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

import { POST } from '../disable/route';

function mkReq(body: unknown) {
  return new Request('http://localhost/api/admin/channels/whatsapp/disable', {
    method: 'POST',
    body: JSON.stringify(body),
    headers: { 'Content-Type': 'application/json' },
  });
}

beforeEach(() => {
  sqlQueue.length = 0;
  delete process.env.CHANNELS_WHATSAPP_ENABLED;
  delete process.env.TWILIO_ACCOUNT_SID;
  delete process.env.TWILIO_AUTH_TOKEN;
  delete process.env.TWILIO_WHATSAPP_NUMBER;
  delete process.env.WHATSAPP_APPROVAL_TEMPLATE_SID;
  delete process.env.WHATSAPP_APPROVAL_URL_BASE;
  process.env.MOCK_EXTERNAL_APIS = 'true';
});

describe('POST /api/admin/channels/whatsapp/disable', () => {
  it('returns 404 when flag is off', async () => {
    const res = await POST(mkReq({ businessId: 'biz-1' }) as any);
    expect(res.status).toBe(404);
  });

  it('flips verified → disabled and returns 200', async () => {
    process.env.CHANNELS_WHATSAPP_ENABLED = 'true';
    sqlQueue.push([{ id: 'enrl-1' }]); // UPDATE RETURNING
    const res = await POST(mkReq({ businessId: 'biz-1' }) as any);
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.ok).toBe(true);
  });

  it('returns 404 when no verified row matches', async () => {
    process.env.CHANNELS_WHATSAPP_ENABLED = 'true';
    sqlQueue.push([]); // UPDATE matches nothing
    const res = await POST(mkReq({ businessId: 'biz-1' }) as any);
    expect(res.status).toBe(404);
  });
});
