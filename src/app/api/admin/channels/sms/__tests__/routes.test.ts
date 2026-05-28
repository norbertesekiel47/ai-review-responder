// src/app/api/admin/channels/sms/__tests__/routes.test.ts
//
// Shared test file for the six admin SMS routes (verify, confirm, cancel,
// disable, delete, status). Tasks 16–21 each append a `describe` block.
// This file owns the hoisted mocks (DB, auth, twilio) so all six routes
// reuse them; resetMocks() re-seeds defaults between every `it`.
//
// Mock shape follows the Phase 0 pattern
// (src/app/api/admin/channels/sms/__tests__/onconflict.test.ts and
// src/lib/notifications/__tests__/enrollments.test.ts):
//   - mockSql is a tagged-template captor. Each call records
//     { raw: strings.join('?'), values } into sqlCallsLog.
//   - sqlReturnQueue is a FIFO the test primes in the same order SQL calls
//     fire in the route (subscription lookup, advisory lock, active-row
//     SELECT, opt-out lookup, INSERT/UPDATE).
//   - mockSql.begin invokes the callback with mockSql as tx, so tx`…` calls
//     inside withMobileEnrollmentLock land in the same log.
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
vi.mock('@/lib/db/server', () => ({ sql: mockSql, jsonb: (x: unknown) => x }));

// ── Auth mock ────────────────────────────────────────────────────────
// The real AuthError uses `statusCode` (see src/lib/db/auth.ts). Match that
// exactly so the route's `err.statusCode` branch works when the mock throws.
// MockAuthError is defined inside vi.hoisted() because vi.mock() is hoisted
// above any top-level declarations — a plain `class MockAuthError {}` above
// would be TDZ-unreachable from the mock factory.
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
// verify.v2.services(SID) returns an object with .verifications.create and
// .verificationChecks.create — Tasks 16 and 17 use these respectively.
const { mockVerifyCreate, mockVerificationCheckCreate } = vi.hoisted(() => ({
  mockVerifyCreate: vi.fn(),
  mockVerificationCheckCreate: vi.fn(),
}));
vi.mock('twilio', () => ({
  default: vi.fn(() => ({
    verify: {
      v2: {
        services: () => ({
          verifications: { create: mockVerifyCreate },
          verificationChecks: { create: mockVerificationCheckCreate },
        }),
      },
    },
  })),
  validateRequest: vi.fn(),
}));

// Routes under test — imported after all vi.mock() calls above.
import { POST as verifyPOST } from '../verify/route';
import { POST as confirmPOST } from '../confirm/route';
import { POST as cancelPOST } from '../cancel/route';
import { POST as disablePOST } from '../disable/route';
import { POST as deletePOST } from '../delete/route';
import { GET as statusGET } from '../status/route';

const APP_URL = 'http://localhost';

function adminReq(body: unknown): NextRequest {
  return new NextRequest('http://localhost/api/admin/channels/sms/verify', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Origin: APP_URL },
    body: JSON.stringify(body),
  });
}

function resetMocks() {
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
  process.env.WORKER_PUBLIC_URL = 'https://worker.test';
  process.env.TWILIO_ACCOUNT_SID = 'ACtest';
  process.env.TWILIO_AUTH_TOKEN = 't';
  process.env.TWILIO_MESSAGING_SERVICE_SID = 'MGtest';
  process.env.TWILIO_VERIFY_SERVICE_SID = 'VAtest';
  process.env.NEXT_PUBLIC_APP_URL = APP_URL;
  delete process.env.MOCK_EXTERNAL_APIS;
}

// ── H2: env-readiness 503 across all 6 routes ─────────────────────────
// When CHANNELS_SMS_ENABLED=true but a required Twilio env var is missing,
// every admin route must 503 with `reason: 'sms_env_not_ready'` BEFORE
// touching auth or DB. Table-driven: one case per route × env var combo.
describe('SMS admin routes: env-readiness 503 (H2)', () => {
  beforeEach(resetMocks);

  const cases: Array<{
    name: string;
    run: () => Promise<Response>;
  }> = [
    {
      name: 'verify',
      run: () => verifyPOST(adminReq({ business_id: 'biz', phone: '+14155552671' })),
    },
    {
      name: 'confirm',
      run: () => confirmPOST(adminReq({ business_id: 'biz', code: '123456' })),
    },
    {
      name: 'cancel',
      run: () => cancelPOST(adminReq({ business_id: 'biz' })),
    },
    {
      name: 'disable',
      run: () => disablePOST(adminReq({ business_id: 'biz' })),
    },
    {
      name: 'delete',
      run: () => deletePOST(adminReq({ business_id: 'biz', confirm: true })),
    },
    {
      name: 'status',
      run: () =>
        statusGET(
          new NextRequest('http://localhost/api/admin/channels/sms/status?business_id=biz', {
            method: 'GET',
          }),
        ),
    },
  ];

  for (const c of cases) {
    it(`${c.name}: 503 sms_env_not_ready when TWILIO_ACCOUNT_SID is missing`, async () => {
      delete process.env.TWILIO_ACCOUNT_SID;
      const res = await c.run();
      expect(res.status).toBe(503);
      const json = await res.json();
      expect(json.reason).toBe('sms_env_not_ready');
      expect(Array.isArray(json.missing)).toBe(true);
      expect(json.missing).toContain('TWILIO_ACCOUNT_SID');
      // Auth was never consulted — 503 fires before requireRole.
      expect(mockRequireRole).not.toHaveBeenCalled();
    });
  }

  it('MOCK_EXTERNAL_APIS=true bypasses the 503 check', async () => {
    delete process.env.TWILIO_ACCOUNT_SID;
    process.env.MOCK_EXTERNAL_APIS = 'true';
    try {
      // Prime enough for the status route to complete successfully.
      sqlReturnQueue.push([]);
      const res = await statusGET(
        new NextRequest('http://localhost/api/admin/channels/sms/status?business_id=biz', {
          method: 'GET',
        }),
      );
      // Not 503 — the env check bypassed.
      expect(res.status).not.toBe(503);
    } finally {
      delete process.env.MOCK_EXTERNAL_APIS;
    }
  });
});

