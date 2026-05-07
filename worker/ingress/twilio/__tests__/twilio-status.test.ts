// worker/ingress/__tests__/twilio-status.test.ts
//
// Unit tests for the Twilio statusCallback handler.
//
// DB strategy: the SQL client is mocked via `vi.mock('@/lib/db/server', ...)`
// with a queue-based mockSql. Each test pushes the return values it expects
// the handler to see (in order), then asserts on the captured SQL calls and
// the Fastify reply. This mirrors worker/__tests__/resend-webhook-bounce.test.ts
// because vitest.setup.ts points DATABASE_POOL_URL at a dummy host — there is
// no real Postgres available to the Vitest run.

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { buildStatusRequest, joinSql } from '../../test-helpers';

// Mock SQL: queue-based returns. The mock returns whatever the test pushes,
// VERBATIM (no wrapping), so tests that need Postgres.js's "array with .count"
// shape can push `Object.assign([], { count: 1 })`. This mirrors
// worker/__tests__/webhook-dedup.test.ts — NOT the simpler wrapping mock in
// resend-webhook-bounce.test.ts, because we need to exercise both the
// count===0 (conflict) and count>0 (claimed) branches of claimInboundEvent.
const { sqlReturnQueue, mockSql } = vi.hoisted(() => {
  const sqlReturnQueue: unknown[] = [];
  const mockSql = vi.fn((_s: TemplateStringsArray, ..._v: unknown[]) => {
    const result = sqlReturnQueue.shift();
    if (result !== undefined) return Promise.resolve(result);
    // Default: empty result set with count=0 (no rows affected).
    const empty: unknown[] & { count: number } = Object.assign([], { count: 0 });
    return Promise.resolve(empty);
  });
  return { sqlReturnQueue, mockSql };
});

vi.mock('../../../../src/lib/db/server', () => ({
  sql: mockSql,
  jsonb: (v: unknown) => v,
}));

// Import AFTER the mock is registered.
import { handleTwilioStatusCallback } from '../twilio';

// Shape-cast for the Fastify request/reply contract used by the handler.
// The handler only reads .rawBody, .url, .headers and calls reply.status().send().
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyReq = any;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyReply = any;

/** Postgres.js INSERT result shape: array with a `.count` property. */
function insertClaimed(): unknown[] & { count: number } {
  return Object.assign([], { count: 1 });
}

function insertConflict(): unknown[] & { count: number } {
  return Object.assign([], { count: 0 });
}

