import { describe, it, expect, vi, beforeEach } from 'vitest';

// Lane routing in the Resend webhook ingress (#657 Task 6, spec §5.1/§5.2). RED
// until `worker/ingress/resend/solicitation-lane.ts` exists.
//
// Pure: the database is the same tagged-template mock
// resend-webhook-bounce.test.ts uses, so every assertion here is about WHICH
// path ran and WHAT SQL was issued — never about stored state. The live-DB
// companion (resend-solicitation-lane.integration.test.ts) owns the effects.
//
// The discriminant is the echoed Resend tag, read BEFORE any delivery-row
// lookup. That was chosen over a try-table-A-fall-back-to-B chain, which couples
// the two lanes and makes a genuinely-unknown email_id indistinguishable from a
// lane mismatch.

const { sqlReturnQueue, mockSql, mockSendInternalEmail, laneHandler, sqlCallsWhenLaneRan } =
  vi.hoisted(() => {
    const sqlReturnQueue: unknown[] = [];
    const sqlCallsWhenLaneRan: string[] = [];
    const mockSql = vi.fn((_s: TemplateStringsArray, ..._v: unknown[]) => {
      const result = sqlReturnQueue.shift() ?? [];
      return Promise.resolve(Array.isArray(result) ? result : [result]);
    });
    const laneHandler = vi.fn(() => {
      // Snapshot the SQL issued SO FAR, at the instant the lane is entered.
      // That ordering is what title "before any database lookup" is about.
      for (const call of mockSql.mock.calls) {
        sqlCallsWhenLaneRan.push((call[0] as TemplateStringsArray).raw.join(' '));
      }
      return Promise.resolve();
    });
    const mockSendInternalEmail = vi.fn().mockResolvedValue({ messageId: 'mock' });
    return { sqlReturnQueue, mockSql, mockSendInternalEmail, laneHandler, sqlCallsWhenLaneRan };
  });

vi.mock('../../../src/lib/db/server', () => ({ sql: mockSql, jsonb: (v: unknown) => v }));
vi.mock('../../../src/lib/notifications/email', () => ({
  sendInternalEmail: (...args: unknown[]) => mockSendInternalEmail(...args),
}));
// Hermetic: the worker config lane self-loads .env.local before its first parse.
// These cases rely on RESEND_WEBHOOK_SECRET being ABSENT (so the handler takes
// the MOCK_EXTERNAL_APIS fail-open branch); stub the loader to a no-op so the
// developer's real .env.local secret can't repopulate it.
vi.mock('../../../src/lib/config/dotenv-load', () => ({ ensureWorkerDotenvLoaded: () => {} }));
// The lane's EFFECTS belong to the live-DB suite. Only the handler is replaced;
// `isSolicitationLane` stays REAL, because the discriminant is exactly what this
// file is testing.
vi.mock('../resend/solicitation-lane', async () => {
  const actual = await vi.importActual<typeof import('../resend/solicitation-lane')>(
    '../resend/solicitation-lane',
  );
  return { ...actual, handleSolicitationResendEvent: laneHandler };
});

import { handleResendWebhook } from '../resend';
import { isSolicitationLane } from '../resend/solicitation-lane';
import { resetWorkerConfigForTests } from '../../../src/lib/config/worker';

// The handler only reads .body, .headers and .rawBody; the mock supplies all
// three. Cast because FastifyRequest's generics are awkward from an ad-hoc object.
function makeReq(body: unknown, svixId = `msg_${Math.random().toString(36).slice(2)}`): never {
  return {
    body,
    headers: {
      'svix-id': svixId,
      'svix-timestamp': String(Math.floor(Date.now() / 1000)),
      'svix-signature': 'v1,ignored',
    },
    rawBody: JSON.stringify(body),
  } as unknown as never;
}

function makeReply() {
  const captured: { status?: number; body?: unknown } = {};
  const reply = {
    status: (code: number) => {
      captured.status = code;
      return reply;
    },
    send: (body: unknown) => {
      captured.body = body;
    },
  } as unknown as import('fastify').FastifyReply;
  return { reply, captured };
}

/** Every tagged-template SQL body, flattened, so a case can pattern-match it. */
function joinSql(calls: unknown[][]): string {
  return calls.flatMap((c) => (c[0] as TemplateStringsArray).raw).join(' ');
}

const SOLICITATION_TAGS_MAP = { lane: 'solicitation', account_id: 'acct-1' };
const SOLICITATION_TAGS_ARRAY = [
  { name: 'category', value: 'solicitation' },
  { name: 'lane', value: 'solicitation' },
];

