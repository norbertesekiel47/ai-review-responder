// Live-DB proofs for src/lib/agents/operator/policy-state.ts.
//
// Nothing is mocked. Every count below is a HAND count of the seeded rows,
// never a value re-derived from the reader. The cases a double cannot answer:
// which reviews the SQL admits (tenant, scope, window, origin markers), how the
// UTC day buckets fall at the microsecond boundary, that dials and token stamps
// share one statement, and that the retained-veto count locks only audit rows.
//
// Named *.integration.test.ts so vitest's serialized `integration` project
// picks it up. It executes NO DDL at run time; the schema is ASSERTED
// (.claude/rules/live-db-tests.md). One pooled connection plus the suite lock.
//
// SILENT SKIP WARNING: without TEST_DATABASE_POOL_URL this whole suite is
// skipped and the run still reports green. Export TEST_DATABASE_POOL_URL AND
// DATABASE_POOL_URL before trusting a local run.
import { randomUUID } from 'node:crypto';
import postgres from 'postgres';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { describeWithDb } from '@/__tests__/helpers/describe-with-db';
import { completeRun, recordStep, startOrGetActiveRun } from '@/lib/agents/run-spine';
import { AUDIT_ACTION_AUTO_APPROVED_BY_POLICY } from '@/lib/approval/audit';
import {
  APPROVAL_METHOD,
  POLICY_ACTION_POSTING,
  POLICY_PERSONA_REPLY,
  type ApprovalMethod,
} from '@/lib/auto-approval/types';
import { REVIEW_STATUS } from '@/lib/reviews/status';
import {
  acquireLiveDbLock,
  assertLocalTestDatabaseUrl,
  LIVE_DB_LOCK_HOOK_TIMEOUT_MS,
  resolveTestDatabaseUrl,
  type LiveDbLock,
} from '@/lib/shared/__tests__/helpers/live-db-lock';
import {
  assertSchemaReady,
  MIGRATION_071_RUN_SPINE,
  MIGRATION_074_TRUST_DIAL_VETO_WINDOW,
} from '@/lib/shared/__tests__/helpers/schema-ready';
import {
  cleanupTenantAccount,
  seedLocation,
  seedTenantAccount,
  type TenantSeed,
} from '@/lib/shared/__tests__/live-db-tenant';
import {
  consequenceForPolicy,
  readPolicySnapshot,
  readRetainedVetoCount,
  type PolicySnapshot,
} from '../policy-state';
import type { PolicyState } from '../schema';
import { versionTokensEqual } from '../version-token';

const testDatabaseUrl = resolveTestDatabaseUrl();
let db: postgres.Sql;
let lock: LiveDbLock | undefined;

/** Non-null only inside `captureStatements`; the client's `debug` hook fills it. */
let captured: string[] | null = null;
const seededTenants: TenantSeed[] = [];

const LOCK_CLAUSE = /\bFOR\s+(?:NO\s+KEY\s+UPDATE|UPDATE|KEY\s+SHARE|SHARE)\b/gi;
const UTC_TEXT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/;
const DAY_MS = 86_400_000;

type TimestampSql = postgres.PendingQuery<postgres.Row[]>;

async function captureStatements<T>(work: () => Promise<T>): Promise<{ result: T; statements: string[] }> {
  const statements: string[] = [];
  captured = statements;
  try {
    return { result: await work(), statements };
  } finally {
    captured = null;
  }
}

function policyState(
  threshold: 4 | 5 | null,
  vetoWindowMinutes: 15 | 30,
  dailyAutoPostCap: number | null,
  rowExists: boolean,
): PolicyState {
  return {
    domain: 'policy',
    threshold,
    vetoWindowMinutes,
    dailyAutoPostCap,
    effectiveDailyCap: dailyAutoPostCap ?? 10,
    rowExists,
  };
}

function snapshotOrThrow(snapshot: PolicySnapshot | null): PolicySnapshot {
  if (snapshot === null) throw new Error('expected a policy snapshot');
  return snapshot;
}

/** UTC text with microseconds → epoch ms. The µs digits are compared separately. */
function epochMs(utcText: string): number {
  return Date.parse(`${utcText.slice(0, 23)}Z`);
}

