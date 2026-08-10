// Live-Postgres suite for the OnboardingDripScheduler's two bounds (#719, eval
// task): the Drip staleness cap and the rolling churn cap.
//
// Both are TIME boundaries, and separate `NOW()` evaluations cannot pin an
// equality — so the cycle is called through the `runOnboardingDripCycle(db,
// asOf)` seam with an explicit `asOf` and this suite's own client. No singleton
// redirection and no wall-clock anywhere.
//
// The first parameter is `db`, not `exec`: `ci:tenant-scope` only recognises
// postgres.js tagged templates under the tag names it knows, and under `exec`
// this file's global scan became invisible to that audit (#719 review D11).
//
// The cycle it exercises also THROWS where the old `checkAndSchedule` swallowed.
// That matters more than it looks: a swallowed `42703` produced "zero rows
// queued", which is indistinguishable from a correct skip, so every negative
// case below would have passed against a crashing query.
//
// ── CONTAMINATION HAZARD ─────────────────────────────────────────────
// `runOnboardingDripCycle` scans EVERY business in the database, not just the
// one under test, so any leftover eligible business from another suite lands in
// the returned counts and in `job_outbox`. Two rules follow, and both are
// load-bearing:
//   * No assertion reads a global count. Row assertions scope to the seeded
//     `aggregate_id` (and `drip_type`); the skip cases assert the seeded pair
//     produced no row OF ITS OWN rather than that the cycle queued nothing.
//   * The inherently-global `tooLate` / `churnCapped` counters are compared as a
//     DELTA against a baseline cycle run before the fixture is seeded. Both runs
//     take the same fixed `asOf`, which is what makes the delta stable — a
//     wall-clock cycle could move a contaminating business across a boundary
//     between the two runs. ONE sanctioned absolute read: after two marking
//     cycles at the same pinned `asOf`, every visible too-late pair carries a
//     durable skip record (#738), so `tooLate === 0` is stable — eligibility is
//     time-frozen and the live-DB lock rules out new contaminating inserts.
//
// Applies NO migration SQL: `pnpm test:db:setup` provisions the schema and this
// file asserts it with `assertSchemaReady` (#573). It DOES hold the cross-process
// live-DB lock, following `ArchivalPoller.integration.test.ts` — its subject is a
// platform-wide sweep, so a live-DB writer in another vitest process could have
// its fixtures swept, or ours theirs.

import { randomUUID } from 'node:crypto';
import { afterAll, afterEach, beforeAll, beforeEach, expect, it, vi } from 'vitest';
import postgres from 'postgres';
import type { Sql } from 'postgres';
import { describeWithDb } from '@/__tests__/helpers/describe-with-db';
import {
  acquireLiveDbLock,
  assertLocalTestDatabaseUrl,
  LIVE_DB_LOCK_HOOK_TIMEOUT_MS,
  resolveTestDatabaseUrl,
  type LiveDbLock,
} from '@/lib/shared/__tests__/helpers/live-db-lock';
import {
  assertSchemaReady,
  MIGRATION_100_IMPORT_CONSENT,
  MIGRATION_104_DRIP_LOG_SKIP_RECORD,
  type SchemaRequirement,
} from '@/lib/shared/__tests__/helpers/schema-ready';
import {
  cleanupLocation,
  cleanupTenantAccount,
  seedLocation,
  seedTenantAccount,
  type TenantSeed,
} from '@/lib/shared/__tests__/live-db-tenant';
import { QUEUE_NAMES } from '@/lib/shared/queue-names';
import { SubscriptionStatus } from '@/lib/shared/subscription-status';
import type { OnboardingDripPayload } from '@/lib/shared/worker-types';
import { DRIP_SKIP_REASONS } from '../../../jobs/OnboardingDripWorker';
import {
  runOnboardingDripCycle,
  type DripCycleResult,
} from '../OnboardingDripScheduler';

// Title 20 asks whether a skip was a SKIP or a swallowed crash, so the module's
// logger has to be observable. Only `createWorkerLogger` is replaced; every other
// export (`toError`, `logUnhandledPollError`, the sanitizer) stays real.
const loggerStub = vi.hoisted(() => ({
  log: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
}));

