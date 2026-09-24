// worker/ingress/stripe/__tests__/status-applier-callers.integration.test.ts
//
// Characterization suite for the six production callers of the single Stripe
// status applier (#1355): checkout-completed, subscription-updated,
// invoice-paid, invoice-payment-failed, subscription-deleted and the billing
// reconcile poller's trial correction.
//
// Written BEFORE the applier contract refactor and run green against the old
// two-mode `ApplyStripeRef` contract, then kept unchanged across it. It pins
// what each caller observably does against real Postgres: the transition result
// the applier hands back, the account columns it writes, the audit row, the
// outbox topics, the trial analytics facts, and the backfill-resume target.
// Only Stripe is faked.
//
// The lineage-race cases pin the one behavior the old applier provided
// internally in `subscription` mode: an account that owned the Stripe lineage at
// the caller's unlocked lookup, but lost it before the entitlement lock was
// granted, is never mutated.

import { afterAll, afterEach, beforeAll, beforeEach, expect, it, vi } from 'vitest';
import postgres from 'postgres';
import type { Sql } from 'postgres';
import { randomUUID } from 'node:crypto';
import { describeWithDb } from '@/__tests__/helpers/describe-with-db';
import {
  cleanupTenantAccount,
  seedLocation,
  seedTenantAccount,
  type TenantSeed,
} from '@/lib/shared/__tests__/live-db-tenant';

const {
  mockRetrieveSubscription,
  mockRetrieveSession,
  mockCancelSubscription,
  mockResumePrimaryBusinessBackfill,
  appliedTransitions,
} = vi.hoisted(() => ({
  mockRetrieveSubscription: vi.fn(),
  mockRetrieveSession: vi.fn(),
  mockCancelSubscription: vi.fn(),
  mockResumePrimaryBusinessBackfill: vi.fn(),
  appliedTransitions: [] as unknown[],
}));

vi.mock('../../../../src/lib/payments/stripe-client', () => ({
  getStripe: () => ({
    checkout: { sessions: { retrieve: mockRetrieveSession } },
    subscriptions: {
      retrieve: mockRetrieveSubscription,
      cancel: mockCancelSubscription,
    },
  }),
}));

vi.mock('../shared', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../shared')>()),
  resumePrimaryBusinessBackfill: mockResumePrimaryBusinessBackfill,
}));

// Record every transition result the applier returns, whatever its exported
// entry point is called. Wrapping by name prefix keeps this suite unchanged
// across the contract refactor.
vi.mock('../apply-subscription-state', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  const wrapped: Record<string, unknown> = { ...actual };
  for (const [name, value] of Object.entries(actual)) {
    if (!name.startsWith('applyStripeSubscriptionState') || typeof value !== 'function') continue;
    const fn = value as (...args: unknown[]) => Promise<unknown>;
    wrapped[name] = async (...args: unknown[]) => {
      const result = await fn(...args);
      appliedTransitions.push(result);
      return result;
    };
  }
  return wrapped;
});

import { processCheckoutSessionCompleted } from '../checkout-completed';
import { processSubscriptionUpdated } from '../subscription-updated';
import { processInvoicePaid } from '../invoice-paid';
import { processInvoicePaymentFailed } from '../invoice-payment-failed';
import { processSubscriptionDeleted } from '../subscription-deleted';
import { reconcileAccount } from '../../../background/pollers/billing-reconciliation/reconcile-account';
import type { AccountWithLocations } from '../../../background/pollers/billing-reconciliation/types';
import { sql as productionSql } from '@/lib/db/server';
import { QUEUE_NAMES } from '@/lib/shared/queue-names';

const OVERAGE_TOPIC = QUEUE_NAMES.UPDATE_STRIPE_OVERAGE;
const MIRROR_TOPIC = QUEUE_NAMES.STRIPE_SUBSCRIPTION_MIRROR_SYNC;

