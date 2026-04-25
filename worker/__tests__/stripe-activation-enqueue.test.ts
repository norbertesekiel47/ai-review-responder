import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * Stripe webhook — checkout.session.completed status-flip behavior.
 *
 * The initial-sync ENQUEUE moved out of this webhook in the self-serve
 * refactor (2026-04-24). The wizard at /api/onboarding/business now owns
 * topic + payload construction, so this webhook only:
 *   1. Acquires the activation advisory lock.
 *   2. FOR UPDATE-reads the current subscription_status.
 *   3. UPDATEs to 'active' (status guard prevents active→active churn).
 *
 * What this test enforces:
 *   - Advisory lock runs before status read (serialization ordering).
 *   - NO INSERT INTO job_outbox call ever fires from the webhook.
 *   - past_due → active still flips status (existing-customer recovery).
 *   - active → active is a no-op (status guard rejects).
 */

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

  mockSql.begin = vi.fn(async (callback: (tx: any) => Promise<any>) => {
    return callback(mockSql);
  });

  return { sqlReturnQueue, sqlCalls, mockSql };
});

vi.mock('../../src/lib/db/server', () => ({ sql: mockSql, jsonb: (v: unknown) => v }));
vi.mock('uuid', () => ({ v7: vi.fn(() => 'test-uuid-v7') }));

const mockConstructEvent = vi.fn();
vi.mock('stripe', () => ({
  default: class MockStripe {
    webhooks = { constructEvent: mockConstructEvent };
  },
}));

// ── Helpers ──────────────────────────────────────────────────────────

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

function setCheckoutSessionCompletedEvent(overrides: {
  businessId?: string;
  eventId?: string;
} = {}) {
  mockConstructEvent.mockReturnValueOnce({
    id: overrides.eventId ?? 'evt_test_123',
    type: 'checkout.session.completed',
    data: {
      object: {
        client_reference_id: overrides.businessId ?? 'biz-1',
        customer: 'cus_1',
        subscription: 'sub_1',
        mode: 'subscription',
        payment_status: 'paid',
      },
    },
  });
}

function queueHappyPath(currentStatus: string, options: { updateBusinessesCount?: number } = {}) {
  const insertInbound: any = []; insertInbound.count = 1;
  sqlReturnQueue.push(insertInbound);
  sqlReturnQueue.push([]); // pg_advisory_xact_lock
  sqlReturnQueue.push([{ subscription_status: currentStatus }]); // SELECT ... FOR UPDATE
  const updateBiz: any = []; updateBiz.count = options.updateBusinessesCount ?? 1;
  sqlReturnQueue.push(updateBiz);
}

function getInsertOutboxCall() {
  return sqlCalls.find(
    (c) => c.text.includes('INSERT INTO job_outbox') || (c.text.includes('INSERT') && c.text.includes('job_outbox')),
  );
}

// ─────────────────────────────────────────────────────────────────────
describe('Stripe webhook — status flip only (initial-sync enqueue moved to /api/onboarding/business)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    sqlReturnQueue.length = 0;
    sqlCalls.length = 0;
    process.env.STRIPE_SECRET_KEY = 'sk_test_fake';
    process.env.STRIPE_WEBHOOK_SECRET = 'whsec_test_fake';
    vi.resetModules();
  });

  it('pending_payment → active flips status and does NOT enqueue any outbox row', async () => {
    setCheckoutSessionCompletedEvent({ businessId: 'biz-self-1' });
    queueHappyPath('pending_payment');

    const { handleStripeWebhook } = await import('../ingress/stripe');
    await handleStripeWebhook(makeRequest(), makeReply());

    // Status flip happened.
    const updateCall = sqlCalls.find(
      (c) => c.text.includes('UPDATE') && c.text.includes('businesses') && c.text.includes("'active'"),
    );
    expect(updateCall).toBeDefined();
    // Critical regression guard: webhook MUST NOT INSERT INTO job_outbox.
    expect(getInsertOutboxCall()).toBeUndefined();
  });

  it('past_due → active flips status and does NOT enqueue (recovery, not first sync)', async () => {
    setCheckoutSessionCompletedEvent({ businessId: 'biz-pastdue' });
    queueHappyPath('past_due');

    const { handleStripeWebhook } = await import('../ingress/stripe');
    await handleStripeWebhook(makeRequest(), makeReply());

    const updateCall = sqlCalls.find(
      (c) => c.text.includes('UPDATE') && c.text.includes('businesses') && c.text.includes("'active'"),
    );
    expect(updateCall).toBeDefined();
    expect(getInsertOutboxCall()).toBeUndefined();
  });

  it('active → active is a no-op (status guard) and does NOT enqueue', async () => {
    setCheckoutSessionCompletedEvent({ businessId: 'biz-active-dup' });
    queueHappyPath('active', { updateBusinessesCount: 0 });

    const { handleStripeWebhook } = await import('../ingress/stripe');
    await handleStripeWebhook(makeRequest(), makeReply());

    expect(getInsertOutboxCall()).toBeUndefined();
  });

  it('serialization ordering: advisory lock runs before FOR UPDATE select and before UPDATE businesses', async () => {
    setCheckoutSessionCompletedEvent({ businessId: 'biz-concurrent' });
    queueHappyPath('pending_payment');

    const { handleStripeWebhook } = await import('../ingress/stripe');
    await handleStripeWebhook(makeRequest(), makeReply());

    const lockIdx = sqlCalls.findIndex((c) => c.text.includes('pg_advisory_xact_lock'));
    const selectIdx = sqlCalls.findIndex(
      (c) => c.text.includes('FOR UPDATE') && c.text.includes('subscription_status'),
    );
    const updateBizIdx = sqlCalls.findIndex(
      (c) =>
        c.text.includes('UPDATE') &&
        c.text.includes('businesses') &&
        c.text.includes("'active'"),
    );

    expect(lockIdx).toBeGreaterThanOrEqual(0);
    expect(selectIdx).toBeGreaterThan(lockIdx);
    expect(updateBizIdx).toBeGreaterThan(selectIdx);

    // Lock key is hash-stable per business.
    const lockCall = sqlCalls[lockIdx]!;
    expect(lockCall.text).toContain('hashtext');
    expect(lockCall.values).toContain('biz-concurrent:activation');
  });

  it('biz-row-deleted race: still completes the outer flow with no enqueue', async () => {
    setCheckoutSessionCompletedEvent({ businessId: 'biz-deleted' });
    // Inbound INSERT → count=1
    const insertInbound: any = []; insertInbound.count = 1;
    sqlReturnQueue.push(insertInbound);
    // advisory lock → []
    sqlReturnQueue.push([]);
    // FOR UPDATE returns no row.
    sqlReturnQueue.push([]);

    const { handleStripeWebhook } = await import('../ingress/stripe');
    const reply = makeReply();
    await handleStripeWebhook(makeRequest(), reply);

    // Webhook still acks 200.
    expect(reply.status).toHaveBeenCalledWith(200);
    expect(getInsertOutboxCall()).toBeUndefined();
  });
});