describe('POST /api/admin/channels/sms/verify', () => {
  beforeEach(resetMocks);

  it('404 when CHANNELS_SMS_ENABLED is off', async () => {
    process.env.CHANNELS_SMS_ENABLED = 'false';
    const res = await verifyPOST(adminReq({ business_id: 'biz', phone: '+14155552671' }));
    expect(res.status).toBe(404);
  });

  it('403 when requireRole throws AuthError(403)', async () => {
    mockRequireRole.mockRejectedValueOnce(new MockAuthError('Forbidden', 403));
    const res = await verifyPOST(adminReq({ business_id: 'biz', phone: '+14155552671' }));
    expect(res.status).toBe(403);
  });

  it('401 when requireRole throws AuthError(401)', async () => {
    mockRequireRole.mockRejectedValueOnce(new MockAuthError('Unauthorized', 401));
    const res = await verifyPOST(adminReq({ business_id: 'biz', phone: '+14155552671' }));
    expect(res.status).toBe(401);
  });

  it('400 business_id_required when missing', async () => {
    const res = await verifyPOST(adminReq({ phone: '+14155552671' }));
    expect(res.status).toBe(400);
    expect((await res.json()).reason).toBe('business_id_required');
  });

  it('403 when subscription_status != active', async () => {
    sqlReturnQueue.push([{ subscription_status: 'pending_payment' }]); // loadBusinessSubscriptionStatus
    const res = await verifyPOST(adminReq({ business_id: 'biz', phone: '+14155552671' }));
    expect(res.status).toBe(403);
  });

  it('400 phone_required when no active row and phone missing', async () => {
    sqlReturnQueue.push([{ subscription_status: 'active' }]); // sub
    sqlReturnQueue.push([]);                                   // advisory lock
    sqlReturnQueue.push([]);                                   // active-row SELECT (empty)
    const res = await verifyPOST(adminReq({ business_id: 'biz' }));
    expect(res.status).toBe(400);
    expect((await res.json()).reason).toBe('phone_required');
  });

  it('400 phone_invalid on unparseable phone', async () => {
    sqlReturnQueue.push([{ subscription_status: 'active' }]);
    sqlReturnQueue.push([]);
    sqlReturnQueue.push([]);
    const res = await verifyPOST(adminReq({ business_id: 'biz', phone: 'not-a-phone' }));
    expect(res.status).toBe(400);
    expect((await res.json()).reason).toBe('phone_invalid');
  });

  it('400 sender_opt_in_required when phone is currently opted out', async () => {
    sqlReturnQueue.push([{ subscription_status: 'active' }]);
    sqlReturnQueue.push([]);                                          // advisory lock
    sqlReturnQueue.push([]);                                          // active row — none
    sqlReturnQueue.push([{ opted_out_at: new Date(), opted_in_at: null }]); // opt-out lookup
    const res = await verifyPOST(adminReq({ business_id: 'biz', phone: '+14155552671' }));
    expect(res.status).toBe(400);
    expect((await res.json()).reason).toBe('sender_opt_in_required');
    expect(mockVerifyCreate).not.toHaveBeenCalled();
  });

  it('400 already_verified on verified row', async () => {
    sqlReturnQueue.push([{ subscription_status: 'active' }]);
    sqlReturnQueue.push([]);
    sqlReturnQueue.push([{ handle: '+14155552671', status: 'verified' }]);
    const res = await verifyPOST(adminReq({ business_id: 'biz' }));
    expect(res.status).toBe(400);
    expect((await res.json()).reason).toBe('already_verified');
  });

  it('400 handle_change_forbidden when submitted phone differs from row handle', async () => {
    sqlReturnQueue.push([{ subscription_status: 'active' }]);
    sqlReturnQueue.push([]);
    sqlReturnQueue.push([{ handle: '+14155552671', status: 'disabled' }]);
    const res = await verifyPOST(adminReq({ business_id: 'biz', phone: '+15559999999' }));
    expect(res.status).toBe(400);
    expect((await res.json()).reason).toBe('handle_change_forbidden');
  });

  it('500 verify_send_failed when Twilio errors (DB unchanged)', async () => {
    sqlReturnQueue.push([{ subscription_status: 'active' }]);
    sqlReturnQueue.push([]);
    sqlReturnQueue.push([]);                       // no active row
    sqlReturnQueue.push([]);                       // opt-out — empty
    sqlReturnQueue.push([]);                       // mobile pre-check — no other channels
    mockVerifyCreate.mockRejectedValueOnce(new Error('twilio down'));
    const res = await verifyPOST(adminReq({ business_id: 'biz', phone: '+14155552671' }));
    expect(res.status).toBe(500);
    expect((await res.json()).reason).toBe('verify_send_failed');
    // No INSERT should have been made.
    const raw = sqlCallsLog.map((c) => c.raw).join('\n');
    expect(raw).not.toMatch(/INSERT INTO channel_enrollments/);
  });

  it('200 on brand-new: INSERTs pending_verification row', async () => {
    sqlReturnQueue.push([{ subscription_status: 'active' }]);
    sqlReturnQueue.push([]);
    sqlReturnQueue.push([]);
    sqlReturnQueue.push([]);                       // opt-out — not present
    sqlReturnQueue.push([]);                       // mobile pre-check — no other channels
    sqlReturnQueue.push([]);                       // post-Twilio opt-out re-check
    sqlReturnQueue.push([{ account_id: 'acct-1' }]); // SELECT account_id from businesses
    sqlReturnQueue.push([]);                       // INSERT
    const res = await verifyPOST(adminReq({ business_id: 'biz', phone: '+14155552671' }));
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.ok).toBe(true);
    expect(json.phoneMasked).toMatch(/^\+1 415-XXX-2671$/);
    expect(mockVerifyCreate).toHaveBeenCalledWith(
      expect.objectContaining({ to: '+14155552671', channel: 'sms' }),
    );
    const raw = sqlCallsLog.map((c) => c.raw).join('\n');
    expect(raw).toMatch(/INSERT INTO channel_enrollments/);
    expect(raw).toMatch(/'pending_verification'/);
  });

  it('200 on re-enable from disabled: UPDATE, preserves handle + disabled_at', async () => {
    sqlReturnQueue.push([{ subscription_status: 'active' }]);
    sqlReturnQueue.push([]);
    sqlReturnQueue.push([{ handle: '+14155552671', status: 'disabled' }]);
    sqlReturnQueue.push([]);                       // opt-out check — none
    sqlReturnQueue.push([]);                       // mobile pre-check — no other channels
    sqlReturnQueue.push([]);                       // post-Twilio opt-out re-check
    sqlReturnQueue.push([{ id: 'enr-1' }]);        // UPDATE RETURNING id
    const res = await verifyPOST(adminReq({ business_id: 'biz' })); // no phone — uses row.handle
    expect(res.status).toBe(200);
    const raw = sqlCallsLog.map((c) => c.raw).join('\n');
    expect(raw).toMatch(/UPDATE channel_enrollments/);
    expect(raw).not.toMatch(/disabled_at/); // disabled_at untouched — only status + updated_at
  });

  it('409 race_conflict if UPDATE affects 0 rows (concurrent cancel/delete)', async () => {
    sqlReturnQueue.push([{ subscription_status: 'active' }]);
    sqlReturnQueue.push([]);
    sqlReturnQueue.push([{ handle: '+14155552671', status: 'disabled' }]);
    sqlReturnQueue.push([]);                       // opt-out check
    sqlReturnQueue.push([]);                       // mobile pre-check — no other channels
    sqlReturnQueue.push([]);                       // post-Twilio opt-out re-check
    sqlReturnQueue.push([]);                       // UPDATE RETURNING — empty!
    const res = await verifyPOST(adminReq({ business_id: 'biz' }));
    expect(res.status).toBe(409);
  });

  it('200 noop on pending_verification row: re-send code, no DB change', async () => {
    sqlReturnQueue.push([{ subscription_status: 'active' }]);
    sqlReturnQueue.push([]);
    sqlReturnQueue.push([{ handle: '+14155552671', status: 'pending_verification' }]);
    sqlReturnQueue.push([]);                       // opt-out check
    sqlReturnQueue.push([]);                       // mobile pre-check — no other channels
    sqlReturnQueue.push([]);                       // post-Twilio opt-out re-check
    // NO INSERT or UPDATE expected
    const res = await verifyPOST(adminReq({ business_id: 'biz' }));
    expect(res.status).toBe(200);
    const raw = sqlCallsLog.map((c) => c.raw).join('\n');
    expect(raw).not.toMatch(/INSERT INTO channel_enrollments/);
    expect(raw).not.toMatch(/UPDATE channel_enrollments/);
    expect(mockVerifyCreate).toHaveBeenCalled();
  });

  // H3: post-Twilio STOP race. The pre-Twilio opt-out check is clean, Twilio
  // Verify succeeds, but between the API roundtrip and the DB mutation, a STOP
  // webhook wrote sms_sender_opt_outs. The post-Twilio re-check must catch it
  // and return 409 sender_opted_out_during_verification instead of flipping
  // the row to pending_verification (which would overwrite unsubscribed).
  it('H3: 409 sender_opted_out_during_verification on post-Twilio STOP race', async () => {
    sqlReturnQueue.push([{ subscription_status: 'active' }]); // subscription
    sqlReturnQueue.push([]);                                    // advisory lock
    sqlReturnQueue.push([{ handle: '+14155552671', status: 'disabled' }]); // active row
    sqlReturnQueue.push([]);                                    // pre-Twilio opt-out — clean
    sqlReturnQueue.push([]);                                    // mobile pre-check — no other channels
    sqlReturnQueue.push([{ opted_out_at: new Date(), opted_in_at: null }]); // post-Twilio — opted out!
    // Verify succeeds — Twilio call happened before STOP arrived.
    mockVerifyCreate.mockResolvedValueOnce({ status: 'pending' });
    const res = await verifyPOST(adminReq({ business_id: 'biz' }));
    expect(res.status).toBe(409);
    expect((await res.json()).reason).toBe('sender_opted_out_during_verification');
    // No UPDATE should have fired — row stays in unsubscribed state the STOP set.
    const raw = sqlCallsLog.map((c) => c.raw).join('\n');
    expect(raw).not.toMatch(/UPDATE channel_enrollments/);
  });

  // H4: equal timestamps must be treated as still opted out (matches /status
  // semantics `opted_in_at > opted_out_at`). Before the fix, `<` allowed equal
  // to pass — contradiction with /status.
  it('H4: 400 sender_opt_in_required when opted_in_at == opted_out_at', async () => {
    const sameTime = new Date('2026-04-20T10:00:00Z');
    sqlReturnQueue.push([{ subscription_status: 'active' }]);
    sqlReturnQueue.push([]);
    sqlReturnQueue.push([]);                       // no active row
    sqlReturnQueue.push([{ opted_out_at: sameTime, opted_in_at: sameTime }]); // equal!
    const res = await verifyPOST(adminReq({ business_id: 'biz', phone: '+14155552671' }));
    expect(res.status).toBe(400);
    expect((await res.json()).reason).toBe('sender_opt_in_required');
    expect(mockVerifyCreate).not.toHaveBeenCalled();
  });
});

