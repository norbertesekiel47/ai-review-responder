import { afterAll, afterEach, beforeAll, beforeEach, expect, it, vi } from 'vitest';
import postgres from 'postgres';
import type { Sql } from 'postgres';
import { randomUUID } from 'node:crypto';
import { describeWithDb } from '@/__tests__/helpers/describe-with-db';
import {
  cleanupTenantAccount,
  seedTenantAccount,
  type TenantSeed,
} from '@/lib/shared/__tests__/live-db-tenant';
import { applyTierChange } from '@/lib/accounts/tier-change';
import { recordPollerCycle, POLLER_JUDGE_SWEEP } from '@/lib/shared/poller-liveness';
import { startStage, type Stage } from '@/__tests__/helpers/concurrency-handoff';

const {
  mockResolveTarget,
  mockPublishReply,
  mockFindReply,
  mockRetrieveSubscription,
  mockSubscriptionItemUpdate,
  mockSubscriptionItemCreate,
  mockSubscriptionItemDelete,
} = vi.hoisted(() => ({
  mockResolveTarget: vi.fn(),
  mockPublishReply: vi.fn(),
  mockFindReply: vi.fn(),
  mockRetrieveSubscription: vi.fn(),
  mockSubscriptionItemUpdate: vi.fn(),
  mockSubscriptionItemCreate: vi.fn(),
  mockSubscriptionItemDelete: vi.fn(),
}));

vi.mock('@/lib/payments/stripe-client', () => ({
  getStripe: () => ({
    subscriptions: { retrieve: mockRetrieveSubscription },
    subscriptionItems: {
      update: mockSubscriptionItemUpdate,
      create: mockSubscriptionItemCreate,
      del: mockSubscriptionItemDelete,
    },
  }),
}));

vi.mock('@/lib/publishing/review-publisher', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/publishing/review-publisher')>();
  return {
    ...actual,
    getReviewPublisher: () => ({
      resolveTarget: mockResolveTarget,
      publishReply: mockPublishReply,
      findReply: mockFindReply,
      deleteReply: vi.fn(),
    }),
    getTransactionalReviewPublisher: () => ({
      resolveTarget: mockResolveTarget,
      publishReply: mockPublishReply,
      findReply: mockFindReply,
      deleteReply: vi.fn(),
    }),
  };
});

vi.mock('../activation', () => ({
  maybeCaptureActivationCompleted: vi.fn().mockResolvedValue(undefined),
}));

import { publishAutoPolicyResponse } from '../auto-policy-publish';
import { processSubscriptionUpdated } from '../../../ingress/stripe/subscription-updated';
import { applyStripeSubscriptionState } from '../../../ingress/stripe/apply-subscription-state';
import {
  persistResponseAndNotify,
  type PersistResponseInput,
} from '../../response-generation/persist';
import { resetServerConfigForTests } from '@/lib/config/server';
// #889: the webhook path runs on the production singleton, NOT on a suite
// client, so the singleton is a participant this file must be able to inspect
// (admission stats) and shut down (teardown). Importing it here is legal —
// `ci:db-imports` skips `__tests__` (scripts/ci/lib/ratchet-harness.ts) and
// invariant #1's ESLint boundary covers src/app, src/components and
// src/instrumentation, not worker tests.
import { sql as productionSql } from '@/lib/db/server';
import { admissionStats } from '@/lib/db/admission';

const testDatabaseUrl = process.env.TEST_DATABASE_POOL_URL;
let dbA: Sql | undefined;
let dbB: Sql | undefined;
let dbObserver: Sql | undefined;
let dbTier: Sql | undefined;
let tenant: TenantSeed | undefined;
const businessId = randomUUID();
const reviewId = randomUUID();
const stripeCustomerId = 'cus_ws8_concurrency';
const stripeSubscriptionId = 'sub_ws8_concurrency';
const policyId = randomUUID();

const PRICE_ENV = {
  STRIPE_PRICE_COPILOT_LIST: 'price_ws8_copilot_list',
  STRIPE_PRICE_COPILOT_FOUNDING: 'price_ws8_copilot_founding',
  STRIPE_PRICE_AUTOPILOT_LIST: 'price_ws8_autopilot_list',
  STRIPE_PRICE_AUTOPILOT_FOUNDING: 'price_ws8_autopilot_founding',
  STRIPE_PRICE_COPILOT_OVERAGE: 'price_ws8_copilot_overage',
  STRIPE_PRICE_AUTOPILOT_OVERAGE: 'price_ws8_autopilot_overage',
} as const;

function sqlA(): Sql {
  if (!dbA) throw new Error('publisher concurrency dbA not initialized');
  return dbA;
}

function sqlB(): Sql {
  if (!dbB) throw new Error('publisher concurrency dbB not initialized');
  return dbB;
}

function observerSql(): Sql {
  if (!dbObserver) throw new Error('publisher concurrency observer DB not initialized');
  return dbObserver;
}

function tierSql(): Sql {
  if (!dbTier) throw new Error('publisher concurrency tier DB not initialized');
  return dbTier;
}

function accountId(): string {
  if (!tenant) throw new Error('publisher concurrency tenant not initialized');
  return tenant.accountId;
}

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((res) => { resolve = res; });
  return { promise, resolve };
}

