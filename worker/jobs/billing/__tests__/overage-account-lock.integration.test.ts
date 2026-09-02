// worker/jobs/billing/__tests__/overage-account-lock.integration.test.ts
//
// Real-Postgres proof that two concurrent UpdateStripeOverage runs for the SAME
// account serialize their Stripe section, and that two DIFFERENT accounts do
// not block each other. This is the replica-safety argument for the
// operation-scoped Stripe idempotency keys (overage-sync.ts): the guarantee is
// the per-account `pg_advisory_xact_lock` taken by `acquireBillingLock` inside
// the handler's `sql.begin`, around the Stripe retrieve + mutation — NOT
// `concurrency: 1`, NOT a single Railway instance. Both of those are bypassed
// here on purpose: the handler is invoked twice in parallel on one process.
//
// Mutation-checked 2026-09-02: removing ONLY the advisory lock still passes
// (the `FOR UPDATE` on the account row inside the same tx is a second
// serializer); removing both makes the same-account case observe peak=2 and
// fail. The property under test is "same-account Stripe sections never
// overlap", not which of the two locks provides it.
//
// Stripe and the outbox bookkeeping are mocked (the lock is what is under
// test); Postgres is real. Gated on TEST_DATABASE_POOL_URL; skips cleanly
// without one. No DDL. Touches only the rows it seeds.

import { afterAll, beforeAll, beforeEach, expect, it, vi } from 'vitest';
import postgres from 'postgres';
import type postgresType from 'postgres';
import type { Job } from 'bullmq';
import { randomUUID } from 'node:crypto';
import { describeWithDb } from '../../../../src/__tests__/helpers/describe-with-db';

const {
  mockStripeSubscriptionsRetrieve,
  mockStripeSubscriptionItemsUpdate,
} = vi.hoisted(() => ({
  mockStripeSubscriptionsRetrieve: vi.fn(),
  mockStripeSubscriptionItemsUpdate: vi.fn(),
}));

vi.mock('stripe', () => ({
  default: class FakeStripe {
    subscriptions = { retrieve: mockStripeSubscriptionsRetrieve };
    subscriptionItems = {
      update: mockStripeSubscriptionItemsUpdate,
      create: vi.fn(),
      del: vi.fn(),
    };
  },
}));

vi.mock('../../../../src/lib/shared/outbox', () => ({
  markOutboxCompleted: vi.fn(),
  markOutboxFailed: vi.fn(),
  recordOutboxTransientError: vi.fn(),
  extractOutboxHandle: vi.fn(
    (data: { outbox_id?: string; outbox_attempt?: number }, jobId: string) => ({
      outboxId: data.outbox_id ?? jobId,
      attempt: data.outbox_attempt ?? 1,
    }),
  ),
}));

vi.mock('@sentry/node', () => ({
  captureMessage: vi.fn(),
  captureException: vi.fn(),
}));

process.env.STRIPE_SECRET_KEY ??= 'sk_test_dummy';
process.env.STRIPE_PRICE_COPILOT_LIST ??= 'price_copilot';
process.env.STRIPE_PRICE_COPILOT_FOUNDING ??= 'price_copilot_founding';
process.env.STRIPE_PRICE_AUTOPILOT_LIST ??= 'price_autopilot';
process.env.STRIPE_PRICE_AUTOPILOT_FOUNDING ??= 'price_autopilot_founding';
process.env.STRIPE_PRICE_COPILOT_OVERAGE ??= 'price_copilot_overage';
process.env.STRIPE_PRICE_AUTOPILOT_OVERAGE ??= 'price_autopilot_overage';

const testDatabaseUrl = process.env.TEST_DATABASE_POOL_URL;

type Handler = (sql: postgresType.Sql, job: Job<{ account_id: string; correlation_id?: string; outbox_id?: string; outbox_attempt?: number }>) => Promise<void>;

let sql: postgresType.Sql | undefined;
let handleUpdateStripeOverage: Handler;

const userIds: string[] = [];
const accountIds: string[] = [];
const businessIds: string[] = [];

const STRIPE_SECTION_MS = 200;

function db(): postgresType.Sql {
  if (!sql) throw new Error('overage lock integration database not initialized');
  return sql;
}