describe('POST /api/admin/channels/sms/confirm', () => {
  beforeEach(resetMocks);

  function confirmReq(body: unknown): NextRequest {
    return new NextRequest('http://localhost/api/admin/channels/sms/confirm', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Origin: APP_URL },
      body: JSON.stringify(body),
    });
  }

  it('404 when flag is off', async () => {
    process.env.CHANNELS_SMS_ENABLED = 'false';
    const res = await confirmPOST(confirmReq({ business_id: 'biz', code: '123456' }));
    expect(res.status).toBe(404);
  });

  it('400 missing_fields when code omitted', async () => {
    const res = await confirmPOST(confirmReq({ business_id: 'biz' }));
    expect(res.status).toBe(400);
    expect((await res.json()).reason).toBe('missing_fields');
  });

  it('403 when subscription not active', async () => {
    sqlReturnQueue.push([{ subscription_status: 'pending_payment' }]);
    const res = await confirmPOST(confirmReq({ business_id: 'biz', code: '123456' }));
    expect(res.status).toBe(403);
  });

  it('400 no_pending_verification when no active row', async () => {
    sqlReturnQueue.push([{ subscription_status: 'active' }]);
    sqlReturnQueue.push([]);                 // advisory lock
    sqlReturnQueue.push([]);                 // no active row
    const res = await confirmPOST(confirmReq({ business_id: 'biz', code: '123456' }));
    expect(res.status).toBe(400);
    expect((await res.json()).reason).toBe('no_pending_verification');
  });

  it('409 sender_opted_out_during_verification (mid-flow STOP race)', async () => {
    sqlReturnQueue.push([{ subscription_status: 'active' }]);
    sqlReturnQueue.push([]);
    sqlReturnQueue.push([{ handle: '+14155552671', status: 'pending_verification' }]);
    sqlReturnQueue.push([{ opted_out_at: new Date(), opted_in_at: null }]); // opted out!
    const res = await confirmPOST(confirmReq({ business_id: 'biz', code: '123456' }));
    expect(res.status).toBe(409);
    expect((await res.json()).reason).toBe('sender_opted_out_during_verification');
    expect(mockVerificationCheckCreate).not.toHaveBeenCalled();
  });

  it('409 row_not_pending when row is verified', async () => {
    sqlReturnQueue.push([{ subscription_status: 'active' }]);
    sqlReturnQueue.push([]);
    sqlReturnQueue.push([{ handle: '+14155552671', status: 'verified' }]);
    sqlReturnQueue.push([]); // opt-out check — clean
    const res = await confirmPOST(confirmReq({ business_id: 'biz', code: '123456' }));
    expect(res.status).toBe(409);
    expect((await res.json()).reason).toBe('row_not_pending');
    expect(mockVerificationCheckCreate).not.toHaveBeenCalled();
  });

  it('409 row_not_pending when row is disabled', async () => {
    sqlReturnQueue.push([{ subscription_status: 'active' }]);
    sqlReturnQueue.push([]);
    sqlReturnQueue.push([{ handle: '+14155552671', status: 'disabled' }]);
    sqlReturnQueue.push([]);
    const res = await confirmPOST(confirmReq({ business_id: 'biz', code: '123456' }));
    expect(res.status).toBe(409);
  });

  it('400 invalid_code_or_expired when Twilio returns non-approved', async () => {
    sqlReturnQueue.push([{ subscription_status: 'active' }]);
    sqlReturnQueue.push([]);
    sqlReturnQueue.push([{ handle: '+14155552671', status: 'pending_verification' }]);
    sqlReturnQueue.push([]);                 // opt-out check — clean
    mockVerificationCheckCreate.mockResolvedValueOnce({ status: 'pending' });
    const res = await confirmPOST(confirmReq({ business_id: 'biz', code: 'wrong' }));
    expect(res.status).toBe(400);
    expect((await res.json()).reason).toBe('invalid_code_or_expired');
  });

  it('200 on approved: UPDATE flips to verified + clears unsub fields', async () => {
    sqlReturnQueue.push([{ subscription_status: 'active' }]);
    sqlReturnQueue.push([]);
    sqlReturnQueue.push([{ handle: '+14155552671', status: 'pending_verification' }]);
    sqlReturnQueue.push([]);                 // opt-out check — clean
    sqlReturnQueue.push([{ id: 'enr-1' }]);  // UPDATE RETURNING
    const res = await confirmPOST(confirmReq({ business_id: 'biz', code: '123456' }));
    expect(res.status).toBe(200);
    expect((await res.json()).ok).toBe(true);
    const raw = sqlCallsLog.map((c) => c.raw).join('\n');
    expect(raw).toMatch(/UPDATE channel_enrollments/);
    expect(raw).toMatch(/status = 'verified'/);
    expect(raw).toMatch(/unsubscribed_at = NULL/);
    expect(raw).toMatch(/unsubscribed_reason = NULL/);
  });

  it('confirm does NOT touch sms_sender_opt_outs', async () => {
    sqlReturnQueue.push([{ subscription_status: 'active' }]);
    sqlReturnQueue.push([]);
    sqlReturnQueue.push([{ handle: '+14155552671', status: 'pending_verification' }]);
    // Opted back in — confirm proceeds. We then assert no writes to opt-out tables.
    sqlReturnQueue.push([
      { opted_out_at: new Date('2026-04-01'), opted_in_at: new Date('2026-04-02') },
    ]);
    sqlReturnQueue.push([{ id: 'enr-1' }]);
    await confirmPOST(confirmReq({ business_id: 'biz', code: '123456' }));
    const raw = sqlCallsLog.map((c) => c.raw).join('\n');
    expect(raw).not.toMatch(/UPDATE sms_sender_opt_outs/);
    expect(raw).not.toMatch(/INSERT INTO sms_sender_opt_outs/);
    expect(raw).not.toMatch(/INSERT INTO sms_sender_opt_out_events/);
  });

  it('409 race_conflict if UPDATE affects 0 rows', async () => {
    sqlReturnQueue.push([{ subscription_status: 'active' }]);
    sqlReturnQueue.push([]);
    sqlReturnQueue.push([{ handle: '+14155552671', status: 'pending_verification' }]);
    sqlReturnQueue.push([]);
    sqlReturnQueue.push([]); // UPDATE RETURNING — empty (concurrent cancel)
    const res = await confirmPOST(confirmReq({ business_id: 'biz', code: '123456' }));
    expect(res.status).toBe(409);
  });

  // H4: equal timestamps treated as still opted out (matches /verify + /status).
  it('H4: 409 sender_opted_out_during_verification when opted_in_at == opted_out_at', async () => {
    const sameTime = new Date('2026-04-20T10:00:00Z');
    sqlReturnQueue.push([{ subscription_status: 'active' }]);
    sqlReturnQueue.push([]);
    sqlReturnQueue.push([{ handle: '+14155552671', status: 'pending_verification' }]);
    sqlReturnQueue.push([{ opted_out_at: sameTime, opted_in_at: sameTime }]); // equal!
    const res = await confirmPOST(confirmReq({ business_id: 'biz', code: '123456' }));
    expect(res.status).toBe(409);
    expect((await res.json()).reason).toBe('sender_opted_out_during_verification');
    expect(mockVerificationCheckCreate).not.toHaveBeenCalled();
  });
});

