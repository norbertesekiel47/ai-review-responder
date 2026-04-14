import { describe, it, expect, vi, beforeEach } from 'vitest';

// ── Hoisted mock state ───────────────────────────────────────────────
const { sqlReturnQueue, sqlCalls, mockSql } = vi.hoisted(() => {
  const sqlReturnQueue: unknown[] = [];
  const sqlCalls: { text: string; values: unknown[] }[] = [];

  const mockSql: any = vi.fn((_s: TemplateStringsArray, ..._v: unknown[]) => {
    const text = Array.from(_s).join('?');
    sqlCalls.push({ text, values: _v });
    const queued = sqlReturnQueue.shift();
    if (queued !== undefined) return Promise.resolve(queued);
    const empty: unknown[] & { count: number } = Object.assign([], { count: 0 });
    return Promise.resolve(empty);
  });

  return { sqlReturnQueue, sqlCalls, mockSql };
});

vi.mock('../../src/lib/db/server', () => ({ sql: mockSql }));
vi.mock('uuid', () => ({ v7: vi.fn(() => 'test-uuid') }));

// Mock Stripe SDK
const mockConstructEvent = vi.fn();
vi.mock('stripe', () => ({
  default: class MockStripe {
    webhooks = { constructEvent: mockConstructEvent };
  },
}));

// ── Stripe handler tests ─────────────────────────────────────────────

describe('Stripe webhook dedup — handleStripeWebhook', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    sqlReturnQueue.length = 0;
    sqlCalls.length = 0;
    process.env.STRIPE_SECRET_KEY = 'sk_test_fake';
    process.env.STRIPE_WEBHOOK_SECRET = 'whsec_test_fake';
    vi.resetModules();
  });

  function setupStripeEvent(eventId = 'evt_test_123') {
    mockConstructEvent.mockReturnValueOnce({
      id: eventId,
      type: 'checkout.session.completed',
      data: {
        object: {
          client_reference_id: 'biz-1',
          customer: 'cus_1',
          subscription: 'sub_1',
        },
      },
    });
  }

  function makeRequest() {
    return {
      rawBody: 'raw-body',
      headers: { 'stripe-signature': 'sig_test' },
      body: {},
    } as any;
  }

  function makeReply() {
    return {
      status: vi.fn().mockReturnThis(),
      send: vi.fn().mockReturnThis(),
    } as any;
  }

  it('skips processing and returns duplicate:true when event is already processed', async () => {
    setupStripeEvent();
    // 1: INSERT returns count=0 (conflict — already claimed)
    const dupResult: any = []; dupResult.count = 0;
    sqlReturnQueue.push(dupResult);
    // 2: SELECT status → processed
    sqlReturnQueue.push([{ status: 'processed' }]);

    const { handleStripeWebhook } = await import('../ingress/stripe');
    const reply = makeReply();
    await handleStripeWebhook(makeRequest(), reply);

    expect(reply.status).toHaveBeenCalledWith(200);
    expect(reply.send).toHaveBeenCalledWith(
      expect.objectContaining({ duplicate: true }),
    );
    // 2 SQL calls: INSERT (conflict) + SELECT for status log
    expect(sqlCalls).toHaveLength(2);
    expect(sqlCalls[0]!.text).toContain('inbound_events');
  });

  it('inserts inbound_event and processes new event', async () => {
    setupStripeEvent();
    // 1: INSERT INTO inbound_events → count=1 (new event claimed)
    const insertResult: any = []; insertResult.count = 1;
    sqlReturnQueue.push(insertResult);
    // 2: UPDATE businesses (checkout.session.completed skips — mode=undefined)
    // (no SQL call for businesses since mode check fails)
    // 3: UPDATE inbound_events SET status='processed'
    sqlReturnQueue.push([]);

    const { handleStripeWebhook } = await import('../ingress/stripe');
    const reply = makeReply();
    await handleStripeWebhook(makeRequest(), reply);

    expect(reply.status).toHaveBeenCalledWith(200);
    expect(reply.send).toHaveBeenCalledWith({ received: true });

    // Verify INSERT INTO inbound_events was called with ON CONFLICT
    const insertCalls = sqlCalls.filter((c) => c.text.includes('INSERT') && c.text.includes('inbound_events'));
    expect(insertCalls).toHaveLength(1);
    expect(insertCalls[0]!.text).toContain('ON CONFLICT');
    expect(insertCalls[0]!.values).toContain('evt_test_123');
  });

  it('returns duplicate:true when event is already claimed with status=received', async () => {
    setupStripeEvent();
    // 1: INSERT returns count=0 (conflict — already claimed even if not yet processed)
    const dupResult: any = []; dupResult.count = 0;
    sqlReturnQueue.push(dupResult);
    // 2: SELECT status → received
    sqlReturnQueue.push([{ status: 'received' }]);

    const { handleStripeWebhook } = await import('../ingress/stripe');
    const reply = makeReply();
    await handleStripeWebhook(makeRequest(), reply);

    expect(reply.status).toHaveBeenCalledWith(200);
    expect(reply.send).toHaveBeenCalledWith(
      expect.objectContaining({ duplicate: true }),
    );
    // Only the INSERT attempt + SELECT for status log — no business logic calls
    const businessUpdateCalls = sqlCalls.filter((c) => c.text.includes('UPDATE businesses'));
    expect(businessUpdateCalls).toHaveLength(0);
  });

  it('rejects missing stripe-signature with 401', async () => {
    const { handleStripeWebhook } = await import('../ingress/stripe');
    const reply = makeReply();
    await handleStripeWebhook({ rawBody: '', headers: {}, body: {} } as any, reply);

    expect(reply.status).toHaveBeenCalledWith(401);
    expect(reply.send).toHaveBeenCalledWith({ error: 'missing_signature' });
  });
});