async function sleep(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

// ---------------------------------------------------------------------------
// #889 bounded-wait scaffolding.
//
// This suite parks on deferreds that only a mocked call resolves. When the
// operation returns early, rejects, or blocks, a bare `await` parks forever and
// vitest reports the suite timeout with no reason — which is #889 verbatim.
// Every wait below therefore runs through `startStage`, whose watchdog starts
// when the OPERATION starts and fires before the server cancels a statement.
// ---------------------------------------------------------------------------

/** Mirrors the suite `timeout` on the describe block below. */
const SUITE_TIMEOUT_MS = 30_000;

/**
 * Statement ceiling for every suite client. Below the suite timeout and far
 * above anything this file legitimately runs (whole-file runtime is ~1.2s in
 * CI), so it only ever fires on a genuine stall. Without it these clients
 * inherit the container default of unlimited, and a blocked cleanup statement
 * wedges the whole file. Same mechanism the production singleton uses.
 */
const SUITE_STATEMENT_TIMEOUT_MS = 10_000;

/** Wall clock for the afterEach drain and for the afterAll cleanup sequence. */
const DRAIN_DEADLINE_MS = 10_000;
const CLEANUP_DEADLINE_MS = 10_000;

function suiteClient(): Sql {
  return postgres(testDatabaseUrl!, {
    max: 1,
    prepare: false,
    connection: { statement_timeout: SUITE_STATEMENT_TIMEOUT_MS },
  });
}

let testStartedAt = 0;
/**
 * Set when a drain expires. Throwing from `afterEach` does NOT stop the file —
 * vitest records the hook failure and runs the remaining tests (`bail` defaults
 * to 0) — so the latch is what actually stops a later `beforeEach` from
 * resetting fixtures an abandoned operation may still be writing to.
 */
let suitePoisoned: string | null = null;
let clientsClosed = false;
const releases: Array<() => void> = [];
const operations: Array<{ name: string; promise: Promise<unknown> }> = [];

/** A `deferred()` whose resolver the drain will always call. */
function releasable(): { promise: Promise<void>; resolve: () => void } {
  const gate = deferred();
  releases.push(gate.resolve);
  return gate;
}

/**
 * Reads every backend on the database, the advisory locks, and the production
 * singleton's admission-gate state.
 *
 * All three parts matter. The webhook runs on the singleton, not on a suite
 * client, so a four-connection dump would omit the session most likely to hold
 * the entitlement lock. `pg_blocking_pids` names the blocker directly. And an
 * operation queued behind the #773 admission chokepoint executes NO SQL, so
 * without the gate counts a clean activity dump cannot tell that apart from a
 * JavaScript lost wakeup.
 */
async function dumpLockState(label: string): Promise<string> {
  const lines = [`--- ${label}: live database state ---`];
  await observerSql().begin(async (tx) => {
    await tx`SET LOCAL statement_timeout = 1500`;
    const backends = await tx<{
      pid: number;
      application_name: string | null;
      state: string | null;
      wait_event_type: string | null;
      wait_event: string | null;
      blocked_by: number[];
      query: string | null;
    }[]>`
      SELECT a.pid, a.application_name, a.state, a.wait_event_type, a.wait_event,
             pg_blocking_pids(a.pid) AS blocked_by,
             left(a.query, 200) AS query
      FROM pg_stat_activity a
      WHERE a.datname = current_database() AND a.pid <> pg_backend_pid()
      ORDER BY a.application_name NULLS LAST, a.pid
    `;
    for (const row of backends) {
      lines.push(
        `  pid=${row.pid} app=${row.application_name ?? '-'} state=${row.state ?? '-'} ` +
        `wait=${row.wait_event_type ?? '-'}/${row.wait_event ?? '-'} ` +
        `blocked_by=[${row.blocked_by.join(',')}] query=${JSON.stringify(row.query)}`,
      );
    }
    const locks = await tx<{
      pid: number; granted: boolean; classid: number; objid: number;
    }[]>`
      SELECT l.pid, l.granted, l.classid, l.objid
      FROM pg_locks l
      WHERE l.locktype = 'advisory'
      ORDER BY l.granted, l.pid
    `;
    lines.push(`  advisory locks: ${locks.length === 0 ? 'none' : ''}`);
    for (const lock of locks) {
      lines.push(
        `    pid=${lock.pid} granted=${lock.granted} ` +
        `key=${lock.classid}:${lock.objid}`,
      );
    }
  });
  const gate = admissionStats(productionSql);
  lines.push(gate === undefined
    ? '  singleton admission: ungated'
    : `  singleton admission: inFlight=${gate.inFlight} waiting=${gate.waiting} ` +
      `cap=${gate.cap} timeouts=${gate.timeouts} reentrantBypasses=${gate.reentrantBypasses}`);
  return lines.join('\n');
}

/**
 * Wraps one in-flight operation. Call it WHERE THE OPERATION IS CREATED: the
 * watchdog clock starts here, and several tests create an operation, sleep,
 * assert, and only then await it.
 */
function stage<T>(name: string, operation: Promise<T>): Stage<T> {
  const wrapped = startStage(name, operation, {
    budgetMs: SUITE_TIMEOUT_MS - (Date.now() - testStartedAt),
    diagnose: dumpLockState,
  });
  operations.push({ name, promise: operation });
  return wrapped;
}

/**
 * Closes every participant, including the production singleton, concurrently
 * and at most once. Concurrently because five sequential 5s closes would blow
 * the hook budget; the singleton because closing it is the only thing that
 * actually stops work still outstanding on it — a statement timeout bounds one
 * statement, not an operation.
 *
 * Safe to call here because vitest defaults to `isolate: true`, so this file
 * owns its own module registry and its own `productionSql` instance. If that
 * ever changes, this call closes a client other suites share.
 */
async function closeAllClients(): Promise<void> {
  if (clientsClosed) return;
  clientsClosed = true;
  const clients = [dbA, dbB, dbObserver, dbTier, productionSql].filter(
    (client): client is Sql => client !== undefined,
  );
  await Promise.allSettled(clients.map((client) => client.end({ timeout: 5 })));
}

/** Resolves to `'expired'` instead of throwing, so callers decide the outcome. */
async function withDeadline<T>(work: Promise<T>, ms: number): Promise<T | 'expired'> {
  let handle: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      work,
      new Promise<'expired'>((resolve) => { handle = setTimeout(() => resolve('expired'), ms); }),
    ]);
  } finally {
    if (handle !== undefined) clearTimeout(handle);
  }
}