async function seedTenant(label: string): Promise<TenantSeed> {
  const tenant = await seedTenantAccount(db, {
    userName: `${label} Owner`,
    accountDisplayName: `${label} Account`,
  });
  seededTenants.push(tenant);
  return tenant;
}

async function seedBusinesses(accountId: string, count: number): Promise<string[]> {
  const ids: string[] = [];
  for (let index = 0; index < count; index += 1) {
    const seeded = await seedLocation(db, accountId, { name: `Location ${index + 1}`, isPrimary: index === 0 });
    ids.push(seeded.businessId);
  }
  return ids;
}

async function archiveBusiness(accountId: string, businessId: string): Promise<void> {
  await db`
    UPDATE businesses SET archived_at = NOW()
    WHERE id = ${businessId}::uuid AND account_id = ${accountId}::uuid
  `;
}

async function insertPolicy(
  accountId: string,
  locationId: string | null,
  dials: { threshold: 4 | 5 | null; vetoWindowMinutes: 15 | 30; dailyAutoPostCap: number | null; suspended?: boolean },
): Promise<string> {
  const id = randomUUID();
  await db`
    INSERT INTO auto_approval_policies (
      id, account_id, location_id, persona, action_class, auto_approve_min_star,
      veto_window_minutes, daily_auto_post_cap, suspended_at, suspended_reason, updated_at
    ) VALUES (
      ${id}::uuid, ${accountId}::uuid, ${locationId}::uuid, ${POLICY_PERSONA_REPLY}, ${POLICY_ACTION_POSTING},
      ${dials.threshold}, ${dials.vetoWindowMinutes}, ${dials.dailyAutoPostCap},
      ${dials.suspended ? db`NOW()` : null}, ${dials.suspended ? 'policy-state fixture' : null},
      NOW() + interval '419 microseconds'
    )
  `;
  return id;
}

async function storedUpdatedAt(policyId: string, accountId: string): Promise<string> {
  const [row] = await db<{ updated_at: string }[]>`
    SELECT updated_at::text AS updated_at FROM auto_approval_policies
    WHERE id = ${policyId}::uuid AND account_id = ${accountId}::uuid
  `;
  if (!row) throw new Error('fixture policy row vanished');
  return row.updated_at;
}

/** Yesterday 12:00:00 UTC plus `seconds` — always inside the window, one UTC day. */
function yesterdayNoonPlus(seconds: number): TimestampSql {
  return db`(date_trunc('day', NOW() AT TIME ZONE 'UTC') AT TIME ZONE 'UTC' - interval '12 hours' + ${seconds}::int * interval '1 second')`;
}