const PRICE_ENV = {
  STRIPE_PRICE_COPILOT_LIST: 'price_1355_copilot_list',
  STRIPE_PRICE_COPILOT_FOUNDING: 'price_1355_copilot_founding',
  STRIPE_PRICE_AUTOPILOT_LIST: 'price_1355_autopilot_list',
  STRIPE_PRICE_AUTOPILOT_FOUNDING: 'price_1355_autopilot_founding',
  STRIPE_PRICE_COPILOT_OVERAGE: 'price_1355_copilot_overage',
  STRIPE_PRICE_AUTOPILOT_OVERAGE: 'price_1355_autopilot_overage',
} as const;

const TRIAL_DAYS_SECONDS = 30 * 86_400;
const SUCCESS_URL = 'https://app.example.com/onboarding/payment-success?session_id={CHECKOUT_SESSION_ID}';
const CANCEL_URL = 'https://app.example.com/onboarding/pay?cancelled=true';

let db: Sql | undefined;
const seeded: { tenant: TenantSeed; businessId: string | null }[] = [];

function suiteDb(): Sql {
  if (!db) throw new Error('status-applier-callers suite DB not initialized');
  return db;
}

interface Fixture {
  accountId: string;
  businessId: string | null;
  customerId: string;
  subscriptionId: string;
}

async function seedAccount(input: {
  status: string;
  bound?: boolean;
  primaryBusiness?: boolean;
}): Promise<Fixture> {
  const tenant = await seedTenantAccount(suiteDb(), {
    subscriptionStatus: input.status,
    accountDisplayName: '#1355 applier caller',
  });
  const suffix = randomUUID().slice(0, 8);
  const customerId = `cus_1355_${suffix}`;
  const subscriptionId = `sub_1355_${suffix}`;
  if (input.bound !== false) {
    await suiteDb()`
      UPDATE accounts
      SET stripe_customer_id = ${customerId},
          stripe_subscription_id = ${subscriptionId},
          trial_ends_at = CASE WHEN subscription_status = 'trialing' THEN NOW() + INTERVAL '10 days' ELSE NULL END,
          past_due_at = CASE WHEN subscription_status = 'past_due' THEN NOW() - INTERVAL '1 day' ELSE NULL END
      WHERE id = ${tenant.accountId}::uuid
    `;
  }
  let businessId: string | null = null;
  if (input.primaryBusiness !== false) {
    businessId = (await seedLocation(suiteDb(), tenant.accountId, { isPrimary: true })).businessId;
  }
  seeded.push({ tenant, businessId });
  return { accountId: tenant.accountId, businessId, customerId, subscriptionId };
}

async function openCheckoutAttempt(
  fixture: Fixture,
  sessionId: string,
  attemptId: string,
  trialDays: number | null,
): Promise<void> {
  await suiteDb()`
    UPDATE accounts
    SET checkout_attempt_id = ${attemptId}::uuid,
        checkout_session_id = ${sessionId},
        checkout_attempt_state = 'open',
        checkout_attempt_tier = 'copilot',
        checkout_attempt_price_variant = 'list',
        checkout_attempt_base_price_id = ${PRICE_ENV.STRIPE_PRICE_COPILOT_LIST},
        checkout_attempt_overage_price_id = ${PRICE_ENV.STRIPE_PRICE_COPILOT_OVERAGE},
        checkout_attempt_base_price_cents = 2900,
        checkout_attempt_overage_price_cents = 1500,
        checkout_attempt_locations_included = 1,
        checkout_attempt_locations_paid = 0,
        checkout_attempt_overage_quantity = 0,
        checkout_attempt_trial_period_days = ${trialDays},
        checkout_attempt_tax_enabled = FALSE,
        checkout_attempt_customer_email = 'owner-1355@example.com',
        checkout_attempt_success_url = ${SUCCESS_URL},
        checkout_attempt_cancel_url = ${CANCEL_URL},
        checkout_attempt_updated_at = NOW()
    WHERE id = ${fixture.accountId}::uuid
  `;
}

interface AccountState {
  subscription_status: string;
  stripe_customer_id: string | null;
  stripe_subscription_id: string | null;
  has_trial_end: boolean;
  has_past_due_at: boolean;
  has_cancelled_at: boolean;
  has_activated_at: boolean;
}