describe('POST /api/admin/channels/sms/cancel', () => {
  beforeEach(resetMocks);

  function cancelReq(body: unknown): NextRequest {
    return new NextRequest('http://localhost/api/admin/channels/sms/cancel', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Origin: APP_URL },
      body: JSON.stringify(body),
    });
  }

  it('404 when flag off', async () => {
    process.env.CHANNELS_SMS_ENABLED = 'false';
    const res = await cancelPOST(cancelReq({ business_id: 'biz' }));
    expect(res.status).toBe(404);
  });

  it('400 business_id_required when missing', async () => {
    const res = await cancelPOST(cancelReq({}));
    expect(res.status).toBe(400);
  });

  it('403 when subscription not active', async () => {
    sqlReturnQueue.push([{ subscription_status: 'pending_payment' }]);
    const res = await cancelPOST(cancelReq({ business_id: 'biz' }));
    expect(res.status).toBe(403);
  });

  it('200 issues the state-revert CTE (UPDATE + DELETE subquery)', async () => {
    sqlReturnQueue.push([{ subscription_status: 'active' }]);
    sqlReturnQueue.push([]); // advisory lock
    sqlReturnQueue.push([]); // CTE result (empty — no active rows)
    const res = await cancelPOST(cancelReq({ business_id: 'biz' }));
    expect(res.status).toBe(200);
    expect((await res.json()).ok).toBe(true);

    const raw = sqlCallsLog.map(c => c.raw).join('\n');
    expect(raw).toMatch(/WITH reverted AS/);
    expect(raw).toMatch(/UPDATE channel_enrollments/);
    expect(raw).toMatch(/CASE\s+WHEN unsubscribed_at IS NOT NULL THEN 'unsubscribed'/);
    expect(raw).toMatch(/WHEN disabled_at\s+IS NOT NULL THEN 'disabled'/);
    expect(raw).toMatch(/WHEN verified_at\s+IS NOT NULL THEN 'verified'/);
    expect(raw).toMatch(/DELETE FROM channel_enrollments/);
    expect(raw).toMatch(/WHERE id IN \(SELECT id FROM reverted WHERE status = 'pending_verification'\)/);
    expect(raw).toMatch(/archived_at IS NULL/);
    expect(raw).toMatch(/status = 'pending_verification'/);
  });

  it('does NOT touch sms_sender_opt_outs or sms_sender_opt_out_events', async () => {
    sqlReturnQueue.push([{ subscription_status: 'active' }]);
    sqlReturnQueue.push([]);
    sqlReturnQueue.push([]);
    await cancelPOST(cancelReq({ business_id: 'biz' }));
    const raw = sqlCallsLog.map(c => c.raw).join('\n');
    expect(raw).not.toMatch(/sms_sender_opt_outs/);
    expect(raw).not.toMatch(/sms_sender_opt_out_events/);
  });

  it('acquires advisory lock scoped to account_id (not business_id)', async () => {
    sqlReturnQueue.push([{ subscription_status: 'active', account_id: 'acct-9' }]);
    sqlReturnQueue.push([]);
    sqlReturnQueue.push([]);
    await cancelPOST(cancelReq({ business_id: 'biz-42' }));
    const lockCall = sqlCallsLog.find(c => /pg_advisory_xact_lock/.test(c.raw));
    expect(lockCall).toBeDefined();
    expect(lockCall!.values).toContain('mobile_enroll:acct-9');
    expect(lockCall!.values).not.toContain('mobile_enroll:biz-42');
  });
});