async function waitForGrantEntitlementLock(): Promise<{
  wait_event_type: string | null;
  query: string;
}> {
  for (let attempt = 0; attempt < 30; attempt += 1) {
    const [activity] = await observerSql()<{
      wait_event_type: string | null;
      query: string;
    }[]>`
      SELECT wait_event_type, query
      FROM pg_stat_activity
      WHERE application_name = 'ws8_grant_writer'
        AND state = 'active'
      LIMIT 1
    `;
    if (activity?.wait_event_type === 'Lock' && /pg_advisory_xact_lock/i.test(activity.query)) {
      return activity;
    }
    await sleep(50);
  }
  throw new Error(
    'grant writer did not block on the tier-entitlement advisory lock\n' +
    await dumpLockState('waitForGrantEntitlementLock'),
  );
}

async function waitForTierEntitlementLock(): Promise<{
  wait_event_type: string | null;
  query: string;
}> {
  for (let attempt = 0; attempt < 30; attempt += 1) {
    const [activity] = await observerSql()<{
      wait_event_type: string | null;
      query: string;
    }[]>`
      SELECT a.wait_event_type, a.query
      FROM pg_stat_activity a
      JOIN pg_locks l
        ON l.pid = a.pid
       AND l.locktype = 'advisory'
       AND l.granted = FALSE
      WHERE a.application_name = 'ws8_tier_writer'
        AND a.state = 'active'
        AND a.wait_event_type = 'Lock'
        AND a.query ~* 'pg_advisory_xact_lock'
      LIMIT 1
    `;
    if (activity) return activity;
    await sleep(50);
  }
  throw new Error(
    'tier writer did not block on the tier-entitlement advisory lock\n' +
    await dumpLockState('waitForTierEntitlementLock'),
  );
}

async function setTier(db: Sql, tier: 'copilot' | 'autopilot'): Promise<void> {
  await db`
    UPDATE accounts
    SET subscription_tier = ${tier},
        base_price_cents = ${tier === 'autopilot' ? 6900 : 2900},
        locations_overage_price_cents = ${tier === 'autopilot' ? 2000 : 1500},
        locations_included = 1,
        locations_paid = 0,
        subscription_status = 'active',
        cancelled_at = NULL,
        past_due_at = NULL,
        stripe_customer_id = ${stripeCustomerId},
        stripe_subscription_id = ${stripeSubscriptionId}
    WHERE id = ${accountId()}::uuid
  `;
  await db`
    UPDATE businesses
    SET subscription_tier = ${tier},
        subscription_status = 'active'
    WHERE account_id = ${accountId()}::uuid
  `;
}

function autopilotProviderSubscription() {
  return {
    id: stripeSubscriptionId,
    customer: stripeCustomerId,
    status: 'active',
    items: {
      data: [{
        id: 'si_ws8_base',
        quantity: 1,
        metadata: {},
        price: { id: PRICE_ENV.STRIPE_PRICE_AUTOPILOT_LIST, metadata: {} },
      }],
    },
  };
}

async function seedAttempt(): Promise<{ responseId: string; outboxId: string }> {
  const responseId = randomUUID();
  const outboxId = randomUUID();
  await sqlA()`
    INSERT INTO responses (
      id, review_id, business_id, response_text, original_draft_text,
      approved_text, version, status, approval_method, approved_at
    ) VALUES (
      ${responseId}::uuid, ${reviewId}::uuid, ${businessId}::uuid,
      'Thanks!', 'Thanks!', 'Thanks!', 1, 'approved', 'auto_policy', NOW()
    )
  `;
  await sqlA()`
    INSERT INTO approval_audit_log (
      id, response_id, business_id, account_id, action, metadata,
      auth_method, response_text_at_approval
    ) VALUES (
      ${randomUUID()}::uuid, ${responseId}::uuid, ${businessId}::uuid,
      ${accountId()}::uuid, 'auto_approved_by_policy',
      ${sqlA().json({ veto_window_minutes: 15 } as never)},
      'auto_policy', 'Thanks!'
    )
  `;
  await sqlA()`
    INSERT INTO notification_deliveries (
      id, business_id, response_id, channel, recipient, template, sent_at
    ) VALUES (
      ${randomUUID()}::uuid, ${businessId}::uuid, ${responseId}::uuid,
      'email', ${tenant!.ownerEmail}, 'pending_post_notice', NOW() - INTERVAL '20 minutes'
    )
  `;
  await sqlA()`
    INSERT INTO job_outbox (
      id, topic, aggregate_type, aggregate_id, payload,
      status, attempts, max_attempts, dispatched_at
    ) VALUES (
      ${outboxId}::uuid, 'publish_response', 'response', ${responseId}::uuid,
      ${sqlA().json({ response_id: responseId, business_id: businessId } as never)},
      'dispatched', 1, 5, NOW()
    )
  `;
  return { responseId, outboxId };
}

async function cleanupAttempt(responseId: string): Promise<void> {
  await sqlA()`DELETE FROM job_outbox WHERE aggregate_id = ${responseId}::uuid`;
  await sqlA()`DELETE FROM notification_deliveries WHERE response_id = ${responseId}::uuid`;
  await sqlA()`DELETE FROM approval_audit_log WHERE response_id = ${responseId}::uuid`;
  await sqlA()`DELETE FROM responses WHERE id = ${responseId}::uuid`;
}

function publishInput(ids: { responseId: string; outboxId: string }) {
  return {
    responseId: ids.responseId,
    reviewId,
    businessId,
    accountId: accountId(),
    approvedText: 'Thanks!',
    outboxId: ids.outboxId,
    outboxAttempt: 1,
    correlationId: 'ws8-concurrency',
    logger: { log: vi.fn(), warn: vi.fn(), error: vi.fn() } as never,
  };
}

