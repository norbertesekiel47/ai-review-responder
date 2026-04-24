import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * Task 16 — Stripe webhook transition-gated initial-sync enqueue.
 *
 * Validates `processCheckoutSessionCompleted` in `worker/ingress/stripe.ts`:
 *   - advisory lock before state read + UPDATE
 *   - transition gate: only enqueue on pending_payment → active
 *   - self-serve scope (onboarded_by IS NULL AND u.auth_id IS NOT NULL) enforced IN SQL
 *   - verified place_id → sync_reviews topic + {business_id, google_place_id, correlation_id}
 *   - unverified + google_maps_url → validate_place_id topic + {business_id, google_maps_url, correlation_id}
 *   - neither → log loudly, skip (data-integrity breach)
 *   - WHERE NOT EXISTS dedup over ('sync_reviews','validate_place_id') × non-terminal statuses
 *
 * Test strategy: a tracked `mockSql` that records every tagged-template call and
 * returns queued results in order; `mockSql.begin` invokes the callback with the
 * same mockSql (so we observe every tx call). Stripe SDK is stubbed via
 * webhooks.constructEvent (same pattern as webhook-dedup.test.ts).
 */

// ── Hoisted mock state ───────────────────────────────────────────────
const { sqlReturnQueue, sqlCalls, mockSql, beginInvocations } = vi.hoisted(() => {
  const sqlReturnQueue: unknown[] = [];
  const sqlCalls: { text: string; values: unknown[] }[] = [];
  const beginInvocations: number[] = [];

  const mockSql: any = vi.fn((_s: TemplateStringsArray, ..._v: unknown[]) => {
    const text = Array.from(_s).join('?');
    sqlCalls.push({ text, values: _v });
    const queued = sqlReturnQueue.shift();
    if (queued !== undefined) return Promise.resolve(queued);
    const empty: unknown[] & { count: number } = Object.assign([], { count: 0 });
    return Promise.resolve(empty);
  });

  mockSql.begin = vi.fn(async (callback: (tx: any) => Promise<any>) => {
    beginInvocations.push(sqlCalls.length);
    return callback(mockSql);
  });

  return { sqlReturnQueue, sqlCalls, mockSql, beginInvocations };
});

vi.mock('../../src/lib/db/server', () => ({ sql: mockSql, jsonb: (v: unknown) => v }));
vi.mock('uuid', () => ({ v7: vi.fn(() => 'test-uuid-v7') }));

const mockConstructEvent = vi.fn();
vi.mock('stripe', () => ({
  default: class MockStripe {
    webhooks = { constructEvent: mockConstructEvent };
  },
}));

// ── Shared helpers ───────────────────────────────────────────────────

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
  paymentStatus?: 'paid' | 'unpaid';
  mode?: 'subscription' | 'payment';
} = {}) {
  mockConstructEvent.mockReturnValueOnce({
    id: overrides.eventId ?? 'evt_test_123',
    type: 'checkout.session.completed',
    data: {
      object: {
        client_reference_id: overrides.businessId ?? 'biz-1',
        customer: 'cus_1',
        subscription: 'sub_1',
        mode: overrides.mode ?? 'subscription',
        payment_status: overrides.paymentStatus ?? 'paid',
      },
    },
  });
}

/**
 * Set up the minimum sql-return-queue required for a happy-path webhook call
 * up to (but not including) the transition-gate behavior. Caller can append
 * additional returns for the INSERT job_outbox statement.
 *
 * Queue order:
 *  1. claimInboundEvent INSERT → count=1 (new event)
 *  2. sql.begin callback:
 *     2a. pg_advisory_xact_lock → []
 *     2b. SELECT ... FOR UPDATE → [bizRow] (caller-supplied)
 *     2c. UPDATE businesses SET subscription_status='active'... → {count:1}
 *     2d. (caller may append: INSERT INTO job_outbox ... WHERE NOT EXISTS ...)
 *  3. UPDATE inbound_events SET status='processed' → []
 */
function queueHappyPath(bizRow: {
  subscription_status: string;
  google_place_id: string | null;
  google_maps_url: string | null;
  place_id_verified: boolean;
}, options: { updateBusinessesCount?: number } = {}) {
  const insertInbound: any = []; insertInbound.count = 1;
  sqlReturnQueue.push(insertInbound);
  sqlReturnQueue.push([]); // pg_advisory_xact_lock
  sqlReturnQueue.push([bizRow]); // SELECT ... FOR UPDATE
  const updateBiz: any = []; updateBiz.count = options.updateBusinessesCount ?? 1;
  sqlReturnQueue.push(updateBiz);
}