describe('POST /api/admin/channels/sms/disable', () => {
  beforeEach(resetMocks);

  function disableReq(body: unknown): NextRequest {
    return new NextRequest('http://localhost/api/admin/channels/sms/disable', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Origin: APP_URL },
      body: JSON.stringify(body),
    });
  }

  it('404 when flag off', async () => {
    process.env.CHANNELS_SMS_ENABLED = 'false';
    const res = await disablePOST(disableReq({ business_id: 'biz' }));
    expect(res.status).toBe(404);
  });

  it('200 UPDATEs verified → disabled', async () => {
    sqlReturnQueue.push([{ subscription_status: 'active' }]);
    sqlReturnQueue.push([]);                // advisory lock
    sqlReturnQueue.push([{ id: 'enr-1' }]); // UPDATE RETURNING
    const res = await disablePOST(disableReq({ business_id: 'biz' }));
    expect(res.status).toBe(200);
    const raw = sqlCallsLog.map(c => c.raw).join('\n');
    expect(raw).toMatch(/UPDATE channel_enrollments/);
    expect(raw).toMatch(/status = 'disabled'/);
    expect(raw).toMatch(/disabled_at = NOW\(\)/);
    expect(raw).toMatch(/status = 'verified'/);   // WHERE guard
    expect(raw).toMatch(/archived_at IS NULL/);
  });

  it('409 not_verified when row is not in verified state', async () => {
    sqlReturnQueue.push([{ subscription_status: 'active' }]);
    sqlReturnQueue.push([]);
    sqlReturnQueue.push([]);                // UPDATE RETURNING — empty
    const res = await disablePOST(disableReq({ business_id: 'biz' }));
    expect(res.status).toBe(409);
    expect((await res.json()).reason).toBe('not_verified');
  });
});

