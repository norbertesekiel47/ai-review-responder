// Real-Postgres concurrency coverage for the fixed WS8 billing lock graph.
// Unit tests pin SQL text/order; these tests use two independent connections
// to prove the locks actually block and release in both caller interleavings.

import { afterAll, beforeAll, expect, it } from 'vitest';
import postgres from 'postgres';
import type postgresType from 'postgres';
import { randomUUID } from 'node:crypto';
import { describeWithDb } from '@/__tests__/helpers/describe-with-db';
import {
  acquireBillingLock,
  acquireTierBillingActivationLocks,
} from '../billing-locks';

const testDatabaseUrl = process.env.TEST_DATABASE_POOL_URL;
let dbA: postgresType.Sql | undefined;
let dbB: postgresType.Sql | undefined;

function sqlA(): postgresType.Sql {
  if (!dbA) throw new Error('billing-lock integration database A was not initialized');
  return dbA;
}

function sqlB(): postgresType.Sql {
  if (!dbB) throw new Error('billing-lock integration database B was not initialized');
  return dbB;
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

describeWithDb('WS8 billing advisory lock graph against live Postgres', { timeout: 15_000 }, () => {
  beforeAll(() => {
    dbA = postgres(testDatabaseUrl!, { max: 1, prepare: false });
    dbB = postgres(testDatabaseUrl!, { max: 1, prepare: false });
  });

  afterAll(async () => {
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
});
