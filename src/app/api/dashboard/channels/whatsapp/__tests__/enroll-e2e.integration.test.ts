// src/app/api/dashboard/channels/whatsapp/__tests__/enroll-e2e.integration.test.ts
//
// Owner WhatsApp enrollment round-trip integration test. Spans the owner start
// route (POST /api/dashboard/channels/whatsapp/start) AND the worker inbound
// webhook handler (handleTwilioWhatsAppInbound) that flips the enrollment to
// verified — the "owner scans the QR" step.
//
// ── Boundary (DONE_WITH_CONCERNS) ────────────────────────────────────────────
// This codebase's convention for an integration test that spans a route + the
// inbound webhook handler is to mock the DB seam with a queue-based mockSql, NOT
// to use a real Postgres pool. Real-Postgres coverage is reserved for the
// Playwright e2e under TEST_DATABASE_POOL_URL (see the comment headers in
// worker/jobs/zernio/__tests__/zernio-end-to-end.integration.test.ts and
// worker/ingress/test-helpers.ts). We mirror src/app/api/admin/channels/sms/
// __tests__/reenable-e2e.test.ts exactly: a shared hoisted sqlReturnQueue, a
// mocked requireRole (the route's only auth dependency), the REAL Twilio
// validateRequest (so the inbound handler's signature path runs), and the REAL
// handleTwilioWhatsAppInbound. This exercises the full round-trip — owner POST
// mints a token + deepLink → inbound start-<token> webhook → verification UPDATE
// — without needing a Supabase Auth session or a live database.
//
// Gating: runs unconditionally. Because the DB seam is mocked (no real
// Postgres is touched), this test needs no harness env var — it mirrors
// src/app/api/admin/channels/sms/__tests__/reenable-e2e.test.ts, which also
// runs every Vitest invocation. Real-Postgres coverage is reserved for the
// Playwright e2e gated on TEST_DATABASE_POOL_URL.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { NextRequest } from 'next/server';
import { createHash, createHmac } from 'node:crypto';

const d = describe;

// ── Shared DB mock (queue-based; covers both the route and the worker) ───────
// Vitest canonicalises the `@/lib/db/server` alias and the worker's relative
// `../../../src/lib/db/server` to the same module, so one mock covers both — the
// same assumption reenable-e2e.test.ts documents and relies on.
const { sqlCallsLog, sqlReturnQueue, mockSql } = vi.hoisted(() => {
  const sqlCallsLog: Array<{ raw: string; values: unknown[] }> = [];
  const sqlReturnQueue: unknown[] = [];
  const mockSql: any = vi.fn((strings: TemplateStringsArray, ...values: unknown[]) => {
    sqlCallsLog.push({ raw: strings.join('?'), values });
    const next = sqlReturnQueue.shift();
    const arr: any = Array.isArray(next) ? next : [];
    if (next && typeof next === 'object' && 'count' in (next as object)) {
      Object.assign(arr, { count: (next as any).count });
    }
    return Promise.resolve(arr);
  });
  mockSql.begin = vi.fn(async (cb: (tx: typeof mockSql) => Promise<unknown>) => cb(mockSql));
  return { sqlCallsLog, sqlReturnQueue, mockSql };
});
vi.mock('@/lib/db/server', () => ({ sql: mockSql, jsonb: (x: unknown) => x }));

// ── Auth mock (the route's only real dependency we must stub) ────────────────
const { MockAuthError, mockRequireRole } = vi.hoisted(() => {
  class MockAuthError extends Error {
    constructor(message: string, public readonly statusCode: number) {
      super(message);
      this.name = 'AuthError';
    }
  }
  return { MockAuthError, mockRequireRole: vi.fn() };
});
vi.mock('@/lib/db/auth', () => ({ requireRole: mockRequireRole, AuthError: MockAuthError }));

// Best-effort cache invalidation — no-op in the test.
vi.mock('@/lib/notifications/resolve-channels', () => ({
  safeInvalidateChannelCache: vi.fn(async () => {}),
  invalidateChannelCache: vi.fn(async () => {}),
}));

// Twilio: keep the REAL static validateRequest so the inbound handler's
// signature verification passes against our locally-signed request. Stub the
// client constructor so WhatsAppClient.sendFreeform (the inbound confirmation
// send) resolves harmlessly instead of hitting the network.
vi.mock('twilio', async () => {
  const actual = await vi.importActual<typeof import('twilio')>('twilio');
  const client: any = vi.fn(() => ({
    messages: { create: vi.fn(async () => ({ sid: 'SM_confirm_ok' })) },
  }));
  client.validateRequest = actual.validateRequest;
  return { default: client, validateRequest: actual.validateRequest };
});