describe('POST /api/admin/channels/sms/delete', () => {
  beforeEach(resetMocks);

  function deleteReq(body: unknown): NextRequest {
    return new NextRequest('http://localhost/api/admin/channels/sms/delete', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Origin: APP_URL },
      body: JSON.stringify(body),
    });
  }

  it('404 when flag off', async () => {
    process.env.CHANNELS_SMS_ENABLED = 'false';
    const res = await deletePOST(deleteReq({ business_id: 'biz', confirm: true }));
    expect(res.status).toBe(404);
  });

  it('400 confirmation_required when confirm missing', async () => {
    const res = await deletePOST(deleteReq({ business_id: 'biz' }));
    expect(res.status).toBe(400);
    expect((await res.json()).reason).toBe('confirmation_required');
  });

  it('400 confirmation_required when confirm is false', async () => {
    const res = await deletePOST(deleteReq({ business_id: 'biz', confirm: false }));
    expect(res.status).toBe(400);
    expect((await res.json()).reason).toBe('confirmation_required');
  });

  it('400 confirmation_required when confirm is a truthy non-true value', async () => {
    // Strict true check — catches typos like confirm: 'true' string.
    const res = await deletePOST(deleteReq({ business_id: 'biz', confirm: 'true' }));
    expect(res.status).toBe(400);
  });

  it('200 soft-deletes: UPDATE with archived_at + archive_reason', async () => {
    sqlReturnQueue.push([{ subscription_status: 'active' }]);
    sqlReturnQueue.push([]);                // advisory lock
    sqlReturnQueue.push([]);                // UPDATE
    const res = await deletePOST(deleteReq({ business_id: 'biz', confirm: true }));
    expect(res.status).toBe(200);
    const raw = sqlCallsLog.map(c => c.raw).join('\n');
    expect(raw).toMatch(/UPDATE channel_enrollments/);
    expect(raw).toMatch(/archived_at = NOW\(\)/);
    expect(raw).toMatch(/archive_reason = 'admin_delete'/);
    expect(raw).toMatch(/archived_at IS NULL/); // WHERE guard
  });

  it('does NOT touch sms_sender_opt_outs or audit events (TCPA retention)', async () => {
    sqlReturnQueue.push([{ subscription_status: 'active' }]);
    sqlReturnQueue.push([]);
    sqlReturnQueue.push([]);
    await deletePOST(deleteReq({ business_id: 'biz', confirm: true }));
    const raw = sqlCallsLog.map(c => c.raw).join('\n');
    expect(raw).not.toMatch(/sms_sender_opt_outs/);
    expect(raw).not.toMatch(/sms_sender_opt_out_events/);
  });

  it('does NOT delete channel_enrollments (soft-delete only)', async () => {
    sqlReturnQueue.push([{ subscription_status: 'active' }]);
    sqlReturnQueue.push([]);
    sqlReturnQueue.push([]);
    await deletePOST(deleteReq({ business_id: 'biz', confirm: true }));
    const raw = sqlCallsLog.map(c => c.raw).join('\n');
    expect(raw).not.toMatch(/DELETE FROM channel_enrollments/);
  });
});