describe('handleTwilioStatusCallback', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    sqlReturnQueue.length = 0;
  });

  it('401 on invalid signature (no DB side-effects)', async () => {
    const { req, reply } = buildStatusRequest(
      { MessageSid: 'SM_bad_sig', MessageStatus: 'delivered' },
      { invalidSig: true },
    );
    await handleTwilioStatusCallback(req as AnyReq, reply as AnyReply);
    expect(reply.statusCode).toBe(401);
    expect(mockSql).not.toHaveBeenCalled();
  });

  it('delivered -> sets delivered_at', async () => {
    // claim: INSERT succeeds (not a duplicate)
    sqlReturnQueue.push(insertClaimed());
    // SELECT notification_deliveries — row exists, non-terminal
    sqlReturnQueue.push([{ id: 'delivery-1', delivered_at: null, failed_at: null }]);
    // UPDATE notification_deliveries
    sqlReturnQueue.push([]);
    // UPDATE inbound_events -> processed
    sqlReturnQueue.push([]);

    const { req, reply } = buildStatusRequest({
      MessageSid: 'SM_deliv_1',
      MessageStatus: 'delivered',
    });
    await handleTwilioStatusCallback(req as AnyReq, reply as AnyReply);

    expect(reply.statusCode).toBe(200);

    const joined = joinSql(mockSql.mock.calls);
    expect(joined).toContain('UPDATE notification_deliveries');
    expect(joined).toContain('delivered_at = NOW()');
    // Race-safe inline guard must be present
    expect(joined).toContain('delivered_at IS NULL AND failed_at IS NULL');
    const updateCall = mockSql.mock.calls.find((c) => {
      const raw = (c[0] as TemplateStringsArray).raw.join('');
      return raw.includes('UPDATE notification_deliveries') && raw.includes('delivered_at = NOW()');
    });
    expect(updateCall?.[2]).toBe('sms');
  });

  it('failed with ErrorCode -> sets failed_at + failure_reason=twilio:<code>', async () => {
    sqlReturnQueue.push(insertClaimed());
    sqlReturnQueue.push([{ id: 'delivery-1', delivered_at: null, failed_at: null }]);
    sqlReturnQueue.push([]); // UPDATE notification_deliveries
    sqlReturnQueue.push([]); // UPDATE inbound_events

    const { req, reply } = buildStatusRequest({
      MessageSid: 'SM_fail_1',
      MessageStatus: 'failed',
      ErrorCode: '30006',
    });
    await handleTwilioStatusCallback(req as AnyReq, reply as AnyReply);

    expect(reply.statusCode).toBe(200);

    const updateCall = mockSql.mock.calls.find((c) => {
      const raw = (c[0] as TemplateStringsArray).raw.join('');
      return raw.includes('UPDATE notification_deliveries') && raw.includes('failed_at = NOW()');
    });
    expect(updateCall).toBeDefined();
    // Tagged-template args: [strings, ...values]. Order of ${} in the SQL:
    //   1. failure_reason literal  2. row.id   -> failure_reason is values[0] = index 1
    const reasonValue = updateCall ? (updateCall[1] as string) : '';
    expect(reasonValue).toBe('twilio:30006');
  });

  it('undelivered without ErrorCode -> failure_reason=twilio:unknown', async () => {
    sqlReturnQueue.push(insertClaimed());
    sqlReturnQueue.push([{ id: 'delivery-1', delivered_at: null, failed_at: null }]);
    sqlReturnQueue.push([]);
    sqlReturnQueue.push([]);

    const { req, reply } = buildStatusRequest({
      MessageSid: 'SM_undel',
      MessageStatus: 'undelivered',
    });
    await handleTwilioStatusCallback(req as AnyReq, reply as AnyReply);

    expect(reply.statusCode).toBe(200);
    const updateCall = mockSql.mock.calls.find((c) => {
      const raw = (c[0] as TemplateStringsArray).raw.join('');
      return raw.includes('UPDATE notification_deliveries') && raw.includes('failed_at = NOW()');
    });
    // failure_reason is the FIRST ${} in the SQL (before row.id) -> values[0] = index 1
    const reasonValue = updateCall ? (updateCall[1] as string) : '';
    expect(reasonValue).toBe('twilio:unknown');
  });

  it('intermediate queued status: 200 no-op even without delivery row', async () => {
    // claim: INSERT succeeds
    sqlReturnQueue.push(insertClaimed());
    // UPDATE inbound_events -> processed (no delivery-row lookup!)
    sqlReturnQueue.push([]);

    const { req, reply } = buildStatusRequest({
      MessageSid: 'SM_queued_only',
      MessageStatus: 'queued',
    });
    await handleTwilioStatusCallback(req as AnyReq, reply as AnyReply);

    expect(reply.statusCode).toBe(200);

    const joined = joinSql(mockSql.mock.calls);
    // Must NOT have queried notification_deliveries for intermediate states
    expect(joined).not.toContain('SELECT id, delivered_at, failed_at FROM notification_deliveries');
    expect(joined).not.toContain('UPDATE notification_deliveries');
    // But must have transitioned the inbound_event to processed
    expect(joined).toContain('UPDATE inbound_events');
    expect(joined).toContain("status = 'processed'");
  });

  it('intermediate sent status: 200 no-op', async () => {
    sqlReturnQueue.push(insertClaimed());
    sqlReturnQueue.push([]); // UPDATE inbound_events

    const { req, reply } = buildStatusRequest({
      MessageSid: 'SM_sent_stage',
      MessageStatus: 'sent',
    });
    await handleTwilioStatusCallback(req as AnyReq, reply as AnyReply);

    expect(reply.statusCode).toBe(200);
    const joined = joinSql(mockSql.mock.calls);
    expect(joined).not.toContain('UPDATE notification_deliveries');
  });

  it('terminal status + missing delivery row -> 503 + inbound_event marked failed (for dedup reclaim)', async () => {
    sqlReturnQueue.push(insertClaimed()); // claim
    sqlReturnQueue.push([]); // SELECT notification_deliveries -> no row
    sqlReturnQueue.push([]); // UPDATE inbound_events -> failed

    const { req, reply } = buildStatusRequest({
      MessageSid: 'SM_missing_row',
      MessageStatus: 'delivered',
    });
    await handleTwilioStatusCallback(req as AnyReq, reply as AnyReply);

    expect(reply.statusCode).toBe(503);
    expect(reply.sentBody).toMatchObject({ retry: 'delivery_row_not_yet_present' });

    // The inbound_event must be marked failed with the specific error_message
    // 'delivery_row_not_yet_present' so the dedup-reclaim branch
    // (status='failed') picks it up on retry.
    const failCall = mockSql.mock.calls.find((c) => {
      const raw = (c[0] as TemplateStringsArray).raw.join('');
      return (
        raw.includes('UPDATE inbound_events') &&
        raw.includes("status = 'failed'") &&
        raw.includes('error_message =')
      );
    });
    expect(failCall).toBeDefined();
    expect(failCall?.[1]).toBe('delivery_row_not_yet_present');
  });

  it('dedup: second call with same MessageSid+MessageStatus returns 200 duplicate', async () => {
    // First call: normal delivered path
    sqlReturnQueue.push(insertClaimed());
    sqlReturnQueue.push([{ id: 'delivery-1', delivered_at: null, failed_at: null }]);
    sqlReturnQueue.push([]);
    sqlReturnQueue.push([]);

    const a = buildStatusRequest({ MessageSid: 'SM_dedup', MessageStatus: 'delivered' });
    await handleTwilioStatusCallback(a.req as AnyReq, a.reply as AnyReply);
    expect(a.reply.statusCode).toBe(200);

    // Second call: INSERT returns count=0 (conflict) AND reclaim returns [] (row is 'processed')
    sqlReturnQueue.push(insertConflict()); // INSERT conflict
    sqlReturnQueue.push([]); // UPDATE reclaim returns no rows -> duplicate

    const b = buildStatusRequest({ MessageSid: 'SM_dedup', MessageStatus: 'delivered' });
    await handleTwilioStatusCallback(b.req as AnyReq, b.reply as AnyReply);

    expect(b.reply.statusCode).toBe(200);
    expect(b.reply.sentBody).toMatchObject({ duplicate: true });
  });

  it('first-wins terminal: delivered then failed keeps delivered_at, ignores failed', async () => {
    // First: delivered lands
    sqlReturnQueue.push(insertClaimed());
    sqlReturnQueue.push([{ id: 'delivery-1', delivered_at: null, failed_at: null }]);
    sqlReturnQueue.push([]); // UPDATE notification_deliveries
    sqlReturnQueue.push([]); // UPDATE inbound_events

    const a = buildStatusRequest({ MessageSid: 'SM_first_wins', MessageStatus: 'delivered' });
    await handleTwilioStatusCallback(a.req as AnyReq, a.reply as AnyReply);
    expect(a.reply.statusCode).toBe(200);

    // Second: failed arrives with a DIFFERENT MessageStatus (so new dedup key),
    // SELECT now finds the row with delivered_at set -> first-wins branch.
    sqlReturnQueue.push(insertClaimed()); // new claim (different dedup key)
    sqlReturnQueue.push([
      { id: 'delivery-1', delivered_at: new Date('2026-04-21T00:00:00Z'), failed_at: null },
    ]);
    sqlReturnQueue.push([]); // UPDATE inbound_events -> processed (NO notification_deliveries update)

    const b = buildStatusRequest({
      MessageSid: 'SM_first_wins',
      MessageStatus: 'failed',
      ErrorCode: '30003',
    });
    const sqlCallsBefore = mockSql.mock.calls.length;
    await handleTwilioStatusCallback(b.req as AnyReq, b.reply as AnyReply);

    expect(b.reply.statusCode).toBe(200);
    expect(b.reply.sentBody).toMatchObject({ terminal_state_preserved: true });

    // Exactly 3 new SQL calls: claim INSERT, SELECT, UPDATE inbound_events
    // (NO UPDATE notification_deliveries — that's the first-wins guarantee)
    const newCalls = mockSql.mock.calls.slice(sqlCallsBefore);
    expect(newCalls).toHaveLength(3);
    const newRawJoined = newCalls
      .flatMap((c) => (c[0] as TemplateStringsArray).raw)
      .join(' ');
    expect(newRawJoined).not.toContain('UPDATE notification_deliveries');
  });

  it('missing required fields -> 400', async () => {
    // No MessageSid at all.
    const { req, reply } = buildStatusRequest({ MessageStatus: 'delivered' });
    await handleTwilioStatusCallback(req as AnyReq, reply as AnyReply);
    expect(reply.statusCode).toBe(400);
    // Handler must short-circuit BEFORE touching the DB.
    expect(mockSql).not.toHaveBeenCalled();
  });
});