async function accountState(accountId: string): Promise<AccountState> {
  const [row] = await suiteDb()<AccountState[]>`
    SELECT subscription_status,
      stripe_customer_id,
      stripe_subscription_id,
      trial_ends_at IS NOT NULL AS has_trial_end,
      past_due_at IS NOT NULL AS has_past_due_at,
      cancelled_at IS NOT NULL AS has_cancelled_at,
      subscription_activated_at IS NOT NULL AS has_activated_at
    FROM accounts
    WHERE id = ${accountId}::uuid
  `;
  if (!row) throw new Error(`account ${accountId} missing`);
  return row;
}

async function trialEndsAt(accountId: string): Promise<string | null> {
  const [row] = await suiteDb()<{ trial_ends_at: string | null }[]>`
    SELECT trial_ends_at::text AS trial_ends_at FROM accounts WHERE id = ${accountId}::uuid
  `;
  return row?.trial_ends_at ?? null;
}

async function statusAudits(accountId: string): Promise<unknown[]> {
  const rows = await suiteDb()<{ payload: unknown }[]>`
    SELECT payload
    FROM account_audit_log
    WHERE account_id = ${accountId}::uuid
      AND event_type = 'subscription_status_changed'
    ORDER BY created_at, id
  `;
  return rows.map((row) => (typeof row.payload === 'string' ? JSON.parse(row.payload) : row.payload));
}

async function outboxTopics(accountId: string): Promise<string[]> {
  const rows = await suiteDb()<{ topic: string }[]>`
    SELECT topic
    FROM job_outbox
    WHERE aggregate_id = ${accountId}::uuid
      AND topic IN (${OVERAGE_TOPIC}, ${MIRROR_TOPIC})
    ORDER BY topic
  `;
  return rows.map((row) => row.topic);
}

async function trialEvents(accountId: string): Promise<string[]> {
  const rows = await suiteDb()<{ event_name: string }[]>`
    SELECT event_name
    FROM analytics_events
    WHERE account_id = ${accountId}::uuid
      AND event_name LIKE 'trial_%'
    ORDER BY event_name
  `;
  return rows.map((row) => row.event_name);
}

function stripeSubscription(fixture: Fixture, overrides: Record<string, unknown> = {}) {
  return {
    id: fixture.subscriptionId,
    customer: fixture.customerId,
    status: 'active',
    trial_start: null,
    trial_end: null,
    metadata: {},
    items: { data: [{ id: 'si_base', quantity: 1, price: { id: PRICE_ENV.STRIPE_PRICE_COPILOT_LIST } }] },
    ...overrides,
  };
}

function invoice(fixture: Fixture): never {
  return {
    id: `in_1355_${randomUUID().slice(0, 8)}`,
    customer: fixture.customerId,
    subscription: fixture.subscriptionId,
  } as never;
}

function eventContext(): { id: string; created: number } {
  return { id: `evt_1355_${randomUUID().slice(0, 8)}`, created: Math.floor(Date.now() / 1000) };
}

function reconcileAccountRow(fixture: Fixture, status: string): AccountWithLocations {
  return {
    id: fixture.accountId,
    subscription_tier: 'copilot',
    subscription_status: status,
    stripe_customer_id: fixture.customerId,
    stripe_subscription_id: fixture.subscriptionId,
    locations_included: 1,
    locations_paid: 0,
    locations_overage_price_cents: 1500,
    base_price_cents: 2900,
    active_location_count: 1,
    past_due_at: null,
    flags: {},
  };
}

/**
 * Transitions the applier returned for an account it actually resolved. A
 * lineage-race case must produce none. (Before #1355 the applier itself ran the
 * lineage recheck and returned an unresolved result; after it, the caller
 * rechecks and never calls the applier. Neither writes, which is what matters.)
 */
function resolvedTransitions(): unknown[] {
  return appliedTransitions.filter(
    (result) => (result as { accountResolved?: boolean }).accountResolved === true,
  );
}

function fakeStripe(subscription: unknown) {
  return {
    subscriptions: {
      retrieve: vi.fn().mockResolvedValue(subscription),
      list: vi.fn().mockResolvedValue({ data: [] }),
    },
  } as never;
}

