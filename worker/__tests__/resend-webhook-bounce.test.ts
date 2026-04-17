import { describe, it, expect, vi, beforeEach } from 'vitest';

const { sqlReturnQueue, mockSql, mockSendInternalEmail } = vi.hoisted(() => {
  const sqlReturnQueue: unknown[] = [];
  // Preserve vi.fn() type so .mock.calls is accessible for assertions.
  const mockSql = vi.fn((_s: TemplateStringsArray, ..._v: unknown[]) => {
    const result = sqlReturnQueue.shift() ?? [];
    return Promise.resolve(Array.isArray(result) ? result : [result]);
  });
  const mockSendInternalEmail = vi.fn().mockResolvedValue({ messageId: 'mock' });
  return { sqlReturnQueue, mockSql, mockSendInternalEmail };
});

vi.mock('../../src/lib/db/server', () => ({ sql: mockSql }));
vi.mock('../../src/lib/notifications/email', () => ({
  sendInternalEmail: (...args: unknown[]) => mockSendInternalEmail(...args),
}));

import { handleResendWebhook } from '../ingress/resend';

// Cast through `any` because FastifyRequest has a generics-heavy type surface
// that's awkward to satisfy from an ad-hoc test object. The handler only reads
// .body, .headers, and .rawBody — the test mock supplies all three.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function makeReq(body: unknown, headers: Record<string, string | undefined> = {}): any {
  return {
    body,
    headers: {
      'svix-id': 'msg_test',
      'svix-timestamp': String(Math.floor(Date.now() / 1000)),
      'svix-signature': 'v1,ignored',
      ...headers,
    },
    rawBody: JSON.stringify(body),
  };
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

describe('handleResendWebhook — bounce handling', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    sqlReturnQueue.length = 0;
    process.env.MOCK_EXTERNAL_APIS = 'true'; // bypass signature verification
    process.env.ADMIN_NOTIFICATION_EMAIL = 'admin@example.com';
  });

  it('sets owner_email_bounced=true on hard bounce (data.bounce.type=permanent)', async () => {
    sqlReturnQueue.push({ count: 1 }); // inbound_events INSERT (not duplicate)
    sqlReturnQueue.push([{ business_id: 'biz-1' }]); // lookup via notification_deliveries
    sqlReturnQueue.push([]); // UPDATE notification_deliveries
    sqlReturnQueue.push([]); // UPDATE businesses SET owner_email_bounced
    sqlReturnQueue.push([]); // UPDATE inbound_events SET status = 'processed'

    const body = {
      type: 'email.bounced',
      data: { email_id: 'msg-abc', bounce: { type: 'Permanent' } },
    };
    const { reply, captured } = makeReply();
    await handleResendWebhook(makeReq(body), reply);

    expect(captured.status).toBe(200);

    // Find the SQL call that UPDATEd businesses.owner_email_bounced
    const stringArgs = mockSql.mock.calls.flatMap((c) =>
      (c[0] as TemplateStringsArray).raw.map((s) => s),
    );
    const joinedSql = stringArgs.join(' ');
    expect(joinedSql).toContain('owner_email_bounced');
    expect(joinedSql).toContain('UPDATE businesses');

    // Admin got an alert
    expect(mockSendInternalEmail).toHaveBeenCalledOnce();
    const alertArgs = mockSendInternalEmail.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(alertArgs.to).toBe('admin@example.com');
    expect(String(alertArgs.subject)).toMatch(/hard bounce/i);
    expect(alertArgs.category).toBe('internal');
  });

  it('does not flag business for soft bounces (data.bounce.type=transient)', async () => {
    sqlReturnQueue.push({ count: 1 });
    sqlReturnQueue.push([{ business_id: 'biz-1' }]);
    sqlReturnQueue.push([]); // UPDATE notification_deliveries
    sqlReturnQueue.push([]); // UPDATE inbound_events

    const body = {
      type: 'email.bounced',
      data: { email_id: 'msg-abc', bounce: { type: 'Transient' } },
    };
    const { reply } = makeReply();
    await handleResendWebhook(makeReq(body), reply);

    const stringArgs = mockSql.mock.calls.flatMap((c) =>
      (c[0] as TemplateStringsArray).raw.map((s) => s),
    );
    const joinedSql = stringArgs.join(' ');
    // No UPDATE businesses ... owner_email_bounced = TRUE
    expect(joinedSql).not.toMatch(/UPDATE\s+businesses[\s\S]*owner_email_bounced\s*=\s*TRUE/i);

    // No admin alert
    expect(mockSendInternalEmail).not.toHaveBeenCalled();
  });

  it('falls back to unknown bounce type when payload has no type hints', async () => {
    sqlReturnQueue.push({ count: 1 });
    sqlReturnQueue.push([{ business_id: 'biz-1' }]);
    sqlReturnQueue.push([]);
    sqlReturnQueue.push([]);

    const body = {
      type: 'email.bounced',
      data: { email_id: 'msg-abc' }, // no bounce field at all
    };
    const { reply, captured } = makeReply();
    await handleResendWebhook(makeReq(body), reply);

    expect(captured.status).toBe(200);
    // Unknown bounce type is NOT treated as hard — business not flagged, no admin alert
    expect(mockSendInternalEmail).not.toHaveBeenCalled();
  });

  it('accepts alternative payload shapes (data.reason="permanent_failure")', async () => {
    sqlReturnQueue.push({ count: 1 });
    sqlReturnQueue.push([{ business_id: 'biz-1' }]);
    sqlReturnQueue.push([]);
    sqlReturnQueue.push([]);
    sqlReturnQueue.push([]);

    const body = {
      type: 'email.bounced',
      data: { email_id: 'msg-abc', reason: 'permanent_failure' },
    };
    const { reply } = makeReply();
    await handleResendWebhook(makeReq(body), reply);

    expect(mockSendInternalEmail).toHaveBeenCalledOnce();
  });

  it('records complained status and does not flag business as bounced', async () => {
    sqlReturnQueue.push({ count: 1 });
    sqlReturnQueue.push([]); // UPDATE notification_deliveries
    sqlReturnQueue.push([]); // UPDATE inbound_events

    const body = {
      type: 'email.complained',
      data: { email_id: 'msg-abc' },
    };
    const { reply, captured } = makeReply();
    await handleResendWebhook(makeReq(body), reply);

    expect(captured.status).toBe(200);

    const stringArgs = mockSql.mock.calls.flatMap((c) =>
      (c[0] as TemplateStringsArray).raw.map((s) => s),
    );
    const joinedSql = stringArgs.join(' ');
    expect(joinedSql).toContain('failure_reason');
    expect(joinedSql).not.toContain('owner_email_bounced');
    expect(mockSendInternalEmail).not.toHaveBeenCalled();
  });
});
