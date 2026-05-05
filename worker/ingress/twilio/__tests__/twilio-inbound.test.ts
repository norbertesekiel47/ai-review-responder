// worker/ingress/__tests__/twilio-inbound.test.ts
//
// Unit tests for the Twilio inbound SMS handler (STOP/START + miscellaneous).
//
// DB strategy mirrors twilio-status.test.ts: the SQL client is mocked via
// `vi.mock('@/lib/db/server', ...)` with a queue-based mockSql. Each test
// pushes the return values it expects the handler to see (in order), then
// asserts on the captured SQL calls and the Fastify reply.
//
// The one twist here is `sql.begin`: the handler opens a transaction to
// atomically upsert opt_outs + audit event + flip enrollments. The mock's
// .begin passes the same mockSql instance back as `tx`, so the nested
// tx`...` calls land in the SAME sqlCallsLog queue in source order.

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { buildInboundRequest } from '../../test-helpers';

const { sqlCallsLog, sqlReturnQueue, mockSql } = vi.hoisted(() => {
  const sqlCallsLog: Array<{ raw: string; values: unknown[] }> = [];
  const sqlReturnQueue: unknown[] = [];
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const mockSql: any = vi.fn((strings: TemplateStringsArray, ...values: unknown[]) => {
    sqlCallsLog.push({ raw: strings.join('?'), values });
    const next = sqlReturnQueue.shift();
    const result = Array.isArray(next) ? next : [];
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const asArray: any = result;
    // Mirror Postgres.js `.count` for INSERT results.
    if (next && typeof next === 'object' && 'count' in (next as object)) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      Object.assign(asArray, { count: (next as any).count });
    }
    return Promise.resolve(asArray);
  });
  mockSql.begin = vi.fn(async (cb: (tx: typeof mockSql) => Promise<unknown>) => cb(mockSql));
  return { sqlCallsLog, sqlReturnQueue, mockSql };
});

vi.mock('../../../../src/lib/db/server', () => ({
  sql: mockSql,
  jsonb: (x: unknown) => x,
}));

// Import AFTER the mock is registered.
import { handleTwilioInbound } from '../twilio';

// Shape-cast for the Fastify request/reply contract used by the handler.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyReq = any;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyReply = any;