/**
 * Hold account A's tier-entitlement advisory lock on a separate connection,
 * start `run` (which resolves A by lineage WITHOUT a lock, then blocks on the
 * entitlement lock), move A's subscription lineage while `run` waits, and only
 * then release. `run` proceeds with a stale lineage and must not mutate A.
 */
async function withLineageMovedUnderEntitlement(
  fixture: Fixture,
  run: () => Promise<unknown>,
): Promise<unknown> {
  let releaseHolder!: () => void;
  const released = new Promise<void>((resolve) => { releaseHolder = resolve; });
  let signalHeld!: () => void;
  const held = new Promise<void>((resolve) => { signalHeld = resolve; });
  const holder = suiteDb().begin(async (tx) => {
    await tx`SELECT pg_advisory_xact_lock(hashtext(${`${fixture.accountId}:tier_entitlement`}))`;
    signalHeld();
    await released;
    await tx`
      UPDATE accounts
      SET stripe_subscription_id = ${`${fixture.subscriptionId}_moved`}
      WHERE id = ${fixture.accountId}::uuid
    `;
  });
  await held;
  const outcome = run();
  const deadline = Date.now() + 10_000;
  for (;;) {
    const [waiting] = await suiteDb()<{ n: number }[]>`
      SELECT COUNT(*)::int AS n
      FROM pg_locks
      WHERE locktype = 'advisory' AND NOT granted
    `;
    if ((waiting?.n ?? 0) > 0) break;
    if (Date.now() > deadline) throw new Error('caller never queued on the entitlement lock');
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  releaseHolder();
  await holder;
  return outcome;
}

describeWithDb('#1355 Stripe status applier — six caller characterization (live Postgres)', { timeout: 30_000 }, () => {
  beforeAll(() => {
    const url = process.env.TEST_DATABASE_POOL_URL;
    if (!url) throw new Error('TEST_DATABASE_POOL_URL is required');
    db = postgres(url, { max: 4, prepare: false, onnotice: () => {} });
  });

  beforeEach(() => {
    for (const [key, value] of Object.entries(PRICE_ENV)) process.env[key] = value;
    appliedTransitions.length = 0;
    mockRetrieveSubscription.mockReset();
    mockRetrieveSession.mockReset();
    mockCancelSubscription.mockReset();
    mockCancelSubscription.mockResolvedValue({});
    mockResumePrimaryBusinessBackfill.mockReset();
    mockResumePrimaryBusinessBackfill.mockResolvedValue(undefined);
  });

  afterEach(async () => {
    const rows = seeded.splice(0);
    for (const { tenant, businessId } of rows) {
      const ids = [tenant.accountId, ...(businessId ? [businessId] : [])];
      await suiteDb()`DELETE FROM job_outbox WHERE aggregate_id = ANY(${ids}::uuid[])`;
      await suiteDb()`DELETE FROM analytics_events WHERE account_id = ${tenant.accountId}::uuid`;
      await suiteDb()`DELETE FROM account_audit_log WHERE account_id = ${tenant.accountId}::uuid`;
      if (businessId) await suiteDb()`DELETE FROM businesses WHERE id = ${businessId}::uuid`;
      await cleanupTenantAccount(suiteDb(), tenant);
    }
  });

  afterAll(async () => {
    for (const key of Object.keys(PRICE_ENV)) delete process.env[key];
    await db?.end({ timeout: 5 });
    await productionSql.end({ timeout: 5 });
  });

  // ── 1. checkout-completed ────────────────────────────────────────────────

  it('checkout-completed (pay-now): pending_payment → active binds the Stripe ids and resumes the primary business', async () => {
    const f = await seedAccount({ status: 'pending_payment', bound: false });
    const sessionId = `cs_1355_${randomUUID().slice(0, 8)}`;
    const attemptId = randomUUID();
    await openCheckoutAttempt(f, sessionId, attemptId, null);
    mockRetrieveSession.mockResolvedValue({
      id: sessionId,
      mode: 'subscription',
      status: 'complete',
      payment_status: 'paid',
      client_reference_id: f.accountId,
      customer: f.customerId,
      subscription: f.subscriptionId,
      metadata: { checkout_attempt_id: attemptId },
      allow_promotion_codes: false,
      automatic_tax: { enabled: false },
      billing_address_collection: null,
      tax_id_collection: { enabled: false },
      customer_email: 'owner-1355@example.com',
      success_url: SUCCESS_URL,
      cancel_url: CANCEL_URL,
      line_items: { data: [{ quantity: 1, price: { id: PRICE_ENV.STRIPE_PRICE_COPILOT_LIST } }] },
    });
    mockRetrieveSubscription.mockResolvedValue(
      stripeSubscription(f, { metadata: { checkout_attempt_id: attemptId } }),
    );

    await processCheckoutSessionCompleted({
      id: sessionId,
      mode: 'subscription',
      payment_status: 'paid',
      client_reference_id: f.accountId,
      customer: f.customerId,
      subscription: f.subscriptionId,
      metadata: { checkout_attempt_id: attemptId },
    } as never);

    expect(appliedTransitions).toEqual([{
      accountResolved: true,
      fromStatus: 'pending_payment',
      toStatus: 'active',
      changed: true,
      activated: true,
      primaryBusinessId: f.businessId,
    }]);
    expect(await accountState(f.accountId)).toEqual({
      subscription_status: 'active',
      stripe_customer_id: f.customerId,
      stripe_subscription_id: f.subscriptionId,
      has_trial_end: false,
      has_past_due_at: false,
      has_cancelled_at: false,
      has_activated_at: true,
    });
    expect(await statusAudits(f.accountId)).toEqual([{ fromStatus: 'pending_payment', toStatus: 'active' }]);
    expect(await outboxTopics(f.accountId)).toEqual([MIRROR_TOPIC, OVERAGE_TOPIC].sort());
    expect(await trialEvents(f.accountId)).toEqual([]);
    expect(mockResumePrimaryBusinessBackfill).toHaveBeenCalledWith(f.businessId);
    expect(mockCancelSubscription).not.toHaveBeenCalled();
  });

  it('checkout-completed (trial): pending_payment → trialing persists Stripe trial_end and emits trial_started', async () => {
    const f = await seedAccount({ status: 'pending_payment', bound: false });
    const sessionId = `cs_1355_${randomUUID().slice(0, 8)}`;
    const attemptId = randomUUID();
    await openCheckoutAttempt(f, sessionId, attemptId, 30);
    const trialStart = Math.floor(Date.now() / 1000);
    const trialEnd = trialStart + TRIAL_DAYS_SECONDS;
    mockRetrieveSession.mockResolvedValue({
      id: sessionId,
      mode: 'subscription',
      status: 'complete',
      payment_status: 'no_payment_required',
      client_reference_id: f.accountId,
      customer: f.customerId,
      subscription: f.subscriptionId,
      metadata: { checkout_attempt_id: attemptId },
      allow_promotion_codes: false,
      automatic_tax: { enabled: false },
      billing_address_collection: null,
      tax_id_collection: { enabled: false },
      customer_email: 'owner-1355@example.com',
      success_url: SUCCESS_URL,
      cancel_url: CANCEL_URL,
      line_items: { data: [{ quantity: 1, price: { id: PRICE_ENV.STRIPE_PRICE_COPILOT_LIST } }] },
    });
    mockRetrieveSubscription.mockResolvedValue(stripeSubscription(f, {
      status: 'trialing',
      trial_start: trialStart,
      trial_end: trialEnd,
      metadata: { checkout_attempt_id: attemptId },
    }));

    await processCheckoutSessionCompleted({
      id: sessionId,
      mode: 'subscription',
      payment_status: 'no_payment_required',
      client_reference_id: f.accountId,
      customer: f.customerId,
      subscription: f.subscriptionId,
      metadata: { checkout_attempt_id: attemptId },
    } as never);

    expect(appliedTransitions).toEqual([{
      accountResolved: true,
      fromStatus: 'pending_payment',
      toStatus: 'trialing',
      changed: true,
      activated: true,
      primaryBusinessId: f.businessId,
    }]);
    expect(await accountState(f.accountId)).toMatchObject({
      subscription_status: 'trialing',
      stripe_customer_id: f.customerId,
      stripe_subscription_id: f.subscriptionId,
      has_trial_end: true,
      has_activated_at: true,
    });
    expect(new Date((await trialEndsAt(f.accountId))!).getTime()).toBe(trialEnd * 1000);
    expect(await trialEvents(f.accountId)).toEqual(['trial_started']);
    expect(mockResumePrimaryBusinessBackfill).toHaveBeenCalledWith(f.businessId);
  });

  // ── 2. subscription-updated ──────────────────────────────────────────────

  it('subscription-updated: provider-current trialing → active converts and returns the transition', async () => {
    const f = await seedAccount({ status: 'trialing' });
    mockRetrieveSubscription.mockResolvedValue(stripeSubscription(f));

    const outcome = await processSubscriptionUpdated(
      stripeSubscription(f) as never,
      eventContext(),
    );

    const expected = {
      accountResolved: true,
      fromStatus: 'trialing',
      toStatus: 'active',
      changed: true,
      activated: true,
      primaryBusinessId: f.businessId,
    };
    expect(outcome).toMatchObject({ kind: 'updated', accountId: f.accountId, transition: expected });
    expect(appliedTransitions).toEqual([expected]);
    expect(await accountState(f.accountId)).toMatchObject({
      subscription_status: 'active',
      has_trial_end: false,
      has_activated_at: true,
    });
    expect(await statusAudits(f.accountId)).toEqual([{ fromStatus: 'trialing', toStatus: 'active' }]);
    expect(await outboxTopics(f.accountId)).toEqual([MIRROR_TOPIC, OVERAGE_TOPIC].sort());
    expect(await trialEvents(f.accountId)).toEqual(['trial_converted']);
  });

  it('subscription-updated: a same-status replay is a resolved no-op that still enqueues one mirror sync', async () => {
    const f = await seedAccount({ status: 'active' });
    mockRetrieveSubscription.mockResolvedValue(stripeSubscription(f));

    const outcome = await processSubscriptionUpdated(
      stripeSubscription(f) as never,
      eventContext(),
    );

    const expected = {
      accountResolved: true,
      fromStatus: 'active',
      toStatus: 'active',
      changed: false,
      activated: false,
      primaryBusinessId: f.businessId,
    };
    expect(outcome).toMatchObject({ kind: 'updated', transition: expected });
    expect(appliedTransitions).toEqual([expected]);
    expect(await statusAudits(f.accountId)).toEqual([]);
    expect(await outboxTopics(f.accountId)).toEqual([MIRROR_TOPIC]);
  });

  // ── 3. invoice-paid ──────────────────────────────────────────────────────

  it('invoice-paid: past_due → active recovers and resumes the primary business backfill', async () => {
    const f = await seedAccount({ status: 'past_due' });
    mockRetrieveSubscription.mockResolvedValue(stripeSubscription(f));

    await processInvoicePaid(invoice(f));

    expect(appliedTransitions).toEqual([{
      accountResolved: true,
      fromStatus: 'past_due',
      toStatus: 'active',
      changed: true,
      activated: true,
      primaryBusinessId: f.businessId,
    }]);
    expect(await accountState(f.accountId)).toMatchObject({
      subscription_status: 'active',
      has_past_due_at: false,
    });
    expect(await statusAudits(f.accountId)).toEqual([{ fromStatus: 'past_due', toStatus: 'active' }]);
    expect(await outboxTopics(f.accountId)).toEqual([MIRROR_TOPIC, OVERAGE_TOPIC].sort());
    expect(mockResumePrimaryBusinessBackfill).toHaveBeenCalledWith(f.businessId);
  });

  it('invoice-paid: a still-past_due provider read throws for redelivery and writes nothing', async () => {
    const f = await seedAccount({ status: 'past_due' });
    mockRetrieveSubscription.mockResolvedValue(stripeSubscription(f, { status: 'past_due' }));

    await expect(processInvoicePaid(invoice(f))).rejects.toThrow(/stale past_due subscription read/);

    expect(appliedTransitions).toEqual([{
      accountResolved: true,
      fromStatus: 'past_due',
      toStatus: 'past_due',
      changed: false,
      activated: false,
      primaryBusinessId: f.businessId,
    }]);
    expect(await statusAudits(f.accountId)).toEqual([]);
  });

  it('invoice-paid: a lineage moved before the entitlement lock is never mutated', async () => {
    const f = await seedAccount({ status: 'past_due' });
    mockRetrieveSubscription.mockResolvedValue(stripeSubscription(f));

    await withLineageMovedUnderEntitlement(f, () => processInvoicePaid(invoice(f)));

    expect(resolvedTransitions()).toEqual([]);
    expect(await accountState(f.accountId)).toMatchObject({
      subscription_status: 'past_due',
      stripe_subscription_id: `${f.subscriptionId}_moved`,
    });
    expect(await statusAudits(f.accountId)).toEqual([]);
    expect(await outboxTopics(f.accountId)).toEqual([]);
    expect(mockResumePrimaryBusinessBackfill).not.toHaveBeenCalled();
  });

  // ── 4. invoice-payment-failed ────────────────────────────────────────────

  it('invoice-payment-failed: active → past_due, with trial_payment_failed after a recent conversion', async () => {
    const f = await seedAccount({ status: 'active' });
    await suiteDb()`
      INSERT INTO analytics_events (id, event_key, event_name, distinct_id, account_id, properties, occurred_at)
      VALUES (${randomUUID()}::uuid, ${`trial_converted:${f.accountId}`}, 'trial_converted',
        ${f.accountId}, ${f.accountId}::uuid, '{}'::jsonb, NOW())
    `;
    mockRetrieveSubscription.mockResolvedValue(stripeSubscription(f, { status: 'past_due' }));

    await processInvoicePaymentFailed(invoice(f));

    expect(appliedTransitions).toEqual([{
      accountResolved: true,
      fromStatus: 'active',
      toStatus: 'past_due',
      changed: true,
      activated: false,
      primaryBusinessId: f.businessId,
    }]);
    expect(await accountState(f.accountId)).toMatchObject({
      subscription_status: 'past_due',
      has_past_due_at: true,
    });
    expect(await statusAudits(f.accountId)).toEqual([{ fromStatus: 'active', toStatus: 'past_due' }]);
    expect(await outboxTopics(f.accountId)).toEqual([MIRROR_TOPIC]);
    expect(await trialEvents(f.accountId)).toEqual(['trial_converted', 'trial_payment_failed']);
  });

  it('invoice-payment-failed: trialing → past_due clears the trial and emits trial_payment_failed', async () => {
    const f = await seedAccount({ status: 'trialing' });
    mockRetrieveSubscription.mockResolvedValue(stripeSubscription(f, { status: 'past_due' }));

    await processInvoicePaymentFailed(invoice(f));

    expect(appliedTransitions).toEqual([{
      accountResolved: true,
      fromStatus: 'trialing',
      toStatus: 'past_due',
      changed: true,
      activated: false,
      primaryBusinessId: f.businessId,
    }]);
    expect(await accountState(f.accountId)).toMatchObject({
      subscription_status: 'past_due',
      has_trial_end: false,
      has_past_due_at: true,
    });
    expect(await trialEvents(f.accountId)).toEqual(['trial_payment_failed']);
  });

  it('invoice-payment-failed: a lineage moved before the entitlement lock is never mutated', async () => {
    const f = await seedAccount({ status: 'active' });
    mockRetrieveSubscription.mockResolvedValue(stripeSubscription(f, { status: 'past_due' }));

    await withLineageMovedUnderEntitlement(f, () => processInvoicePaymentFailed(invoice(f)));

    expect(resolvedTransitions()).toEqual([]);
    expect(await accountState(f.accountId)).toMatchObject({ subscription_status: 'active' });
    expect(await statusAudits(f.accountId)).toEqual([]);
  });

  // ── 5. subscription-deleted ──────────────────────────────────────────────

  it('subscription-deleted: trialing → cancelled sets cancelled_at and emits trial_cancelled', async () => {
    const f = await seedAccount({ status: 'trialing' });

    const ack = await processSubscriptionDeleted(
      stripeSubscription(f, { status: 'canceled' }) as never,
      eventContext(),
    );

    expect(ack).toBeDefined();
    expect(appliedTransitions).toEqual([{
      accountResolved: true,
      fromStatus: 'trialing',
      toStatus: 'cancelled',
      changed: true,
      activated: false,
      primaryBusinessId: f.businessId,
    }]);
    expect(await accountState(f.accountId)).toMatchObject({
      subscription_status: 'cancelled',
      has_cancelled_at: true,
      has_trial_end: false,
      has_past_due_at: false,
    });
    expect(await statusAudits(f.accountId)).toEqual([{ fromStatus: 'trialing', toStatus: 'cancelled' }]);
    expect(await outboxTopics(f.accountId)).toEqual([MIRROR_TOPIC]);
    expect(await trialEvents(f.accountId)).toEqual(['trial_cancelled']);
  });

  it('subscription-deleted: a lineage moved before the entitlement lock is never mutated', async () => {
    const f = await seedAccount({ status: 'active' });

    await withLineageMovedUnderEntitlement(f, () => processSubscriptionDeleted(
      stripeSubscription(f, { status: 'canceled' }) as never,
      eventContext(),
    ));

    expect(resolvedTransitions()).toEqual([]);
    expect(await accountState(f.accountId)).toMatchObject({ subscription_status: 'active', has_cancelled_at: false });
    expect(await statusAudits(f.accountId)).toEqual([]);
  });

  // ── 6. reconcile-account (billing reconcile poller) ──────────────────────

  it('reconcile-account: a stuck trialing row whose Stripe status moved to active is corrected', async () => {
    const f = await seedAccount({ status: 'trialing' });
    const stripe = fakeStripe(stripeSubscription(f));

    const outcome = await reconcileAccount(productionSql, stripe, reconcileAccountRow(f, 'trialing'));

    expect(outcome).toEqual({ accountsChecked: 1, drifts: [], errors: 0 });
    expect(appliedTransitions).toEqual([{
      accountResolved: true,
      fromStatus: 'trialing',
      toStatus: 'active',
      changed: true,
      activated: true,
      primaryBusinessId: f.businessId,
    }]);
    expect(await accountState(f.accountId)).toMatchObject({ subscription_status: 'active', has_trial_end: false });
    expect(await trialEvents(f.accountId)).toEqual(['trial_converted']);
  });

  it('reconcile-account: a provider subscription with no customer falls back to the stored customer id', async () => {
    const f = await seedAccount({ status: 'trialing' });
    const stripe = fakeStripe(stripeSubscription(f, { customer: null, status: 'canceled' }));

    await reconcileAccount(productionSql, stripe, reconcileAccountRow(f, 'trialing'));

    expect(appliedTransitions).toEqual([expect.objectContaining({
      accountResolved: true,
      fromStatus: 'trialing',
      toStatus: 'cancelled',
      changed: true,
    })]);
    expect(await accountState(f.accountId)).toMatchObject({
      subscription_status: 'cancelled',
      stripe_customer_id: f.customerId,
    });
  });

  it('reconcile-account: a lineage moved before the entitlement lock is never mutated', async () => {
    const f = await seedAccount({ status: 'trialing' });
    const stripe = fakeStripe(stripeSubscription(f));

    const outcome = await withLineageMovedUnderEntitlement(
      f,
      () => reconcileAccount(productionSql, stripe, reconcileAccountRow(f, 'trialing')),
    );

    expect(outcome).toEqual({ accountsChecked: 1, drifts: [], errors: 0 });
    expect(resolvedTransitions()).toEqual([]);
    expect(await accountState(f.accountId)).toMatchObject({ subscription_status: 'trialing', has_trial_end: true });
  });
});