vi.mock('@/lib/shared/logger', async (orig) => {
  const actual = await orig<typeof import('@/lib/shared/logger')>();
  return { ...actual, createWorkerLogger: () => loggerStub };
});

const testDatabaseUrl = resolveTestDatabaseUrl();

/**
 * Fixed, so both runs of a delta pair evaluate every boundary against the same
 * instant. In the past on purpose: a business another suite seeded with
 * `subscription_activated_at = NOW()` is not yet due relative to it.
 */
const ASOF = new Date('2026-06-15T12:00:00.000Z');

const MINUTE_MS = 60_000;
const HOUR_MS = 3_600_000;
const DAY_MS = 86_400_000;

/** Grace is 3 days, so day_1's cap is activation + 4 days. (The old GRACE+1
 * outer reporting window is gone since #738 — the durable skip record is the
 * dedup now, so a too-late pair is selected once, recorded, and excluded.) */
const STALENESS_GRACE_DAYS = 3;

const DRIP_TYPES = {
  day1: 'day_1',
  day7: 'day_7',
  day30: 'day_30',
} as const satisfies Record<string, OnboardingDripPayload['drip_type']>;

const DRIP_OFFSET_DAYS = {
  [DRIP_TYPES.day1]: 1,
  [DRIP_TYPES.day7]: 7,
  [DRIP_TYPES.day30]: 30,
} as const;

const ONBOARDING_DRIP_SCHEDULER_SCHEMA: SchemaRequirement = {
  migration: '001_initial_schema + 034_account_scoped_users',
  tables: ['onboarding_drip_log', 'job_outbox'],
  columns: [
    'businesses.account_id',
    'businesses.subscription_activated_at',
    'job_outbox.dispatched_at',
    'job_outbox.completed_at',
  ],
};

let featureDatabaseLock: LiveDbLock | undefined;
let suiteSql: Sql | undefined;
let suiteStartedAt: Date | undefined;

function db(): Sql {
  if (!suiteSql) throw new Error('drip scheduler integration database was not initialized');
  return suiteSql;
}

function runCycle(): Promise<DripCycleResult> {
  return runOnboardingDripCycle(db(), ASOF);
}

// ── Fixture bookkeeping ──────────────────────────────────────────────

const seededTenants: TenantSeed[] = [];
const seededBusinessIds: string[] = [];

/** One entitled account + one location whose activation instant is pinned. */
async function seedDueLocation(activatedAt: Date): Promise<string> {
  const tenant = await seedTenantAccount(db(), {
    subscriptionStatus: SubscriptionStatus.ACTIVE,
  });
  seededTenants.push(tenant);
  const { businessId } = await seedLocation(db(), tenant.accountId, {
    ownerEmail: tenant.ownerEmail,
    subscriptionActivatedAt: activatedAt,
  });
  seededBusinessIds.push(businessId);
  return businessId;
}

/** Activation that puts `dripType` exactly `offsetMs` past its own due instant. */
function activationFor(
  dripType: OnboardingDripPayload['drip_type'],
  offsetMs: number,
): Date {
  return new Date(ASOF.getTime() - DRIP_OFFSET_DAYS[dripType] * DAY_MS - offsetMs);
}

interface FailedRowOptions {
  businessId: string;
  dripType: string;
  topic?: string;
  createdAt: Date;
  dispatchedAt?: Date | null;
  completedAt?: Date | null;
}

/**
 * One terminal `failed` row. `uniq_outbox_onboarding_drip` is partial on
 * `status <> 'failed'`, so any number of these may coexist for one
 * (location, drip_type) — which is precisely why the scheduler's in-flight
 * `NOT EXISTS` never blocked them and the pile grew.
 */
