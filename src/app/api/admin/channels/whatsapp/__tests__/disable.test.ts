import { describe, it, expect, vi, beforeEach } from 'vitest';

const sqlQueue: unknown[] = [];
const sqlCalls: Array<{ raw: string; values: unknown[] }> = [];
vi.mock('@/lib/db/server', () => ({
  sql: async (strings: TemplateStringsArray, ...values: unknown[]) => {
    sqlCalls.push({ raw: Array.isArray(strings) ? strings.join('?') : '', values });
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

const APP_URL = 'http://localhost';

function mkReq(body: unknown) {
  return new Request('http://localhost/api/admin/channels/whatsapp/disable', {
    method: 'POST',
    body: JSON.stringify(body),
    headers: { 'Content-Type': 'application/json', Origin: APP_URL },
  });
}

beforeEach(() => {
  sqlQueue.length = 0;
  sqlCalls.length = 0;
  process.env.NEXT_PUBLIC_APP_URL = APP_URL;
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

  it('flips verified → disabled (account-scoped) and returns 200', async () => {
    process.env.CHANNELS_WHATSAPP_ENABLED = 'true';
    sqlQueue.push([{ account_id: 'acct-1' }]); // businesses → account_id lookup
    sqlQueue.push([{ id: 'enrl-1' }]); // disableWhatsAppEnrollment UPDATE RETURNING
    const res = await POST(mkReq({ businessId: 'biz-1' }) as any);
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.ok).toBe(true);

    // Guard: the disable UPDATE must key by account_id (acct-1) + org-default
    // scope, NOT the legacy business_id. Reverting to business_id fails here.
    const disableUpdate = sqlCalls.find(
      (c) => c.raw.includes('UPDATE channel_enrollments') && c.raw.includes("status = 'verified'"),
    );
    expect(disableUpdate).toBeDefined();
    expect(disableUpdate!.raw).toMatch(/account_id = /);
    expect(disableUpdate!.raw).toMatch(/location_id IS NULL/);
    expect(disableUpdate!.raw).not.toMatch(/business_id = /);
    expect(disableUpdate!.values).toContain('acct-1');
  });

  it('returns 404 when no verified row matches', async () => {
    process.env.CHANNELS_WHATSAPP_ENABLED = 'true';
    sqlQueue.push([{ account_id: 'acct-1' }]); // businesses → account_id lookup
    sqlQueue.push([]); // UPDATE matches nothing
    const res = await POST(mkReq({ businessId: 'biz-1' }) as any);
    expect(res.status).toBe(404);
  });

  it('returns 404 when the business does not exist', async () => {
    process.env.CHANNELS_WHATSAPP_ENABLED = 'true';
    sqlQueue.push([]); // businesses → account_id lookup returns nothing
    const res = await POST(mkReq({ businessId: 'biz-1' }) as any);
    expect(res.status).toBe(404);
  });
});
