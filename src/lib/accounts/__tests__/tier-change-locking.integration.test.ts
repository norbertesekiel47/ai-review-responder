// Production-path concurrency proof: applyTierChange must not lock/read the
// account or locations until a same-account overage writer releases billing.

import { afterAll, beforeAll, beforeEach, expect, it, vi } from 'vitest';
import postgres from 'postgres';
import type postgresType from 'postgres';
import { randomUUID } from 'node:crypto';
import { describeWithDb } from '@/__tests__/helpers/describe-with-db';

const {
  mockSubscriptionsRetrieve,
  mockSubscriptionItemsUpdate,
  mockSubscriptionItemsCreate,
  mockSubscriptionItemsDel,
} = vi.hoisted(() => ({
  mockSubscriptionsRetrieve: vi.fn(),
  mockSubscriptionItemsUpdate: vi.fn(),
  mockSubscriptionItemsCreate: vi.fn(),
  mockSubscriptionItemsDel: vi.fn(),
}));

vi.mock('@/lib/payments/stripe-client', () => ({
  getStripe: () => ({
    subscriptions: { retrieve: mockSubscriptionsRetrieve },
    subscriptionItems: {
      update: mockSubscriptionItemsUpdate,
      create: mockSubscriptionItemsCreate,
      del: mockSubscriptionItemsDel,
    },
  }),
}));

import { acquireBillingLock } from '../billing-locks';
import { applyTierChange } from '../tier-change';

const testDatabaseUrl = process.env.TEST_DATABASE_POOL_URL;
const ids = {
  user: randomUUID(),
  account: randomUUID(),
  primary: randomUUID(),
  secondary: randomUUID(),
};
let dbWriter: postgresType.Sql | undefined;
let dbTier: postgresType.Sql | undefined;

function writerSql(): postgresType.Sql {
  if (!dbWriter) throw new Error('tier-change writer DB was not initialized');
  return dbWriter;
}

function tierSql(): postgresType.Sql {
  if (!dbTier) throw new Error('tier-change DB was not initialized');
  return dbTier;
}

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function expectBlocked(promise: Promise<unknown>): Promise<void> {
  const result = await Promise.race([
    promise.then(() => 'completed', () => 'rejected'),
    sleep(150).then(() => 'blocked'),
  ]);
  expect(result).toBe('blocked');
}

