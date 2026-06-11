import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

/**
 * Stripe webhook — checkout.session.completed status-flip + backfill-resume.
 *
 * The initial-sync ENQUEUE moved out of this webhook in the self-serve
 * refactor (2026-04-24). The wizard at /api/onboarding/business now owns
 * sync_reviews-topic-equivalent enqueue, so this webhook activation path:
 *   1. Acquires the activation advisory lock.
 *   2. FOR UPDATE-reads the current subscription_status.
 *   3. UPDATEs to 'active' (status guard prevents active→active churn).
 *   4. Outside the activation tx — best-effort post-activation Zernio
 *      backfill resume via maybeEnqueueBackfillResume (only when
 *      ZERNIO_PUBLISHING_ENABLED=true AND the predicate finds an active
 *      Zernio connection AND no completed backfill row exists).
 *
 * What this file enforces:
 *   - Advisory lock runs before status read (serialization ordering).
 *   - When ZERNIO_PUBLISHING_ENABLED unset/false → NO outbox INSERT fires.
 *   - past_due → active still flips status (existing-customer recovery).
 *   - active → active is a no-op (status guard rejects).
 *   - When ZERNIO_PUBLISHING_ENABLED=true AND predicate matches → exactly
 *     one zernio_initial_backfill outbox row enqueued, dedup-guarded
 *     against in-flight rows.
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

vi.mock('../../../src/lib/db/server', () => ({ sql: mockSql, jsonb: (v: unknown) => v }));
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

// Valid UUIDv7 fixtures. The processCheckoutSessionCompleted handler
// rejects any client_reference_id that doesn't match the canonical
// 8-4-4-4-12 hex UUID shape (B23 fix), so test fixtures need to be real
// UUIDs to exercise the activation path. Pre-B23 tests used readable
// strings like 'biz-self-1' that would now be skipped before any SQL
// fires.
const TEST_BIZ_PENDING = '019dc366-29ce-7000-a000-000000000001';
const TEST_BIZ_PASTDUE = '019dc366-29ce-7000-a000-000000000002';
const TEST_BIZ_ACTIVE_DUP = '019dc366-29ce-7000-a000-000000000003';
const TEST_BIZ_CONCURRENT = '019dc366-29ce-7000-a000-000000000004';
const TEST_BIZ_DELETED = '019dc366-29ce-7000-a000-000000000005';
const TEST_BIZ_DEFAULT = '019dc366-29ce-7000-a000-000000000000';

function setCheckoutSessionCompletedEvent(overrides: {
  businessId?: string;
  eventId?: string;
} = {}) {
  mockConstructEvent.mockReturnValueOnce({
    id: overrides.eventId ?? 'evt_test_123',
    type: 'checkout.session.completed',
    data: {
      object: {
        client_reference_id: overrides.businessId ?? TEST_BIZ_DEFAULT,
        customer: 'cus_1',
        subscription: 'sub_1',
        mode: 'subscription',
        payment_status: 'paid',
      },
    },
  });
}

function queueHappyPath(currentStatus: string, options: { updateBusinessesCount?: number } = {}) {
  // New flow: account lookup first (outside tx)
  const insertInbound: any = []; insertInbound.count = 1;
  sqlReturnQueue.push(insertInbound);
  // Account lookup: SELECT id FROM accounts WHERE id = ${refId}::uuid
  sqlReturnQueue.push([{ id: '019dc366-29ce-7000-a000-000000000000' }]); // account found
  // Inside tx:
  sqlReturnQueue.push([]); // pg_advisory_xact_lock
  // SELECT subscription_status FROM accounts ... FOR UPDATE
  sqlReturnQueue.push([{ subscription_status: currentStatus }]);
  // UPDATE accounts → active (WHERE subscription_status IN ('pending_payment','past_due'))
  // Returns count=0 when already active (status guard blocks the update).
  const didActivate = currentStatus !== 'active';
  const updateAcct: any = []; updateAcct.count = didActivate ? 1 : 0;
  sqlReturnQueue.push(updateAcct);
  if (didActivate) {
    // INSERT account_audit_log (subscription_status_changed)
    const auditLog: any = []; auditLog.count = 1;
    sqlReturnQueue.push(auditLog);
    // INSERT job_outbox (update_stripe_overage_quantity) — D3: inside the
    // if (updateAcct.count > 0) block.
    const overageOutbox: any = []; overageOutbox.count = 1;
    sqlReturnQueue.push(overageOutbox);
  }
  // UPDATE businesses (deprecated column compat)
  const updateBiz: any = []; updateBiz.count = options.updateBusinessesCount ?? 1;
  sqlReturnQueue.push(updateBiz);
}

function getInsertOutboxCall() {
  // Narrowed to zernio_initial_backfill — the overage INSERT is separate
  // (update_stripe_overage_quantity) and tested by its own helper below.
  return sqlCalls.find(
    (c) => (c.text.includes('INSERT INTO job_outbox') || (c.text.includes('INSERT') && c.text.includes('job_outbox')))
      && c.text.includes("'zernio_initial_backfill'"),
  );
}

function getOverageOutboxInserts() {
  // Topic is an interpolated value, not a template literal — check values array.
  return sqlCalls.filter(
    (c) => c.text.includes('INSERT INTO job_outbox') && c.values.includes('update_stripe_overage_quantity'),
  );
}

// ─────────────────────────────────────────────────────────────────────
describe('Stripe webhook — status flip + post-activation backfill resume', () => {
  let prevZernioFlag: string | undefined;

  beforeEach(() => {
    vi.clearAllMocks();
    sqlReturnQueue.length = 0;
    sqlCalls.length = 0;
    process.env.STRIPE_SECRET_KEY = 'sk_test_fake';
    process.env.STRIPE_WEBHOOK_SECRET = 'whsec_test_fake';
    prevZernioFlag = process.env.ZERNIO_PUBLISHING_ENABLED;
    delete process.env.ZERNIO_PUBLISHING_ENABLED;  // explicit OFF default
    vi.resetModules();
  });

  afterEach(() => {
    if (prevZernioFlag === undefined) delete process.env.ZERNIO_PUBLISHING_ENABLED;
    else process.env.ZERNIO_PUBLISHING_ENABLED = prevZernioFlag;
  });

  it('pending_payment → active flips status; ZERNIO_PUBLISHING_ENABLED off → NO outbox enqueue', async () => {
    setCheckoutSessionCompletedEvent({ businessId: TEST_BIZ_PENDING });
    queueHappyPath('pending_payment');

    const { handleStripeWebhook } = await import('../stripe');
    await handleStripeWebhook(makeRequest(), makeReply());

    // Status flip happened — check for accounts UPDATE (source of truth)
    const updateCall = sqlCalls.find(
      (c) => c.text.includes('UPDATE') && c.text.includes('accounts') && c.text.includes("'active'"),
    );
    expect(updateCall).toBeDefined();
    // ZERNIO_PUBLISHING_ENABLED is unset in beforeEach, so the post-activation
    // backfill-resume hook short-circuits BEFORE any SQL fires.
    expect(getInsertOutboxCall()).toBeUndefined();
  });

  it('past_due → active flips status and does NOT enqueue (recovery, not first sync)', async () => {
    setCheckoutSessionCompletedEvent({ businessId: TEST_BIZ_PASTDUE });
    queueHappyPath('past_due');

    const { handleStripeWebhook } = await import('../stripe');
    await handleStripeWebhook(makeRequest(), makeReply());

    const updateCall = sqlCalls.find(
      (c) => c.text.includes('UPDATE') && c.text.includes('accounts') && c.text.includes("'active'"),
    );
    expect(updateCall).toBeDefined();
    expect(getInsertOutboxCall()).toBeUndefined();
  });

  it('active → active is a no-op (status guard) and does NOT enqueue', async () => {
    setCheckoutSessionCompletedEvent({ businessId: TEST_BIZ_ACTIVE_DUP });
    queueHappyPath('active', { updateBusinessesCount: 0 });

    const { handleStripeWebhook } = await import('../stripe');
    await handleStripeWebhook(makeRequest(), makeReply());

    expect(getInsertOutboxCall()).toBeUndefined();
  });

  it('serialization ordering: advisory lock runs before FOR UPDATE select and before UPDATE accounts', async () => {
    setCheckoutSessionCompletedEvent({ businessId: TEST_BIZ_CONCURRENT });
    queueHappyPath('pending_payment');

    const { handleStripeWebhook } = await import('../stripe');
    await handleStripeWebhook(makeRequest(), makeReply());

    const lockIdx = sqlCalls.findIndex((c) => c.text.includes('pg_advisory_xact_lock'));
    const selectIdx = sqlCalls.findIndex(
      (c) => c.text.includes('FOR UPDATE') && c.text.includes('subscription_status'),
    );
    const updateAcctIdx = sqlCalls.findIndex(
      (c) =>
        c.text.includes('UPDATE') &&
        c.text.includes('accounts') &&
        c.text.includes("'active'"),
    );

    expect(lockIdx).toBeGreaterThanOrEqual(0);
    expect(selectIdx).toBeGreaterThan(lockIdx);
    expect(updateAcctIdx).toBeGreaterThan(selectIdx);

    // Lock key is hash-stable per account (after migration 034, lock key
    // uses accountId instead of businessId). The account lookup mock returns
    // id='019dc366-29ce-7000-a000-000000000000' for all happy-path tests.
    const lockCall = sqlCalls[lockIdx]!;
    expect(lockCall.text).toContain('hashtext');
    expect(lockCall.values).toContain('019dc366-29ce-7000-a000-000000000000:activation');
  });

  it('biz-row-deleted race: still completes the outer flow with no enqueue', async () => {
    setCheckoutSessionCompletedEvent({ businessId: TEST_BIZ_DELETED });
    // Inbound INSERT → count=1
    const insertInbound: any = []; insertInbound.count = 1;
    sqlReturnQueue.push(insertInbound);
    // Account lookup returns no row (new flow)
    sqlReturnQueue.push([]);
    // Business lookup also returns no row (legacy fallback)
    sqlReturnQueue.push([]);

    const { handleStripeWebhook } = await import('../stripe');
    const reply = makeReply();
    await handleStripeWebhook(makeRequest(), reply);

    // Webhook still acks 200.
    expect(reply.status).toHaveBeenCalledWith(200);
    expect(getInsertOutboxCall()).toBeUndefined();
  });

  // ── Backfill-resume branch (ZERNIO_PUBLISHING_ENABLED=true) ──────────────

  function getBackfillInsertCalls() {
    return sqlCalls.filter(
      (c) => c.text.includes('INSERT INTO job_outbox')
        && c.text.includes("'zernio_initial_backfill'"),
    );
  }

  function queueBackfillResumeMatchPath(opts: {
    accountId?: string;
    locationId?: string;
    tier?: string;
    activatedAt?: Date;
  } = {}) {
    // After the activation tx, processCheckoutSessionCompleted needs
    // to find the primary business for the account (new step).
    sqlReturnQueue.push([{ id: TEST_BIZ_PENDING }]); // primary business lookup
    // Then maybeEnqueueBackfillResume does:
    //   SELECT … (predicate match → returns target row)
    //   INSERT INTO job_outbox … (conditional on no in-flight outbox row)
    sqlReturnQueue.push([{
      zernio_account_id: opts.accountId ?? 'zacct-1',
      zernio_location_id: opts.locationId ?? 'zloc-1',
      subscription_tier: opts.tier ?? 'standard',
      subscription_activated_at: opts.activatedAt ?? new Date('2026-04-15T00:00:00Z'),
    }]);
    // Outbox INSERT — count=1 (a new row was inserted).
    const insertOutbox: any = []; insertOutbox.count = 1;
    sqlReturnQueue.push(insertOutbox);
  }

  it('flag=ON + active connection + no completed run → enqueues zernio_initial_backfill', async () => {
    process.env.ZERNIO_PUBLISHING_ENABLED = 'true';
    setCheckoutSessionCompletedEvent({ businessId: TEST_BIZ_PENDING });
    queueHappyPath('pending_payment');
    queueBackfillResumeMatchPath();

    const { handleStripeWebhook } = await import('../stripe');
    await handleStripeWebhook(makeRequest(), makeReply());

    const inserts = getBackfillInsertCalls();
    expect(inserts).toHaveLength(1);
    // Payload includes the snapshot fields the worker needs (accountId,
    // locationId, tier, activated_at). The mocked jsonb passes the object
    // through, so it lands as a tx-arg object value.
    const payload = inserts[0]!.values.find(
      (v): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v)
        && 'subscription_tier' in (v as Record<string, unknown>),
    );
    expect(payload).toMatchObject({
      zernio_account_id: 'zacct-1',
      zernio_location_id: 'zloc-1',
      subscription_tier: 'standard',
    });

    const resumeSelect = sqlCalls.find(
      (c) => c.text.includes('FROM zernio_connections zc')
        && c.text.includes('JOIN businesses b'),
    );
    expect(resumeSelect).toBeDefined();
    expect(resumeSelect!.text).toMatch(/JOIN\s+accounts\s+a\s+ON\s+a\.id\s*=\s*b\.account_id/i);
    expect(resumeSelect!.text).toMatch(/a\.subscription_tier/);
    expect(resumeSelect!.text).toMatch(/a\.subscription_activated_at/);
    expect(resumeSelect!.text).not.toMatch(/b\.subscription_tier/);
    expect(resumeSelect!.text).not.toMatch(/b\.subscription_activated_at/);
  });

  it('flag=ON + predicate miss (no active connection OR completed run exists) → NO outbox INSERT', async () => {
    process.env.ZERNIO_PUBLISHING_ENABLED = 'true';
    setCheckoutSessionCompletedEvent({ businessId: TEST_BIZ_PENDING });
    queueHappyPath('pending_payment');
    // Primary business lookup (new step)
    sqlReturnQueue.push([{ id: TEST_BIZ_PENDING }]);
    // SELECT returns no row (no active connection OR completed run exists).
    sqlReturnQueue.push([]);

    const { handleStripeWebhook } = await import('../stripe');
    await handleStripeWebhook(makeRequest(), makeReply());

    expect(getBackfillInsertCalls()).toHaveLength(0);
  });

  it('flag=ON + no zernio_backfill_runs row at all (admin connected Zernio pre-checkout) → enqueues backfill', async () => {
    // Round-2 reviewer fix: predicate is "no completed run exists" not
    // "incomplete row exists", so a business with NO row at all also
    // triggers enqueue. The mock's SELECT returns the connection target
    // row regardless of which precise NOT EXISTS shape we used; this
    // test pins the contract by exercising the path where a fresh
    // connect-pre-checkout business gets its first backfill.
    process.env.ZERNIO_PUBLISHING_ENABLED = 'true';
    setCheckoutSessionCompletedEvent({ businessId: TEST_BIZ_PENDING });
    queueHappyPath('pending_payment');
    queueBackfillResumeMatchPath({ tier: 'premium' });

    const { handleStripeWebhook } = await import('../stripe');
    await handleStripeWebhook(makeRequest(), makeReply());

    const inserts = getBackfillInsertCalls();
    expect(inserts).toHaveLength(1);
  });

  it('flag=ON + in-flight outbox row exists → INSERT … SELECT WHERE NOT EXISTS skips (count=0)', async () => {
    process.env.ZERNIO_PUBLISHING_ENABLED = 'true';
    setCheckoutSessionCompletedEvent({ businessId: TEST_BIZ_PENDING });
    queueHappyPath('pending_payment');
    // Primary business lookup (new step)
    sqlReturnQueue.push([{ id: TEST_BIZ_PENDING }]);
    // SELECT for predicate → returns target.
    sqlReturnQueue.push([{
      zernio_account_id: 'zacct-1',
      zernio_location_id: 'zloc-1',
      subscription_tier: 'standard',
      subscription_activated_at: new Date('2026-04-15T00:00:00Z'),
    }]);
    // INSERT … SELECT WHERE NOT EXISTS → count=0 (in-flight row blocked it).
    const insertSkipped: any = []; insertSkipped.count = 0;
    sqlReturnQueue.push(insertSkipped);

    const { handleStripeWebhook } = await import('../stripe');
    await handleStripeWebhook(makeRequest(), makeReply());

    // The INSERT statement still ran (the WHERE NOT EXISTS dedup is
    // server-side, not skipped client-side). Pin the SQL shape: it must
    // include "NOT EXISTS" + "zernio_initial_backfill" + "in ('pending'".
    const insertSql = sqlCalls.find(
      (c) => c.text.includes('INSERT INTO job_outbox')
        && c.text.includes("'zernio_initial_backfill'"),
    );
    expect(insertSql).toBeDefined();
    expect(insertSql!.text).toContain('NOT EXISTS');
    expect(insertSql!.text).toMatch(/status\s+IN/);
  });

  // ── D3: overage outbox enqueue on recovery ────────────────────────────

  it('VAL-BILLING-D3c: pending_payment → active activation inserts one update_stripe_overage_quantity outbox row', async () => {
    setCheckoutSessionCompletedEvent({ businessId: TEST_BIZ_PENDING });
    queueHappyPath('pending_payment');

    const { handleStripeWebhook } = await import('../stripe');
    await handleStripeWebhook(makeRequest(), makeReply());

    const inserts = getOverageOutboxInserts();
    expect(inserts).toHaveLength(1);
    const insert = inserts[0]!;
    expect(insert.text).toContain("'account'");   // aggregate_type — SQL literal
    expect(insert.values).toContain('pending');   // status — bound by enqueueStripeOverageRecompute
    // The account id resolved by queueHappyPath account lookup
    expect(insert.values).toContain('019dc366-29ce-7000-a000-000000000000'); // aggregate_id
  });

  it('VAL-BILLING-D3d: active → active no-op (updateAcct.count === 0) does NOT insert overage outbox row', async () => {
    setCheckoutSessionCompletedEvent({ businessId: TEST_BIZ_ACTIVE_DUP });
    queueHappyPath('active', { updateBusinessesCount: 0 });

    const { handleStripeWebhook } = await import('../stripe');
    await handleStripeWebhook(makeRequest(), makeReply());

    expect(getOverageOutboxInserts()).toHaveLength(0);
  });
});