// ── Resend handler tests ─────────────────────────────────────────────

describe('Resend webhook dedup — handleResendWebhook', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    sqlReturnQueue.length = 0;
    sqlCalls.length = 0;
    process.env.MOCK_EXTERNAL_APIS = 'true';
    delete process.env.RESEND_WEBHOOK_SECRET;
    vi.resetModules();
  });

  function makeResendRequest() {
    return {
      rawBody: '{"type":"email.delivered","data":{"email_id":"email-1"}}',
      headers: { 'svix-id': 'msg_test_456', 'svix-timestamp': '1234567890', 'svix-signature': 'v1,fake' },
      body: { type: 'email.delivered', data: { email_id: 'email-1' } },
    } as any;
  }

  function makeReply() {
    return {
      status: vi.fn().mockReturnThis(),
      send: vi.fn().mockReturnThis(),
    } as any;
  }

  it('returns duplicate:true when ON CONFLICT DO NOTHING returns count=0', async () => {
    // 1: INSERT returns count=0 (duplicate)
    const dupResult: any = []; dupResult.count = 0;
    sqlReturnQueue.push(dupResult);

    const { handleResendWebhook } = await import('../ingress/resend');
    const reply = makeReply();
    await handleResendWebhook(makeResendRequest(), reply);

    expect(reply.status).toHaveBeenCalledWith(200);
    expect(reply.send).toHaveBeenCalledWith(
      expect.objectContaining({ duplicate: true }),
    );
    // Only 1 SQL call (the INSERT that hit conflict), no UPDATE
    expect(sqlCalls).toHaveLength(1);
  });

  it('processes event and updates delivery status when INSERT succeeds', async () => {
    // 1: INSERT returns count=1 (new event)
    const insertResult: any = []; insertResult.count = 1;
    sqlReturnQueue.push(insertResult);
    // 2: UPDATE notification_deliveries SET delivered_at
    sqlReturnQueue.push([]);
    // 3: UPDATE inbound_events SET status='processed'
    sqlReturnQueue.push([]);

    const { handleResendWebhook } = await import('../ingress/resend');
    const reply = makeReply();
    await handleResendWebhook(makeResendRequest(), reply);

    expect(reply.status).toHaveBeenCalledWith(200);
    expect(reply.send).toHaveBeenCalledWith({ received: true });

    // Verify INSERT hit inbound_events with ON CONFLICT
    const insertCalls = sqlCalls.filter((c) => c.text.includes('inbound_events'));
    expect(insertCalls).toHaveLength(2); // INSERT + UPDATE processed_at
    expect(insertCalls[0]!.text).toContain('ON CONFLICT');

    // Verify notification_deliveries was updated
    const deliveryCalls = sqlCalls.filter((c) => c.text.includes('notification_deliveries'));
    expect(deliveryCalls).toHaveLength(1);
    expect(deliveryCalls[0]!.text).toContain('delivered_at');
  });

  it('rejects missing signature in non-mock mode', async () => {
    delete process.env.MOCK_EXTERNAL_APIS;
    delete process.env.RESEND_WEBHOOK_SECRET;

    const { handleResendWebhook } = await import('../ingress/resend');
    const reply = makeReply();
    await handleResendWebhook(
      { rawBody: '', headers: {}, body: { type: 'test', data: {} } } as any,
      reply,
    );

    expect(reply.status).toHaveBeenCalledWith(401);
  });
});
