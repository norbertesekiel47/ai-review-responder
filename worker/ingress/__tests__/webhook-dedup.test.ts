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

vi.mock('../../../src/lib/db/server', () => ({ sql: mockSql, jsonb: (v: unknown) => v }));
vi.mock('uuid', () => ({ v7: vi.fn(() => 'test-uuid') }));
// Hermetic: the worker config lane self-loads .env.local before its first parse.
// The Resend dedup cases below rely on RESEND_WEBHOOK_SECRET being ABSENT (so the
// handler takes the MOCK_EXTERNAL_APIS fail-open branch); stub the loader to a
// no-op so the developer's real .env.local secret can't repopulate it.
vi.mock('../../../src/lib/config/dotenv-load', () => ({ ensureWorkerDotenvLoaded: () => {} }));

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
    // 2: reclaim UPDATE returns [] — row is in 'processed' state, not reclaimable.
    sqlReturnQueue.push([]);

    const { handleStripeWebhook } = await import('../stripe');
    const reply = makeReply();
    await handleStripeWebhook(makeRequest(), reply);

    expect(reply.status).toHaveBeenCalledWith(200);
    expect(reply.send).toHaveBeenCalledWith(
      expect.objectContaining({ duplicate: true }),
    );
    // 2 SQL calls: INSERT (conflict) + reclaim UPDATE
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

    const { handleStripeWebhook } = await import('../stripe');
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

  it('returns duplicate:true when event is already claimed with status=received (fresh in-flight)', async () => {
    setupStripeEvent();
    // 1: INSERT returns count=0 (conflict — another worker is processing)
    const dupResult: any = []; dupResult.count = 0;
    sqlReturnQueue.push(dupResult);
    // 2: reclaim UPDATE returns [] — row is 'received' but inside the 2-min
    //    window, so reclaim guard rejects it and caller gets 'duplicate'.
    sqlReturnQueue.push([]);

    const { handleStripeWebhook } = await import('../stripe');
    const reply = makeReply();
    await handleStripeWebhook(makeRequest(), reply);

    expect(reply.status).toHaveBeenCalledWith(200);
    expect(reply.send).toHaveBeenCalledWith(
      expect.objectContaining({ duplicate: true }),
    );
    // Only the INSERT attempt + reclaim UPDATE — no business logic calls
    const businessUpdateCalls = sqlCalls.filter((c) => c.text.includes('UPDATE businesses'));
    expect(businessUpdateCalls).toHaveLength(0);
  });

  it('reclaims and reprocesses a failed event instead of permanently swallowing it', async () => {
    setupStripeEvent();
    // 1: INSERT returns count=0 (row already exists — previous attempt failed)
    const dupResult: any = []; dupResult.count = 0;
    sqlReturnQueue.push(dupResult);
    // 2: reclaim UPDATE returns a row — status='failed' is reclaimable
    sqlReturnQueue.push([{ id: 'evt-row-id' }]);
    // 3: UPDATE businesses (checkout.session.completed processing — mode=undefined skips)
    //    (no SQL since mode check fails)
    // 4: UPDATE inbound_events SET status='processed'
    sqlReturnQueue.push([]);

    const { handleStripeWebhook } = await import('../stripe');
    const reply = makeReply();
    await handleStripeWebhook(makeRequest(), reply);

    // Event is reclaimed and reprocessed — not a 200 duplicate
    expect(reply.status).toHaveBeenCalledWith(200);
    expect(reply.send).toHaveBeenCalledWith({ received: true });

    // inbound_events must be marked 'processed' on successful reclaim
    const processedUpdate = sqlCalls.find(
      (c) => c.text.includes('UPDATE') && c.text.includes('inbound_events') && c.text.includes('processed'),
    );
    expect(processedUpdate).toBeDefined();
  });

  it('rejects missing stripe-signature with 401', async () => {
    const { handleStripeWebhook } = await import('../stripe');
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

  it('returns duplicate:true when prior event was processed', async () => {
    // 1: INSERT conflict (count=0)
    const dupResult: any = []; dupResult.count = 0;
    sqlReturnQueue.push(dupResult);
    // 2: atomic reclaim UPDATE returns [] (no row matched — already processed)
    sqlReturnQueue.push([]);
    // 3: status lookup — confirm processed
    sqlReturnQueue.push([{ status: 'processed' }]);

    const { handleResendWebhook } = await import('../resend');
    const reply = makeReply();
    await handleResendWebhook(makeResendRequest(), reply);

    expect(reply.status).toHaveBeenCalledWith(200);
    expect(reply.send).toHaveBeenCalledWith(
      expect.objectContaining({ duplicate: true }),
    );
  });

  it('acks 200 with in_flight:true when another invocation holds a fresh lease', async () => {
    // 1: INSERT conflict
    const dupResult: any = []; dupResult.count = 0;
    sqlReturnQueue.push(dupResult);
    // 2: atomic reclaim UPDATE returns [] (not stale yet — in-flight)
    sqlReturnQueue.push([]);
    // 3: status lookup — received (fresh)
    sqlReturnQueue.push([{ status: 'received' }]);

    const { handleResendWebhook } = await import('../resend');
    const reply = makeReply();
    await handleResendWebhook(makeResendRequest(), reply);

    expect(reply.status).toHaveBeenCalledWith(200);
    expect(reply.send).toHaveBeenCalledWith(
      expect.objectContaining({ in_flight: true }),
    );
  });

  it('reclaims a failed prior event and reprocesses on retry', async () => {
    // 1: INSERT conflict
    const dupResult: any = []; dupResult.count = 0;
    sqlReturnQueue.push(dupResult);
    // 2: atomic reclaim UPDATE returns [{id:...}] (reclaimed)
    sqlReturnQueue.push([{ id: 'claim-x' }]);
    // 3: UPDATE notification_deliveries SET delivered_at
    sqlReturnQueue.push([]);
    // 4: UPDATE inbound_events SET status='processed'
    sqlReturnQueue.push([]);

    const { handleResendWebhook } = await import('../resend');
    const reply = makeReply();
    await handleResendWebhook(makeResendRequest(), reply);

    expect(reply.status).toHaveBeenCalledWith(200);
    // Verify the reclaim UPDATE includes both the failed AND stale-received
    // takeover conditions — this is the core guarantee that prevents a
    // crashed handler from permanently stranding the event in 'received'.
    // Window widened from 2min → 10min (F-15); SQL now uses make_interval.
    const reclaimCall = sqlCalls.find(
      (c) =>
        c.text.includes('inbound_events') &&
        c.text.includes("SET received_at = NOW()") &&
        c.text.includes("status = 'failed'") &&
        c.text.includes("received_at < NOW()") &&
        c.text.includes("make_interval"),
    );
    expect(reclaimCall).toBeDefined();
  });

  // Regression for the specific bug the reviewer flagged: a row stuck in
  // 'received' beyond the reclaim lease MUST be reclaimable. Before the
  // lease fix, every future webhook retry would have returned in_flight
  // indefinitely and the bounce/delivery update would have been lost.
  it('reclaims a STALE received prior event (crashed handler scenario)', async () => {
    // 1: INSERT conflict
    const dupResult: any = []; dupResult.count = 0;
    sqlReturnQueue.push(dupResult);
    // 2: atomic reclaim UPDATE returns [{id:...}] — stale lease takeover
    sqlReturnQueue.push([{ id: 'stale-claim' }]);
    // 3: UPDATE notification_deliveries
    sqlReturnQueue.push([]);
    // 4: UPDATE inbound_events SET status='processed'
    sqlReturnQueue.push([]);

    const { handleResendWebhook } = await import('../resend');
    const reply = makeReply();
    await handleResendWebhook(makeResendRequest(), reply);

    // Event was reprocessed, not stuck as in_flight
    expect(reply.send).not.toHaveBeenCalledWith(
      expect.objectContaining({ in_flight: true }),
    );
    expect(reply.status).toHaveBeenCalledWith(200);
    // Must have run the actual processing UPDATE after reclaim
    const processUpdate = sqlCalls.find(
      (c) => c.text.includes("notification_deliveries") && c.text.includes("delivered_at"),
    );
    expect(processUpdate).toBeDefined();
  });

  it('processes event and updates delivery status when INSERT succeeds', async () => {
    // 1: INSERT returns count=1 (new event)
    const insertResult: any = []; insertResult.count = 1;
    sqlReturnQueue.push(insertResult);
    // 2: UPDATE notification_deliveries SET delivered_at
    sqlReturnQueue.push([]);
    // 3: UPDATE inbound_events SET status='processed'
    sqlReturnQueue.push([]);

    const { handleResendWebhook } = await import('../resend');
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

    const { handleResendWebhook } = await import('../resend');
    const reply = makeReply();
    await handleResendWebhook(
      { rawBody: '', headers: {}, body: { type: 'test', data: {} } } as any,
      reply,
    );

    expect(reply.status).toHaveBeenCalledWith(401);
  });
});