// QR generation is deterministic + offline; stub to avoid the qrcode dep work.
vi.mock('qrcode', () => ({ default: { toDataURL: vi.fn(async () => 'data:image/png;base64,TEST') } }));

// Imports AFTER mocks are registered.
import { POST as startPOST } from '../start/route';
import { handleTwilioWhatsAppInbound } from '../../../../../../../worker/ingress/twilio/twilio-whatsapp-inbound';

type AnyReq = any;
type AnyReply = any;

const APP_URL = 'http://localhost';
const WORKER_URL = 'https://worker.example.com';
const TWILIO_AUTH_TOKEN = 'test_auth_token_for_ingress_fixtures';

function ownerStartReq(): NextRequest {
  return new NextRequest('http://localhost/api/dashboard/channels/whatsapp/start', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Origin: APP_URL },
    body: JSON.stringify({}),
  });
}

/** Twilio HMAC: base64(HMAC-SHA1(token, url + concat(sorted(k+v)))). Mirrors
 * worker/ingress/test-helpers.ts but for the whatsapp-inbound path. */
function sign(fullUrl: string, params: Record<string, string>): string {
  const sorted = Object.keys(params).sort().map((k) => k + params[k]).join('');
  return createHmac('sha1', TWILIO_AUTH_TOKEN).update(fullUrl + sorted).digest('base64');
}

function buildWhatsAppInbound(params: Record<string, string>): { req: AnyReq; reply: AnyReply } {
  const path = '/ingress/twilio/whatsapp-inbound';
  const rawBody = new URLSearchParams(params).toString();
  const fullUrl = `${WORKER_URL}${path}`;
  const req = {
    rawBody,
    url: path,
    ip: '1.2.3.4',
    headers: {
      'x-twilio-signature': sign(fullUrl, params),
      'content-type': 'application/x-www-form-urlencoded',
    },
  };
  const reply = {
    statusCode: 0,
    sentBody: undefined as unknown,
    status(code: number) { this.statusCode = code; return this; },
    send(payload: unknown) { this.sentBody = payload; return this; },
  };
  return { req, reply };
}

// Snapshot the pristine env once (before any beforeEach mutation) so afterEach
// can fully restore it and avoid cross-test contamination.
const ORIGINAL_ENV = { ...process.env };

beforeEach(() => {
  sqlCallsLog.length = 0;
  sqlReturnQueue.length = 0;
  mockSql.mockClear();
  mockSql.begin.mockClear();
  mockRequireRole.mockReset();
  mockRequireRole.mockResolvedValue({
    userId: 'owner-1', role: 'owner', locationId: 'biz-1', accountId: 'acct-1',
  });
  process.env.CHANNELS_WHATSAPP_ENABLED = 'true';
  process.env.MOCK_EXTERNAL_APIS = 'true';
  process.env.TWILIO_ACCOUNT_SID = 'ACtest';
  process.env.TWILIO_AUTH_TOKEN = TWILIO_AUTH_TOKEN;
  process.env.TWILIO_WHATSAPP_NUMBER = 'whatsapp:+15551230000';
  process.env.WORKER_PUBLIC_URL = WORKER_URL;
  process.env.NEXT_PUBLIC_APP_URL = APP_URL;
});

afterEach(() => {
  // Delete keys this test added, then restore originals — leaves process.env
  // exactly as it was before this file ran.
  for (const key of Object.keys(process.env)) {
    if (!(key in ORIGINAL_ENV)) delete process.env[key];
  }
  Object.assign(process.env, ORIGINAL_ENV);
});