describe('GET /api/admin/channels/sms/status', () => {
  beforeEach(resetMocks);

  function statusReq(businessId?: string): NextRequest {
    const url = businessId
      ? `http://localhost/api/admin/channels/sms/status?business_id=${businessId}`
      : 'http://localhost/api/admin/channels/sms/status';
    return new NextRequest(url, { method: 'GET' });
  }

  it('404 when flag off', async () => {
    process.env.CHANNELS_SMS_ENABLED = 'false';
    const res = await statusGET(statusReq('biz'));
    expect(res.status).toBe(404);
  });

  it('400 business_id_required when missing', async () => {
    const res = await statusGET(statusReq());
    expect(res.status).toBe(400);
  });

  it('returns enrollment:null when no active row', async () => {
    sqlReturnQueue.push([]); // empty result set
    const res = await statusGET(statusReq('biz'));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ enrollment: null });
  });

  it('returns enrollment with sender_opt_in_cleared=true when opted back in', async () => {
    sqlReturnQueue.push([{
      status: 'verified',
      handle: '+14155552671',
      verified_at: new Date('2026-04-15'),
      disabled_at: null,
      unsubscribed_at: null,
      unsubscribed_reason: null,
      archived_at: null,
      sender_opt_in_cleared: true,
    }]);
    const res = await statusGET(statusReq('biz'));
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.enrollment.sender_opt_in_cleared).toBe(true);
    expect(json.enrollment.status).toBe('verified');
  });

  it('query uses LEFT JOIN scoped to TWILIO_MESSAGING_SERVICE_SID', async () => {
    sqlReturnQueue.push([]);
    await statusGET(statusReq('biz-42'));
    const queryCall = sqlCallsLog.find(c => /channel_enrollments/.test(c.raw))!;
    expect(queryCall.raw).toMatch(/LEFT JOIN sms_sender_opt_outs so/);
    expect(queryCall.raw).toMatch(/so\.messaging_service_sid = /);
    expect(queryCall.values).toContain('MGtest'); // from resetMocks()
    expect(queryCall.values).toContain('biz-42');
  });

  it('query filters archived rows (archived_at IS NULL)', async () => {
    sqlReturnQueue.push([]);
    await statusGET(statusReq('biz'));
    const queryCall = sqlCallsLog.find(c => /channel_enrollments/.test(c.raw))!;
    expect(queryCall.raw).toMatch(/ce\.archived_at IS NULL/);
    expect(queryCall.raw).toMatch(/LIMIT 1/);
  });

  it('derived sender_opt_in_cleared CASE uses opted_in_at > opted_out_at', async () => {
    sqlReturnQueue.push([]);
    await statusGET(statusReq('biz'));
    const queryCall = sqlCallsLog.find(c => /sender_opt_in_cleared/.test(c.raw))!;
    expect(queryCall.raw).toMatch(/WHEN so\.handle IS NULL THEN TRUE/);
    expect(queryCall.raw).toMatch(/WHEN so\.opted_in_at IS NOT NULL AND so\.opted_in_at > so\.opted_out_at THEN TRUE/);
    expect(queryCall.raw).toMatch(/ELSE FALSE/);
  });
});

