// Live-Postgres suite for the onboarding drip (#719, eval task).
//
// The unit suite (`OnboardingDripWorker.test.ts`) feeds `sql` from a positional
// queue that returns canned rows for ANY statement, so it cannot see a column
// that no longer exists. `users.business_id` was dropped by migration 034 on
// 2026-05-10 and three live queries still read it; the topic has therefore
// thrown `42703` on every run since, after claiming its `onboarding_drip_log`
// row and before sending, and no drip email has ever left. Only a real schema
// can prove otherwise, which is what this file is for.
//
// Applies NO migration SQL: `pnpm test:db:setup` provisions the schema and this
// file asserts it with `assertSchemaReady` (#573). It takes no cross-process
// live-DB lock — unlike the scheduler suite next door, `handleOnboardingDrip`
// touches only the rows of the location it is handed, so it holds no lock a
// sibling suite could invert.
//
// The handler reads the module-level `sql` singleton from @/lib/db/server, which
// binds DATABASE_POOL_URL at import time — so both it and the singleton are
// imported DYNAMICALLY, after beforeAll points that variable at the test DB
// (`ArchivalPoller.integration.test.ts:250-261` is the precedent).

import { randomUUID } from 'node:crypto';
import { afterEach, afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import postgres from 'postgres';
import type { Sql } from 'postgres';
import type { Job } from 'bullmq';
import { describeWithDb } from '@/__tests__/helpers/describe-with-db';
import {
  assertLocalTestDatabaseUrl,
  resolveTestDatabaseUrl,
} from '@/lib/shared/__tests__/helpers/live-db-lock';
import {
  assertSchemaReady,
  MIGRATION_100_IMPORT_CONSENT,
  type SchemaRequirement,
} from '@/lib/shared/__tests__/helpers/schema-ready';
import {
  cleanupLocation,
  cleanupTenantAccount,
  seedLocation,
  seedTenantAccount,
  type TenantSeed,
} from '@/lib/shared/__tests__/live-db-tenant';
import { asLocationId, type LocationId } from '@/lib/shared/ids';
import { QUEUE_NAMES } from '@/lib/shared/queue-names';
import { HANDLED_STATUSES } from '@/lib/shared/response-status';
import { SubscriptionStatus } from '@/lib/shared/subscription-status';
import type { OnboardingDripPayload } from '@/lib/shared/worker-types';
import { resolveDashboardUrl } from '../summary-report-helpers';

// Only the transport is faked. Every query, every claim and every outbox
// transition runs against the real schema — that is the whole point of the file.
// `buildOnboardingDay30Html` keeps its REAL implementation and is merely wrapped
// so the sign-off argument can be inspected (titles 10 and 11).
vi.mock('../../../src/lib/notifications/email', async (orig) => {
  const actual = await orig<typeof import('../../../src/lib/notifications/email')>();
  return {
    ...actual,
    sendInternalEmail: vi.fn(async () => ({ messageId: 'msg-live-drip' })),
    buildOnboardingDay30Html: vi.fn(actual.buildOnboardingDay30Html),
  };
});

import {
  buildOnboardingDay30Html,
  sendInternalEmail,
} from '../../../src/lib/notifications/email';

// ── Title 1: the execution sentinel ──────────────────────────────────
//
// Deliberately NOT inside describeWithDb: that helper SKIPS when the URL is
// absent, which is the exact failure this test exists to catch. A silent skip
// of the other 10 live cases is indistinguishable from a green run, and that
// blindness is how #719 shipped in the first place. It is silenced only by the
// repo's sanctioned opt-out, so an ACCIDENTALLY missing URL fails loudly while a
// DELIBERATE local opt-out stays quiet (#563).

const liveDbDeliberatelyDisabled = process.env.REPWORTH_DISABLE_LIVE_DB_SUITES === '1';

/**
 * The objects this eval reads, declared here rather than in `schema-ready.ts`:
 * they span the base schema and 034 rather than one migration, and no suite but
 * this one depends on the set. `MIGRATION_100_IMPORT_CONSENT` rides alongside as
 * the near-head proof, so a container provisioned months ago fails with the
 * actionable `pnpm test:db:setup` message instead of a puzzling missing column.
 */
const ONBOARDING_DRIP_SCHEMA: SchemaRequirement = {
  migration: '001_initial_schema + 034_account_scoped_users',
  tables: ['onboarding_drip_log', 'notification_deliveries', 'job_outbox'],
  columns: [
    'businesses.account_id',
    'businesses.onboarded_by',
    'businesses.subscription_activated_at',
    'users.account_id',
    'users.auth_id',
  ],
};

describe.skipIf(liveDbDeliberatelyDisabled)('#719 live-DB eval preconditions', () => {
  it('the live-DB eval executes against migration-head Postgres', async () => {
    // Resolve exactly the way describeWithDb does, via resolveTestDatabaseUrl —
    // NOT via process.env directly. The resolver falls back to reading
    // .env.local off disk, so a bare process.env read made this sentinel fail in
    // the one setup where the other ten live cases DID run against migration-head
    // Postgres. A guard that reports "the live tests did not run" while they are
    // passing beside it is a false negative of exactly the kind this guard exists
    // to prevent, and it trains readers to ignore it.
    const url = resolveTestDatabaseUrl();
    expect(url ?? '').not.toBe('');
    const probe = postgres(url!, { max: 1, onnotice: () => {} });
    try {
      await assertSchemaReady(probe, [ONBOARDING_DRIP_SCHEMA, MIGRATION_100_IMPORT_CONSENT]);
    } finally {
      await probe.end();
    }
  });
});

// ── Suite state ──────────────────────────────────────────────────────

const testDatabaseUrl = resolveTestDatabaseUrl();

/** Pinned so the assertion names the URL rather than re-deriving it. */
const APP_URL = 'https://drip-eval.repworth.test';

const DRIP_TYPES = {
  day1: 'day_1',
  day7: 'day_7',
  day30: 'day_30',
} as const satisfies Record<string, OnboardingDripPayload['drip_type']>;

/**
 * `posted` — the one HANDLED status that `responses_approval_method_required`
 * does not force an `approval_method` onto, so the day_7 recap fixture needs no
 * approval row of its own.
 */
const HANDLED_RESPONSE_STATUS = HANDLED_STATUSES[3];

const DAY_MS = 86_400_000;

let appSql: Sql | undefined;
let handleOnboardingDrip:
  | ((job: Job<OnboardingDripPayload>) => Promise<void>)
  | undefined;

function sql(): Sql {
  if (!appSql) throw new Error('onboarding drip integration database was not initialized');
  return appSql;
}

function runDrip(job: Job<OnboardingDripPayload>): Promise<void> {
  if (!handleOnboardingDrip) {
    throw new Error('onboarding drip integration handler was not imported');
  }
  return handleOnboardingDrip(job);
}

// ── Fixture bookkeeping ──────────────────────────────────────────────

const seededTenants: TenantSeed[] = [];
const seededBusinessIds: LocationId[] = [];
const seededExtraUserIds: string[] = [];

interface LocationFixture {
  tenant: TenantSeed;
  businessId: LocationId;
}

async function seedTenantWithLocation(options: {
  ownerAuthId?: string | null;
  subscriptionActivatedAt?: Date | null;
  onboardedBy?: string | null;
  isPrimary?: boolean;
} = {}): Promise<LocationFixture> {
  const tenant = await seedTenantAccount(sql(), {
    subscriptionStatus: SubscriptionStatus.ACTIVE,
  });
  seededTenants.push(tenant);
  await setOwnerAuthId(tenant.userId, options.ownerAuthId ?? null);

  // `seedLocation` hands back a bare string; the production helper takes the
  // branded `LocationId`, so the suite brands at the seam rather than casting
  // at the assertion.
  const seeded = await seedLocation(sql(), tenant.accountId, {
    ownerEmail: tenant.ownerEmail,
    subscriptionActivatedAt: options.subscriptionActivatedAt ?? null,
    onboardedBy: options.onboardedBy ?? null,
    isPrimary: options.isPrimary ?? true,
  });
  const businessId = asLocationId(seeded.businessId);
  seededBusinessIds.push(businessId);
  return { tenant, businessId };
}

/**
 * `users.auth_id` is a UNIQUE varchar with no FK to `auth.users`, so a suite may
 * mint one freely. Kept in the suite rather than pushed into `seedTenantAccount`:
 * this is the discriminator titles 2-4 turn on, and it reads better where it is
 * asserted.
 */
async function setOwnerAuthId(userId: string, authId: string | null): Promise<void> {
  await sql()`UPDATE users SET auth_id = ${authId} WHERE id = ${userId}::uuid`;
}

/**
 * A second user on the SAME account, authenticated, with the only non-owner role
 * the live `users_role_check` admits. Titles 4's discriminator: a query that
 * drops `u.role = 'owner'` resolves this row and hands back a dashboard URL the
 * account owner cannot use.
 */
async function seedAuthenticatedNonOwner(accountId: string): Promise<string> {
  const userId = randomUUID();
  await sql()`
    INSERT INTO users (id, name, email, role, account_id, auth_id)
    VALUES (
      ${userId}::uuid, 'Drip Eval Non-Owner', ${`non-owner-${userId}@test.local`},
      'admin', ${accountId}::uuid, ${`auth-non-owner-${userId}`}
    )
  `;
  seededExtraUserIds.push(userId);
  return userId;
}

/** The onboarding staff member `businesses.onboarded_by` points at. */
async function seedOnboardingAdmin(name: string): Promise<string> {
  const userId = randomUUID();
  await sql()`
    INSERT INTO users (id, name, email, role, account_id)
    VALUES (${userId}::uuid, ${name}, ${`admin-${userId}@test.local`}, 'admin', NULL)
  `;
  seededExtraUserIds.push(userId);
  return userId;
}

interface DripJobFixture {
  job: Job<OnboardingDripPayload>;
  outboxId: string;
}

/**
 * The `dispatched` outbox row the OutboxPoller would have handed BullMQ, plus
 * the matching job. `outbox_attempt` is populated so the handler's completion
 * takes the attempt-guarded path rather than the legacy unguarded one.
 */
async function seedDispatchedDrip(
  businessId: string,
  dripType: OnboardingDripPayload['drip_type'],
): Promise<DripJobFixture> {
  const outboxId = randomUUID();
  const payload: OnboardingDripPayload = {
    business_id: businessId,
    drip_type: dripType,
    correlation_id: randomUUID(),
    outbox_id: outboxId,
    outbox_attempt: 1,
  };
  // `{ ...payload }` rather than `payload`: postgres.js' `json()` takes a
  // JSONValue, and an INTERFACE gets no implicit index signature, so the
  // declared type is rejected while the spread's inferred one is accepted.
  await sql()`
    INSERT INTO job_outbox (
      id, topic, aggregate_type, aggregate_id, payload, status, attempts, dispatched_at
    ) VALUES (
      ${outboxId}::uuid, ${QUEUE_NAMES.ONBOARDING_DRIP}, 'business', ${businessId}::uuid,
      ${sql().json({ ...payload })}, 'dispatched', 1, NOW()
    )
  `;
  return {
    outboxId,
    job: { id: outboxId, data: payload } as Job<OnboardingDripPayload>,
  };
}

/** One handled response inside the first-week window, so the recap has content. */
async function seedHandledResponse(businessId: string, handledAt: Date): Promise<void> {
  const reviewId = randomUUID();
  const responseId = randomUUID();
  await sql()`
    INSERT INTO reviews (
      id, business_id, provider_review_id, provider_review_name,
      provider_location_name, reviewer_name, star_rating, review_text, detected_at
    ) VALUES (
      ${reviewId}::uuid, ${businessId}::uuid, ${`drip-eval-${reviewId}`},
      ${`accounts/1/locations/1/reviews/${reviewId}`}, 'accounts/1/locations/1',
      'Dana Reviewer', 5, 'The drip recap needs one review with text in it.',
      ${handledAt}
    )
  `;
  await sql()`
    INSERT INTO responses (
      id, review_id, business_id, response_text, original_draft_text,
      approved_text, status, created_at
    ) VALUES (
      ${responseId}::uuid, ${reviewId}::uuid, ${businessId}::uuid,
      'Thank you Dana!', 'Thank you Dana!', 'Thank you Dana!',
      ${HANDLED_RESPONSE_STATUS}, ${handledAt}
    )
  `;
}

interface OutboxRow {
  status: string;
}

async function readOutboxStatus(outboxId: string): Promise<string> {
  const [row] = await sql()<OutboxRow[]>`
    SELECT status FROM job_outbox WHERE id = ${outboxId}::uuid
  `;
  if (!row) throw new Error(`seeded outbox row ${outboxId} disappeared`);
  return row.status;
}

async function readDripLogSentAt(
  businessId: string,
  dripType: string,
): Promise<string | null> {
  const [row] = await sql()<{ sent_at: string | null }[]>`
    SELECT sent_at::text AS sent_at FROM onboarding_drip_log
    WHERE business_id = ${businessId}::uuid AND drip_type = ${dripType}
  `;
  if (!row) throw new Error(`no onboarding_drip_log row for ${businessId}/${dripType}`);
  return row.sent_at;
}

async function readDeliveryTemplates(businessId: string): Promise<string[]> {
  const rows = await sql()<{ template: string }[]>`
    SELECT template FROM notification_deliveries WHERE business_id = ${businessId}::uuid
  `;
  return rows.map((row) => row.template);
}

describeWithDb(
  'onboarding drip against live local Postgres',
  { enabled: Boolean(testDatabaseUrl), timeout: 120_000 },
  () => {
    beforeAll(async () => {
      const databaseUrl = assertLocalTestDatabaseUrl(testDatabaseUrl);

      // The app `sql` singleton binds DATABASE_POOL_URL at import, and the
      // handler reads that singleton — so point it here, then import both
      // dynamically. The suite seeds through the SAME client the handler uses.
      process.env.DATABASE_POOL_URL = databaseUrl;
      process.env.NEXT_PUBLIC_APP_URL = APP_URL;

      const dbModule = await import('@/lib/db/server');
      appSql = dbModule.sql as unknown as Sql;
      const workerModule = await import('../OnboardingDripWorker');
      handleOnboardingDrip = workerModule.handleOnboardingDrip;

      await assertSchemaReady(sql(), [ONBOARDING_DRIP_SCHEMA, MIGRATION_100_IMPORT_CONSENT]);
    }, 120_000);

    beforeEach(() => {
      vi.mocked(sendInternalEmail).mockClear();
      vi.mocked(buildOnboardingDay30Html).mockClear();
    });

    afterEach(async () => {
      for (const businessId of seededBusinessIds) {
        await sql()`DELETE FROM job_outbox WHERE aggregate_id = ${businessId}::uuid`;
        await sql()`DELETE FROM notification_deliveries WHERE business_id = ${businessId}::uuid`;
        await sql()`DELETE FROM onboarding_drip_log WHERE business_id = ${businessId}::uuid`;
        await sql()`DELETE FROM responses WHERE business_id = ${businessId}::uuid`;
        await sql()`DELETE FROM reviews WHERE business_id = ${businessId}::uuid`;
        await cleanupLocation(sql(), businessId);
      }
      seededBusinessIds.length = 0;

      for (const userId of seededExtraUserIds) {
        await sql()`DELETE FROM users WHERE id = ${userId}::uuid`;
      }
      seededExtraUserIds.length = 0;

      for (const tenant of seededTenants) {
        await cleanupTenantAccount(sql(), tenant);
      }
      seededTenants.length = 0;
    }, 60_000);

    afterAll(async () => {
      appSql = undefined;
    });

    // ── resolveDashboardUrl — the post-034 location → owner join ──────

    it('resolveDashboardUrl returns a dashboard URL for a location whose account owner has auth_id', async () => {
      const { businessId } = await seedTenantWithLocation({ ownerAuthId: 'auth-owner-happy' });

      await expect(resolveDashboardUrl(sql(), businessId, APP_URL)).resolves.toBe(
        `${APP_URL}/dashboard`,
      );
    });

    it('resolveDashboardUrl returns null when the location account owner has no auth_id', async () => {
      const { businessId } = await seedTenantWithLocation({ ownerAuthId: null });

      await expect(resolveDashboardUrl(sql(), businessId, APP_URL)).resolves.toBeNull();
    });

    it('resolveDashboardUrl returns null for an authenticated non-owner on the account', async () => {
      // The owner cannot sign in; a non-owner on the same account can. A query
      // that drops `u.role = 'owner'` matches the non-owner and hands back a URL
      // the recipient of the email has no way to use.
      const { tenant, businessId } = await seedTenantWithLocation({ ownerAuthId: null });
      await seedAuthenticatedNonOwner(tenant.accountId);

      await expect(resolveDashboardUrl(sql(), businessId, APP_URL)).resolves.toBeNull();
    });

    it('resolveDashboardUrl resolves the account owner for a non-primary location', async () => {
      // Post-034 the owner hangs off the ACCOUNT, not a location. A query that
      // reaches the owner through the primary business resolves nothing here.
      const { tenant, businessId } = await seedTenantWithLocation({
        ownerAuthId: 'auth-owner-multi-location',
        isPrimary: true,
      });
      const secondary = await seedLocation(sql(), tenant.accountId, {
        ownerEmail: tenant.ownerEmail,
        isPrimary: false,
        name: 'Secondary Location',
      });
      const secondaryId = asLocationId(secondary.businessId);
      seededBusinessIds.push(secondaryId);
      expect(businessId).not.toBe(secondaryId);

      await expect(
        resolveDashboardUrl(sql(), secondaryId, APP_URL),
      ).resolves.toBe(`${APP_URL}/dashboard`);
    });

    it('resolveDashboardUrl does not match an owner belonging to a different account', async () => {
      const accountA = await seedTenantWithLocation({ ownerAuthId: null });
      await seedTenantWithLocation({ ownerAuthId: 'auth-owner-other-account' });

      await expect(
        resolveDashboardUrl(sql(), accountA.businessId, APP_URL),
      ).resolves.toBeNull();
    });

    it('resolveDashboardUrl returns null without querying when no app URL is configured', async () => {
      const { businessId } = await seedTenantWithLocation({ ownerAuthId: 'auth-owner-no-app-url' });

      let queries = 0;
      const countingSql = new Proxy(sql(), {
        apply(target, thisArg, argArray) {
          queries += 1;
          return Reflect.apply(
            target as unknown as (...args: unknown[]) => unknown,
            thisArg,
            argArray,
          );
        },
      });

      await expect(resolveDashboardUrl(countingSql, businessId, undefined)).resolves.toBeNull();
      // The pair this replaces always ran the query and then discarded the row.
      expect(queries).toBe(0);
    });

    // ── handleOnboardingDrip against the live schema ──────────────────

    it('handleOnboardingDrip sends day_1 to the seeded owner with a dashboard URL and completes the outbox row', async () => {
      const { tenant, businessId } = await seedTenantWithLocation({
        ownerAuthId: 'auth-owner-day-1',
        subscriptionActivatedAt: new Date(Date.now() - 2 * DAY_MS),
      });
      const { job, outboxId } = await seedDispatchedDrip(businessId, DRIP_TYPES.day1);

      await runDrip(job);

      expect(vi.mocked(sendInternalEmail)).toHaveBeenCalledTimes(1);
      const sent = vi.mocked(sendInternalEmail).mock.calls[0]![0];
      expect(sent.to).toBe(tenant.ownerEmail);
      expect(sent.bodyHtml).toContain(`${APP_URL}/dashboard`);

      expect(await readOutboxStatus(outboxId)).toBe('completed');
      expect(await readDripLogSentAt(businessId, DRIP_TYPES.day1)).not.toBeNull();
      expect(await readDeliveryTemplates(businessId)).toContain(
        `onboarding_drip_${DRIP_TYPES.day1}`,
      );
    });

    it('handleOnboardingDrip sends day_7 against the live schema and records an onboarding_drip_day_7 delivery', async () => {
      // The ONLY live coverage of day_7's five branch-specific queries. Seeded
      // with one handled response inside the first-week window so the recap has
      // content rather than short-circuiting on an empty branch.
      const activatedAt = new Date(Date.now() - 8 * DAY_MS);
      const { tenant, businessId } = await seedTenantWithLocation({
        ownerAuthId: 'auth-owner-day-7',
        subscriptionActivatedAt: activatedAt,
      });
      await seedHandledResponse(businessId, new Date(activatedAt.getTime() + DAY_MS));
      const { job, outboxId } = await seedDispatchedDrip(businessId, DRIP_TYPES.day7);

      await runDrip(job);

      expect(vi.mocked(sendInternalEmail)).toHaveBeenCalledTimes(1);
      expect(vi.mocked(sendInternalEmail).mock.calls[0]![0].to).toBe(tenant.ownerEmail);

      expect(await readOutboxStatus(outboxId)).toBe('completed');
      expect(await readDripLogSentAt(businessId, DRIP_TYPES.day7)).not.toBeNull();
      expect(await readDeliveryTemplates(businessId)).toContain(
        `onboarding_drip_${DRIP_TYPES.day7}`,
      );
    });

    it('handleOnboardingDrip signs day_30 with the seeded onboarded_by admin name', async () => {
      const onboarderName = 'Drip Eval Onboarding Admin';
      const onboarderId = await seedOnboardingAdmin(onboarderName);
      const { businessId } = await seedTenantWithLocation({
        ownerAuthId: 'auth-owner-day-30',
        subscriptionActivatedAt: new Date(Date.now() - 31 * DAY_MS),
        onboardedBy: onboarderId,
      });
      const { job, outboxId } = await seedDispatchedDrip(businessId, DRIP_TYPES.day30);

      await runDrip(job);

      expect(vi.mocked(buildOnboardingDay30Html)).toHaveBeenCalledTimes(1);
      expect(vi.mocked(buildOnboardingDay30Html).mock.calls[0]![0]).toMatchObject({
        supportContactName: onboarderName,
      });
      expect(vi.mocked(sendInternalEmail)).toHaveBeenCalledTimes(1);
      expect(await readOutboxStatus(outboxId)).toBe('completed');
      expect(await readDeliveryTemplates(businessId)).toContain(
        `onboarding_drip_${DRIP_TYPES.day30}`,
      );
    });

    it('handleOnboardingDrip omits the day_30 sign-off when the location has no onboarded_by admin', async () => {
      const { businessId } = await seedTenantWithLocation({
        ownerAuthId: 'auth-owner-day-30-unsigned',
        subscriptionActivatedAt: new Date(Date.now() - 31 * DAY_MS),
        onboardedBy: null,
      });
      const { job, outboxId } = await seedDispatchedDrip(businessId, DRIP_TYPES.day30);

      await runDrip(job);

      expect(vi.mocked(buildOnboardingDay30Html)).toHaveBeenCalledTimes(1);
      expect(vi.mocked(buildOnboardingDay30Html).mock.calls[0]![0]).toMatchObject({
        supportContactName: null,
      });
      expect(await readOutboxStatus(outboxId)).toBe('completed');
      expect(await readDripLogSentAt(businessId, DRIP_TYPES.day30)).not.toBeNull();
    });
  },
);