d('owner WhatsApp enrollment round-trip (route start → inbound verify)', () => {
  it('start route mints deepLink; inbound start-<token> flips the row to verified', async () => {
    // ── Step 1: owner POST /start ──────────────────────────────────────────
    // Route SQL order: (1) accounts JOIN businesses subscription lookup,
    // (2) getActiveLocationCount (single-location guard), (3) advisory lock
    // inside sql.begin, (4) SELECT FOR UPDATE existing enrollment (none),
    // (5) INSERT enrollment.
    sqlReturnQueue.push([{ id: 'acct-1', subscription_status: 'active' }]); // 1
    sqlReturnQueue.push([{ count: 1 }]);                                     // 2 getActiveLocationCount
    sqlReturnQueue.push([]);                                                 // 3 advisory lock
    sqlReturnQueue.push([]);                                                 // 4 SELECT FOR UPDATE (none)
    sqlReturnQueue.push([]);                                                 // 5 INSERT

    const startRes = await startPOST(ownerStartReq() as AnyReq);
    expect(startRes.status).toBe(200);
    const startBody = await startRes.json();
    expect(startBody.deepLink).toMatch(/^https:\/\/wa\.me\/15551230000\?text=start-/);

    // The INSERT carries the sha256(rawToken) hash. Recover rawToken from the
    // deepLink and assert the route persisted its hash.
    const prefilled = decodeURIComponent(new URL(startBody.deepLink).searchParams.get('text')!);
    expect(prefilled).toMatch(/^start-/);
    const rawToken = prefilled.slice('start-'.length);
    const tokenHash = createHash('sha256').update(rawToken).digest('hex');

    const insertCall = sqlCallsLog.find((c) => c.raw.includes('INSERT INTO channel_enrollments'));
    expect(insertCall).toBeDefined();
    expect(insertCall!.values).toContain(tokenHash);
    expect(insertCall!.raw).toMatch(/'whatsapp'/);
    expect(insertCall!.raw).toMatch(/'pending_verification'/);

    // ── Step 2: inbound webhook ("owner scans QR") ─────────────────────────
    // Inbound SQL order: (1) claimInboundEvent INSERT, (2) sql.begin →
    // SELECT FOR UPDATE matching pending row, (3) UPDATE → verified,
    // (4) markInboundEventProcessed.
    sqlCallsLog.length = 0;
    mockSql.begin.mockClear();
    sqlReturnQueue.push(Object.assign([], { count: 1 }));            // 1 claim (not duplicate)
    sqlReturnQueue.push([{ id: 'enroll-1', account_id: 'acct-1' }]); // 2 SELECT FOR UPDATE matched
    sqlReturnQueue.push([]);                                          // 3 UPDATE → verified
    sqlReturnQueue.push([]);                                          // 4 markProcessed

    const { req, reply } = buildWhatsAppInbound({
      MessageSid: 'SM_wa_enroll_e2e',
      From: 'whatsapp:+15551237654',
      To: 'whatsapp:+15551230000',
      Body: `start-${rawToken}`,
    });
    await handleTwilioWhatsAppInbound(req, reply);
    expect(reply.statusCode).toBe(200);

    const inboundSql = sqlCallsLog.map((c) => c.raw).join('\n---\n');
    // The verification UPDATE flips status → verified, sets handle, NULLs hash.
    expect(inboundSql).toMatch(/UPDATE channel_enrollments/);
    expect(inboundSql).toMatch(/status = 'verified'/);
    expect(inboundSql).toMatch(/SET[\s\S]*handle = /);
    expect(inboundSql).toMatch(/verification_token_hash = NULL/);
    // The SELECT FOR UPDATE that matched the row was keyed on the hash of the
    // inbound token — prove the inbound path looked up by sha256(rawToken).
    const selectForUpdate = sqlCallsLog.find(
      (c) => c.raw.includes('FOR UPDATE') && c.values.includes(tokenHash),
    );
    expect(selectForUpdate).toBeDefined();
    expect(mockSql.begin).toHaveBeenCalledTimes(1);
  });

  it('start route returns 409 already_verified when a verified row exists', async () => {
    sqlReturnQueue.push([{ id: 'acct-1', subscription_status: 'active' }]); // subscription lookup
    sqlReturnQueue.push([{ count: 1 }]);                                     // getActiveLocationCount (single-location guard)
    sqlReturnQueue.push([]);                                                 // advisory lock
    sqlReturnQueue.push([{ id: 'enroll-1', status: 'verified' }]);           // SELECT FOR UPDATE → verified

    const res = await startPOST(ownerStartReq() as AnyReq);
    expect(res.status).toBe(409);
    expect((await res.json()).error).toBe('already_verified');
  });

  it('inbound with an unissued token does NOT flip any row to verified', async () => {
    sqlReturnQueue.push(Object.assign([], { count: 1 })); // claim
    sqlReturnQueue.push([]);                              // SELECT FOR UPDATE → no match
    sqlReturnQueue.push([]);                              // markProcessed

    const { req, reply } = buildWhatsAppInbound({
      MessageSid: 'SM_wa_bad_e2e',
      From: 'whatsapp:+15551237654',
      To: 'whatsapp:+15551230000',
      Body: 'start-00000000-0000-7000-8000-000000000000',
    });
    await handleTwilioWhatsAppInbound(req, reply);
    expect(reply.statusCode).toBe(200);

    const inboundSql = sqlCallsLog.map((c) => c.raw).join('\n');
    // No verification UPDATE ran — the SELECT FOR UPDATE returned no row.
    expect(inboundSql).not.toMatch(/status = 'verified'/);
  });
});