describe('handleResendWebhook — solicitation lane routing', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    sqlReturnQueue.length = 0;
    sqlCallsWhenLaneRan.length = 0;
    process.env.MOCK_EXTERNAL_APIS = 'true'; // bypass signature verification
    delete process.env.ADMIN_NOTIFICATION_EMAIL;
    resetWorkerConfigForTests();
  });

  it('the resend webhook routes a solicitation-tagged payload to the solicitation lane', async () => {
    sqlReturnQueue.push({ count: 1 }); // inbound_events INSERT (claimed)
    sqlReturnQueue.push([]); // UPDATE inbound_events SET status='processed'

    const body = {
      type: 'email.bounced',
      data: { email_id: 'msg-solicitation', bounce: { type: 'Permanent' }, tags: SOLICITATION_TAGS_MAP },
    };
    const { reply, captured } = makeReply();
    await handleResendWebhook(makeReq(body), reply);

    expect(captured.status).toBe(200);
    expect(laneHandler).toHaveBeenCalledTimes(1);
    // (sql, eventType, emailId, data) — the lane takes its executor as a
    // parameter (invariant #15); only the ingress imports the singleton.
    const [, eventType, emailId, data] = laneHandler.mock.calls[0] as unknown as [
      unknown,
      string,
      string,
      Record<string, unknown>,
    ];
    expect(eventType).toBe('email.bounced');
    expect(emailId).toBe('msg-solicitation');
    expect(data).toBe(body.data);
  });

  it('the resend webhook routes an untagged payload to the notification deliveries path', async () => {
    sqlReturnQueue.push({ count: 1 }); // claim
    sqlReturnQueue.push([]); // UPDATE notification_deliveries
    sqlReturnQueue.push([]); // UPDATE inbound_events

    const body = { type: 'email.delivered', data: { email_id: 'msg-notification' } };
    const { reply, captured } = makeReply();
    await handleResendWebhook(makeReq(body), reply);

    expect(captured.status).toBe(200);
    expect(laneHandler).not.toHaveBeenCalled();
    // The sibling path is behaviourally untouched by this ticket.
    expect(joinSql(mockSql.mock.calls)).toContain('notification_deliveries');
  });

  it('the resend webhook routes a non-solicitation-tagged payload to the notification deliveries path', async () => {
    sqlReturnQueue.push({ count: 1 }); // claim
    sqlReturnQueue.push([]); // UPDATE notification_deliveries
    sqlReturnQueue.push([]); // UPDATE inbound_events

    const body = {
      type: 'email.delivered',
      data: { email_id: 'msg-notification-2', tags: { lane: 'notification' } },
    };
    const { reply } = makeReply();
    await handleResendWebhook(makeReq(body), reply);

    // A tag that is present but says something else is NOT this lane. Only the
    // exact value routes here.
    expect(laneHandler).not.toHaveBeenCalled();
    expect(joinSql(mockSql.mock.calls)).toContain('notification_deliveries');
  });

  it('the resend webhook reads the lane discriminant before any database lookup', async () => {
    sqlReturnQueue.push({ count: 1 }); // claim
    sqlReturnQueue.push([]); // UPDATE inbound_events

    const body = {
      type: 'email.bounced',
      data: { email_id: 'msg-early', bounce: { type: 'Permanent' }, tags: SOLICITATION_TAGS_MAP },
    };
    const { reply } = makeReply();
    await handleResendWebhook(makeReq(body), reply);

    expect(laneHandler).toHaveBeenCalledTimes(1);
    const before = sqlCallsWhenLaneRan.join(' ');
    // The idempotency claim is the ONE statement allowed to precede the
    // discriminant — it is the same write for both lanes and must stay shared.
    expect(before).toContain('inbound_events');
    // Nothing that looks up a row to decide which lane this is.
    expect(before).not.toContain('notification_deliveries');
    expect(before).not.toContain('solicitation_outreach');
    expect(before).not.toContain('businesses');
  });

  it("the resend webhook reads the lane discriminant from Resend's echoed tag shape", async () => {
    sqlReturnQueue.push({ count: 1 }); // claim
    sqlReturnQueue.push([]); // UPDATE inbound_events

    // Resend echoes the tags it was sent; the array-of-{name,value} form is the
    // shape the adapter actually submits, so the reader must accept it.
    const body = {
      type: 'email.complained',
      data: { email_id: 'msg-echoed', tags: SOLICITATION_TAGS_ARRAY },
    };
    const { reply, captured } = makeReply();
    await handleResendWebhook(makeReq(body), reply);

    expect(captured.status).toBe(200);
    expect(laneHandler).toHaveBeenCalledTimes(1);
  });

  it('a solicitation payload never writes notification_deliveries', async () => {
    sqlReturnQueue.push({ count: 1 }); // claim
    sqlReturnQueue.push([]); // UPDATE inbound_events

    const body = {
      type: 'email.delivered',
      data: { email_id: 'msg-no-deliveries', tags: SOLICITATION_TAGS_ARRAY },
    };
    const { reply } = makeReply();
    await handleResendWebhook(makeReq(body), reply);

    // A solicitation send has no notification_deliveries row, so a write here
    // would silently match zero rows — or, worse, someone else's.
    expect(joinSql(mockSql.mock.calls)).not.toContain('notification_deliveries');
    expect(laneHandler).toHaveBeenCalledTimes(1);
  });

  it('a solicitation payload never flips businesses.owner_email_bounced', async () => {
    sqlReturnQueue.push({ count: 1 }); // claim
    sqlReturnQueue.push([]); // UPDATE inbound_events

    const body = {
      type: 'email.bounced',
      data: { email_id: 'msg-no-owner-flag', bounce: { type: 'Permanent' }, tags: SOLICITATION_TAGS_MAP },
    };
    const { reply } = makeReply();
    await handleResendWebhook(makeReq(body), reply);

    // The bounced address belongs to a CUSTOMER of the business, not to its
    // owner. Flagging owner_email_bounced would suppress every owner-directed
    // email — approvals included — because a stranger's mailbox is full.
    const joined = joinSql(mockSql.mock.calls);
    expect(joined).not.toContain('owner_email_bounced');
    expect(joined).not.toContain('UPDATE businesses');
    expect(mockSendInternalEmail).not.toHaveBeenCalled();
  });

  it('the resend webhook routes a solicitation payload whose tags are an object map to the solicitation lane', () => {
    // Both echoed shapes, and the negative, against the real reader.
    expect(isSolicitationLane({ tags: { lane: 'solicitation' } })).toBe(true);
    expect(isSolicitationLane({ tags: [{ name: 'lane', value: 'solicitation' }] })).toBe(true);
    expect(isSolicitationLane({ tags: { lane: 'notification' } })).toBe(false);
    expect(isSolicitationLane({})).toBe(false);
    expect(isSolicitationLane(null)).toBe(false);
  });
});