describeWithDb('tier change production-path lock interleaving', { timeout: 15_000 }, () => {
  beforeAll(async () => {
    dbWriter = postgres(testDatabaseUrl!, { max: 1, prepare: false });
    dbTier = postgres(testDatabaseUrl!, { max: 1, prepare: false });
    process.env.STRIPE_PRICE_COPILOT_LIST = 'price_copilot_list';
    process.env.STRIPE_PRICE_COPILOT_FOUNDING = 'price_copilot_founding';
    process.env.STRIPE_PRICE_AUTOPILOT_LIST = 'price_autopilot_list';
    process.env.STRIPE_PRICE_AUTOPILOT_FOUNDING = 'price_autopilot_founding';
    process.env.STRIPE_PRICE_COPILOT_OVERAGE = 'price_copilot_overage';
    process.env.STRIPE_PRICE_AUTOPILOT_OVERAGE = 'price_autopilot_overage';

    const email = `tier-lock-${ids.user}@test.local`;
    await writerSql().begin(async (tx) => {
      await tx`SET CONSTRAINTS ALL DEFERRED`;
      await tx`
        INSERT INTO users (id, name, email, role, account_id)
        VALUES (${ids.user}::uuid, 'Tier Lock Owner', ${email}, 'owner', ${ids.account}::uuid)
      `;
      await tx`
        INSERT INTO accounts (
          id,
          owner_user_id,
          display_name,
          subscription_tier,
          subscription_status,
          stripe_subscription_id,
          price_variant,
          base_price_cents,
          locations_overage_price_cents,
          locations_included,
          locations_paid
        ) VALUES (
          ${ids.account}::uuid,
          ${ids.user}::uuid,
          'Tier Lock Account',
          'autopilot',
          'active',
          'sub_tier_lock',
          'list',
          6900,
          2000,
          1,
          0
        )
      `;
      await tx`
        INSERT INTO businesses (
          id, name, owner_name, owner_email, account_id,
          subscription_tier, subscription_status, is_primary, archived_at
        ) VALUES (
          ${ids.primary}::uuid, 'Primary', 'Tier Lock Owner', ${email},
          ${ids.account}::uuid, 'autopilot', 'active', TRUE, NULL
        )
      `;
    });
  });

  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterAll(async () => {
    if (dbWriter) {
      await writerSql().begin(async (tx) => {
        await tx`SET CONSTRAINTS ALL DEFERRED`;
        await tx`DELETE FROM account_audit_log WHERE account_id = ${ids.account}::uuid`;
        await tx`DELETE FROM businesses WHERE account_id = ${ids.account}::uuid`;
        await tx`DELETE FROM accounts WHERE id = ${ids.account}::uuid`;
        await tx`DELETE FROM users WHERE id = ${ids.user}::uuid`;
      });
    }
    await dbTier?.end({ timeout: 5 });
    await dbWriter?.end({ timeout: 5 });
  });

  it('waits before account/location reads and plans from the overage writer commit', async () => {
    const billingHeld = deferred();
    const allowWriterMutation = deferred();
    const writerMutationDone = deferred();
    const releaseWriter = deferred();
    const email = `tier-lock-secondary-${ids.user}@test.local`;

    const overageWriter = writerSql().begin(async (tx) => {
      await tx`SET LOCAL lock_timeout = '4s'`;
      await tx`SET LOCAL statement_timeout = '6s'`;
      await acquireBillingLock(tx, ids.account);
      billingHeld.resolve();
      await allowWriterMutation.promise;
      // If applyTierChange moved its account FOR UPDATE before billing, this
      // harmless writer update would block and the assertion below would fail.
      await tx`
        UPDATE accounts SET updated_at = NOW() WHERE id = ${ids.account}::uuid
      `;
      await tx`
        INSERT INTO businesses (
          id, name, owner_name, owner_email, account_id,
          subscription_tier, subscription_status, is_primary, archived_at
        ) VALUES (
          ${ids.secondary}::uuid, 'Secondary', 'Tier Lock Owner', ${email},
          ${ids.account}::uuid, 'autopilot', 'active', FALSE, NULL
        )
      `;
      writerMutationDone.resolve();
      await releaseWriter.promise;
    });
    await billingHeld.promise;

    mockSubscriptionsRetrieve.mockResolvedValueOnce({
      id: 'sub_tier_lock',
      items: {
        data: [
          { id: 'si_base', quantity: 1, metadata: {}, price: { id: 'price_autopilot_list', metadata: {} } },
          {
            id: 'si_overage',
            quantity: 0,
            metadata: { billing_role: 'overage' },
            price: { id: 'price_autopilot_overage', metadata: {} },
          },
        ],
      },
    });
    mockSubscriptionItemsUpdate.mockResolvedValue({});

    const tierChange = applyTierChange(tierSql(), {
      accountId: ids.account,
      tier: 'copilot',
      operationKey: 'live-production-interleaving',
    });
    await expectBlocked(tierChange);
    expect(mockSubscriptionsRetrieve).not.toHaveBeenCalled();

    allowWriterMutation.resolve();
    const mutationOutcome = await Promise.race([
      writerMutationDone.promise.then(() => 'completed'),
      sleep(750).then(() => 'blocked'),
    ]);
    expect(mutationOutcome).toBe('completed');
    await expectBlocked(tierChange);

    releaseWriter.resolve();
    await overageWriter;
    const result = await tierChange;
    expect(result.ok).toBe(true);
    expect(mockSubscriptionItemsUpdate).toHaveBeenCalledWith(
      'si_overage',
      expect.objectContaining({ price: 'price_copilot_overage', quantity: 1 }),
      expect.objectContaining({
        idempotencyKey: expect.stringContaining(':live-production-interleaving:overage-update'),
      }),
    );
    const [stored] = await tierSql()<{
      subscription_tier: string;
      locations_paid: number;
    }[]>`
      SELECT subscription_tier, locations_paid
      FROM accounts
      WHERE id = ${ids.account}::uuid
    `;
    expect(stored).toEqual({ subscription_tier: 'copilot', locations_paid: 1 });
  });
});
