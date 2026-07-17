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
  acquireTierEntitlementLock,
  acquireTierAndBillingLocks,
  acquireTierBillingActivationLocks,
} from '../billing-locks';
import {
  cleanupTenantAccount,
  seedTenantAccount,
} from '@/lib/shared/__tests__/live-db-tenant';
import {
  archiveLocationTransaction,
  reactivateLocationTransaction,
} from '@/lib/locations/archive-location-tx';
import { addLocationTransaction } from '@/lib/locations/add-location-tx';
import {
  getOffboardingState,
  lockAccountBeforeOffboardingProjection,
} from '@/lib/account-offboarding/gate';

const testDatabaseUrl = process.env.TEST_DATABASE_POOL_URL;
let dbA: postgresType.Sql | undefined;
let dbB: postgresType.Sql | undefined;
let dbC: postgresType.Sql | undefined;
let dbD: postgresType.Sql | undefined;

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

function sqlD(): postgresType.Sql {
  if (!dbD) throw new Error('billing-lock integration database D was not initialized');
  return dbD;
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

async function waitForLocationBusinessRowLock(): Promise<void> {
  for (let attempt = 0; attempt < 40; attempt += 1) {
    const [activity] = await sqlD()<{
      wait_event_type: string | null;
      query: string;
    }[]>`
      SELECT wait_event_type, query
      FROM pg_stat_activity
      WHERE application_name = 'ws8_location_lifecycle_writer'
        AND state = 'active'
      LIMIT 1
    `;
    if (
      activity?.wait_event_type === 'Lock'
      && /FROM\s+businesses/i.test(activity.query)
      && /FOR\s+UPDATE/i.test(activity.query)
    ) {
      return;
    }
    await sleep(50);
  }
  throw new Error('location lifecycle writer did not block on the business row');
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

    const tierActor = sourceSegment(
      tierChangeSource,
      'async function applyTierChangeInTx',
      'export async function applyTierChange',
    );
    expectSourceOrder(tierActor, [
      'acquireTierAndBillingLocks(tx, input.accountId)',
      'loadLockedAccountState(tx, input.accountId)',
    ]);

    const webhookProjector = sourceSegment(
      webhookSource,
      'async function projectProviderCurrentSubscriptionTx',
      'async function projectProviderCurrentSubscription',
    );
    expectSourceOrder(webhookProjector, [
      'acquireTierAndBillingLocks(tx, input.accountId)',
      'getStripe().subscriptions.retrieve(input.subscriptionId)',
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
  beforeAll(async () => {
    dbA = postgres(testDatabaseUrl!, { max: 1, prepare: false });
    dbB = postgres(testDatabaseUrl!, { max: 1, prepare: false });
    dbC = postgres(testDatabaseUrl!, { max: 1, prepare: false });
    dbD = postgres(testDatabaseUrl!, { max: 1, prepare: false });
    await dbC`SET application_name = 'ws8_location_lifecycle_writer'`;
  });

  afterAll(async () => {
    await dbD?.end({ timeout: 5 });
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

  it.each([
    { mode: 'delete_data' as const, status: 'pending' as const },
    { mode: 'cancel_only' as const, status: 'scheduled' as const },
  ])(
    'takes the offboarding projection from a fresh snapshot after waiting for the account lock ($mode/$status)',
    async ({ mode, status }) => {
      const tenant = await seedTenantAccount(sqlA());
      const offboardingId = randomUUID();
      const accountLockHeld = deferred();
      const releaseOffboardingWriter = deferred();
      let writer: Promise<unknown> | undefined;
      let reader: Promise<unknown> | undefined;
      let seenOffboardingId: string | null = null;

      try {
        writer = sqlA().begin(async (tx) => {
          await tx`SET LOCAL lock_timeout = '4s'`;
          await tx`SET LOCAL statement_timeout = '7s'`;
          await tx`
            SELECT id
            FROM accounts
            WHERE id = ${tenant.accountId}::uuid
            FOR UPDATE
          `;
          accountLockHeld.resolve();
          await releaseOffboardingWriter.promise;
          await tx`
            INSERT INTO account_offboardings (id, account_id, mode, status)
            VALUES (
              ${offboardingId}::uuid,
              ${tenant.accountId}::uuid,
              ${mode},
              ${status}
            )
          `;
        });
        await accountLockHeld.promise;

        reader = sqlB().begin(async (tx) => {
          await tx`SET LOCAL lock_timeout = '4s'`;
          await tx`SET LOCAL statement_timeout = '7s'`;
          const accountExists = await lockAccountBeforeOffboardingProjection(
            tx,
            tenant.accountId,
          );
          expect(accountExists).toBe(true);
          const state = await getOffboardingState(tenant.accountId, tx);
          seenOffboardingId = state?.id ?? null;
        });

        await assertStillBlocked(reader);
        releaseOffboardingWriter.resolve();
        await Promise.all([writer, reader]);
        expect(seenOffboardingId).toBe(offboardingId);
      } finally {
        releaseOffboardingWriter.resolve();
        await Promise.allSettled([
          writer ?? Promise.resolve(),
          reader ?? Promise.resolve(),
        ]);
        await sqlA()`
          DELETE FROM account_offboardings
          WHERE id = ${offboardingId}::uuid
        `;
        await cleanupTenantAccount(sqlA(), tenant);
      }
    },
  );

  it.each(['add', 'reactivate'] as const)(
    'rejects a production location %s that was already in flight when delete-data offboarding captured its location snapshot',
    async (operation) => {
      const tenant = await seedTenantAccount(sqlA());
      const primaryBusinessId = randomUUID();
      const archivedBusinessId = randomUUID();
      const offboardingId = randomUUID();
      const snapshotCaptured = deferred();
      const allowOffboardingCommit = deferred();
      let capturedLocationIds: string[] = [];
      let writer: Promise<unknown> | undefined;
      let locationMutation: Promise<unknown> | undefined;

      try {
        await sqlA()`
          INSERT INTO businesses (
            id, account_id, name, owner_name, owner_email,
            subscription_status, is_primary, archived_at
          ) VALUES
            (
              ${primaryBusinessId}::uuid, ${tenant.accountId}::uuid,
              'Offboarding Snapshot Primary', 'Snapshot Owner', ${tenant.ownerEmail},
              'active', TRUE, NULL
            ),
            (
              ${archivedBusinessId}::uuid, ${tenant.accountId}::uuid,
              'Offboarding Snapshot Archived', 'Snapshot Owner', ${tenant.ownerEmail},
              'active', FALSE, NOW()
            )
        `;

        // Model the authoritative confirm transaction: own account, capture
        // the teardown location set, then persist active offboarding before
        // releasing the row. The production expansion must wait and reject.
        writer = sqlA().begin(async (tx) => {
          await tx`SET LOCAL lock_timeout = '4s'`;
          await tx`SET LOCAL statement_timeout = '7s'`;
          await tx`
            SELECT id
            FROM accounts
            WHERE id = ${tenant.accountId}::uuid
            FOR UPDATE
          `;
          const captured = await tx<{ id: string }[]>`
            SELECT id
            FROM businesses
            WHERE account_id = ${tenant.accountId}::uuid
              AND archived_at IS NULL
            ORDER BY id
          `;
          capturedLocationIds = captured.map((row) => row.id);
          snapshotCaptured.resolve();
          await allowOffboardingCommit.promise;
          await tx`
            INSERT INTO account_offboardings (id, account_id, mode, status)
            VALUES (
              ${offboardingId}::uuid,
              ${tenant.accountId}::uuid,
              'delete_data',
              'pending'
            )
          `;
        });
        await snapshotCaptured.promise;

        locationMutation = operation === 'add'
          ? addLocationTransaction(sqlB(), {
              accountId: tenant.accountId,
              displayLabel: 'Must Not Be Added',
              actorUserId: tenant.userId,
              ownerName: 'Snapshot Owner',
              ownerEmail: tenant.ownerEmail,
              subscriptionTier: 'copilot',
              subscriptionStatus: 'active',
              activeLocationsBefore: capturedLocationIds.length,
              voiceConfig: { tone: 'professional and friendly' },
            })
          : reactivateLocationTransaction(sqlB(), {
              locationId: archivedBusinessId,
              accountId: tenant.accountId,
              actorUserId: tenant.userId,
            });

        await assertStillBlocked(locationMutation);
        allowOffboardingCommit.resolve();
        const [writerResult, mutationResult] = await Promise.allSettled([
          writer,
          locationMutation,
        ]);
        expect(writerResult.status).toBe('fulfilled');
        expect(mutationResult.status).toBe('rejected');
        if (mutationResult.status === 'rejected') {
          expect(mutationResult.reason).toMatchObject({
            message: 'account_offboarding_blocked',
          });
        }

        const activeAfter = await sqlA()<{ id: string }[]>`
          SELECT id
          FROM businesses
          WHERE account_id = ${tenant.accountId}::uuid
            AND archived_at IS NULL
          ORDER BY id
        `;
        expect(activeAfter.map((row) => row.id)).toEqual(capturedLocationIds);
        if (operation === 'reactivate') {
          const [archived] = await sqlA()<{ archived_at: Date | null }[]>`
            SELECT archived_at
            FROM businesses
            WHERE id = ${archivedBusinessId}::uuid
          `;
          expect(archived?.archived_at).not.toBeNull();
        }
      } finally {
        allowOffboardingCommit.resolve();
        await Promise.allSettled([
          writer ?? Promise.resolve(),
          locationMutation ?? Promise.resolve(),
        ]);
        await sqlA()`DELETE FROM account_offboardings WHERE id = ${offboardingId}::uuid`;
        await sqlA()`DELETE FROM account_audit_log WHERE account_id = ${tenant.accountId}::uuid`;
        await sqlA()`DELETE FROM businesses WHERE account_id = ${tenant.accountId}::uuid`;
        await cleanupTenantAccount(sqlA(), tenant);
      }
    },
  );

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

  it.each(['publisher', 'mirror'] as const)(
    'keeps the three-actor location/%s/tier graph acyclic under real row and advisory locks',
    async (businessActorKind) => {
      const tenant = await seedTenantAccount(sqlA());
      const primaryBusinessId = randomUUID();
      const businessId = randomUUID();
      const reviewId = randomUUID();
      await sqlA()`
        INSERT INTO businesses (
          id, account_id, name, owner_name, owner_email,
          subscription_status, is_primary
        ) VALUES
          (
            ${primaryBusinessId}::uuid, ${tenant.accountId}::uuid,
            'Lock Graph Primary', 'Lock Graph Owner', ${tenant.ownerEmail},
            'active', TRUE
          ),
          (
            ${businessId}::uuid, ${tenant.accountId}::uuid,
            'Lock Graph Secondary', 'Lock Graph Owner', ${tenant.ownerEmail},
            'active', FALSE
          )
      `;
      await sqlA()`
        INSERT INTO reviews (
          id, business_id, provider, provider_review_id,
          provider_review_name, provider_location_name, reviewer_name,
          star_rating, review_text, status
        ) VALUES (
          ${reviewId}::uuid, ${businessId}::uuid, 'google', ${`lock-${reviewId}`},
          ${`google://reviews/lock-${reviewId}`},
          ${`google://locations/lock-${businessId}`},
          'Lock Reviewer', 5, 'Lock graph review', 'new'
        )
      `;

      const entitlementHeld = deferred();
      const requestAccountRow = deferred();
      const businessRowHeld = deferred();
      const events: string[] = [];
      let tierWriter: Promise<unknown> | undefined;
      let businessActor: Promise<unknown> | undefined;
      let locationActor: Promise<unknown> | undefined;

      try {
        // Tier/status writers own entitlement before requesting the account.
        // The split lets the test recreate the original three-party cycle if
        // the production location helper ever regresses to account->business.
        tierWriter = sqlA().begin(async (tx) => {
          await tx`SET LOCAL lock_timeout = '4s'`;
          await tx`SET LOCAL statement_timeout = '7s'`;
          await acquireTierEntitlementLock(tx, tenant.accountId);
          events.push('tier-entitlement-held');
          entitlementHeld.resolve();
          await requestAccountRow.promise;
          await tx`
            SELECT id FROM accounts
            WHERE id = ${tenant.accountId}::uuid
            FOR UPDATE
          `;
        }).then(() => { events.push('tier-committed'); });
        await entitlementHeld.promise;

        // The publisher variant adds its review anchor; both production actors
        // then own business rows before waiting for entitlement.
        businessActor = sqlB().begin(async (tx) => {
          await tx`SET LOCAL lock_timeout = '4s'`;
          await tx`SET LOCAL statement_timeout = '7s'`;
          if (businessActorKind === 'publisher') {
            await tx`
              SELECT id FROM reviews
              WHERE id = ${reviewId}::uuid
              FOR UPDATE
            `;
          }
          await tx`
            SELECT id FROM businesses
            WHERE account_id = ${tenant.accountId}::uuid
            ORDER BY id
            FOR UPDATE
          `;
          businessRowHeld.resolve();
          await acquireTierEntitlementLock(tx, tenant.accountId);
          events.push(`${businessActorKind}-entitlement`);
        }).then(() => { events.push(`${businessActorKind}-committed`); });
        await businessRowHeld.promise;
        await assertStillBlocked(businessActor);

        // Invoke the production location helper. Fixed code blocks on the
        // business row before owning the account row. The historical
        // account->business mutation instead owns account here, so asking the
        // tier writer for account completes the exact deadlock cycle:
        // tier entitlement -> account -> business -> entitlement.
        locationActor = archiveLocationTransaction(sqlC(), {
          locationId: businessId,
          accountId: tenant.accountId,
          actorUserId: tenant.userId,
        }).then(() => { events.push('location-committed'); });
        await waitForLocationBusinessRowLock();

        requestAccountRow.resolve();
        await Promise.all([tierWriter, businessActor, locationActor]);

        expect(events[0]).toBe('tier-entitlement-held');
        const tierCommitted = events.indexOf('tier-committed');
        const businessEntitlement = events.indexOf(`${businessActorKind}-entitlement`);
        const businessCommitted = events.indexOf(`${businessActorKind}-committed`);
        const locationCommitted = events.indexOf('location-committed');
        expect(tierCommitted).toBeGreaterThan(0);
        expect(businessEntitlement).toBeGreaterThan(0);
        expect(businessCommitted).toBeGreaterThan(tierCommitted);
        expect(businessCommitted).toBeGreaterThan(businessEntitlement);
        expect(locationCommitted).toBeGreaterThan(businessCommitted);
      } finally {
        requestAccountRow.resolve();
        await Promise.allSettled([
          tierWriter ?? Promise.resolve(),
          businessActor ?? Promise.resolve(),
          locationActor ?? Promise.resolve(),
        ]);
        await sqlA()`DELETE FROM reviews WHERE id = ${reviewId}::uuid`;
        await sqlA()`DELETE FROM account_audit_log WHERE account_id = ${tenant.accountId}::uuid`;
        await sqlA()`DELETE FROM businesses WHERE id IN (${businessId}::uuid, ${primaryBusinessId}::uuid)`;
        await cleanupTenantAccount(sqlA(), tenant);
      }
    },
  );
});