async function seedAccount(label: string): Promise<string> {
  const userId = randomUUID();
  const accountId = randomUUID();
  await db().begin(async (tx) => {
    await tx`
      INSERT INTO users (id, name, email, role)
      VALUES (${userId}::uuid, ${`Lock ${label}`}, ${`lock-${label}-${userId}@example.test`}, 'owner')
    `;
    await tx`
      INSERT INTO accounts (
        id, owner_user_id, display_name,
        subscription_tier, subscription_status, price_variant,
        stripe_subscription_id, locations_included, locations_overage_price_cents
      ) VALUES (
        ${accountId}::uuid, ${userId}::uuid, ${`Lock ${label}`},
        'copilot', 'active', 'list',
        ${`sub_lock_${label}`}, 1, 1500
      )
    `;
    for (let i = 0; i < 3; i++) {
      const businessId = randomUUID();
      businessIds.push(businessId);
      await tx`
        INSERT INTO businesses (id, name, owner_name, owner_email, account_id)
        VALUES (${businessId}::uuid, ${`Loc ${label} ${i}`}, ${`Lock ${label}`}, ${`lock-${label}@example.test`}, ${accountId}::uuid)
      `;
    }
  });
  userIds.push(userId);
  accountIds.push(accountId);
  return accountId;
}

function mockJob(accountId: string, outboxId: string) {
  return {
    id: `job-${outboxId}`,
    data: {
      account_id: accountId,
      correlation_id: `corr-${outboxId}`,
      outbox_id: outboxId,
      outbox_attempt: 1,
    },
  } as unknown as Job<{ account_id: string; correlation_id?: string; outbox_id?: string; outbox_attempt?: number }>;
}

/**
 * Instruments the fake Stripe so "in the Stripe section" spans retrieve-start
 * → update-end, sleeping inside so two unserialized runs would overlap.
 * Returns the peak number of simultaneously in-section runs.
 */
function instrumentStripeSection(): { peak: () => number } {
  let active = 0;
  let peak = 0;
  mockStripeSubscriptionsRetrieve.mockImplementation(async () => {
    active += 1;
    peak = Math.max(peak, active);
    await new Promise((r) => setTimeout(r, STRIPE_SECTION_MS));
    return {
      items: {
        data: [
          { id: 'si_base', price: { id: 'price_copilot' }, quantity: 1 },
          { id: 'si_overage', price: { id: 'price_copilot_overage' }, quantity: 1 },
        ],
      },
    };
  });
  mockStripeSubscriptionItemsUpdate.mockImplementation(async () => {
    active -= 1;
    return { id: 'si_overage' };
  });
  return { peak: () => peak };
}

describeWithDb('UpdateStripeOverage — per-account advisory lock serializes the Stripe section (replica-safe)', () => {
  beforeAll(async () => {
    sql = postgres(testDatabaseUrl!, { max: 4, prepare: false });
    const mod = await import('../UpdateStripeOverageWorker');
    handleUpdateStripeOverage = mod.handleUpdateStripeOverage as unknown as Handler;
  });

  beforeEach(() => {
    mockStripeSubscriptionsRetrieve.mockReset();
    mockStripeSubscriptionItemsUpdate.mockReset();
  });

  afterAll(async () => {
    if (sql) {
      if (businessIds.length) await sql`DELETE FROM businesses WHERE id = ANY(${businessIds}::uuid[])`;
      if (accountIds.length) await sql`DELETE FROM accounts WHERE id = ANY(${accountIds}::uuid[])`;
      if (userIds.length) await sql`DELETE FROM users WHERE id = ANY(${userIds}::uuid[])`;
      await sql.end({ timeout: 5 });
    }
  });

  it('two concurrent runs for the SAME account never overlap in the Stripe section', async () => {
    const accountId = await seedAccount('same');
    const section = instrumentStripeSection();

    await Promise.all([
      handleUpdateStripeOverage(db(), mockJob(accountId, `same-1-${accountId}`)),
      handleUpdateStripeOverage(db(), mockJob(accountId, `same-2-${accountId}`)),
    ]);

    expect(mockStripeSubscriptionsRetrieve).toHaveBeenCalledTimes(2);
    expect(mockStripeSubscriptionItemsUpdate).toHaveBeenCalledTimes(2);
    expect(section.peak()).toBe(1);
  }, 15_000);

  it('two concurrent runs for DIFFERENT accounts do overlap (the lock is per account, not global)', async () => {
    const accountA = await seedAccount('a');
    const accountB = await seedAccount('b');
    const section = instrumentStripeSection();

    await Promise.all([
      handleUpdateStripeOverage(db(), mockJob(accountA, `diff-a-${accountA}`)),
      handleUpdateStripeOverage(db(), mockJob(accountB, `diff-b-${accountB}`)),
    ]);

    expect(mockStripeSubscriptionsRetrieve).toHaveBeenCalledTimes(2);
    expect(section.peak()).toBe(2);
  }, 15_000);
});