function persistInput(
  responseText: string,
  correlationId: string,
): PersistResponseInput {
  return {
    result: {
      responseText,
      language: 'en',
      provider: 'openai',
      model: 'gpt-4o-mini-2024-07-18',
      usage: { promptTokens: 10, completionTokens: 5 },
      costUsd: 0.0001,
      apiCostId: null,
    },
    reviewId,
    businessId,
    version: 1,
    correlationId,
    suppressNotification: false,
    originLane: 'live_ingest_new' as const,
    loadedReviewContentHash: 'ws8-live-hash',
    moderation: {
      flagged: false,
      severity: 'low' as const,
      reason: null,
      categories: {},
      score: 0,
      source: 'openai_moderation' as const,
      providerStatus: 'clean' as const,
    },
    accountId: accountId(),
    preLlmSubscriptionTier: 'autopilot',
    logger: { log: vi.fn(), warn: vi.fn() } as never,
  };
}

describeWithDb('WS8 Autopilot publisher entitlement linearization (live Postgres)', { timeout: 30_000 }, () => {
  beforeAll(async () => {
    dbA = suiteClient();
    dbB = suiteClient();
    dbObserver = suiteClient();
    dbTier = suiteClient();
    await dbA`SET application_name = 'ws8_grant_writer'`;
    await dbB`SET application_name = 'ws8_status_writer'`;
    await dbTier`SET application_name = 'ws8_tier_writer'`;
    tenant = await seedTenantAccount(dbA, {
      subscriptionTier: 'autopilot',
      subscriptionStatus: 'active',
      accountDisplayName: 'WS8 Publisher Concurrency',
    });
    await setTier(dbA, 'autopilot');
    await dbA`
      INSERT INTO businesses (
        id, name, owner_name, owner_email, account_id, subscription_status, subscription_tier
      ) VALUES (
        ${businessId}::uuid, 'WS8 Publisher Biz', 'Owner', ${tenant.ownerEmail},
        ${tenant.accountId}::uuid, 'active', 'autopilot'
      )
    `;
    await dbA`
      INSERT INTO zernio_connections (
        business_id, zernio_profile_id, zernio_account_id,
        zernio_location_id, status, connected_at
      ) VALUES (
        ${businessId}::uuid, 'ws8-profile', 'ws8-provider-account',
        'ws8-provider-location', 'active', NOW()
      )
    `;
    await dbA`
      INSERT INTO auto_approval_policies (
        id, account_id, location_id, auto_approve_min_star,
        persona, action_class, veto_window_minutes, daily_auto_post_cap
      ) VALUES (
        ${policyId}::uuid, ${tenant.accountId}::uuid, ${businessId}::uuid, 4,
        'reply', 'posting', 15, 10
      )
    `;
    await dbA`
      INSERT INTO reviews (
        id, business_id, provider, provider_review_id, provider_review_name,
        provider_location_name, reviewer_name, star_rating, review_text, status
      ) VALUES (
        ${reviewId}::uuid, ${businessId}::uuid, 'zernio', 'ws8-provider-review',
        'zernio://reviews/ws8', 'zernio://locations/ws8', 'Reviewer', 5,
        'Great place.', 'pending'
      )
    `;
    await dbA`
      UPDATE reviews
      SET review_content_hash = 'ws8-live-hash'
      WHERE id = ${reviewId}::uuid
    `;
  });

  beforeEach(async () => {
    // #889 poison latch. FIRST statement: before any mock reset, before
    // `setTier`, before any fixture write. A drain that expired already closed
    // the clients, so nothing below could run anyway — and running it would
    // reset fixtures an abandoned operation may still be writing to.
    if (suitePoisoned !== null) throw new Error(suitePoisoned);
    testStartedAt = Date.now();
    releases.length = 0;
    operations.length = 0;
    vi.clearAllMocks();
    process.env.AUTO_APPROVAL_ENABLED = 'true';
    process.env.OPENAI_MODERATION_ENABLED = 'true';
    process.env.JUDGE_ENABLED = 'true';
    process.env.AUTOPILOT_PURCHASABLE = 'true';
    for (const [key, value] of Object.entries(PRICE_ENV)) process.env[key] = value;
    resetServerConfigForTests();
    // "Judge available" is no longer just the flag (#949). This suite drives the
    // publisher's judge gate (invariant #3) through the REAL `isJudgeHealthy`,
    // whose third arm fails CLOSED on a missing sweep heartbeat — without this
    // every auto-policy post here downgrades to owner review, the mocked
    // `publishReply` is never entered, and the `postEntered` / `retrieveEntered`
    // handoffs are never signalled. #1156 seeded the two suites it found and
    // missed this third one.
    //
    // Upsert, never delete: `poller_heartbeats` is keyed by poller name, so the
    // `judge_sweep` row is a singleton shared by every concurrent live-DB vitest
    // process. A FRESHER timestamp is always safe under that sharing; deleting
    // or back-dating it would break an unrelated suite.
    await recordPollerCycle(sqlA(), POLLER_JUDGE_SWEEP);
    await setTier(sqlA(), 'autopilot');
    await sqlA()`
      DELETE FROM job_outbox
      WHERE topic = 'stripe_subscription_mirror_sync'
        AND aggregate_id = ${accountId()}::uuid
    `;
    mockResolveTarget.mockImplementation(async ({ responseId }: { responseId: string }) => ({
      kind: 'resolved',
      target: {
        ref: { responseId, reviewId, businessId },
        locator: { accountId: 'provider-account', locationId: 'provider-location', providerReviewId: 'provider-review' },
      },
    }));
    mockPublishReply.mockResolvedValue(undefined);
    mockFindReply.mockResolvedValue({ kind: 'found', reply: { comment: 'Thanks!' } });
    mockRetrieveSubscription.mockReset();
    mockSubscriptionItemUpdate.mockReset();
    mockSubscriptionItemCreate.mockReset();
    mockSubscriptionItemDelete.mockReset();
    mockSubscriptionItemUpdate.mockResolvedValue({});
    mockSubscriptionItemCreate.mockResolvedValue({});
    mockSubscriptionItemDelete.mockResolvedValue({});
  });

  // #889 layer 1 + 3: un-park the JavaScript, then drain under a wall clock.
  // Resolving the release gates is the ONLY layer that helps a mock parked
  // inside an open transaction — `statement_timeout` never sees it, because no
  // command is in flight. The explicit hook timeout is required: vitest defaults
  // hooks to 10s and the describe-level `timeout` is a TEST timeout only.
  afterEach(async () => {
    if (suitePoisoned !== null) return;
    for (const release of releases) release();
    if (operations.length === 0) return;

    const drained = await withDeadline(
      Promise.allSettled(operations.map((entry) => entry.promise)),
      DRAIN_DEADLINE_MS,
    );
    if (drained !== 'expired') return;

    // Abandoning the wait does not stop the work, and throwing does not stop the
    // file. Poison the suite and close the clients — that is what stops it.
    const outstanding = operations.map((entry) => entry.name).join(', ');
    suitePoisoned =
      `#889 drain expired after ${DRAIN_DEADLINE_MS}ms with operations still ` +
      `outstanding: ${outstanding}. The suite is poisoned and its clients are ` +
      'closed; every later test fails at beforeEach rather than running against ' +
      'fixtures those operations may still be writing to.';
    await closeAllClients();
    throw new Error(suitePoisoned);
  }, 20_000);

  afterAll(async () => {
    delete process.env.AUTO_APPROVAL_ENABLED;
    delete process.env.JUDGE_ENABLED;
    if (!dbA) return;
    if (suitePoisoned !== null) {
      // Layer 3 already closed everything. Cleanup would only fail on a closed
      // client, so skip straight to the idempotent shutdown.
      console.warn(`[ws8-concurrency] skipping cleanup: ${suitePoisoned}`);
      await closeAllClients();
      return;
    }
    // #889 layer 4: cleanup runs under its own wall clock, and the shutdown is
    // in `finally` so it is reached whether cleanup finished, threw, or expired.
    const db = dbA;
    try {
      const cleaned = await withDeadline((async () => {
        await db`DELETE FROM job_outbox WHERE aggregate_id IN (SELECT id FROM responses WHERE business_id = ${businessId}::uuid)`;
        await db`DELETE FROM notification_deliveries WHERE business_id = ${businessId}::uuid`;
        await db`DELETE FROM approval_audit_log WHERE business_id = ${businessId}::uuid`;
        // #1012's rows. `refusal_events.business_id` REFERENCES `businesses(id)`
        // with NO cascade (migration 116), and this suite reaches
        // `downgradeAutoApprovedResponseForManualReviewInTx` through the judge
        // gate, which now writes an `auto_post_revoked` Refusal. Without this the
        // business DELETE below fails with `refusal_events_business_id_fkey`.
        // Production purge hard-deletes this table for the same reason
        // (`purge-stages.ts`).
        await db`DELETE FROM refusal_events WHERE business_id = ${businessId}::uuid`;
        await db`DELETE FROM responses WHERE business_id = ${businessId}::uuid`;
        await db`DELETE FROM auto_approval_policies WHERE id = ${policyId}::uuid`;
        await db`DELETE FROM zernio_connections WHERE business_id = ${businessId}::uuid`;
        await db`DELETE FROM reviews WHERE id = ${reviewId}::uuid`;
        await db`DELETE FROM businesses WHERE id = ${businessId}::uuid`;
        if (tenant) await cleanupTenantAccount(db, tenant);
      })(), CLEANUP_DEADLINE_MS);
      if (cleaned === 'expired') {
        console.warn(
          `[ws8-concurrency] cleanup exceeded ${CLEANUP_DEADLINE_MS}ms — ` +
          'closing clients anyway; fixture rows may survive this run',
        );
      }
    } finally {
      await closeAllClients();
    }
  }, 30_000);

  it('production persist grants auto_policy under the live review-business-entitlement lock spine', async () => {
    const outcome = await persistResponseAndNotify(
      sqlA(),
      persistInput('Thanks!', 'ws8-live-persist'),
    );
    if (outcome.kind !== 'persisted') throw new Error('expected persisted');
    const responseId = outcome.responseId;

    const [response] = await sqlA()<{
      status: string;
      approval_method: string | null;
    }[]>`
      SELECT status, approval_method
      FROM responses
      WHERE id = ${responseId}::uuid
    `;
    const topics = await sqlA()<{ topic: string }[]>`
      SELECT topic
      FROM job_outbox
      WHERE aggregate_id = ${responseId}::uuid
      ORDER BY topic
    `;
    expect(response).toEqual({ status: 'approved', approval_method: 'auto_policy' });
    expect(topics.map((row) => row.topic)).toEqual([
      'pending_post_notice',
      'publish_response',
    ]);
    await cleanupAttempt(responseId);
  });

  it('tier writer first makes the real persist grant wait before any response FK insert, then deny Copilot autonomy', async () => {
    const writerHoldsEntitlementAndAccount = deferred();
    const releaseWriter = releasable();
    mockRetrieveSubscription.mockImplementationOnce(async () => {
      writerHoldsEntitlementAndAccount.resolve();
      await releaseWriter.promise;
      return autopilotProviderSubscription();
    });

    const tierStage = stage('tierWriter', applyTierChange(sqlB(), {
      accountId: accountId(),
      tier: 'copilot',
      operationKey: `grant-writer-first-${randomUUID()}`,
    }));
    await tierStage.awaitHandoff(
      'writerHoldsEntitlementAndAccount',
      writerHoldsEntitlementAndAccount.promise,
    );

    const responseText = `WS8 grant wait ${randomUUID()}`;
    let grantFinished = false;
    const grant = persistResponseAndNotify(
      sqlA(),
      persistInput(responseText, 'ws8-live-grant-waits-tier'),
    ).then((outcome) => {
      grantFinished = true;
      if (outcome.kind !== 'persisted') throw new Error('expected persisted');
      return outcome.responseId;
    });
    const grantStage = stage('grant', grant);

    const blocked = await waitForGrantEntitlementLock();
    expect(blocked.wait_event_type).toBe('Lock');
    expect(blocked.query).toMatch(/pg_advisory_xact_lock/i);
    expect(grantFinished).toBe(false);
    const [beforeInsert] = await observerSql()<{ count: number }[]>`
      SELECT COUNT(*)::int AS count
      FROM responses
      WHERE review_id = ${reviewId}::uuid
        AND business_id = ${businessId}::uuid
        AND response_text = ${responseText}
    `;
    expect(beforeInsert?.count).toBe(0);

    releaseWriter.resolve();
    await expect(tierStage.awaitSettled()).resolves.toMatchObject({ ok: true });
    const responseId = await grantStage.awaitSettled();

    const [response] = await observerSql()<{
      status: string;
      approval_method: string | null;
    }[]>`
      SELECT status, approval_method
      FROM responses
      WHERE id = ${responseId}::uuid
    `;
    const topics = await observerSql()<{ topic: string }[]>`
      SELECT topic
      FROM job_outbox
      WHERE aggregate_id = ${responseId}::uuid
      ORDER BY topic
    `;
    expect(response).toEqual({ status: 'pending_approval', approval_method: null });
    expect(topics.map((row) => row.topic)).toEqual(['send_notification']);
    await cleanupAttempt(responseId);
  });

  it('committed generic status loss makes publisher downgrade with zero provider calls', async () => {
    const ids = await seedAttempt();
    const transition = await sqlB().begin((tx) => applyStripeSubscriptionState(
      tx,
      { mode: 'checkout', accountId: accountId() },
      {
        id: stripeSubscriptionId,
        customer: stripeCustomerId,
        status: 'canceled',
        trial_end: null,
      },
    ));
    expect(transition).toMatchObject({
      accountResolved: true,
      fromStatus: 'active',
      toStatus: 'cancelled',
      changed: true,
    });

    await publishAutoPolicyResponse(sqlA(), publishInput(ids));

    const [response] = await sqlA()<{
      status: string;
      approval_method: string | null;
      posting_error: string | null;
    }[]>`
      SELECT status, approval_method, posting_error
      FROM responses
      WHERE id = ${ids.responseId}::uuid
    `;
    expect(response).toEqual({
      status: 'pending_approval',
      approval_method: null,
      posting_error: 'auto_policy_revoked_tier_entitlement',
    });
    expect(mockResolveTarget).not.toHaveBeenCalled();
    expect(mockPublishReply).not.toHaveBeenCalled();
    const [mirrorJob] = await observerSql()<{ count: number }[]>`
      SELECT COUNT(*)::int AS count
      FROM job_outbox
      WHERE topic = 'stripe_subscription_mirror_sync'
        AND aggregate_id = ${accountId()}::uuid
    `;
    expect(mirrorJob?.count).toBe(1);
    await cleanupAttempt(ids.responseId);
    await observerSql()`DELETE FROM job_outbox WHERE topic = 'stripe_subscription_mirror_sync' AND aggregate_id = ${accountId()}::uuid`;
  });

  it.each(['publisher-first', 'tier-first'] as const)(
    'status-first cancellation commits without business wait in the %s three-party interleaving',
    async (waiterOrder) => {
    const ids = await seedAttempt();
    const statusApplied = deferred();
    const releaseStatusCommit = releasable();
    const statusWriter = sqlB().begin(async (tx) => {
      const transition = await applyStripeSubscriptionState(
        tx,
        { mode: 'checkout', accountId: accountId() },
        {
          id: stripeSubscriptionId,
          customer: stripeCustomerId,
          status: 'canceled',
          trial_end: null,
        },
      );
      statusApplied.resolve();
      await releaseStatusCommit.promise;
      return transition;
    });
    const statusStage = stage('statusWriter', statusWriter);
    await statusStage.awaitHandoff('statusApplied', statusApplied.promise);

    let publisherFinished = false;
    // Each factory opens its own stage, so the watchdog starts when THAT
    // operation starts — the two orders start them seconds apart.
    const startPublisher = () => stage(
      'publisher',
      publishAutoPolicyResponse(sqlA(), publishInput(ids)).then(() => {
        publisherFinished = true;
      }),
    );
    const startTier = () => stage('tierWriter', applyTierChange(tierSql(), {
      accountId: accountId(),
      tier: 'copilot',
      operationKey: `three-party-${waiterOrder}-${ids.responseId}`,
    }));

    let publisher: Stage<void>;
    let tierWriter: Stage<Awaited<ReturnType<typeof applyTierChange>>>;
    if (waiterOrder === 'publisher-first') {
      publisher = startPublisher();
      const blocked = await waitForGrantEntitlementLock();
      expect(blocked.wait_event_type).toBe('Lock');
      expect(publisherFinished).toBe(false);
      tierWriter = startTier();
    } else {
      tierWriter = startTier();
      const tierBlocked = await waitForTierEntitlementLock();
      expect(tierBlocked.wait_event_type).toBe('Lock');
      expect(tierBlocked.query).toMatch(/pg_advisory_xact_lock/i);
      publisher = startPublisher();
      const blocked = await waitForGrantEntitlementLock();
      expect(blocked.wait_event_type).toBe('Lock');
    }
    await sleep(150);
    expect(publisherFinished).toBe(false);
    expect(mockResolveTarget).not.toHaveBeenCalled();
    expect(mockPublishReply).not.toHaveBeenCalled();

    // The publisher now holds its business anchor while waiting for the status
    // writer's entitlement lock. Canonical cancellation has no business write,
    // so releasing its deliberate pause must commit without waiting for either
    // downstream participant.
    releaseStatusCommit.resolve();
    await expect(Promise.race([
      statusWriter,
      sleep(2_000).then(() => { throw new Error('canonical cancellation waited on business'); }),
    ])).resolves.toMatchObject({
      fromStatus: 'active',
      toStatus: 'cancelled',
      changed: true,
    });
    await Promise.all([publisher.awaitSettled(), tierWriter.awaitSettled()]);

    const [committedAccount] = await observerSql()<{
      subscription_status: string;
    }[]>`
      SELECT subscription_status
      FROM accounts
      WHERE id = ${accountId()}::uuid
    `;
    const [response] = await observerSql()<{
      status: string;
      approval_method: string | null;
      posting_error: string | null;
    }[]>`
      SELECT status, approval_method, posting_error
      FROM responses
      WHERE id = ${ids.responseId}::uuid
    `;
    expect(committedAccount?.subscription_status).toBe('cancelled');
    expect(response).toEqual({
      status: 'pending_approval',
      approval_method: null,
      posting_error: 'auto_policy_revoked_tier_entitlement',
    });
    expect(mockResolveTarget).not.toHaveBeenCalled();
    expect(mockPublishReply).not.toHaveBeenCalled();
    const [mirrorJob] = await observerSql()<{ count: number }[]>`
      SELECT COUNT(*)::int AS count
      FROM job_outbox
      WHERE topic = 'stripe_subscription_mirror_sync'
        AND aggregate_id = ${accountId()}::uuid
    `;
    expect(mirrorJob?.count).toBe(1);
    await cleanupAttempt(ids.responseId);
    await observerSql()`DELETE FROM job_outbox WHERE topic = 'stripe_subscription_mirror_sync' AND aggregate_id = ${accountId()}::uuid`;
    },
  );

  it('tier/subscription writer first makes publisher wait, then downgrade with zero external calls', async () => {
    const ids = await seedAttempt();
    const writerHoldsLocks = deferred();
    const releaseWriter = releasable();

    mockRetrieveSubscription.mockImplementationOnce(async () => {
      writerHoldsLocks.resolve();
      await releaseWriter.promise;
      return autopilotProviderSubscription();
    });
    const writerStage = stage('writer', applyTierChange(sqlB(), {
      accountId: accountId(),
      tier: 'copilot',
      operationKey: `publisher-writer-first-${ids.responseId}`,
    }));

    await writerStage.awaitHandoff('writerHoldsLocks', writerHoldsLocks.promise);
    let publisherFinished = false;
    const publisherStage = stage(
      'publisher',
      publishAutoPolicyResponse(sqlA(), publishInput(ids)).then(() => {
        publisherFinished = true;
      }),
    );
    await sleep(200);
    expect(publisherFinished).toBe(false);
    expect(mockResolveTarget).not.toHaveBeenCalled();
    expect(mockPublishReply).not.toHaveBeenCalled();

    releaseWriter.resolve();
    await expect(writerStage.awaitSettled()).resolves.toMatchObject({ ok: true });
    await publisherStage.awaitSettled();

    const [response] = await sqlA()<{
      status: string;
      approval_method: string | null;
      posting_error: string | null;
    }[]>`SELECT status, approval_method, posting_error FROM responses WHERE id = ${ids.responseId}::uuid`;
    expect(response).toEqual({
      status: 'pending_approval',
      approval_method: null,
      posting_error: 'auto_policy_revoked_tier_entitlement',
    });
    expect(mockResolveTarget).not.toHaveBeenCalled();
    expect(mockPublishReply).not.toHaveBeenCalled();
    await cleanupAttempt(ids.responseId);
  });

  it('publisher first holds entitlement through bounded post/mark before tier mutation commits', async () => {
    const ids = await seedAttempt();
    const postEntered = deferred();
    const releasePost = releasable();
    mockPublishReply.mockImplementationOnce(async () => {
      postEntered.resolve();
      await releasePost.promise;
    });

    const publisherStage = stage(
      'publisher',
      publishAutoPolicyResponse(sqlA(), publishInput(ids)),
    );
    await publisherStage.awaitHandoff('postEntered', postEntered.promise);

    mockRetrieveSubscription.mockResolvedValueOnce(autopilotProviderSubscription());
    const writerStage = stage('writer', applyTierChange(sqlB(), {
      accountId: accountId(),
      tier: 'copilot',
      operationKey: `publisher-first-${ids.responseId}`,
    }));
    await sleep(200);
    expect(mockRetrieveSubscription).not.toHaveBeenCalled();

    releasePost.resolve();
    await publisherStage.awaitSettled();
    await expect(writerStage.awaitSettled()).resolves.toMatchObject({ ok: true });

    const [response] = await sqlA()<{ status: string; approval_method: string | null }[]>`
      SELECT status, approval_method FROM responses WHERE id = ${ids.responseId}::uuid
    `;
    const [account] = await sqlA()<{ subscription_tier: string }[]>`
      SELECT subscription_tier FROM accounts WHERE id = ${accountId()}::uuid
    `;
    expect(response).toEqual({ status: 'posted', approval_method: 'auto_policy' });
    expect(account?.subscription_tier).toBe('copilot');
    expect(mockPublishReply).toHaveBeenCalledTimes(1);
    await cleanupAttempt(ids.responseId);
  });

  it('possible 2xx success reconciles matching provider truth before a later Copilot downgrade', async () => {
    const ids = await seedAttempt();
    mockFindReply
      .mockResolvedValueOnce({ kind: 'review_absent', pagesWalked: 1, reviewsSeen: 0 })
      .mockResolvedValueOnce({ kind: 'found', reply: { comment: 'Thanks!' } });

    await expect(
      publishAutoPolicyResponse(sqlA(), publishInput(ids)),
    ).rejects.toMatchObject({ name: 'ZernioReplyVerificationIndeterminateError' });

    const [attempt] = await sqlA()<{
      status: string;
      marker: string | null;
    }[]>`
      SELECT status, payload->'_auto_policy_provider_attempt'->>'phase' AS marker
      FROM job_outbox
      WHERE id = ${ids.outboxId}::uuid
    `;
    expect(attempt).toEqual({ status: 'dispatched', marker: 'possible' });

    await setTier(sqlA(), 'copilot');
    await publishAutoPolicyResponse(sqlA(), publishInput(ids));

    const [response] = await sqlA()<{
      status: string;
      approval_method: string | null;
    }[]>`
      SELECT status, approval_method
      FROM responses
      WHERE id = ${ids.responseId}::uuid
    `;
    expect(response).toEqual({ status: 'posted', approval_method: 'auto_policy' });
    expect(mockPublishReply).toHaveBeenCalledTimes(1);
    expect(mockFindReply).toHaveBeenCalledTimes(2);
    await cleanupAttempt(ids.responseId);
  });

  it('possible provider success repairs an actual pending/null veto projection from durable approval truth', async () => {
    const ids = await seedAttempt();
    mockFindReply
      .mockResolvedValueOnce({ kind: 'review_absent', pagesWalked: 1, reviewsSeen: 0 })
      .mockResolvedValueOnce({ kind: 'found', reply: { comment: 'Thanks!' } });

    await expect(
      publishAutoPolicyResponse(sqlA(), publishInput(ids)),
    ).rejects.toMatchObject({ name: 'ZernioReplyVerificationIndeterminateError' });
    await sqlA()`
      UPDATE responses
      SET status = 'pending_approval',
          approval_method = NULL,
          approved_text = NULL,
          approved_at = NULL,
          auto_post_scheduled_at = NULL
      WHERE id = ${ids.responseId}::uuid
    `;

    await publishAutoPolicyResponse(sqlA(), publishInput(ids));

    const [response] = await observerSql()<{
      status: string;
      approval_method: string | null;
      approved_text: string | null;
      approved_at: Date | null;
    }[]>`
      SELECT status, approval_method, approved_text, approved_at
      FROM responses
      WHERE id = ${ids.responseId}::uuid
    `;
    expect(response).toMatchObject({
      status: 'posted',
      approval_method: 'auto_policy',
      approved_text: 'Thanks!',
    });
    expect(response?.approved_at).toBeInstanceOf(Date);
    expect(mockPublishReply).toHaveBeenCalledTimes(1);
    expect(mockFindReply).toHaveBeenCalledTimes(2);
    await cleanupAttempt(ids.responseId);
  });

  it('subscription-updated holds entitlement first, projects Copilot, then publisher downgrades', async () => {
    const ids = await seedAttempt();
    await sqlA()`
      UPDATE accounts
      SET stripe_customer_id = ${stripeCustomerId},
          stripe_subscription_id = ${stripeSubscriptionId}
      WHERE id = ${accountId()}::uuid
    `;
    const retrieveEntered = deferred();
    const releaseRetrieve = releasable();
    const providerCurrent = {
      id: stripeSubscriptionId,
      customer: stripeCustomerId,
      status: 'active',
      trial_end: null,
      metadata: {},
      items: {
        data: [
          {
            id: 'si_base', quantity: 1, metadata: {},
            price: { id: PRICE_ENV.STRIPE_PRICE_COPILOT_LIST, metadata: {}, unit_amount: 2900 },
          },
          {
            id: 'si_overage', quantity: 0, metadata: { billing_role: 'overage' },
            price: { id: PRICE_ENV.STRIPE_PRICE_COPILOT_OVERAGE, metadata: {}, unit_amount: 1500 },
          },
        ],
      },
    };
    mockRetrieveSubscription.mockImplementationOnce(async () => {
      retrieveEntered.resolve();
      await releaseRetrieve.promise;
      return providerCurrent;
    });

    // D6: the event context is a required argument. Fresh + in-window, so the
    // out-of-order retry window is open and behaviour is unchanged.
    // #889's case. The webhook can return an `ignoredOutcome` or throw
    // `AccountNotProvisionedYetError` BEFORE it ever reaches the mocked Stripe
    // retrieve; a bare `await retrieveEntered.promise` then parks forever. The
    // stage races the handoff against the webhook itself, so that path now
    // reports the outcome reason instead of a 30s timeout with no message.
    const webhookStage = stage('webhook', processSubscriptionUpdated(
      providerCurrent as never,
      { id: 'evt_test', created: Math.floor(Date.now() / 1000) },
    ));
    await webhookStage.awaitHandoff('retrieveEntered', retrieveEntered.promise);

    let publisherFinished = false;
    const publisherStage = stage(
      'publisher',
      publishAutoPolicyResponse(sqlA(), publishInput(ids)).then(() => {
        publisherFinished = true;
      }),
    );
    await sleep(200);
    expect(publisherFinished).toBe(false);
    expect(mockResolveTarget).not.toHaveBeenCalled();

    releaseRetrieve.resolve();
    const webhookOutcome = await webhookStage.awaitSettled();
    await publisherStage.awaitSettled();

    expect(webhookOutcome).toMatchObject({ kind: 'updated', tier: 'copilot' });
    const [response] = await sqlA()<{
      status: string;
      approval_method: string | null;
      posting_error: string | null;
    }[]>`SELECT status, approval_method, posting_error FROM responses WHERE id = ${ids.responseId}::uuid`;
    expect(response).toEqual({
      status: 'pending_approval',
      approval_method: null,
      posting_error: 'auto_policy_revoked_tier_entitlement',
    });
    expect(mockResolveTarget).not.toHaveBeenCalled();
    expect(mockPublishReply).not.toHaveBeenCalled();
    await cleanupAttempt(ids.responseId);
    await sqlA()`
      UPDATE accounts
      SET stripe_customer_id = NULL,
          stripe_subscription_id = NULL
      WHERE id = ${accountId()}::uuid
    `;
  });
});