// ── Case-specific assertions ─────────────────────────────────────────

function getAdvisoryLockCall() {
  return sqlCalls.find((c) => c.text.includes('pg_advisory_xact_lock'));
}

function getForUpdateSelect() {
  return sqlCalls.find(
    (c) => c.text.includes('FOR UPDATE') && c.text.includes('place_id_verified'),
  );
}

function getUpdateBusinessesCall() {
  return sqlCalls.find(
    (c) => c.text.includes('UPDATE') && c.text.includes('businesses') && c.text.includes("subscription_status = 'active'") || (c.text.includes("subscription_status='active'")),
  );
}

function getInsertOutboxCall() {
  return sqlCalls.find(
    (c) => c.text.includes('INSERT INTO job_outbox') || (c.text.includes('INSERT') && c.text.includes('job_outbox')),
  );
}

// ─────────────────────────────────────────────────────────────────────
describe('Stripe webhook — transition-gated initial-sync enqueue', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    sqlReturnQueue.length = 0;
    sqlCalls.length = 0;
    beginInvocations.length = 0;
    process.env.STRIPE_SECRET_KEY = 'sk_test_fake';
    process.env.STRIPE_WEBHOOK_SECRET = 'whsec_test_fake';
    vi.resetModules();
  });

  it('case 1: self-serve + verified place_id → enqueue sync_reviews with SyncReviewsPayload', async () => {
    setCheckoutSessionCompletedEvent({ businessId: 'biz-self-1' });
    queueHappyPath({
      subscription_status: 'pending_payment',
      google_place_id: 'ChIJ-verified',
      google_maps_url: null,
      place_id_verified: true,
    });

    const { handleStripeWebhook } = await import('../ingress/stripe');
    await handleStripeWebhook(makeRequest(), makeReply());

    // Advisory lock acquired first inside the transaction.
    expect(getAdvisoryLockCall()).toBeDefined();
    // The advisory lock must be on the composite string to scope per-business.
    const lockCall = getAdvisoryLockCall()!;
    expect(lockCall.values).toContain('biz-self-1:activation');
    // FOR UPDATE select snapshot.
    expect(getForUpdateSelect()).toBeDefined();

    // INSERT INTO job_outbox happened — sync_reviews topic.
    const insertOutbox = getInsertOutboxCall();
    expect(insertOutbox).toBeDefined();
    expect(insertOutbox!.text).toContain('job_outbox');
    expect(insertOutbox!.values).toContain('sync_reviews');
    // aggregate_type='business' is inlined literal in the template, not a
    // template-literal parameter — assert on the SQL text.
    expect(insertOutbox!.text).toContain("'business'");
    expect(insertOutbox!.values).toContain('biz-self-1');

    // Dedup + self-serve scope baked into the same statement.
    expect(insertOutbox!.text).toContain('NOT EXISTS');
    expect(insertOutbox!.text).toContain("'sync_reviews'");
    expect(insertOutbox!.text).toContain("'validate_place_id'");
    expect(insertOutbox!.text).toContain("'pending'");
    expect(insertOutbox!.text).toContain("'dispatching'");
    expect(insertOutbox!.text).toContain("'dispatched'");
    expect(insertOutbox!.text).toContain('onboarded_by IS NULL');
    expect(insertOutbox!.text).toContain('auth_id IS NOT NULL');

    // Payload is the SyncReviewsPayload shape.
    const payloadArg = insertOutbox!.values.find(
      (v) => v && typeof v === 'object' && 'google_place_id' in (v as object),
    ) as { business_id: string; google_place_id: string; correlation_id: string } | undefined;
    expect(payloadArg).toBeDefined();
    expect(payloadArg!.business_id).toBe('biz-self-1');
    expect(payloadArg!.google_place_id).toBe('ChIJ-verified');
    expect(typeof payloadArg!.correlation_id).toBe('string');
    expect(payloadArg!.correlation_id.length).toBeGreaterThan(0);
  });

  it('case 2: self-serve + unverified place_id + google_maps_url → enqueue validate_place_id with URL', async () => {
    setCheckoutSessionCompletedEvent({ businessId: 'biz-self-2' });
    queueHappyPath({
      subscription_status: 'pending_payment',
      google_place_id: null,
      google_maps_url: 'https://maps.google.com/?cid=12345',
      place_id_verified: false,
    });

    const { handleStripeWebhook } = await import('../ingress/stripe');
    await handleStripeWebhook(makeRequest(), makeReply());

    const insertOutbox = getInsertOutboxCall();
    expect(insertOutbox).toBeDefined();
    expect(insertOutbox!.values).toContain('validate_place_id');
    expect(insertOutbox!.values).toContain('biz-self-2');

    const payloadArg = insertOutbox!.values.find(
      (v) => v && typeof v === 'object' && 'google_maps_url' in (v as object),
    ) as { business_id: string; google_maps_url: string; correlation_id: string } | undefined;
    expect(payloadArg).toBeDefined();
    expect(payloadArg!.business_id).toBe('biz-self-2');
    expect(payloadArg!.google_maps_url).toBe('https://maps.google.com/?cid=12345');
    expect(typeof payloadArg!.correlation_id).toBe('string');
    // No google_place_id on this payload shape.
    expect((payloadArg as any).google_place_id).toBeUndefined();
  });

  it('case 3: self-serve + neither verified place_id nor google_maps_url → NO enqueue, error logged', async () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    setCheckoutSessionCompletedEvent({ businessId: 'biz-self-3' });
    queueHappyPath({
      subscription_status: 'pending_payment',
      google_place_id: null,
      google_maps_url: null,
      place_id_verified: false,
    });

    const { handleStripeWebhook } = await import('../ingress/stripe');
    await handleStripeWebhook(makeRequest(), makeReply());

    expect(getInsertOutboxCall()).toBeUndefined();
    expect(errorSpy).toHaveBeenCalled();
    const errMsgs = errorSpy.mock.calls.flat().join(' ');
    expect(errMsgs).toMatch(/biz-self-3/);
    expect(errMsgs).toMatch(/neither/i);
    errorSpy.mockRestore();
  });

  it('case 4: transition gate — past_due → active does NOT enqueue (existing customer recovery)', async () => {
    setCheckoutSessionCompletedEvent({ businessId: 'biz-pastdue' });
    queueHappyPath({
      subscription_status: 'past_due',
      google_place_id: 'ChIJ-something',
      google_maps_url: null,
      place_id_verified: true,
    });

    const { handleStripeWebhook } = await import('../ingress/stripe');
    await handleStripeWebhook(makeRequest(), makeReply());

    // Businesses UPDATE still ran (status guard IN ('pending_payment','past_due')
    // still matches past_due).
    const updateCalls = sqlCalls.filter(
      (c) =>
        c.text.includes('UPDATE') &&
        c.text.includes('businesses') &&
        c.text.includes('subscription_status'),
    );
    expect(updateCalls.length).toBeGreaterThan(0);
    // Transition gate blocks the enqueue — past_due activation is recovery, not first-sync.
    expect(getInsertOutboxCall()).toBeUndefined();
  });

  it('case 5: transition gate — active → active (duplicate webhook) does NOT enqueue', async () => {
    setCheckoutSessionCompletedEvent({ businessId: 'biz-active-dup' });
    queueHappyPath(
      {
        subscription_status: 'active',
        google_place_id: 'ChIJ-test',
        google_maps_url: null,
        place_id_verified: true,
      },
      { updateBusinessesCount: 0 }, // status-guarded UPDATE does nothing when already active
    );

    const { handleStripeWebhook } = await import('../ingress/stripe');
    await handleStripeWebhook(makeRequest(), makeReply());

    expect(getInsertOutboxCall()).toBeUndefined();
  });

  it('case 6: admin-onboarded (self-serve scope fails in SQL) does NOT enqueue — predicate baked in', async () => {
    // Admin-onboarded biz: the SELECT's inner EXISTS predicate
    // (onboarded_by IS NULL AND u.auth_id IS NOT NULL) fails, so INSERT ... SELECT
    // writes zero rows. We assert the INSERT statement exists and has the
    // predicate — the DB itself is the enforcement point.
    setCheckoutSessionCompletedEvent({ businessId: 'biz-admin-1' });
    queueHappyPath({
      subscription_status: 'pending_payment',
      google_place_id: 'ChIJ-admin',
      google_maps_url: null,
      place_id_verified: true,
    });
    // INSERT ... WHERE NOT EXISTS AND EXISTS — returns 0 rows in real DB;
    // queue a 0-count to simulate that.
    const outboxInsertResult: any = []; outboxInsertResult.count = 0;
    sqlReturnQueue.push(outboxInsertResult);

    const { handleStripeWebhook } = await import('../ingress/stripe');
    await handleStripeWebhook(makeRequest(), makeReply());

    const insertOutbox = getInsertOutboxCall();
    // Statement ran (transition gate allowed it), but its predicate enforces
    // self-serve scope in the DB layer. Assert the predicate is present.
    expect(insertOutbox).toBeDefined();
    expect(insertOutbox!.text).toContain('onboarded_by IS NULL');
    expect(insertOutbox!.text).toContain('auth_id IS NOT NULL');
    expect(insertOutbox!.text).toContain("role = 'owner'");
  });

  it('case 7: existing non-terminal outbox row prevents duplicate enqueue (dedup baked in)', async () => {
    setCheckoutSessionCompletedEvent({ businessId: 'biz-dup-outbox' });
    queueHappyPath({
      subscription_status: 'pending_payment',
      google_place_id: 'ChIJ-dup',
      google_maps_url: null,
      place_id_verified: true,
    });
    // Simulate the dedup path: INSERT ... WHERE NOT EXISTS finds a pending row
    // and writes nothing.
    const insertResult: any = []; insertResult.count = 0;
    sqlReturnQueue.push(insertResult);

    const { handleStripeWebhook } = await import('../ingress/stripe');
    await handleStripeWebhook(makeRequest(), makeReply());

    const insertOutbox = getInsertOutboxCall();
    expect(insertOutbox).toBeDefined();
    // NOT EXISTS predicate covers BOTH topics + all non-terminal statuses.
    expect(insertOutbox!.text).toContain("topic IN ('sync_reviews', 'validate_place_id')");
    expect(insertOutbox!.text).toContain("status IN ('pending', 'dispatching', 'dispatched')");
  });

  it('case 8: advisory lock runs BEFORE FOR UPDATE select and UPDATE businesses (serialization ordering)', async () => {
    setCheckoutSessionCompletedEvent({ businessId: 'biz-concurrent' });
    queueHappyPath({
      subscription_status: 'pending_payment',
      google_place_id: 'ChIJ-c',
      google_maps_url: null,
      place_id_verified: true,
    });

    const { handleStripeWebhook } = await import('../ingress/stripe');
    await handleStripeWebhook(makeRequest(), makeReply());

    const lockIdx = sqlCalls.findIndex((c) => c.text.includes('pg_advisory_xact_lock'));
    const selectIdx = sqlCalls.findIndex(
      (c) => c.text.includes('FOR UPDATE') && c.text.includes('place_id_verified'),
    );
    const updateBizIdx = sqlCalls.findIndex(
      (c) =>
        c.text.includes('UPDATE') &&
        c.text.includes('businesses') &&
        c.text.includes("'active'"),
    );
    const insertOutboxIdx = sqlCalls.findIndex(
      (c) => c.text.includes('INSERT') && c.text.includes('job_outbox'),
    );

    expect(lockIdx).toBeGreaterThanOrEqual(0);
    expect(selectIdx).toBeGreaterThan(lockIdx);
    expect(updateBizIdx).toBeGreaterThan(selectIdx);
    expect(insertOutboxIdx).toBeGreaterThan(updateBizIdx);

    // Advisory lock key is hash-stable per business.
    const lockCall = sqlCalls[lockIdx]!;
    expect(lockCall.text).toContain('hashtext');
    expect(lockCall.values).toContain('biz-concurrent:activation');
  });

  it('case 9 (safety): skips enqueue but still completes UPDATE when biz row has deleted between claim and tx', async () => {
    setCheckoutSessionCompletedEvent({ businessId: 'biz-deleted' });
    // Inbound events INSERT → count=1
    const insertInbound: any = []; insertInbound.count = 1;
    sqlReturnQueue.push(insertInbound);
    // advisory lock → []
    sqlReturnQueue.push([]);
    // FOR UPDATE SELECT returns no row (race: biz was deleted)
    sqlReturnQueue.push([]);

    const { handleStripeWebhook } = await import('../ingress/stripe');
    const reply = makeReply();
    await handleStripeWebhook(makeRequest(), reply);

    // No crash. Webhook still acks 200.
    expect(reply.status).toHaveBeenCalledWith(200);
    // No outbox insert since row-not-found bails early.
    expect(getInsertOutboxCall()).toBeUndefined();
  });
});