async function seedReview(
  businessId: string,
  stars: number,
  detectedAt: TimestampSql,
  status: string = REVIEW_STATUS.NEW,
): Promise<string> {
  const id = randomUUID();
  await db`
    INSERT INTO reviews (
      id, business_id, provider, provider_review_id, provider_review_name,
      provider_location_name, reviewer_name, star_rating, review_text, detected_at, status
    ) VALUES (
      ${id}::uuid, ${businessId}::uuid, 'zernio', ${`policy-state-${id}`},
      ${`zernio://policy-state/reviews/${id}`}, 'zernio://policy-state/locations/1',
      'Fixture Reviewer', ${stars}, 'fixture', ${detectedAt}, ${status}
    )
  `;
  return id;
}

/** One origin marker on its own completed `review_handler` run, via the run-spine writer. */
async function mark(input: {
  accountId: string;
  businessId: string;
  subjectId: string;
  origin?: unknown;
  stepKey?: 'review_ingested' | 'review_updated';
}): Promise<void> {
  await db.begin(async (tx) => {
    await tx`SELECT id FROM reviews WHERE id::text = ${input.subjectId} FOR UPDATE`;
    const run = await startOrGetActiveRun(tx, {
      kind: 'review_handler',
      subjectType: 'review',
      subjectId: input.subjectId,
      accountId: input.accountId,
      businessId: input.businessId,
    });
    await recordStep(tx, {
      runId: run.runId,
      stepKey: input.stepKey ?? 'review_ingested',
      detail: input.origin === undefined ? {} : { ingestion_origin: input.origin },
    });
    await completeRun(tx, run.runId, 'completed');
  });
}

async function seedResponse(input: {
  accountId: string;
  businessId: string;
  status: 'approved' | 'posted' | 'pending_approval';
  approvalMethod: ApprovalMethod | null;
  grants: readonly { metadata: Record<string, unknown>; ageSeconds: number }[];
}): Promise<string> {
  // Outside every snapshot window, and one review per response (one
  // non-terminal response per review).
  const reviewId = await seedReview(input.businessId, 5, db`NOW() - interval '40 days'`);
  const responseId = randomUUID();
  const approved = input.approvalMethod !== null;
  await db`
    INSERT INTO responses (
      id, review_id, business_id, response_text, original_draft_text, version,
      status, approval_method, approved_at, approved_text, posted_at
    ) VALUES (
      ${responseId}::uuid, ${reviewId}::uuid, ${input.businessId}::uuid, 'Thanks!', 'Thanks!', 1,
      ${input.status}, ${input.approvalMethod}, ${approved ? db`NOW()` : null},
      ${approved ? 'Thanks!' : null}, ${input.status === 'posted' ? db`NOW()` : null}
    )
  `;
  for (const grant of input.grants) {
    await db`
      INSERT INTO approval_audit_log (
        id, response_id, business_id, account_id, action, metadata,
        auth_method, response_text_at_approval, created_at
      ) VALUES (
        ${randomUUID()}::uuid, ${responseId}::uuid, ${input.businessId}::uuid, ${input.accountId}::uuid,
        ${AUDIT_ACTION_AUTO_APPROVED_BY_POLICY}, ${db.json(grant.metadata as never)},
        'auto_policy', 'Thanks!', NOW() - ${grant.ageSeconds}::int * interval '1 second'
      )
    `;
  }
  return responseId;
}

function grant(minutes: number, ageSeconds = 0) {
  return { metadata: { veto_window_minutes: minutes }, ageSeconds };
}

// ── The shared counting fixture ─────────────────────────────────────────────
//
// Account default: threshold 4, veto 30, cap 2. Locations: inheritA and
// inheritB inherit; `manual` has a manual row (null threshold, veto 15, cap
// null); `archived` has a row and is archived. All windowed reviews sit on one
// UTC day (yesterday noon + N seconds), so detection order is the offset order.
//
//   inheritA  r1 5★ live   r2 4★ live   r3 5★ live   r4 3★ live
//             r5 5★ imported            r6 5★ only a review_updated 'live' marker
//             r7 5★ live + imported     r8 5★ live twice
//             (deleted 5★ live, 31-day-old 5★ live: neither counted nor excluded)
//   inheritB  r9 4★ markers only on a foreign account and on the wrong business
//             r10 5★ marker only on a different subject      r11 5★ live
//             r14 5★ marker 'backfill'
//   manual    r12 5★ live
//   archived  r13 5★ live (not in scope)
//   foreign tenant: one 5★ live review (not in scope)
interface MainFixture {
  tenant: TenantSeed;
  inheritA: string;
  inheritB: string;
  manual: string;
  archived: string;
  accountDefaultId: string;
  manualPolicyId: string;
  archivedPolicyId: string;
  review: Record<'r1' | 'r2' | 'r3' | 'r4' | 'r8' | 'r11' | 'r12', string>;
}

let mainFixture: Promise<MainFixture> | undefined;

function getMainFixture(): Promise<MainFixture> {
  mainFixture ??= buildMainFixture();
  return mainFixture;
}

async function buildMainFixture(): Promise<MainFixture> {
  const tenant = await seedTenant('Policy Count');
  const foreign = await seedTenant('Policy Count Foreign');
  const [inheritA, inheritB, manual, archived] = await seedBusinesses(tenant.accountId, 4);
  const [foreignLocation] = await seedBusinesses(foreign.accountId, 1);
  if (!inheritA || !inheritB || !manual || !archived || !foreignLocation) throw new Error('fixture locations missing');

  const accountDefaultId = await insertPolicy(tenant.accountId, null, { threshold: 4, vetoWindowMinutes: 30, dailyAutoPostCap: 2 });
  const manualPolicyId = await insertPolicy(tenant.accountId, manual, { threshold: null, vetoWindowMinutes: 15, dailyAutoPostCap: null });
  const archivedPolicyId = await insertPolicy(tenant.accountId, archived, { threshold: 4, vetoWindowMinutes: 15, dailyAutoPostCap: null });

  const accountId = tenant.accountId;
  const markAs = (businessId: string, subjectId: string, origin: unknown) =>
    mark({ accountId, businessId, subjectId, origin });
  const liveReview = async (businessId: string, stars: number, offset: number) => {
    const id = await seedReview(businessId, stars, yesterdayNoonPlus(offset));
    await markAs(businessId, id, 'live');
    return id;
  };

  const r1 = await liveReview(inheritA, 5, 1);
  const r2 = await liveReview(inheritA, 4, 2);
  const r3 = await liveReview(inheritA, 5, 3);
  const r4 = await liveReview(inheritA, 3, 4);
  const r5 = await seedReview(inheritA, 5, yesterdayNoonPlus(5));
  await markAs(inheritA, r5, 'imported');
  const r6 = await seedReview(inheritA, 5, yesterdayNoonPlus(6));
  await mark({ accountId, businessId: inheritA, subjectId: r6, origin: 'live', stepKey: 'review_updated' });
  const r7 = await seedReview(inheritA, 5, yesterdayNoonPlus(7));
  await markAs(inheritA, r7, 'live');
  await markAs(inheritA, r7, 'imported');
  const r8 = await liveReview(inheritA, 5, 8);
  await markAs(inheritA, r8, 'live');
  const deleted = await seedReview(inheritA, 5, yesterdayNoonPlus(9), REVIEW_STATUS.DELETED);
  await markAs(inheritA, deleted, 'live');
  const old = await seedReview(inheritA, 5, db`NOW() - interval '31 days'`);
  await markAs(inheritA, old, 'live');

  const r9 = await seedReview(inheritB, 4, yesterdayNoonPlus(10));
  await mark({ accountId: foreign.accountId, businessId: foreignLocation, subjectId: r9, origin: 'live' });
  // Independent FKs permit this inconsistent run. Only ar.account_id can
  // exclude it: business and subject intentionally match the target review.
  await mark({ accountId: foreign.accountId, businessId: inheritB, subjectId: r9, origin: 'live' });
  await markAs(inheritA, r9, 'live');
  await seedReview(inheritB, 5, yesterdayNoonPlus(11));
  await markAs(inheritB, randomUUID(), 'live');
  const r11 = await liveReview(inheritB, 5, 12);
  const r14 = await seedReview(inheritB, 5, yesterdayNoonPlus(13));
  await markAs(inheritB, r14, 'backfill');

  const r12 = await liveReview(manual, 5, 14);
  await liveReview(archived, 5, 15);
  await archiveBusiness(accountId, archived);

  const foreignReview = await seedReview(foreignLocation, 5, yesterdayNoonPlus(16));
  await mark({ accountId: foreign.accountId, businessId: foreignLocation, subjectId: foreignReview, origin: 'live' });

  return {
    tenant,
    inheritA,
    inheritB,
    manual,
    archived,
    accountDefaultId,
    manualPolicyId,
    archivedPolicyId,
    review: { r1, r2, r3, r4, r8, r11, r12 },
  };
}

describeWithDb(
  'policy-state reads (live DB)',
  { enabled: Boolean(testDatabaseUrl), timeout: 180_000 },
  () => {
    beforeAll(async () => {
      const databaseUrl = assertLocalTestDatabaseUrl(testDatabaseUrl);
      lock = await acquireLiveDbLock(databaseUrl);
      db = postgres(databaseUrl, {
        max: 1,
        prepare: false,
        connection: { statement_timeout: 30_000 },
        debug: (_connection: number, query: string) => {
          captured?.push(query);
        },
      });
      await assertSchemaReady(db, [MIGRATION_071_RUN_SPINE, MIGRATION_074_TRUST_DIAL_VETO_WINDOW]);
    }, LIVE_DB_LOCK_HOOK_TIMEOUT_MS);

    afterAll(async () => {
      try {
        if (db) {
          for (const tenant of [...seededTenants].reverse()) {
            await db`DELETE FROM approval_audit_log WHERE account_id = ${tenant.accountId}::uuid`;
            await db`DELETE FROM agent_runs WHERE account_id = ${tenant.accountId}::uuid`;
            await db`DELETE FROM auto_approval_policies WHERE account_id = ${tenant.accountId}::uuid`;
            // Cascades reviews → responses.
            await db`DELETE FROM businesses WHERE account_id = ${tenant.accountId}::uuid`;
            await cleanupTenantAccount(db, tenant);
          }
        }
      } finally {
        try {
          if (db) await db.end({ timeout: 5 });
        } finally {
          await lock?.release();
          lock = undefined;
        }
      }
    }, LIVE_DB_LOCK_HOOK_TIMEOUT_MS);

    it('readPolicySnapshot returns null for a missing account and for a missing or foreign target location', async () => {
      const tenant = await seedTenant('Policy Null');
      const [own] = await seedBusinesses(tenant.accountId, 1);
      const foreign = await seedTenant('Policy Null Foreign');
      const [foreignLocation] = await seedBusinesses(foreign.accountId, 1);
      if (!own || !foreignLocation) throw new Error('fixture locations missing');

      expect(await readPolicySnapshot(db, { accountId: randomUUID(), locationId: null })).toBeNull();
      expect(await readPolicySnapshot(db, { accountId: tenant.accountId, locationId: randomUUID() })).toBeNull();
      expect(await readPolicySnapshot(db, { accountId: tenant.accountId, locationId: foreignLocation })).toBeNull();
      expect(await readPolicySnapshot(db, { accountId: tenant.accountId, locationId: own })).not.toBeNull();
    });

    it('account scope counts only confirmed-live reviews of active locations, caps each business independently and labels every exclusion', async () => {
      const f = await getMainFixture();
      const snapshot = snapshotOrThrow(await readPolicySnapshot(db, { accountId: f.tenant.accountId, locationId: null }));

      expect(snapshot).toMatchObject({
        target: { scope: 'account' },
        locationId: null,
        targetArchived: false,
        policySuspended: false,
        source: 'reviews_received_30d',
      });
      expect(snapshot.state).toEqual({ accountDefault: policyState(4, 30, 2, true), location: null });
      const byId = (a: { id: string }, b: { id: string }) => (a.id < b.id ? -1 : 1);
      // `manual` keeps ITS row whole: veto 15 and the platform cap, not the parent's 30 and 2.
      expect([...snapshot.locations].sort(byId)).toEqual([
        { id: f.inheritA, state: policyState(4, 30, 2, false) },
        { id: f.inheritB, state: policyState(4, 30, 2, false) },
        { id: f.manual, state: policyState(null, 15, null, true) },
      ].sort(byId));

      const { r1, r2, r3, r4, r8, r11, r12 } = f.review;
      expect(snapshot.reviews.map((review) => review.reviewId).sort()).toEqual([r1, r2, r3, r4, r8, r11, r12].sort());
      expect(snapshot.reviews.every((review) => review.imported === false)).toBe(true);
      expect(snapshot.excludedImported).toBe(1);
      expect(snapshot.excludedUnknown).toBe(5);

      // Hand count, current dials. inheritA (cap 2): r1, r2 eligible; r3, r8
      // cap; r4 below. inheritB: r11 eligible. manual: r12 held manual.
      const day = snapshot.reviews[0]?.dayKey;
      expect(day).toMatch(/T00:00:00\.000000Z$/);
      expect(consequenceForPolicy(snapshot, snapshot.state.accountDefault)).toEqual({
        total: 7,
        eligible: 3,
        held: { below_threshold: 1, cap_reached: 2, manual: 1 },
        byDay: [{ day, total: 7, eligible: 3, held: 4 }],
        busiestDay: 7,
        windowStart: snapshot.windowStart,
        windowEnd: snapshot.windowEnd,
        asOf: snapshot.asOf,
        source: 'reviews_received_30d',
        excludedImported: 1,
        excludedUnknown: 5,
      });

      // New account default 5★ / cap 1. inheritA: r1 eligible; r3, r8 cap;
      // r2, r4 below. inheritB: r11 eligible. manual keeps its own row.
      expect(consequenceForPolicy(snapshot, policyState(5, 30, 1, true))).toMatchObject({
        total: 7,
        eligible: 2,
        held: { below_threshold: 2, cap_reached: 2, manual: 1 },
        busiestDay: 7,
        excludedImported: 1,
        excludedUnknown: 5,
      });
    });

    it('location scope: a manual row replaces the whole default, an inheritor stamps both rows, an archived target keeps its state with no cohort', async () => {
      const f = await getMainFixture();
      const accountId = f.tenant.accountId;
      const accountDefaultRow = { id: f.accountDefaultId, updatedAt: await storedUpdatedAt(f.accountDefaultId, accountId) };

      const manual = snapshotOrThrow(await readPolicySnapshot(db, { accountId, locationId: f.manual }));
      expect(manual.target).toEqual({ scope: 'location', locationId: f.manual });
      expect(manual.state).toEqual({ accountDefault: policyState(4, 30, 2, true), location: policyState(null, 15, null, true) });
      expect(manual.locations).toEqual([{ id: f.manual, state: policyState(null, 15, null, true) }]);
      expect(manual.reviews.map((review) => review.reviewId)).toEqual([f.review.r12]);
      expect(manual).toMatchObject({ excludedImported: 0, excludedUnknown: 0, targetArchived: false });
      expect(manual.versionToken).toEqual({
        locationRow: { id: f.manualPolicyId, updatedAt: await storedUpdatedAt(f.manualPolicyId, accountId) },
        accountDefaultRow,
      });
      expect(consequenceForPolicy(manual, policyState(4, 15, null, true))).toMatchObject({
        total: 1,
        eligible: 1,
        held: { below_threshold: 0, cap_reached: 0, manual: 0 },
      });

      const inheriting = snapshotOrThrow(await readPolicySnapshot(db, { accountId, locationId: f.inheritA }));
      expect(inheriting.state.location).toEqual(policyState(4, 30, 2, false));
      expect(inheriting.versionToken).toEqual({ locationRow: { id: 'absent' }, accountDefaultRow });
      const { r1, r2, r3, r4, r8 } = f.review;
      expect(inheriting.reviews.map((review) => review.reviewId).sort()).toEqual([r1, r2, r3, r4, r8].sort());
      expect(inheriting).toMatchObject({ excludedImported: 1, excludedUnknown: 2 });

      const archived = snapshotOrThrow(await readPolicySnapshot(db, { accountId, locationId: f.archived }));
      expect(archived).toMatchObject({ targetArchived: true, locations: [], reviews: [], excludedImported: 0, excludedUnknown: 0 });
      expect(archived.state.location).toEqual(policyState(4, 15, null, true));
      expect(archived.versionToken).toEqual({
        locationRow: { id: f.archivedPolicyId, updatedAt: await storedUpdatedAt(f.archivedPolicyId, accountId) },
        accountDefaultRow,
      });
    });

    it('stamps absent rows, then opaque updated_at text read in the same lock-free statement as the values', async () => {
      const tenant = await seedTenant('Policy Token');
      const [location] = await seedBusinesses(tenant.accountId, 1);
      if (!location) throw new Error('fixture location missing');
      const accountId = tenant.accountId;

      const absentAccount = snapshotOrThrow(await readPolicySnapshot(db, { accountId, locationId: null }));
      expect(absentAccount.versionToken).toEqual({ accountDefaultRow: { id: 'absent' } });
      expect(absentAccount.state).toEqual({ accountDefault: policyState(null, 15, null, false), location: null });
      const absentLocation = snapshotOrThrow(await readPolicySnapshot(db, { accountId, locationId: location }));
      expect(absentLocation.versionToken).toEqual({ locationRow: { id: 'absent' }, accountDefaultRow: { id: 'absent' } });
      expect(absentLocation.state.location).toEqual(policyState(null, 15, null, false));

      const accountPolicyId = await insertPolicy(accountId, null, {
        threshold: 5, vetoWindowMinutes: 30, dailyAutoPostCap: 7, suspended: true,
      });
      const overrideId = await insertPolicy(accountId, location, { threshold: 4, vetoWindowMinutes: 15, dailyAutoPostCap: null });

      const { result, statements } = await captureStatements(() => readPolicySnapshot(db, { accountId, locationId: location }));
      const snapshot = snapshotOrThrow(result);
      expect(statements).toHaveLength(1);
      const statement = statements[0] ?? '';
      for (const part of ['updated_at::text', 'FROM reviews r', 'agent_run_steps', 'statement_timestamp()']) {
        expect(statement).toContain(part);
      }
      expect(statement.match(LOCK_CLAUSE)).toBeNull();

      expect(snapshot.versionToken).toEqual({
        locationRow: { id: overrideId, updatedAt: await storedUpdatedAt(overrideId, accountId) },
        accountDefaultRow: { id: accountPolicyId, updatedAt: await storedUpdatedAt(accountPolicyId, accountId) },
      });
      expect(snapshot.state).toEqual({ accountDefault: policyState(5, 30, 7, true), location: policyState(4, 15, null, true) });
      // The account default is suspended; the unsuspended winning row cannot mask it.
      expect(snapshot.policySuspended).toBe(true);

      // One microsecond: a JS Date could not see it; the text token must.
      await db`
        UPDATE auto_approval_policies SET updated_at = updated_at + interval '1 microsecond'
        WHERE id = ${accountPolicyId}::uuid AND account_id = ${accountId}::uuid
      `;
      const bumped = snapshotOrThrow(await readPolicySnapshot(db, { accountId, locationId: location }));
      expect(versionTokensEqual(bumped.versionToken, snapshot.versionToken)).toBe(false);
      expect(bumped.state).toEqual(snapshot.state);
    });

    it('bounds the cohort to [windowEnd - 30 days, windowEnd) and splits 23:59:59.999999 and 00:00:00 UTC into two days', async () => {
      const tenant = await seedTenant('Policy Window');
      const [location] = await seedBusinesses(tenant.accountId, 1);
      if (!location) throw new Error('fixture location missing');
      const accountId = tenant.accountId;
      await insertPolicy(accountId, null, { threshold: 4, vetoWindowMinutes: 15, dailyAutoPostCap: 1 });

      const seedMarked = async (at: TimestampSql, origin: string) => {
        const id = await seedReview(location, 5, at);
        await mark({ accountId, businessId: location, subjectId: id, origin });
        return id;
      };
      const lastMicro = await seedMarked(db`(date_trunc('day', NOW() AT TIME ZONE 'UTC') AT TIME ZONE 'UTC' - interval '1 microsecond')`, 'live');
      const midnight = await seedMarked(db`(date_trunc('day', NOW() AT TIME ZONE 'UTC') AT TIME ZONE 'UTC')`, 'live');
      const insideStart = await seedMarked(db`(NOW() - interval '30 days' + interval '10 minutes')`, 'live');
      await seedMarked(db`(NOW() - interval '30 days' - interval '10 minutes')`, 'live');
      await seedMarked(db`(NOW() + interval '1 hour')`, 'live');
      await seedMarked(db`(date_trunc('day', NOW() AT TIME ZONE 'UTC') AT TIME ZONE 'UTC' - interval '1 microsecond')`, 'imported');

      const snapshot = snapshotOrThrow(await readPolicySnapshot(db, { accountId, locationId: null }));
      expect(snapshot.windowEnd).toMatch(UTC_TEXT);
      expect(snapshot.asOf).toBe(snapshot.windowEnd);
      expect(snapshot.windowStart.slice(19)).toBe(snapshot.windowEnd.slice(19));
      expect(epochMs(snapshot.windowEnd) - epochMs(snapshot.windowStart)).toBe(30 * DAY_MS);

      const byId = new Map(snapshot.reviews.map((review) => [review.reviewId, review]));
      expect([...byId.keys()].sort()).toEqual([lastMicro, midnight, insideStart].sort());
      const last = byId.get(lastMicro);
      const first = byId.get(midnight);
      if (!last || !first) throw new Error('boundary reviews missing');
      expect(last.detectedAt).toMatch(/T23:59:59\.999999Z$/);
      expect(last.dayKey).toMatch(/T00:00:00\.000000Z$/);
      expect(first.detectedAt).toMatch(/T00:00:00\.000000Z$/);
      expect(first.dayKey).toBe(first.detectedAt);
      expect(epochMs(first.dayKey) - epochMs(last.dayKey)).toBe(DAY_MS);
      // The imported twin at the same instant changes neither the window nor the day keys.
      expect(snapshot).toMatchObject({ excludedImported: 1, excludedUnknown: 0 });

      // Cap 1 per business per UTC day: three days, three eligible.
      expect(consequenceForPolicy(snapshot, snapshot.state.accountDefault)).toMatchObject({
        total: 3,
        eligible: 3,
        held: { below_threshold: 0, cap_reached: 0, manual: 0 },
        busiestDay: 1,
      });
    });

    it('readRetainedVetoCount counts one latest grant per scoped auto-policy approval and locks only the audit rows', async () => {
      const tenant = await seedTenant('Policy Veto');
      const foreign = await seedTenant('Policy Veto Foreign');
      const [inheriting, overridden, archived] = await seedBusinesses(tenant.accountId, 3);
      const [foreignLocation] = await seedBusinesses(foreign.accountId, 1);
      if (!inheriting || !overridden || !archived || !foreignLocation) throw new Error('fixture locations missing');
      const accountId = tenant.accountId;
      // A MANUAL row is still an override: its location never inherits.
      await insertPolicy(accountId, overridden, { threshold: null, vetoWindowMinutes: 15, dailyAutoPostCap: null });

      const autoApproved = { status: 'approved', approvalMethod: APPROVAL_METHOD.AUTO_POLICY } as const;
      await seedResponse({ accountId, businessId: inheriting, ...autoApproved, grants: [grant(15)] });
      const duplicated = await seedResponse({
        accountId, businessId: inheriting, ...autoApproved, grants: [grant(15, 120), grant(30), grant(30)],
      });
      await seedResponse({ accountId, businessId: inheriting, status: 'posted', approvalMethod: APPROVAL_METHOD.AUTO_POLICY, grants: [grant(15)] });
      await seedResponse({ accountId, businessId: inheriting, status: 'pending_approval', approvalMethod: null, grants: [grant(15)] });
      await seedResponse({ accountId, businessId: inheriting, status: 'approved', approvalMethod: APPROVAL_METHOD.OWNER, grants: [] });
      await seedResponse({ accountId, businessId: overridden, ...autoApproved, grants: [grant(30)] });
      await seedResponse({ accountId, businessId: archived, ...autoApproved, grants: [grant(15)] });
      await archiveBusiness(accountId, archived);
      await seedResponse({ accountId: foreign.accountId, businessId: foreignLocation, ...autoApproved, grants: [grant(15)] });

      const { result, statements } = await db.begin((tx) =>
        captureStatements(() => readRetainedVetoCount(tx, { accountId, locationId: null })));
      expect(result.count).toBe(2);
      expect(result.asOf).toMatch(UTC_TEXT);
      expect(statements).toHaveLength(1);
      const statement = statements[0] ?? '';
      expect(statement.match(LOCK_CLAUSE)).toEqual(['FOR SHARE']);
      expect(statement).toContain('FOR SHARE OF aal');
      expect(statement).not.toMatch(/\b(?:INSERT|UPDATE|DELETE)\b/i);

      const countAt = (locationId: string) =>
        db.begin((tx) => readRetainedVetoCount(tx, { accountId, locationId }));
      expect((await countAt(inheriting)).count).toBe(2);
      expect((await countAt(overridden)).count).toBe(1);
      expect((await countAt(archived)).count).toBe(0);

      // Reading never rewrites a grant.
      const windows = await db<{ minutes: number }[]>`
        SELECT (metadata ->> 'veto_window_minutes')::int AS minutes
        FROM approval_audit_log
        WHERE response_id = ${duplicated}::uuid AND account_id = ${accountId}::uuid
        ORDER BY created_at, id
      `;
      expect(windows.map((row) => row.minutes)).toEqual([15, 30, 30]);
    });

    it('readRetainedVetoCount throws when an approval has no grant, or its LATEST grant has no veto window', async () => {
      const tenant = await seedTenant('Policy Veto Invariant');
      const [location] = await seedBusinesses(tenant.accountId, 1);
      if (!location) throw new Error('fixture location missing');
      const accountId = tenant.accountId;
      const autoApproved = { status: 'approved', approvalMethod: APPROVAL_METHOD.AUTO_POLICY } as const;
      const count = () => db.begin((tx) => readRetainedVetoCount(tx, { accountId, locationId: null }));

      const missing = await seedResponse({ accountId, businessId: location, ...autoApproved, grants: [] });
      await expect(count()).rejects.toThrow(/Invariant violation/);
      await db`DELETE FROM responses WHERE id = ${missing}::uuid AND business_id = ${location}::uuid`;

      await seedResponse({
        accountId, businessId: location, ...autoApproved,
        grants: [grant(15, 120), { metadata: {}, ageSeconds: 0 }],
      });
      await expect(count()).rejects.toThrow(/Invariant violation/);
    });
  },
);
