// src/app/api/admin/channels/sms/__tests__/reenable-e2e.test.ts
//
// End-to-end integration tests for the two lifecycle scenarios that span
// multiple routes + the inbound webhook handler (Task 27):
//
//   1. Enroll → STOP (inbound) → /verify blocked → START (inbound) → /verify
//      allowed → /confirm flips to verified. This proves the entire
//      sender-opt-out gate + inbound webhook + admin route integration.
//
//   2. Archive (soft-delete) → /verify with same phone still blocked by the
//      sender-opt-out gate. Proves soft-delete does NOT bypass TCPA carrier
//      opt-out evidence — the retention invariant Phase 1 is built on.
//
// These tests are intentionally long. Each lifecycle step primes the
// sqlReturnQueue for the SQL calls that step will issue, then asserts on
// the captured SQL and Twilio mock interactions. The value is proving the
// whole architecture works together — individual behaviours are unit-tested
// in routes.test.ts and worker/ingress/__tests__/twilio-inbound.test.ts.
//
// Mock scaffolding mirrors routes.test.ts verbatim (hoisted DB mock with a
// queue, hoisted auth mock with AuthError, hoisted Twilio mock). The extra
// wrinkle is the DB mock registration: the worker's twilio.ts imports
// `../../../src/lib/db/server` (relative), the route code imports
// `@/lib/db/server` (alias). Vitest's alias resolution usually canonicalises
// both to the same module, so a single `@/lib/db/server` mock covers both —
// but we register the relative-path spec as well, defensively, in case the
// vite config routes them through separate module graphs.

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NextRequest } from 'next/server';

// ── DB mock ─────────────────────────────────────────────────────────
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
// Vitest canonicalises the `@` alias and the worker's relative path
// (`../../../src/lib/db/server`) to the same module, so a single mock on
// the `@/lib/db/server` spec covers both the route code and the webhook
// handler — just like worker/ingress/__tests__/twilio-inbound.test.ts
// mocks `../../../src/lib/db/server` and that mock also applies to any
// code path using `@/lib/db/server`.
vi.mock('@/lib/db/server', () => ({ sql: mockSql, jsonb: (x: unknown) => x }));

// ── Auth mock ────────────────────────────────────────────────────────
const { MockAuthError, mockRequireRole } = vi.hoisted(() => {
  class MockAuthError extends Error {
    constructor(
      message: string,
      public readonly statusCode: number,
    ) {
      super(message);
      this.name = 'AuthError';
    }
  }
  return { MockAuthError, mockRequireRole: vi.fn() };
});
vi.mock('@/lib/db/auth', () => ({
  requireRole: mockRequireRole,
  AuthError: MockAuthError,
}));

// ── Twilio mock ──────────────────────────────────────────────────────
// The route code calls `twilio(ACCOUNT_SID, AUTH_TOKEN).verify.v2.services(...)`
// — that needs a mocked Twilio client. The webhook signature validator also
// uses `twilio.validateRequest(...)` (default-imported). buildInboundRequest
// in helpers.ts signs requests with a fixture auth token, so we want the
// REAL validateRequest for signature verification to pass. Solution: keep
// real validateRequest on the mocked default export, and stub only the
// constructor-call shape the route handlers use.
const { mockVerifyCreate, mockVerificationCheckCreate } = vi.hoisted(() => ({
  mockVerifyCreate: vi.fn(),
  mockVerificationCheckCreate: vi.fn(),
}));
vi.mock('twilio', async () => {
  const actual = await vi.importActual<typeof import('twilio')>('twilio');
  const client: any = vi.fn(() => ({
    verify: {
      v2: {
        services: () => ({
          verifications: { create: mockVerifyCreate },
          verificationChecks: { create: mockVerificationCheckCreate },
        }),
      },
    },
  }));
  // Copy real static helpers (validateRequest, etc.) onto our mock default
  // so signature verification in the webhook handler still works against
  // buildInboundRequest's real HMAC-signed fixture.
  client.validateRequest = actual.validateRequest;
  return { default: client, validateRequest: actual.validateRequest };
});

// Imports AFTER vi.mock()s are registered.
import { POST as verifyPOST } from '../verify/route';
import { POST as confirmPOST } from '../confirm/route';
import { handleTwilioInbound } from '../../../../../../../worker/ingress/twilio/twilio';
import { buildInboundRequest } from '../../../../../../../worker/ingress/test-helpers';

// Shape-cast for the Fastify request/reply contract used by the handler.
type AnyReq = any;
type AnyReply = any;

