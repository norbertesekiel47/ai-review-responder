import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createHmac } from 'node:crypto';

const { sqlReturnQueue, mockSql, mockSendInternalEmail } = vi.hoisted(() => {
  const sqlReturnQueue: unknown[] = [];
  const mockSql = vi.fn((_s: TemplateStringsArray, ..._v: unknown[]) => {
    const r = sqlReturnQueue.shift() ?? [];
    return Promise.resolve(Array.isArray(r) ? r : [r]);
  });
  return {
    sqlReturnQueue,
    mockSql,
    mockSendInternalEmail: vi.fn().mockResolvedValue({ messageId: 'mock' }),
  };
});

vi.mock('../../../src/lib/db/server', () => ({ sql: mockSql, jsonb: (v: unknown) => v }));
vi.mock('../../../src/lib/notifications/email', () => ({
  sendInternalEmail: (...a: unknown[]) => mockSendInternalEmail(...a),
}));

import { handleResendWebhook } from '../resend';

// Svix secrets are 'whsec_' + base64(rawKeyBytes); the handler base64-decodes
// the part after the prefix and HMACs "${svixId}.${svixTimestamp}.${rawBody}".
const RAW_SECRET = Buffer.from('resend-test-signing-key').toString('base64');
const SECRET = `whsec_${RAW_SECRET}`;

function sign(rawBody: string, svixId: string, svixTimestamp: string): string {
  const secretBytes = Buffer.from(RAW_SECRET, 'base64');
  const content = `${svixId}.${svixTimestamp}.${rawBody}`;
  return createHmac('sha256', secretBytes).update(content).digest('base64');
}
function nowSeconds(): number {
  return Math.floor(Date.now() / 1000);
}

function makeReq(body: unknown, headers: Record<string, string | undefined>): any {
  return { body, headers, rawBody: JSON.stringify(body) };
}
function makeReply() {
  const captured: { status?: number; body?: unknown } = {};
  const reply = {
    status: (code: number) => {
      captured.status = code;
      return reply;
    },
    send: (b: unknown) => {
      captured.body = b;
    },
  } as unknown as import('fastify').FastifyReply;
  return { reply, captured };
}
// Fully-signed request; ageSeconds shifts the timestamp into the past (>0) or future (<0).
function signedReq(body: unknown, opts: { ageSeconds?: number; svixId?: string } = {}) {
  const svixId = opts.svixId ?? 'msg_signed';
  const ts = String(nowSeconds() - (opts.ageSeconds ?? 0));
  const sig = sign(JSON.stringify(body), svixId, ts);
  return makeReq(body, {
    'svix-id': svixId,
    'svix-timestamp': ts,
    'svix-signature': `v1,${sig}`,
  });
}

describe('handleResendWebhook — signature verification (real HMAC)', () => {
  const origSecret = process.env.RESEND_WEBHOOK_SECRET;
  const origMock = process.env.MOCK_EXTERNAL_APIS;

  beforeEach(() => {
    vi.clearAllMocks();
    sqlReturnQueue.length = 0;
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-05-28T12:00:00Z'));
    process.env.RESEND_WEBHOOK_SECRET = SECRET;
    delete process.env.MOCK_EXTERNAL_APIS;
  });
  afterEach(() => {
    vi.useRealTimers();
    if (origSecret === undefined) delete process.env.RESEND_WEBHOOK_SECRET;
    else process.env.RESEND_WEBHOOK_SECRET = origSecret;
    if (origMock === undefined) delete process.env.MOCK_EXTERNAL_APIS;
    else process.env.MOCK_EXTERNAL_APIS = origMock;
  });

  it('accepts a correctly signed request with a fresh timestamp', async () => {
    // postgres.js returns a Result: an array carrying a numeric `.count`.
    sqlReturnQueue.push(Object.assign([] as unknown[], { count: 1 })); // inbound_events INSERT (fresh)
    sqlReturnQueue.push([]); // UPDATE notification_deliveries (delivered)
    sqlReturnQueue.push([]); // UPDATE inbound_events → processed

    const body = { type: 'email.delivered', data: { email_id: 'msg-abc' } };
    const { reply, captured } = makeReply();
    await handleResendWebhook(signedReq(body), reply);

    expect(captured.status).toBe(200);
    expect(captured.body).toEqual({ received: true });
    expect(mockSql).toHaveBeenCalled();
  });

  it('rejects a stale timestamp (older than 300s) before touching the DB', async () => {
    const body = { type: 'email.delivered', data: { email_id: 'msg-abc' } };
    const { reply, captured } = makeReply();
    await handleResendWebhook(signedReq(body, { ageSeconds: 400 }), reply);

    expect(captured.status).toBe(401);
    expect(captured.body).toEqual({ error: 'invalid_signature' });
    expect(mockSql).not.toHaveBeenCalled();
  });

  it('rejects a future timestamp (more than 60s ahead)', async () => {
    const body = { type: 'email.delivered', data: { email_id: 'msg-abc' } };
    const { reply, captured } = makeReply();
    await handleResendWebhook(signedReq(body, { ageSeconds: -120 }), reply);

    expect(captured.status).toBe(401);
    expect(mockSql).not.toHaveBeenCalled();
  });

  it('rejects when the body is tampered after signing', async () => {
    const signed = signedReq({ type: 'email.delivered', data: { email_id: 'orig' } });
    signed.body = { type: 'email.delivered', data: { email_id: 'tampered' } };
    signed.rawBody = JSON.stringify(signed.body);
    const { reply, captured } = makeReply();
    await handleResendWebhook(signed, reply);

    expect(captured.status).toBe(401);
    expect(mockSql).not.toHaveBeenCalled();
  });

  it('rejects when svix headers are missing', async () => {
    const body = { type: 'email.delivered', data: { email_id: 'msg-abc' } };
    const { reply, captured } = makeReply();
    await handleResendWebhook(makeReq(body, {}), reply);

    expect(captured.status).toBe(401);
    expect(mockSql).not.toHaveBeenCalled();
  });

  it('fails closed (401) when no secret is set and not in mock mode', async () => {
    delete process.env.RESEND_WEBHOOK_SECRET;
    const body = { type: 'email.delivered', data: { email_id: 'msg-abc' } };
    const { reply, captured } = makeReply();
    await handleResendWebhook(signedReq(body), reply);

    expect(captured.status).toBe(401);
    expect(mockSql).not.toHaveBeenCalled();
  });

  it('accepts when one of several space-separated signatures matches', async () => {
    // postgres.js returns a Result: an array carrying a numeric `.count`.
    sqlReturnQueue.push(Object.assign([] as unknown[], { count: 1 })); // inbound_events INSERT (fresh)
    sqlReturnQueue.push([]);
    sqlReturnQueue.push([]);

    const svixId = 'msg_multi';
    const ts = String(nowSeconds());
    const body = { type: 'email.delivered', data: { email_id: 'msg-abc' } };
    const good = sign(JSON.stringify(body), svixId, ts);
    // A correctly-shaped but wrong signature (signed with a different svix-id):
    // proves the handler skips a same-length value mismatch and accepts the valid one.
    const wrong = sign(JSON.stringify(body), 'wrong-svix-id', ts);
    const req = makeReq(body, {
      'svix-id': svixId,
      'svix-timestamp': ts,
      'svix-signature': `v1,${wrong} v1,${good}`,
    });
    const { reply, captured } = makeReply();
    await handleResendWebhook(req, reply);

    expect(captured.status).toBe(200);
  });
});
