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

vi.mock('../../../src/lib/db/server', () => ({ sql: mockSql, jsonb: (v: unknown) => v }));
vi.mock('../../../src/lib/notifications/email', () => ({
  sendInternalEmail: (...args: unknown[]) => mockSendInternalEmail(...args),
}));
// Hermetic: the worker config lane self-loads .env.local before its first parse.
// This test relies on RESEND_WEBHOOK_SECRET being ABSENT (so the handler takes the
// MOCK_EXTERNAL_APIS fail-open branch); stub the loader to a no-op so the
// developer's real .env.local secret can't repopulate it (matches worker.test.ts).
vi.mock('../../../src/lib/config/dotenv-load', () => ({ ensureWorkerDotenvLoaded: () => {} }));

import { handleResendWebhook } from '../resend';
import { resetWorkerConfigForTests } from '../../../src/lib/config/worker';

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

// Collapse every tagged-template SQL call into a single flat string so tests
// can pattern-match against the SQL body regardless of parameter interpolation.
function joinSql(calls: unknown[][]): string {
  return calls
    .flatMap((c) => (c[0] as TemplateStringsArray).raw.map((s) => s))
    .join(' ');
}

describe('handleResendWebhook — bounce handling', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    sqlReturnQueue.length = 0;
    process.env.MOCK_EXTERNAL_APIS = 'true'; // bypass signature verification
    process.env.ADMIN_NOTIFICATION_EMAIL = 'admin@example.com';
    // The hard-bounce admin alert reads ADMIN_NOTIFICATION_EMAIL via the memoized
    // getWorkerConfig(); clear the memo so the env set above is re-parsed (#6).
    resetWorkerConfigForTests();
  });

  it('sets owner_email_bounced=true and alerts admin on hard bounce for owner-directed template', async () => {
    sqlReturnQueue.push({ count: 1 }); // inbound_events INSERT (not duplicate)
    sqlReturnQueue.push([{ business_id: 'biz-1', template: 'approval_request' }]); // SELECT delivery
    sqlReturnQueue.push([]); // UPDATE notification_deliveries
    sqlReturnQueue.push([{ id: 'biz-1' }]); // UPDATE businesses RETURNING (transition flipped)
    sqlReturnQueue.push([]); // UPDATE inbound_events SET status = 'processed'

    const body = {
      type: 'email.bounced',
      data: { email_id: 'msg-abc', bounce: { type: 'Permanent' } },
    };
    const { reply, captured } = makeReply();
    await handleResendWebhook(makeReq(body), reply);

    expect(captured.status).toBe(200);

    const joinedSql = joinSql(mockSql.mock.calls);
    expect(joinedSql).toContain('owner_email_bounced');
    expect(joinedSql).toContain('UPDATE businesses');
    // Transition guard clause must be present — prevents duplicate admin alerts
    expect(joinedSql).toContain('IS DISTINCT FROM TRUE');

    // Normalized failure reason persisted as bounced:hard:<raw>
    const failureCall = mockSql.mock.calls.find((c) =>
      (c[0] as TemplateStringsArray).raw.join('').includes('UPDATE notification_deliveries'),
    );
    expect(failureCall).toBeDefined();
    // The `reason` value is interpolated as a parameter — assert it's stored normalized
    // Tagged-template args: [strings, ...values]. failure_reason is the first ${} = index 1.
    const reasonValue = failureCall ? (failureCall[1] as string) : '';
    expect(reasonValue).toMatch(/^bounced:hard:/);

    // Admin got an alert
    expect(mockSendInternalEmail).toHaveBeenCalledOnce();
    const alertArgs = mockSendInternalEmail.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(alertArgs.to).toBe('admin@example.com');
    expect(String(alertArgs.subject)).toMatch(/hard bounce/i);
    expect(alertArgs.category).toBe('internal');
    // Alert body mentions the template so the admin can see which email bounced
    expect(String(alertArgs.bodyHtml)).toContain('approval_request');
  });

  it('does not flag business for soft bounces (data.bounce.type=transient)', async () => {
    sqlReturnQueue.push({ count: 1 });
    sqlReturnQueue.push([{ business_id: 'biz-1', template: 'approval_request' }]);
    sqlReturnQueue.push([]); // UPDATE notification_deliveries
    sqlReturnQueue.push([]); // UPDATE inbound_events

    const body = {
      type: 'email.bounced',
      data: { email_id: 'msg-abc', bounce: { type: 'Transient' } },
    };
    const { reply } = makeReply();
    await handleResendWebhook(makeReq(body), reply);

    const joinedSql = joinSql(mockSql.mock.calls);
    expect(joinedSql).not.toMatch(/UPDATE\s+businesses[\s\S]*owner_email_bounced\s*=\s*TRUE/i);

    // Normalized as bounced:soft:<raw>
    const failureCall = mockSql.mock.calls.find((c) =>
      (c[0] as TemplateStringsArray).raw.join('').includes('UPDATE notification_deliveries'),
    );
    // Tagged-template args: [strings, ...values]. failure_reason is the first ${} = index 1.
    const reasonValue = failureCall ? (failureCall[1] as string) : '';
    expect(reasonValue).toMatch(/^bounced:soft:/);

    expect(mockSendInternalEmail).not.toHaveBeenCalled();
  });

  it('falls back to unknown bounce type when payload has no type hints', async () => {
    sqlReturnQueue.push({ count: 1 });
    sqlReturnQueue.push([{ business_id: 'biz-1', template: 'approval_request' }]);
    sqlReturnQueue.push([]);
    sqlReturnQueue.push([]);

    const body = {
      type: 'email.bounced',
      data: { email_id: 'msg-abc' }, // no bounce field at all
    };
    const { reply, captured } = makeReply();
    await handleResendWebhook(makeReq(body), reply);

    expect(captured.status).toBe(200);
    expect(mockSendInternalEmail).not.toHaveBeenCalled();
  });

  it('accepts alternative payload shapes (data.reason="permanent_failure") and flags owner-directed templates', async () => {
    sqlReturnQueue.push({ count: 1 });
    sqlReturnQueue.push([{ business_id: 'biz-1', template: 'weekly_value_report' }]);
    sqlReturnQueue.push([]); // UPDATE notification_deliveries
    sqlReturnQueue.push([{ id: 'biz-1' }]); // UPDATE businesses RETURNING
    sqlReturnQueue.push([]); // UPDATE inbound_events

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

    const joinedSql = joinSql(mockSql.mock.calls);
    expect(joinedSql).toContain('failure_reason');
    expect(joinedSql).not.toContain('owner_email_bounced');
    expect(mockSendInternalEmail).not.toHaveBeenCalled();
  });

  // ── Regression: admin/partner-directed template bounce must NOT flag owner ──
  it('does NOT flag owner_email_bounced for partner_engagement_alert template', async () => {
    sqlReturnQueue.push({ count: 1 });
    sqlReturnQueue.push([{ business_id: 'biz-1', template: 'partner_engagement_alert' }]);
    sqlReturnQueue.push([]);
    sqlReturnQueue.push([]);

    const body = {
      type: 'email.bounced',
      data: { email_id: 'msg-abc', bounce: { type: 'hard_bounce' } },
    };
    const { reply } = makeReply();
    await handleResendWebhook(makeReq(body), reply);

    const joinedSql = joinSql(mockSql.mock.calls);
    expect(joinedSql).not.toMatch(/UPDATE\s+businesses[\s\S]*owner_email_bounced/i);
    expect(mockSendInternalEmail).not.toHaveBeenCalled();
  });

  // ── Regression: onboarding_drip_* family is owner-directed ──
  it('DOES flag owner_email_bounced for onboarding_drip_day_7 template (prefix match)', async () => {
    sqlReturnQueue.push({ count: 1 });
    sqlReturnQueue.push([{ business_id: 'biz-1', template: 'onboarding_drip_day_7' }]);
    sqlReturnQueue.push([]); // UPDATE notification_deliveries
    sqlReturnQueue.push([{ id: 'biz-1' }]); // UPDATE businesses RETURNING (transition)
    sqlReturnQueue.push([]); // UPDATE inbound_events

    const body = {
      type: 'email.bounced',
      data: { email_id: 'msg-abc', bounce: { type: 'Permanent' } },
    };
    const { reply, captured } = makeReply();
    await handleResendWebhook(makeReq(body), reply);

    expect(captured.status).toBe(200);
    expect(mockSendInternalEmail).toHaveBeenCalledOnce();
  });

  // ── Regression: auto_post_notice FYI is owner-directed (Workstream B / Codex R1 #8) ──
  it('DOES flag owner_email_bounced for an auto_post_notice hard bounce', async () => {
    sqlReturnQueue.push({ count: 1 });
    sqlReturnQueue.push([{ business_id: 'biz-1', template: 'auto_post_notice' }]);
    sqlReturnQueue.push([]); // UPDATE notification_deliveries
    sqlReturnQueue.push([{ id: 'biz-1' }]); // UPDATE businesses RETURNING (transition)
    sqlReturnQueue.push([]); // UPDATE inbound_events

    const body = {
      type: 'email.bounced',
      data: { email_id: 'msg-abc', bounce: { type: 'Permanent' } },
    };
    const { reply, captured } = makeReply();
    await handleResendWebhook(makeReq(body), reply);

    expect(captured.status).toBe(200);
    const joinedSql = joinSql(mockSql.mock.calls);
    expect(joinedSql).toContain('owner_email_bounced');
    expect(joinedSql).toContain('UPDATE businesses');
    expect(mockSendInternalEmail).toHaveBeenCalledOnce();
  });

  // ── Regression: transition guard prevents duplicate admin alerts ──
  it('does NOT send a duplicate admin alert when business already has owner_email_bounced=true', async () => {
    sqlReturnQueue.push({ count: 1 });
    sqlReturnQueue.push([{ business_id: 'biz-1', template: 'approval_request' }]);
    sqlReturnQueue.push([]); // UPDATE notification_deliveries
    // Transition guard: `IS DISTINCT FROM TRUE` filter means no row updated → empty RETURNING
    sqlReturnQueue.push([]); // UPDATE businesses returns [] (already flagged)
    sqlReturnQueue.push([]); // UPDATE inbound_events

    const body = {
      type: 'email.bounced',
      data: { email_id: 'msg-abc', bounce: { type: 'Permanent' } },
    };
    const { reply, captured } = makeReply();
    await handleResendWebhook(makeReq(body), reply);

    expect(captured.status).toBe(200);
    // Admin was already alerted on the first transition — do not spam
    expect(mockSendInternalEmail).not.toHaveBeenCalled();
  });
});