async function seedFailedDripRow(options: FailedRowOptions): Promise<void> {
  await db()`
    INSERT INTO job_outbox (
      id, topic, aggregate_type, aggregate_id, payload, status,
      attempts, created_at, dispatched_at, completed_at
    ) VALUES (
      ${randomUUID()}::uuid, ${options.topic ?? QUEUE_NAMES.ONBOARDING_DRIP}, 'business',
      ${options.businessId}::uuid,
      ${db().json({ business_id: options.businessId, drip_type: options.dripType })},
      'failed', 5, ${options.createdAt},
      ${options.dispatchedAt ?? null}, ${options.completedAt ?? null}
    )
  `;
}

async function seedRecentFailures(
  businessId: string,
  dripType: string,
  count: number,
): Promise<void> {
  for (let index = 0; index < count; index += 1) {
    await seedFailedDripRow({
      businessId,
      dripType,
      createdAt: new Date(ASOF.getTime() - 2 * HOUR_MS),
      dispatchedAt: new Date(ASOF.getTime() - HOUR_MS),
      completedAt: new Date(ASOF.getTime() - HOUR_MS),
    });
  }
}

interface DripLogState {
  sent_at: Date | null;
  skipped_at: Date | null;
  skip_reason: string | null;
}

/** The onboarding_drip_log row for ONE seeded pair, or undefined when absent. */
async function dripLogRow(
  businessId: string,
  dripType: string,
): Promise<DripLogState | undefined> {
  const [row] = await db()<DripLogState[]>`
    SELECT sent_at, skipped_at, skip_reason FROM onboarding_drip_log
    WHERE business_id = ${businessId}::uuid AND drip_type = ${dripType}
  `;
  return row;
}

/** Pending rows the cycle minted for ONE seeded location and drip type. */
async function pendingDripCount(businessId: string, dripType: string): Promise<number> {
  const [row] = await db()<{ count: number }[]>`
    SELECT count(*)::int AS count FROM job_outbox
    WHERE topic = ${QUEUE_NAMES.ONBOARDING_DRIP}
      AND aggregate_id = ${businessId}::uuid
      AND payload->>'drip_type' = ${dripType}
      AND status = 'pending'
  `;
  return row?.count ?? 0;
}

