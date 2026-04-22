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
//     inside withSmsEnrollmentLock land in the same log.
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

function adminReq(body: unknown): NextRequest {
  return new NextRequest('http://localhost/api/admin/channels/sms/verify', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
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
    businessId: null,
    name: 'Admin',
    email: 'a@b.com',
  });
  mockVerifyCreate.mockReset();
  mockVerifyCreate.mockResolvedValue({ status: 'pending' });
  mockVerificationCheckCreate.mockReset();
  mockVerificationCheckCreate.mockResolvedValue({ status: 'approved' });
  process.env.CHANNELS_SMS_ENABLED = 'true';
  process.env.TWILIO_ACCOUNT_SID = 'ACtest';
  process.env.TWILIO_AUTH_TOKEN = 't';
  process.env.TWILIO_MESSAGING_SERVICE_SID = 'MGtest';
  process.env.TWILIO_VERIFY_SERVICE_SID = 'VAtest';
}

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
    sqlReturnQueue.push([]);
    sqlReturnQueue.push([]);                       // UPDATE RETURNING — empty!
    const res = await verifyPOST(adminReq({ business_id: 'biz' }));
    expect(res.status).toBe(409);
  });

  it('200 noop on pending_verification row: re-send code, no DB change', async () => {
    sqlReturnQueue.push([{ subscription_status: 'active' }]);
    sqlReturnQueue.push([]);
    sqlReturnQueue.push([{ handle: '+14155552671', status: 'pending_verification' }]);
    sqlReturnQueue.push([]);                       // opt-out check
    // NO INSERT or UPDATE expected
    const res = await verifyPOST(adminReq({ business_id: 'biz' }));
    expect(res.status).toBe(200);
    const raw = sqlCallsLog.map((c) => c.raw).join('\n');
    expect(raw).not.toMatch(/INSERT INTO channel_enrollments/);
    expect(raw).not.toMatch(/UPDATE channel_enrollments/);
    expect(mockVerifyCreate).toHaveBeenCalled();
  });
});

describe('POST /api/admin/channels/sms/confirm', () => {
  beforeEach(resetMocks);

  function confirmReq(body: unknown): NextRequest {
    return new NextRequest('http://localhost/api/admin/channels/sms/confirm', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
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
});

describe('POST /api/admin/channels/sms/cancel', () => {
  beforeEach(resetMocks);

  function cancelReq(body: unknown): NextRequest {
    return new NextRequest('http://localhost/api/admin/channels/sms/cancel', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
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

  it('acquires advisory lock scoped to business_id', async () => {
    sqlReturnQueue.push([{ subscription_status: 'active' }]);
    sqlReturnQueue.push([]);
    sqlReturnQueue.push([]);
    await cancelPOST(cancelReq({ business_id: 'biz-42' }));
    const lockCall = sqlCallsLog.find(c => /pg_advisory_xact_lock/.test(c.raw));
    expect(lockCall).toBeDefined();
    expect(lockCall!.values).toContain('sms_enroll:biz-42');
  });
});
