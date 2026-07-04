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

// ── Hoisted mock state (shared Postgres.js mock — issue #268) ─────────
// Uses the repo-canonical createMockSql instead of a hand-rolled copy. The
// async-hoisted dynamic import is required because vi.hoisted runs before static
// imports are initialized (see worker/__tests__/helpers/mock-sql.ts).
const { sqlReturnQueue, sqlCalls, mockSql } = await vi.hoisted(async () => {
  const { createMockSql } = await import('../../__tests__/helpers/mock-sql');
  return createMockSql();
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

// primaryBizId: set when the test also exercises backfill resume (so
// resolveAccount returns a non-null primary_business_id, letting the
// post-tx backfill path proceed). Leave null for tests that don't
// need backfill (backfill short-circuits when resumeBusinessId is falsy).
function queueHappyPath(
  currentStatus: string,
  options: { updateBusinessesCount?: number; primaryBizId?: string | null } = {},
) {
  // Pre-tx claimInboundEvent INSERT (injected by the webhook handler before
  // processCheckoutSessionCompleted is called)
  const insertInbound: any = []; insertInbound.count = 1;
  sqlReturnQueue.push(insertInbound);
  // Pre-tx account lookup: SELECT id FROM accounts WHERE id = ${refId}::uuid
  sqlReturnQueue.push([{ id: '019dc366-29ce-7000-a000-000000000000' }]);

  // ── After B1.4: paid activation routes through the applier (checkout mode) ──
  // Inside sql.begin (tx = mockSql):
  //   1. pg_advisory_xact_lock
  //   2. Applier resolveAccount: SELECT a.id, a.subscription_status,
  //      (SELECT b.id …) AS primary_business_id FROM accounts a WHERE a.id=? FOR UPDATE
  //   3. writeStatusColumns: UPDATE accounts SET subscription_status='active',
  //      trial_ends_at=NULL, past_due_at=NULL, stripe_customer_id=COALESCE(…),
  //      stripe_subscription_id=COALESCE(…), subscription_activated_at=COALESCE(…),
  //      updated_at=NOW() WHERE id=?
  //   4. writeBusinessesMirror: UPDATE businesses SET subscription_status='active',
  //      subscription_activated_at=COALESCE(…), updated_at=NOW()
  //      WHERE account_id=? AND is_primary=TRUE AND archived_at IS NULL
  //      (no stripe_customer_id / stripe_subscription_id — deprecated, VAL-SCHEMA-037)
  //   5. writeAccountAuditLog → INSERT INTO account_audit_log (via mockSql — not mocked separately)
  //   6. enqueueStripeOverageRecompute → INSERT INTO job_outbox (topic='update_stripe_overage_quantity')
  //   7. enqueueLifecycleAnalytics: pending_payment/past_due → active, fromStatus≠trialing → no-op
  //
  // For already-active: isAllowedTransition(active→active)=false → NO_CHANGE,
  // only resolveAccount SELECT fires (no UPDATEs, no audit, no overage enqueue).

  sqlReturnQueue.push([]); // pg_advisory_xact_lock

  const didActivate = currentStatus !== 'active';
  const primaryBizId = options.primaryBizId ?? null;

  // resolveAccount SELECT (always runs — returns id + subscription_status + primary_business_id)
  sqlReturnQueue.push([{
    id: '019dc366-29ce-7000-a000-000000000000',
    subscription_status: currentStatus,
    primary_business_id: primaryBizId,
  }]);

  if (didActivate) {
    // writeStatusColumns: UPDATE accounts
    const updateAcct: any = []; updateAcct.count = 1;
    sqlReturnQueue.push(updateAcct);
    // writeBusinessesMirror: UPDATE businesses
    const updateBiz: any = []; updateBiz.count = options.updateBusinessesCount ?? 1;
    sqlReturnQueue.push(updateBiz);
    // writeAccountAuditLog: INSERT INTO account_audit_log
    const auditLog: any = []; auditLog.count = 1;
    sqlReturnQueue.push(auditLog);
    // enqueueStripeOverageRecompute: INSERT INTO job_outbox (topic='update_stripe_overage_quantity')
    const overageOutbox: any = []; overageOutbox.count = 1;
    sqlReturnQueue.push(overageOutbox);
  }
  // already-active: isAllowedTransition(active→active)=false → no UPDATEs, no audit, no overage
}

function getInsertOutboxCall() {
  // Narrowed to zernio_initial_backfill — the overage INSERT is separate
  // (update_stripe_overage_quantity) and tested by its own helper below.
  // Topic is an interpolated value, not a template literal — check values array.
  return sqlCalls.find(
    (c) => (c.text.includes('INSERT INTO job_outbox') || (c.text.includes('INSERT') && c.text.includes('job_outbox')))
      && c.values.includes('zernio_initial_backfill'),
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
    // Topic is an interpolated value, not a template literal — check values array.
    return sqlCalls.filter(
      (c) => c.text.includes('INSERT INTO job_outbox')
        && c.values.includes('zernio_initial_backfill'),
    );
  }

  function queueBackfillResumeMatchPath(opts: {
    accountId?: string;
    locationId?: string;
    tier?: string;
    activatedAt?: Date;
  } = {}) {
    // After B1.4: the primary business ID comes from transition.primaryBusinessId
    // (returned by the applier's resolveAccount). queueHappyPath must be called
    // with primaryBizId: TEST_BIZ_PENDING so the backfill path gets a non-null
    // resumeBusinessId. No post-tx "find primary business" SQL fires.
    //
    // maybeEnqueueBackfillResume then does:
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
    // primaryBizId from resolveAccount so transition.primaryBusinessId is non-null
    // and the post-tx backfill resume path can proceed without a separate DB lookup.
    queueHappyPath('pending_payment', { primaryBizId: TEST_BIZ_PENDING });
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
    // primaryBizId needed so the backfill path attempts the predicate SELECT
    queueHappyPath('pending_payment', { primaryBizId: TEST_BIZ_PENDING });
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
    queueHappyPath('pending_payment', { primaryBizId: TEST_BIZ_PENDING });
    queueBackfillResumeMatchPath({ tier: 'premium' });

    const { handleStripeWebhook } = await import('../stripe');
    await handleStripeWebhook(makeRequest(), makeReply());

    const inserts = getBackfillInsertCalls();
    expect(inserts).toHaveLength(1);
  });

  it('flag=ON + in-flight outbox row exists → INSERT … SELECT WHERE NOT EXISTS skips (count=0)', async () => {
    process.env.ZERNIO_PUBLISHING_ENABLED = 'true';
    setCheckoutSessionCompletedEvent({ businessId: TEST_BIZ_PENDING });
    queueHappyPath('pending_payment', { primaryBizId: TEST_BIZ_PENDING });
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
    // include "NOT EXISTS" + "zernio_initial_backfill" (interpolated value,
    // not a template literal) + "in ('pending'".
    const insertSql = sqlCalls.find(
      (c) => c.text.includes('INSERT INTO job_outbox')
        && c.values.includes('zernio_initial_backfill'),
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