describeWithDb(
  'OnboardingDripScheduler bounds against live local Postgres',
  { enabled: Boolean(testDatabaseUrl), timeout: 180_000 },
  () => {
    beforeAll(async () => {
      const databaseUrl = assertLocalTestDatabaseUrl(testDatabaseUrl);
      featureDatabaseLock = await acquireLiveDbLock(databaseUrl);
      suiteStartedAt = new Date();

      suiteSql = postgres(databaseUrl, {
        max: 4,
        prepare: false,
        onnotice: () => {},
      });
      await assertSchemaReady(db(), [
        ONBOARDING_DRIP_SCHEDULER_SCHEMA,
        MIGRATION_100_IMPORT_CONSENT,
        MIGRATION_104_DRIP_LOG_SKIP_RECORD,
      ]);
    }, LIVE_DB_LOCK_HOOK_TIMEOUT_MS);

    beforeEach(() => {
      loggerStub.log.mockClear();
      loggerStub.warn.mockClear();
      loggerStub.error.mockClear();
    });

    afterEach(async () => {
      for (const businessId of seededBusinessIds) {
        await db()`DELETE FROM job_outbox WHERE aggregate_id = ${businessId}::uuid`;
        await db()`DELETE FROM onboarding_drip_log WHERE business_id = ${businessId}::uuid`;
        await cleanupLocation(db(), businessId);
      }
      seededBusinessIds.length = 0;

      for (const tenant of seededTenants) {
        await cleanupTenantAccount(db(), tenant);
      }
      seededTenants.length = 0;
    }, 60_000);

    afterAll(async () => {
      try {
        if (suiteSql && suiteStartedAt) {
          // A baseline cycle also mints rows for CONTAMINATING businesses this
          // suite did not seed. They are this suite's litter, so it clears them.
          await db()`
            DELETE FROM job_outbox
            WHERE topic = ${QUEUE_NAMES.ONBOARDING_DRIP}
              AND status = 'pending'
              AND created_at >= ${suiteStartedAt}
          `;
          // Same for durable skip records (#738): every cycle this suite runs
          // stamps skipped_at with the pinned ASOF, so equality identifies
          // exactly the rows OUR cycles wrote — including ones on contaminating
          // businesses — without touching any other suite's records.
          await db()`
            DELETE FROM onboarding_drip_log WHERE skipped_at = ${ASOF}
          `;
        }
      } finally {
        await suiteSql?.end({ timeout: 5 });
        suiteSql = undefined;
        await featureDatabaseLock?.release();
        featureDatabaseLock = undefined;
      }
    }, 120_000);

    // ── Drip staleness cap ────────────────────────────────────────────

    it('the scheduler queues day_1 exactly at the staleness grace boundary', async () => {
      // The locked intake says SEND at the boundary. A `<=` on the too-late
      // predicate skips exactly this location.
      const businessId = await seedDueLocation(
        activationFor(DRIP_TYPES.day1, STALENESS_GRACE_DAYS * DAY_MS),
      );

      await runCycle();

      expect(await pendingDripCount(businessId, DRIP_TYPES.day1)).toBe(1);
    });

    it('the scheduler skips and warns just past the staleness grace boundary', async () => {
      const baseline = await runCycle();
      const businessId = await seedDueLocation(
        activationFor(DRIP_TYPES.day1, STALENESS_GRACE_DAYS * DAY_MS + MINUTE_MS),
      );

      const after = await runCycle();

      expect(await pendingDripCount(businessId, DRIP_TYPES.day1)).toBe(0);
      expect(after.tooLate - baseline.tooLate).toBe(1);
    });

    it('the scheduler records a durable skip for every too-late pair, exactly once (#738)', async () => {
      // The old GRACE+1 outer window reported an abandoned pair for one day and
      // then dropped it from the query silently — so a backlog already past the
      // window (the 10-day location here) never appeared anywhere. Now BOTH
      // locations get a permanent onboarding_drip_log skip record on first
      // selection, no outbox row is minted, and the record itself is the dedup
      // that keeps the pair out of the next cycle. day_1-scoped because the
      // 10-day location's day_7 sits exactly ON its own grace boundary and is
      // expected to queue.
      const baseline = await runCycle();
      const atOuterBoundary = await seedDueLocation(
        activationFor(DRIP_TYPES.day1, (STALENESS_GRACE_DAYS + 1) * DAY_MS),
      );
      const longAbandoned = await seedDueLocation(new Date(ASOF.getTime() - 10 * DAY_MS));

      const after = await runCycle();

      expect(await pendingDripCount(atOuterBoundary, DRIP_TYPES.day1)).toBe(0);
      expect(await pendingDripCount(longAbandoned, DRIP_TYPES.day1)).toBe(0);
      expect(after.tooLate - baseline.tooLate).toBe(2);

      // The durable record answers "which drips were dropped as too-late, and
      // when" — stamped with the cycle's asOf and the owned reason vocabulary.
      for (const businessId of [atOuterBoundary, longAbandoned]) {
        const record = await dripLogRow(businessId, DRIP_TYPES.day1);
        expect(record).toBeDefined();
        expect(record!.sent_at).toBeNull();
        expect(record!.skipped_at).toEqual(ASOF);
        expect(record!.skip_reason).toBe(DRIP_SKIP_REASONS.TOO_STALE);
      }

      // Exactly once: the record replaces the old time-window dedup. The two
      // prior cycles marked EVERY too-late pair the query can see (seeded and
      // contaminating alike), so a third cycle finds none at all.
      const third = await runCycle();
      expect(third.tooLate).toBe(0);
      expect(third.skipRecorded).toBe(0);
    });

    it('a durable skip stamps a dead claim row rather than leaving the pair unrecorded (#738)', async () => {
      // A pair whose handler claimed the drip_log row but crashed before the
      // send has a row with sent_at NULL. The skip INSERT conflicts on
      // (business_id, drip_type); the guarded DO UPDATE stamps that dead claim
      // instead of silently no-oping — without it the pair would be reselected
      // and re-reported every cycle forever.
      const businessId = await seedDueLocation(
        activationFor(DRIP_TYPES.day1, STALENESS_GRACE_DAYS * DAY_MS + MINUTE_MS),
      );
      await db()`
        INSERT INTO onboarding_drip_log (
          id, business_id, drip_type, sent_at, claimed_at, claimed_by_outbox_id
        ) VALUES (
          ${randomUUID()}::uuid, ${businessId}::uuid, ${DRIP_TYPES.day1}, NULL,
          ${ASOF}::timestamptz - INTERVAL '2 days', 'dead-claim-outbox-id'
        )
      `;

      await runCycle();

      const record = await dripLogRow(businessId, DRIP_TYPES.day1);
      expect(record!.skipped_at).toEqual(ASOF);
      expect(record!.skip_reason).toBe(DRIP_SKIP_REASONS.TOO_STALE);
      expect(record!.sent_at).toBeNull();
    });

    it('a sent pair is never skip-marked (#738)', async () => {
      // A pair with a genuine send is excluded from the candidate query by the
      // sent_at arm of the NOT EXISTS, so the skip write can never see it —
      // and migration 104's skip/send-exclusive CHECK makes the contradiction
      // unrepresentable even if it did.
      const businessId = await seedDueLocation(
        activationFor(DRIP_TYPES.day1, STALENESS_GRACE_DAYS * DAY_MS + MINUTE_MS),
      );
      await db()`
        INSERT INTO onboarding_drip_log (id, business_id, drip_type, sent_at)
        VALUES (
          ${randomUUID()}::uuid, ${businessId}::uuid, ${DRIP_TYPES.day1},
          ${ASOF}::timestamptz - INTERVAL '3 days'
        )
      `;

      await runCycle();

      const record = await dripLogRow(businessId, DRIP_TYPES.day1);
      expect(record!.sent_at).not.toBeNull();
      expect(record!.skipped_at).toBeNull();
      expect(record!.skip_reason).toBeNull();
    });

    // ── Churn cap ─────────────────────────────────────────────────────

    it('the scheduler treats three failures exactly 24 hours old as outside the churn window', async () => {
      const businessId = await seedDueLocation(activationFor(DRIP_TYPES.day1, 0));
      const exactlyTwentyFourHoursAgo = new Date(ASOF.getTime() - 24 * HOUR_MS);
      for (let index = 0; index < 3; index += 1) {
        await seedFailedDripRow({
          businessId,
          dripType: DRIP_TYPES.day1,
          createdAt: exactlyTwentyFourHoursAgo,
          dispatchedAt: exactlyTwentyFourHoursAgo,
          completedAt: exactlyTwentyFourHoursAgo,
        });
      }

      await runCycle();

      // The window is strict `>`, so a failure ON the boundary is already out.
      expect(await pendingDripCount(businessId, DRIP_TYPES.day1)).toBe(1);
    });

    it('the scheduler skips a drip with more than three failures inside the churn window', async () => {
      const businessId = await seedDueLocation(activationFor(DRIP_TYPES.day1, 0));
      await seedRecentFailures(businessId, DRIP_TYPES.day1, 4);

      await runCycle();

      // A cap written as `count = 3` lets the fourth failure through.
      expect(await pendingDripCount(businessId, DRIP_TYPES.day1)).toBe(0);
      // A churn-capped pair returns tomorrow — it must NOT get the permanent
      // staleness skip record (#738).
      expect(await dripLogRow(businessId, DRIP_TYPES.day1)).toBeUndefined();
    });

    it('the scheduler counts a recent dispatch failure whose outbox row was created more than 24 hours ago', async () => {
      // Why the clock is COALESCE(completed_at, dispatched_at, created_at): the
      // poller's dispatch-error path never stamps `completed_at`, and the claim
      // UPDATE refreshes `dispatched_at` on every attempt. Keying on
      // `completed_at` alone — or on COALESCE(completed_at, created_at) — reads
      // these three rows as old and re-mints forever.
      const businessId = await seedDueLocation(activationFor(DRIP_TYPES.day1, 0));
      for (let index = 0; index < 3; index += 1) {
        await seedFailedDripRow({
          businessId,
          dripType: DRIP_TYPES.day1,
          createdAt: new Date(ASOF.getTime() - 30 * HOUR_MS),
          dispatchedAt: new Date(ASOF.getTime() - HOUR_MS),
          completedAt: null,
        });
      }

      await runCycle();

      expect(await pendingDripCount(businessId, DRIP_TYPES.day1)).toBe(0);
    });

    it('the churn cap counts only failed rows for the same topic, business and drip_type', async () => {
      const businessId = await seedDueLocation(activationFor(DRIP_TYPES.day1, 0));
      const otherBusinessId = await seedDueLocation(activationFor(DRIP_TYPES.day1, 0));

      await seedRecentFailures(businessId, DRIP_TYPES.day1, 2);
      // Neither of these belongs to (this location, day_1, onboarding_drip); a
      // cap that counts any of them reaches 3 and wrongly skips.
      await seedRecentFailures(otherBusinessId, DRIP_TYPES.day1, 3);
      await seedRecentFailures(businessId, DRIP_TYPES.day7, 3);
      await seedFailedDripRow({
        businessId,
        dripType: DRIP_TYPES.day1,
        topic: QUEUE_NAMES.SEND_NOTIFICATION,
        createdAt: new Date(ASOF.getTime() - 2 * HOUR_MS),
        completedAt: new Date(ASOF.getTime() - HOUR_MS),
      });

      await runCycle();

      expect(await pendingDripCount(businessId, DRIP_TYPES.day1)).toBe(1);
    });

    it('the scheduler applies the churn and staleness bounds to day_7 and day_30', async () => {
      // Bounds wired to day_1 only pass every case above and fail here.
      const baseline = await runCycle();

      const churnedDay7 = await seedDueLocation(activationFor(DRIP_TYPES.day7, 0));
      await seedRecentFailures(churnedDay7, DRIP_TYPES.day7, 3);

      const staleDay30 = await seedDueLocation(
        activationFor(DRIP_TYPES.day30, STALENESS_GRACE_DAYS * DAY_MS + MINUTE_MS),
      );

      const after = await runCycle();

      expect(await pendingDripCount(churnedDay7, DRIP_TYPES.day7)).toBe(0);
      expect(await pendingDripCount(staleDay30, DRIP_TYPES.day30)).toBe(0);
      expect(after.churnCapped - baseline.churnCapped).toBe(1);
      // Four, not one (#738): the outer reporting window that used to hide the
      // OTHER never-sent pairs of these fixtures is gone, so the 33-day
      // location's day_1/day_7/day_30 and the 7-day location's day_1 are all
      // selected, recorded and counted as too late in the same cycle.
      expect(after.tooLate - baseline.tooLate).toBe(4);
    });

    it('every scheduler skip completes without a swallowed SQL error', async () => {
      // `checkAndSchedule` used to catch its own query error and return, so
      // "0 rows queued" could equally mean the query crashed — which is exactly
      // what happened for three months. Every negative fixture above is seeded
      // together here and the cycle must RESOLVE with nothing logged as an error.
      const stale = await seedDueLocation(
        activationFor(DRIP_TYPES.day1, STALENESS_GRACE_DAYS * DAY_MS + MINUTE_MS),
      );
      const churned = await seedDueLocation(activationFor(DRIP_TYPES.day1, 0));
      await seedRecentFailures(churned, DRIP_TYPES.day1, 4);
      const abandoned = await seedDueLocation(new Date(ASOF.getTime() - 10 * DAY_MS));

      await expect(runCycle()).resolves.toMatchObject({
        queued: expect.any(Number),
        tooLate: expect.any(Number),
        churnCapped: expect.any(Number),
        skipRecorded: expect.any(Number),
      });

      expect(loggerStub.error).not.toHaveBeenCalled();
      expect(await pendingDripCount(stale, DRIP_TYPES.day1)).toBe(0);
      expect(await pendingDripCount(churned, DRIP_TYPES.day1)).toBe(0);
      expect(await pendingDripCount(abandoned, DRIP_TYPES.day1)).toBe(0);
    });
  },
);
