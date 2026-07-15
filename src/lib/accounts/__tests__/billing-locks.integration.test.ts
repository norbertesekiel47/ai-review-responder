// Real-Postgres concurrency coverage for the fixed WS8 billing lock graph.
// Unit tests pin SQL text/order; these tests bind the three production actors
// to their lock helpers, then use independent connections to prove the locks
// actually block and release in both caller interleavings.

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import postgres from 'postgres';
import type postgresType from 'postgres';
import { randomUUID } from 'node:crypto';
import { describeWithDb } from '@/__tests__/helpers/describe-with-db';
import {
  acquireBillingLock,
  acquireTierAndBillingLocks,
  acquireTierBillingActivationLocks,
} from '../billing-locks';

const testDatabaseUrl = process.env.TEST_DATABASE_POOL_URL;
let dbA: postgresType.Sql | undefined;
let dbB: postgresType.Sql | undefined;
let dbC: postgresType.Sql | undefined;

function sqlA(): postgresType.Sql {
  if (!dbA) throw new Error('billing-lock integration database A was not initialized');
  return dbA;
}

function sqlB(): postgresType.Sql {
  if (!dbB) throw new Error('billing-lock integration database B was not initialized');
  return dbB;
}

function sqlC(): postgresType.Sql {
  if (!dbC) throw new Error('billing-lock integration database C was not initialized');
  return dbC;
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

async function assertStillBlocked(promise: Promise<unknown>): Promise<void> {
  const outcome = await Promise.race([
    promise.then(() => 'completed', () => 'rejected'),
    sleep(150).then(() => 'blocked'),
  ]);
  expect(outcome).toBe('blocked');
}

function sourceSegment(source: string, startMarker: string, endMarker?: string): string {
  const start = source.indexOf(startMarker);
  expect(start, `missing production marker: ${startMarker}`).toBeGreaterThanOrEqual(0);
  const end = endMarker ? source.indexOf(endMarker, start + startMarker.length) : source.length;
  expect(end, `missing production marker: ${endMarker ?? 'EOF'}`).toBeGreaterThan(start);
  return source.slice(start, end);
}

function expectSourceOrder(source: string, markers: readonly string[]): void {
  let previous = -1;
  for (const marker of markers) {
    const index = source.indexOf(marker);
    expect(index, `missing production call-order marker: ${marker}`).toBeGreaterThan(previous);
    previous = index;
  }
}

describe('WS8 three-actor production lock-order binding', () => {
  it('binds tier change, webhook projection, and overage worker reads to their production lock helpers', () => {
    const tierChangeSource = readFileSync(new URL('../tier-change.ts', import.meta.url), 'utf8');
    const webhookSource = readFileSync(
      new URL('../../../../worker/ingress/stripe/subscription-updated.ts', import.meta.url),
      'utf8',
    );
    const overageSource = readFileSync(
      new URL('../../../../worker/jobs/billing/UpdateStripeOverageWorker.ts', import.meta.url),
      'utf8',
    );

    const tierActor = sourceSegment(tierChangeSource, 'export async function applyTierChange');
    expectSourceOrder(tierActor, [
      'acquireTierAndBillingLocks(tx, input.accountId)',
      'loadLockedAccountState(tx, input.accountId)',
    ]);

    const webhookProjector = sourceSegment(
      webhookSource,
      'async function projectProviderCurrentSubscription',
      'export async function processSubscriptionUpdated',
    );
    expectSourceOrder(webhookProjector, [
      'acquireTierAndBillingLocks(tx, accountId)',
      'getStripe().subscriptions.retrieve(subscriptionId)',
      'const [account] = await tx<LockedAccountRow[]>',
    ]);
    const webhookActor = sourceSegment(
      webhookSource,
      'export async function processSubscriptionUpdated',
    );
    expectSourceOrder(webhookActor, [
      'resolveAccountReference(customerId, subscriptionId)',
      'projectProviderCurrentSubscription(',
    ]);

    const overageActor = sourceSegment(
      overageSource,
      'export async function handleUpdateStripeOverage',
    );
    expectSourceOrder(overageActor, [
      'acquireBillingLock(tx, account_id)',
      'const [account] = await tx<',
    ]);
  });
});

describeWithDb('WS8 billing advisory lock graph against live Postgres', { timeout: 15_000 }, () => {
  beforeAll(() => {
    dbA = postgres(testDatabaseUrl!, { max: 1, prepare: false });
    dbB = postgres(testDatabaseUrl!, { max: 1, prepare: false });
    dbC = postgres(testDatabaseUrl!, { max: 1, prepare: false });
  });

  afterAll(async () => {
    await dbC?.end({ timeout: 5 });
    await dbB?.end({ timeout: 5 });
    await dbA?.end({ timeout: 5 });
  });

  it('tier/activation first blocks overage-only at billing, then release completes both', async () => {
    const accountId = randomUUID();
    const activationId = randomUUID();
    const tierLocksHeld = deferred();
    const releaseTierWriter = deferred();

    const tierWriter = sqlA().begin(async (tx) => {
      await tx`SET LOCAL lock_timeout = '4s'`;
      await tx`SET LOCAL statement_timeout = '5s'`;
      await acquireTierBillingActivationLocks(tx, accountId, activationId);
      tierLocksHeld.resolve();
      await releaseTierWriter.promise;
    });
    await tierLocksHeld.promise;

    let overageAcquired = false;
    const overageWriter = sqlB().begin(async (tx) => {
      await tx`SET LOCAL lock_timeout = '4s'`;
      await tx`SET LOCAL statement_timeout = '5s'`;
      await acquireBillingLock(tx, accountId);
      overageAcquired = true;
    });

    await assertStillBlocked(overageWriter);
    expect(overageAcquired).toBe(false);

    releaseTierWriter.resolve();
    await tierWriter;
    await overageWriter;
    expect(overageAcquired).toBe(true);
  });

  it('overage-only first blocks tier/activation at billing without a reverse edge or deadlock', async () => {
    const accountId = randomUUID();
    const activationId = randomUUID();
    const billingLockHeld = deferred();
    const releaseOverageWriter = deferred();

    const overageWriter = sqlA().begin(async (tx) => {
      await tx`SET LOCAL lock_timeout = '4s'`;
      await tx`SET LOCAL statement_timeout = '5s'`;
      await acquireBillingLock(tx, accountId);
      billingLockHeld.resolve();
      await releaseOverageWriter.promise;
    });
    await billingLockHeld.promise;

    let tierActivationAcquired = false;
    const tierWriter = sqlB().begin(async (tx) => {
      await tx`SET LOCAL lock_timeout = '4s'`;
      await tx`SET LOCAL statement_timeout = '5s'`;
      await acquireTierBillingActivationLocks(tx, accountId, activationId);
      tierActivationAcquired = true;
    });

    await assertStillBlocked(tierWriter);
    expect(tierActivationAcquired).toBe(false);

    releaseOverageWriter.resolve();
    await overageWriter;
    await tierWriter;
    expect(tierActivationAcquired).toBe(true);
  });

  it('tier change first holds one plan boundary against same-account overage sync', async () => {
    const accountId = randomUUID();
    const tierLocksHeld = deferred();
    const releaseTierChange = deferred();

    const tierChange = sqlA().begin(async (tx) => {
      await tx`SET LOCAL lock_timeout = '4s'`;
      await tx`SET LOCAL statement_timeout = '5s'`;
      await acquireTierAndBillingLocks(tx, accountId);
      tierLocksHeld.resolve();
      await releaseTierChange.promise;
    });
    await tierLocksHeld.promise;

    let overageReadBoundaryReached = false;
    const overageSync = sqlB().begin(async (tx) => {
      await tx`SET LOCAL lock_timeout = '4s'`;
      await tx`SET LOCAL statement_timeout = '5s'`;
      await acquireBillingLock(tx, accountId);
      overageReadBoundaryReached = true;
    });

    await assertStillBlocked(overageSync);
    expect(overageReadBoundaryReached).toBe(false);
    releaseTierChange.resolve();
    await tierChange;
    await overageSync;
    expect(overageReadBoundaryReached).toBe(true);
  });

  it('overage sync first blocks tier change before its mutable-state read boundary', async () => {
    const accountId = randomUUID();
    const billingLockHeld = deferred();
    const releaseOverageSync = deferred();

    const overageSync = sqlA().begin(async (tx) => {
      await tx`SET LOCAL lock_timeout = '4s'`;
      await tx`SET LOCAL statement_timeout = '5s'`;
      await acquireBillingLock(tx, accountId);
      billingLockHeld.resolve();
      await releaseOverageSync.promise;
    });
    await billingLockHeld.promise;

    let tierReadBoundaryReached = false;
    const tierChange = sqlB().begin(async (tx) => {
      await tx`SET LOCAL lock_timeout = '4s'`;
      await tx`SET LOCAL statement_timeout = '5s'`;
      await acquireTierAndBillingLocks(tx, accountId);
      tierReadBoundaryReached = true;
    });

    await assertStillBlocked(tierChange);
    expect(tierReadBoundaryReached).toBe(false);
    releaseOverageSync.resolve();
    await overageSync;
    await tierChange;
    expect(tierReadBoundaryReached).toBe(true);
  });

  it('orders webhook, overage, and tier-change actors without any pre-lock read boundary', async () => {
    const accountId = randomUUID();
    const webhookLocksHeld = deferred();
    const releaseWebhook = deferred();
    const overageReadReached = deferred();
    const releaseOverage = deferred();
    let tierReadBoundaryReached = false;

    // subscription-updated owns entitlement -> billing while it retrieves and
    // projects provider-current state.
    const webhook = sqlA().begin(async (tx) => {
      await tx`SET LOCAL lock_timeout = '4s'`;
      await tx`SET LOCAL statement_timeout = '7s'`;
      await acquireTierAndBillingLocks(tx, accountId);
      webhookLocksHeld.resolve();
      await releaseWebhook.promise;
    });
    await webhookLocksHeld.promise;

    // Tier change queues on entitlement. Its mutable account/location read
    // boundary is deliberately after both locks.
    const tierChange = sqlB().begin(async (tx) => {
      await tx`SET LOCAL lock_timeout = '4s'`;
      await tx`SET LOCAL statement_timeout = '7s'`;
      await acquireTierAndBillingLocks(tx, accountId);
      tierReadBoundaryReached = true;
    });
    await assertStillBlocked(tierChange);
    expect(tierReadBoundaryReached).toBe(false);

    // Overage queues directly on billing before webhook release. PostgreSQL's
    // wait queue lets it linearize next; tier holds entitlement and waits for
    // billing, which is safe because overage never requests entitlement.
    const overage = sqlC().begin(async (tx) => {
      await tx`SET LOCAL lock_timeout = '4s'`;
      await tx`SET LOCAL statement_timeout = '7s'`;
      await acquireBillingLock(tx, accountId);
      overageReadReached.resolve();
      await releaseOverage.promise;
    });
    await assertStillBlocked(overage);

    releaseWebhook.resolve();
    await webhook;
    await overageReadReached.promise;
    expect(tierReadBoundaryReached).toBe(false);
    await assertStillBlocked(tierChange);

    releaseOverage.resolve();
    await overage;
    await tierChange;
    expect(tierReadBoundaryReached).toBe(true);
  });
});