describe('handleTwilioInbound', () => {
  beforeEach(() => {
    sqlCallsLog.length = 0;
    sqlReturnQueue.length = 0;
    mockSql.mockClear();
    mockSql.begin.mockClear();
  });

  it('401 on invalid signature', async () => {
    const { req, reply } = buildInboundRequest(
      {
        From: '+15551234567',
        To: '+15550001111',
        Body: 'STOP',
        MessageSid: 'SM_bad',
        MessagingServiceSid: 'MGtest',
      },
      { invalidSig: true },
    );
    await handleTwilioInbound(req as AnyReq, reply as AnyReply);
    expect(reply.statusCode).toBe(401);
    expect(sqlCallsLog).toHaveLength(0);
  });

  it('400 on missing MessageSid', async () => {
    const { req, reply } = buildInboundRequest({ From: '+15551234567', Body: 'STOP' });
    await handleTwilioInbound(req as AnyReq, reply as AnyReply);
    expect(reply.statusCode).toBe(400);
  });

  it('STOP via OptOutType: upserts sms_sender_opt_outs, writes audit event, flips matching enrollments', async () => {
    // Return queue order matches SQL call order:
    // 1. INSERT inbound_events  -> {count:1} (claimed)
    // 2. SELECT id FROM inbound_events -> [{id}]
    // 3. sql.begin starts; inside:
    //    3a. UPSERT sms_sender_opt_outs
    //    3b. INSERT sms_sender_opt_out_events
    //    3c. UPDATE channel_enrollments
    // 4. UPDATE inbound_events status=processed
    sqlReturnQueue.push(Object.assign([], { count: 1 })); // claim insert
    sqlReturnQueue.push([{ id: 'inbound-evt-1' }]); // SELECT id
    sqlReturnQueue.push([]); // UPSERT opt_outs
    sqlReturnQueue.push([]); // INSERT audit event
    sqlReturnQueue.push([]); // UPDATE enrollments
    sqlReturnQueue.push([]); // mark processed

    const { req, reply } = buildInboundRequest({
      From: '+15551234567',
      To: '+15550001111',
      Body: 'STOP',
      MessageSid: 'SM_stop1',
      MessagingServiceSid: 'MGtest',
      OptOutType: 'STOP',
    });
    await handleTwilioInbound(req as AnyReq, reply as AnyReply);
    expect(reply.statusCode).toBe(200);

    const raw = sqlCallsLog.map((c) => c.raw).join('\n---\n');
    expect(raw).toMatch(/INSERT INTO sms_sender_opt_outs/);
    expect(raw).toMatch(/ON CONFLICT \(messaging_service_sid, handle\) DO UPDATE/);
    expect(raw).toMatch(/INSERT INTO sms_sender_opt_out_events/);
    expect(raw).toMatch(/UPDATE channel_enrollments/);
    expect(raw).toMatch(/status = 'unsubscribed'/);
    expect(raw).toMatch(/archived_at IS NULL/);
    expect(mockSql.begin).toHaveBeenCalledTimes(1);

    // Audit event source should be 'twilio_optouttype'. event_type 'stop' is a
    // SQL literal inside the VALUES clause, so it lives in `raw`, not `values`.
    const eventInsert = sqlCallsLog.find((c) =>
      /INSERT INTO sms_sender_opt_out_events/.test(c.raw),
    )!;
    expect(eventInsert).toBeDefined();
    expect(eventInsert.raw).toMatch(/'stop'/);
    expect(eventInsert.values).toContain('twilio_optouttype');
    expect(eventInsert.values).toContain('+15551234567');
    expect(eventInsert.values).toContain('MGtest');
    expect(eventInsert.values).toContain('inbound-evt-1');
  });

  it('STOP via keyword (no OptOutType) — REVOKE, OPTOUT, UNSUBSCRIBE, CANCEL, PARAR all recognized', async () => {
    for (const keyword of ['STOP', 'REVOKE', 'OPTOUT', 'UNSUBSCRIBE', 'CANCEL', 'PARAR']) {
      sqlCallsLog.length = 0;
      sqlReturnQueue.length = 0;
      sqlReturnQueue.push(Object.assign([], { count: 1 }));
      sqlReturnQueue.push([{ id: `evt-${keyword}` }]);
      sqlReturnQueue.push([]);
      sqlReturnQueue.push([]);
      sqlReturnQueue.push([]);
      sqlReturnQueue.push([]);

      const { req, reply } = buildInboundRequest({
        From: '+15551110000',
        To: '+15550001111',
        Body: keyword,
        MessageSid: `SM_${keyword}`,
        MessagingServiceSid: 'MGtest',
      });
      await handleTwilioInbound(req as AnyReq, reply as AnyReply);
      expect(reply.statusCode, `keyword ${keyword} status`).toBe(200);

      const evt = sqlCallsLog.find((c) =>
        /INSERT INTO sms_sender_opt_out_events/.test(c.raw),
      );
      expect(evt, `keyword ${keyword} should produce audit event`).toBeDefined();
      expect(evt!.values, `keyword ${keyword} source`).toContain('twilio_inbound_keyword');
      // event_type is a SQL literal, not a parameter — assert against raw SQL.
      expect(evt!.raw, `keyword ${keyword} event type`).toMatch(/'stop'/);
    }
  });

  it('START after prior STOP: UPDATEs opted_in_at, writes audit event; does NOT touch channel_enrollments', async () => {
    sqlReturnQueue.push(Object.assign([], { count: 1 })); // claim
    sqlReturnQueue.push([{ id: 'inbound-evt-start' }]); // SELECT id
    // Inside begin:
    sqlReturnQueue.push([]); // UPDATE opt_outs
    sqlReturnQueue.push([]); // INSERT audit event
    // NO update channel_enrollments
    sqlReturnQueue.push([]); // processed

    const { req, reply } = buildInboundRequest({
      From: '+15551234567',
      Body: 'START',
      MessageSid: 'SM_in2',
      MessagingServiceSid: 'MGtest',
      OptOutType: 'START',
    });
    await handleTwilioInbound(req as AnyReq, reply as AnyReply);
    expect(reply.statusCode).toBe(200);

    const raw = sqlCallsLog.map((c) => c.raw).join('\n---\n');
    expect(raw).toMatch(/UPDATE sms_sender_opt_outs\s+SET opted_in_at/);
    expect(raw).toMatch(/INSERT INTO sms_sender_opt_out_events/);
    expect(raw).not.toMatch(/UPDATE channel_enrollments/);

    const evt = sqlCallsLog.find((c) =>
      /INSERT INTO sms_sender_opt_out_events/.test(c.raw),
    )!;
    // event_type is a SQL literal, not a parameter — assert against raw SQL.
    expect(evt.raw).toMatch(/'start'/);
    expect(evt.values).toContain('twilio_optouttype');
  });

  it('START without prior STOP: UPDATE affects 0 rows, audit event still written', async () => {
    sqlReturnQueue.push(Object.assign([], { count: 1 }));
    sqlReturnQueue.push([{ id: 'evt-lone-start' }]);
    sqlReturnQueue.push([]); // UPDATE returns no rows — still a successful call
    sqlReturnQueue.push([]); // INSERT event (unconditional)
    sqlReturnQueue.push([]); // processed

    const { req, reply } = buildInboundRequest({
      From: '+15559998888',
      Body: 'START',
      MessageSid: 'SM_lone',
      MessagingServiceSid: 'MGtest',
      OptOutType: 'START',
    });
    await handleTwilioInbound(req as AnyReq, reply as AnyReply);
    expect(reply.statusCode).toBe(200);

    const evt = sqlCallsLog.find((c) =>
      /INSERT INTO sms_sender_opt_out_events/.test(c.raw),
    );
    expect(evt, 'audit event written unconditionally').toBeDefined();
  });

  it('non-keyword inbound: no state changes, returns 200', async () => {
    sqlReturnQueue.push(Object.assign([], { count: 1 }));
    sqlReturnQueue.push([{ id: 'evt-other' }]);
    sqlReturnQueue.push([]); // mark processed (no txn)

    const { req, reply } = buildInboundRequest({
      From: '+15551234567',
      Body: 'help please',
      MessageSid: 'SM_misc',
      MessagingServiceSid: 'MGtest',
    });
    await handleTwilioInbound(req as AnyReq, reply as AnyReply);
    expect(reply.statusCode).toBe(200);

    const raw = sqlCallsLog.map((c) => c.raw).join('\n---\n');
    expect(raw).not.toMatch(/INSERT INTO sms_sender_opt_outs/);
    expect(raw).not.toMatch(/INSERT INTO sms_sender_opt_out_events/);
    expect(mockSql.begin).not.toHaveBeenCalled();
  });

  it('Body redacted before persisting to inbound_events.payload', async () => {
    sqlReturnQueue.push(Object.assign([], { count: 1 }));
    sqlReturnQueue.push([{ id: 'evt-red' }]);
    sqlReturnQueue.push([]); // mark processed

    const { req, reply } = buildInboundRequest({
      From: '+15551234567',
      Body: 'super secret note',
      MessageSid: 'SM_red',
      MessagingServiceSid: 'MGtest',
    });
    await handleTwilioInbound(req as AnyReq, reply as AnyReply);

    const claimCall = sqlCallsLog.find((c) => /INSERT INTO inbound_events/.test(c.raw))!;
    expect(claimCall).toBeDefined();
    // The payload is one of the values. Search for a redacted Body in any object value.
    const hasRedacted = claimCall.values.some(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (v) => v !== null && typeof v === 'object' && (v as any).Body === '[redacted]',
    );
    expect(hasRedacted).toBe(true);
    // And the From is preserved in the same payload.
    const hasFrom = claimCall.values.some(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (v) => v !== null && typeof v === 'object' && (v as any).From === '+15551234567',
    );
    expect(hasFrom).toBe(true);
  });

  it('duplicate inbound (claim returns duplicate): 200 without state writes', async () => {
    // Claim insert count=0 (conflict), reclaim returns nothing.
    sqlReturnQueue.push(Object.assign([], { count: 0 })); // INSERT ... DO NOTHING
    sqlReturnQueue.push([]); // reclaim UPDATE ... RETURNING (empty -> truly duplicate)

    const { req, reply } = buildInboundRequest({
      From: '+15551234567',
      Body: 'STOP',
      MessageSid: 'SM_dup',
      MessagingServiceSid: 'MGtest',
    });
    await handleTwilioInbound(req as AnyReq, reply as AnyReply);
    expect(reply.statusCode).toBe(200);

    const raw = sqlCallsLog.map((c) => c.raw).join('\n---\n');
    expect(raw).not.toMatch(/INSERT INTO sms_sender_opt_outs/);
    expect(mockSql.begin).not.toHaveBeenCalled();
  });
});