function adminReq(path: 'verify' | 'confirm', body: unknown): NextRequest {
  return new NextRequest(`http://localhost/api/admin/channels/sms/${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

function resetAll() {
  sqlCallsLog.length = 0;
  sqlReturnQueue.length = 0;
  mockSql.mockClear();
  mockSql.begin.mockClear();
  mockRequireRole.mockReset();
  mockRequireRole.mockResolvedValue({
    id: 'admin-1',
    role: 'admin',
    accountId: null,
    locationId: null,
    name: 'Admin',
    email: 'a@b.com',
  });
  mockVerifyCreate.mockReset();
  mockVerifyCreate.mockResolvedValue({ status: 'pending' });
  mockVerificationCheckCreate.mockReset();
  mockVerificationCheckCreate.mockResolvedValue({ status: 'approved' });
  process.env.CHANNELS_SMS_ENABLED = 'true';
  process.env.TWILIO_ACCOUNT_SID = 'ACtest';
  process.env.TWILIO_AUTH_TOKEN = 'test_auth_token_for_ingress_fixtures';
  process.env.TWILIO_MESSAGING_SERVICE_SID = 'MGtest';
  process.env.TWILIO_VERIFY_SERVICE_SID = 'VAtest';
  process.env.WORKER_PUBLIC_URL = 'https://worker.example.com';
}

describe('SMS re-enable lifecycle (E2E)', () => {
  beforeEach(resetAll);

  it('STOP → /verify blocked → START → /verify allowed → /confirm → verified', async () => {
    const PHONE = '+14155552671';

    // ─────────────────────────────────────────────────────────────
    // Step 1: Inbound STOP webhook. Expected SQL calls (order):
    //   1. INSERT inbound_events (claim, count:1)
    //   2. SELECT id FROM inbound_events
    //   3. sql.begin → 3 writes:
    //      3a. INSERT INTO sms_sender_opt_outs (UPSERT)
    //      3b. INSERT INTO sms_sender_opt_out_events
    //      3c. UPDATE channel_enrollments (flip → unsubscribed)
    //   4. UPDATE inbound_events status=processed
    // ─────────────────────────────────────────────────────────────
    sqlReturnQueue.push(Object.assign([], { count: 1 })); // 1. claim
    sqlReturnQueue.push([{ id: 'inbound-evt-stop' }]);    // 2. SELECT id
    sqlReturnQueue.push([]);                               // 3a. UPSERT opt_outs
    sqlReturnQueue.push([]);                               // 3b. audit event
    sqlReturnQueue.push([]);                               // 3c. UPDATE enrollments
    sqlReturnQueue.push([]);                               // 4. mark processed

    const stopPair = buildInboundRequest({
      From: PHONE,
      To: '+15550001111',
      Body: 'STOP',
      MessageSid: 'SM_stop_e2e',
      MessagingServiceSid: 'MGtest',
      OptOutType: 'STOP',
    });
    await handleTwilioInbound(stopPair.req as AnyReq, stopPair.reply as AnyReply);
    expect(stopPair.reply.statusCode).toBe(200);

    const stopSql = sqlCallsLog.map((c) => c.raw).join('\n---\n');
    expect(stopSql).toMatch(/INSERT INTO sms_sender_opt_outs/);
    expect(stopSql).toMatch(/ON CONFLICT \(messaging_service_sid, handle\) DO UPDATE/);
    expect(stopSql).toMatch(/INSERT INTO sms_sender_opt_out_events/);
    expect(stopSql).toMatch(/UPDATE channel_enrollments/);
    expect(stopSql).toMatch(/status = 'unsubscribed'/);
    expect(mockSql.begin).toHaveBeenCalledTimes(1);

    // ─────────────────────────────────────────────────────────────
    // Step 2: Admin clicks "Send code" on an unsubscribed row.
    // /verify should reject with sender_opt_in_required BEFORE any
    // Twilio call, because the opt-out row still shows opted_in_at
    // IS NULL (from the STOP above).
    // SQL order:
    //   1. SELECT a.subscription_status FROM accounts a JOIN businesses b ...
    //   2. SELECT pg_advisory_xact_lock(...)  (inside sql.begin)
    //   3. SELECT active-row (handle, status) — returns unsubscribed row
    //   4. SELECT opt-out row — returns opted_out_at, opted_in_at=null
    // Flow returns 400 without Twilio, without any INSERT/UPDATE.
    // ─────────────────────────────────────────────────────────────
    sqlCallsLog.length = 0;
    mockSql.begin.mockClear();
    sqlReturnQueue.push([{ subscription_status: 'active' }]);                 // 1. sub
    sqlReturnQueue.push([]);                                                   // 2. advisory lock
    sqlReturnQueue.push([{ handle: PHONE, status: 'unsubscribed' }]);          // 3. active row
    sqlReturnQueue.push([{ opted_out_at: new Date('2026-04-20'), opted_in_at: null }]); // 4. opt-out gate

    const blocked = await verifyPOST(adminReq('verify', { business_id: 'biz-1' }));
    expect(blocked.status).toBe(400);
    expect((await blocked.json()).reason).toBe('sender_opt_in_required');
    expect(mockVerifyCreate).not.toHaveBeenCalled();
    // No DB mutations should have occurred during the blocked verify.
    const blockedSql = sqlCallsLog.map((c) => c.raw).join('\n');
    expect(blockedSql).not.toMatch(/INSERT INTO channel_enrollments/);
    expect(blockedSql).not.toMatch(/UPDATE channel_enrollments/);

    // ─────────────────────────────────────────────────────────────
    // Step 3: Inbound START webhook. Clears sender-level opt-in.
    // SQL order:
    //   1. INSERT inbound_events (claim, count:1)
    //   2. SELECT id FROM inbound_events
    //   3. sql.begin → 2 writes:
    //      3a. UPDATE sms_sender_opt_outs SET opted_in_at=NOW()
    //      3b. INSERT sms_sender_opt_out_events
    //   4. UPDATE inbound_events status=processed
    // ─────────────────────────────────────────────────────────────
    sqlCallsLog.length = 0;
    mockSql.begin.mockClear();
    sqlReturnQueue.push(Object.assign([], { count: 1 }));  // 1. claim
    sqlReturnQueue.push([{ id: 'inbound-evt-start' }]);    // 2. SELECT id
    sqlReturnQueue.push([]);                                // 3a. UPDATE opt_outs
    sqlReturnQueue.push([]);                                // 3b. audit event
    sqlReturnQueue.push([]);                                // 4. mark processed

    const startPair = buildInboundRequest({
      From: PHONE,
      To: '+15550001111',
      Body: 'START',
      MessageSid: 'SM_start_e2e',
      MessagingServiceSid: 'MGtest',
      OptOutType: 'START',
    });
    await handleTwilioInbound(startPair.req as AnyReq, startPair.reply as AnyReply);
    expect(startPair.reply.statusCode).toBe(200);

    const startSql = sqlCallsLog.map((c) => c.raw).join('\n---\n');
    expect(startSql).toMatch(/UPDATE sms_sender_opt_outs\s+SET opted_in_at/);
    expect(startSql).toMatch(/INSERT INTO sms_sender_opt_out_events/);
    // START must NOT touch channel_enrollments — admin re-verifies via /verify.
    expect(startSql).not.toMatch(/UPDATE channel_enrollments/);
    expect(mockSql.begin).toHaveBeenCalledTimes(1);

    // ─────────────────────────────────────────────────────────────
    // Step 4: /verify now succeeds. The opt-out row now has
    // opted_in_at AFTER opted_out_at, so the gate passes.
    // SQL order for dbAction='update' (row is 'unsubscribed'):
    //   1. SELECT subscription_status
    //   2. advisory lock
    //   3. SELECT active row → { handle, status: 'unsubscribed' }
    //   4. SELECT opt-out row → opted_in_at > opted_out_at (GATE PASS)
    //   5. SELECT other mobile channels (pre-check) — none
    //   6. SELECT opt-out row AGAIN after Twilio (post-Twilio STOP race
    //      guard — must still be opted in)
    //   7. UPDATE channel_enrollments RETURNING id
    // Twilio Verify.create is called between step 5 and 6.
    // ─────────────────────────────────────────────────────────────
    sqlCallsLog.length = 0;
    mockSql.begin.mockClear();
    mockVerifyCreate.mockClear();
    sqlReturnQueue.push([{ subscription_status: 'active' }]);
    sqlReturnQueue.push([]);
    sqlReturnQueue.push([{ handle: PHONE, status: 'unsubscribed' }]);
    sqlReturnQueue.push([
      {
        opted_out_at: new Date('2026-04-20T10:00:00Z'),
        opted_in_at: new Date('2026-04-20T11:00:00Z'),
      },
    ]);
    sqlReturnQueue.push([]);  // mobile pre-check — no other channels
    sqlReturnQueue.push([
      {
        opted_out_at: new Date('2026-04-20T10:00:00Z'),
        opted_in_at: new Date('2026-04-20T11:00:00Z'),
      },
    ]); // post-Twilio opt-out re-check — still opted in
    sqlReturnQueue.push([{ id: 'enr-1' }]); // UPDATE RETURNING id (dbAction='update')

    const allowed = await verifyPOST(adminReq('verify', { business_id: 'biz-1' }));
    expect(allowed.status).toBe(200);
    const allowedJson = await allowed.json();
    expect(allowedJson.ok).toBe(true);
    expect(allowedJson.phoneMasked).toMatch(/^\+1 415-XXX-2671$/);
    expect(mockVerifyCreate).toHaveBeenCalledWith(
      expect.objectContaining({ to: PHONE, channel: 'sms' }),
    );
    const allowedSql = sqlCallsLog.map((c) => c.raw).join('\n');
    expect(allowedSql).toMatch(/UPDATE channel_enrollments/);
    expect(allowedSql).toMatch(/status = 'pending_verification'/);
    // Cross-channel pre-check (Phase 4 Fix #2) — fails the test if the
    // SELECT that gates Twilio Verify on "no other mobile channel for this
    // business" is removed or changed shape.
    expect(allowedSql).toMatch(/SELECT channel FROM channel_enrollments[\s\S]*channel IN \('telegram', 'whatsapp'\)/);

    // ─────────────────────────────────────────────────────────────
    // Step 5: /confirm flips the row to verified.
    // SQL order:
    //   1. SELECT subscription_status
    //   2. advisory lock
    //   3. SELECT active row → { handle, status: 'pending_verification' }
    //   4. SELECT opt-out row → opted_in_at > opted_out_at (GATE PASS)
    //   5. UPDATE channel_enrollments SET status='verified' RETURNING id
    // ─────────────────────────────────────────────────────────────
    sqlCallsLog.length = 0;
    mockSql.begin.mockClear();
    sqlReturnQueue.push([{ subscription_status: 'active' }]);
    sqlReturnQueue.push([]);
    sqlReturnQueue.push([{ handle: PHONE, status: 'pending_verification' }]);
    sqlReturnQueue.push([
      {
        opted_out_at: new Date('2026-04-20T10:00:00Z'),
        opted_in_at: new Date('2026-04-20T11:00:00Z'),
      },
    ]);
    sqlReturnQueue.push([{ id: 'enr-1' }]);
    mockVerificationCheckCreate.mockResolvedValueOnce({ status: 'approved' });

    const confirmed = await confirmPOST(adminReq('confirm', { business_id: 'biz-1', code: '123456' }));
    expect(confirmed.status).toBe(200);
    expect((await confirmed.json()).ok).toBe(true);

    const confirmedSql = sqlCallsLog.map((c) => c.raw).join('\n');
    expect(confirmedSql).toMatch(/UPDATE channel_enrollments/);
    expect(confirmedSql).toMatch(/status = 'verified'/);
    expect(confirmedSql).toMatch(/unsubscribed_at = NULL/);

    // Critical invariant: /confirm must NOT touch sms_sender_opt_outs or
    // sms_sender_opt_out_events. The opt-out audit trail (STOP/START timeline)
    // is preserved for TCPA evidence, independent of enrollment status.
    expect(confirmedSql).not.toMatch(/UPDATE sms_sender_opt_outs/);
    expect(confirmedSql).not.toMatch(/INSERT INTO sms_sender_opt_outs/);
    expect(confirmedSql).not.toMatch(/INSERT INTO sms_sender_opt_out_events/);
  });

  it('archive-then-reenroll cannot bypass sender-opt-out gate', async () => {
    // Scenario: admin clicked Delete (archived_at set). Later, a fresh
    // /verify attempt is made with the SAME phone. channel_enrollments
    // has no active row (the old row is soft-deleted), but the
    // sms_sender_opt_outs row persists because archival is enrollment-
    // scoped while opt-outs are sender-scoped (TCPA retention).
    //
    // SQL order for a no-active-row /verify:
    //   1. SELECT subscription_status
    //   2. advisory lock
    //   3. SELECT active row — empty (soft-deleted)
    //   4. SELECT opt-out row — GATE HIT
    // /verify returns 400 sender_opt_in_required; Twilio NOT called;
    // no DB mutations.

    const PHONE = '+14155552671';

    sqlReturnQueue.push([{ subscription_status: 'active' }]);
    sqlReturnQueue.push([]);                                    // advisory lock
    sqlReturnQueue.push([]);                                    // no active row (archived)
    sqlReturnQueue.push([
      { opted_out_at: new Date('2026-03-15'), opted_in_at: null },
    ]);                                                          // opt-out still blocks

    const res = await verifyPOST(
      adminReq('verify', { business_id: 'biz-1', phone: PHONE }),
    );
    expect(res.status).toBe(400);
    expect((await res.json()).reason).toBe('sender_opt_in_required');
    expect(mockVerifyCreate).not.toHaveBeenCalled();

    // Archive-bypass is ONLY prevented because the opt-out row query still
    // returns a hit. Confirm we read from sms_sender_opt_outs (not from
    // channel_enrollments) for the gate decision.
    const raw = sqlCallsLog.map((c) => c.raw).join('\n');
    expect(raw).toMatch(/FROM sms_sender_opt_outs/);
    // And NO enrollment mutations occurred — the gate short-circuited
    // before INSERT or UPDATE.
    expect(raw).not.toMatch(/INSERT INTO channel_enrollments/);
    expect(raw).not.toMatch(/UPDATE channel_enrollments/);
  });
});