// ── Account-scoped enrollment lock + cross-channel precheck ───────────
// Regression for docs/known-issues.md "ACTIVE: Admin SMS lock + cross-channel
// precheck still business-scoped". The mobile-enrollment advisory lock and the
// SMS verify cross-channel precheck must be keyed by the billing-parent
// account_id (matching Telegram/WhatsApp admin routes), NOT the per-location
// business_id. Otherwise on a multi-location account, SMS verify for L2 fails
// to mutually exclude — and fails to see — an account-scoped Telegram/WhatsApp
// org-default created under L1, so the precheck misses and the duplicate is
// only caught late by the one_mobile_per_scope unique index after a Twilio
// Verify SMS has already been dispatched.
describe('SMS admin routes: account-scoped enrollment lock', () => {
  beforeEach(resetMocks);

  function reqFor(path: string, body: unknown): NextRequest {
    return new NextRequest(`http://localhost/api/admin/channels/sms/${path}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Origin: APP_URL },
      body: JSON.stringify(body),
    });
  }

  // Each route resolves the account_id from the subscription lookup (which
  // already JOINs accounts) and uses it for the lock key. The subscription
  // lookup row therefore carries account_id alongside subscription_status.
  const cases: Array<{ name: string; run: () => Promise<Response> }> = [
    {
      name: 'verify',
      run: () => {
        sqlReturnQueue.push([{ subscription_status: 'active', account_id: 'acct-7' }]); // sub + account
        sqlReturnQueue.push([]); // advisory lock
        sqlReturnQueue.push([]); // active-row SELECT — none
        sqlReturnQueue.push([]); // opt-out — clean
        sqlReturnQueue.push([]); // cross-channel precheck — none
        sqlReturnQueue.push([]); // post-Twilio opt-out re-check
        sqlReturnQueue.push([]); // INSERT
        return verifyPOST(reqFor('verify', { business_id: 'biz-L2', phone: '+14155552671' }));
      },
    },
    {
      name: 'confirm',
      run: () => {
        sqlReturnQueue.push([{ subscription_status: 'active', account_id: 'acct-7' }]);
        sqlReturnQueue.push([]); // advisory lock
        sqlReturnQueue.push([{ handle: '+14155552671', status: 'pending_verification' }]);
        sqlReturnQueue.push([]); // opt-out — clean
        sqlReturnQueue.push([{ id: 'enr-1' }]); // UPDATE RETURNING
        return confirmPOST(reqFor('confirm', { business_id: 'biz-L2', code: '123456' }));
      },
    },
    {
      name: 'cancel',
      run: () => {
        sqlReturnQueue.push([{ subscription_status: 'active', account_id: 'acct-7' }]);
        sqlReturnQueue.push([]); // advisory lock
        sqlReturnQueue.push([]); // CTE
        return cancelPOST(reqFor('cancel', { business_id: 'biz-L2' }));
      },
    },
    {
      name: 'disable',
      run: () => {
        sqlReturnQueue.push([{ subscription_status: 'active', account_id: 'acct-7' }]);
        sqlReturnQueue.push([]); // advisory lock
        sqlReturnQueue.push([{ id: 'enr-1' }]); // UPDATE RETURNING
        return disablePOST(reqFor('disable', { business_id: 'biz-L2' }));
      },
    },
    {
      name: 'delete',
      run: () => {
        sqlReturnQueue.push([{ subscription_status: 'active', account_id: 'acct-7' }]);
        sqlReturnQueue.push([]); // advisory lock
        sqlReturnQueue.push([]); // UPDATE
        return deletePOST(reqFor('delete', { business_id: 'biz-L2', confirm: true }));
      },
    },
  ];

  for (const c of cases) {
    it(`${c.name}: advisory lock keyed by account_id, never business_id`, async () => {
      await c.run();
      const lockCall = sqlCallsLog.find((call) => /pg_advisory_xact_lock/.test(call.raw));
      expect(lockCall).toBeDefined();
      expect(lockCall!.values).toContain('mobile_enroll:acct-7');
      expect(lockCall!.values).not.toContain('mobile_enroll:biz-L2');
    });
  }
});

describe('SMS verify: account-scoped cross-channel precheck', () => {
  beforeEach(resetMocks);

  function verifyReq(body: unknown): NextRequest {
    return new NextRequest('http://localhost/api/admin/channels/sms/verify', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Origin: APP_URL },
      body: JSON.stringify(body),
    });
  }

  it('409 multiple_mobile_channels when an account-scoped Telegram org-default exists (created under another location)', async () => {
    sqlReturnQueue.push([{ subscription_status: 'active', account_id: 'acct-7' }]); // sub + account
    sqlReturnQueue.push([]); // advisory lock
    sqlReturnQueue.push([]); // active SMS row — none for L2
    sqlReturnQueue.push([]); // opt-out — clean
    sqlReturnQueue.push([{ channel: 'telegram' }]); // cross-channel precheck — L1 org-default seen
    const res = await verifyPOST(verifyReq({ business_id: 'biz-L2', phone: '+14155552671' }));
    expect(res.status).toBe(409);
    expect((await res.json()).reason).toBe('multiple_mobile_channels');
    // No Twilio Verify SMS should have been dispatched — the precheck caught it.
    expect(mockVerifyCreate).not.toHaveBeenCalled();
  });

  it('cross-channel precheck queries by account_id + location_id IS NULL, not business_id', async () => {
    sqlReturnQueue.push([{ subscription_status: 'active', account_id: 'acct-7' }]);
    sqlReturnQueue.push([]); // advisory lock
    sqlReturnQueue.push([]); // active SMS row — none
    sqlReturnQueue.push([]); // opt-out — clean
    sqlReturnQueue.push([]); // cross-channel precheck — none
    sqlReturnQueue.push([]); // post-Twilio opt-out re-check
    sqlReturnQueue.push([]); // INSERT
    await verifyPOST(verifyReq({ business_id: 'biz-L2', phone: '+14155552671' }));
    const precheck = sqlCallsLog.find(
      (c) => /channel IN \('telegram', 'whatsapp'\)/.test(c.raw),
    );
    expect(precheck).toBeDefined();
    expect(precheck!.raw).toMatch(/account_id = /);
    expect(precheck!.raw).toMatch(/location_id IS NULL/);
    expect(precheck!.raw).not.toMatch(/business_id = /);
    expect(precheck!.values).toContain('acct-7');
    expect(precheck!.values).not.toContain('biz-L2');
  });
});
