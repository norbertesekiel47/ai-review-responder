// The Refusal ledger's READ path — live-Postgres eval (#1014 T1/T2).
//
// Titles 1-22, VERBATIM from `.feature/intake.json` `tests_to_add`. The
// `promised-tests` gate row matches them as fixed strings, so a retitle here
// fails the gate rather than the test. Four remain `it.todo` and belong to
// later tracers: the two archived-location footnote titles are T3's, and the
// two archived-period titles are T4's. Never delete one to match a pass count.
//
// WHY THE LIVE-DB LANE. `getRefusalLog` is three sequential queries whose whole
// contract is scoping, ordering and bounds against real rows: the account /
// location scope predicate, the account-wide suspension that must appear once
// per location view and once in the account total, and the two window bounds.
// None of that is provable against a mock — a mock returns whatever the query
// author believed the query said.
//
// This file applies NO migration SQL and executes NO DDL. `pnpm test:db:setup`
// provisions the schema; this suite asserts it with `assertSchemaReady` and
// seeds with `INSERT` only. Run-time DDL deadlocks (40P01) across concurrent
// suites, and `ci:live-db-suites` R2 enforces that.
//
// It DOES hold the cross-process live-DB lock, for the same reason the write
// suite next door does: `refusal_events_subject_uniq` is a GLOBAL partial
// unique index with no tenant column in it, and the ArchivalPoller's retention
// arm sweeps this table platform-wide.

import { randomUUID } from 'node:crypto';
import { afterAll, afterEach, beforeAll, expect, it } from 'vitest';
import postgres from 'postgres';
import type postgresType from 'postgres';
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
  type SchemaRequirement,
} from '@/lib/shared/__tests__/helpers/schema-ready';
import {
  cleanupTenantAccount,
  seedLocation,
  seedTenantAccount,
  type TenantSeed,
} from '@/lib/shared/__tests__/live-db-tenant';
import {
  REFUSAL_VOCABULARY_VERSION,
  type RefusalCategory,
  type RefusalSource,
} from '../vocabulary';
import { getRefusalLog } from '../read';

/**
 * Declared locally rather than added to `schema-ready.ts`: that helper lives
 * outside this branch's `allowed_edit_surface`, and the write suite next door
 * declares its requirement inline for the same reason.
 */
const MIGRATION_116_REFUSAL_EVENTS: SchemaRequirement = {
  migration: '116_refusal_events',
  tables: ['refusal_events'],
  indexes: [
    'idx_refusal_events_archival',
    'idx_refusal_events_account_window',
    'refusal_events_subject_uniq',
  ],
};

const testDatabaseUrl = resolveTestDatabaseUrl();

let db: postgresType.Sql | undefined;
let featureDatabaseLock: LiveDbLock | undefined;

/** Every tenant a case seeded, torn down newest-first after that case. */
const seededTenants: TenantSeed[] = [];

function sql(): postgresType.Sql {
  if (!db) throw new Error('refusal read integration database was not initialized');
  return db;
}

interface AccountWithLocation {
  tenant: TenantSeed;
  accountId: string;
  businessId: string;
}

/**
 * How far back a seeded tenant's **Coverage start** is pushed.
 *
 * WITHOUT THIS EVERY BACKDATED FIXTURE SILENTLY VANISHES, and the suite reads
 * as a broken query rather than a working clamp. `accounts.created_at` and
 * `businesses.created_at` both default to `NOW()`, so a tenant seeded inside the
 * test IS the coverage start — and `getRefusalLog` clamps `windowStart` up to
 * it, correctly excluding every row dated before the account existed. A fixture
 * seeded one minute in the past is one minute before its own account.
 *
 * 200 days puts coverage behind the widest selectable window (90d), so the
 * clamp is inert unless a case sets `created_at` itself. The three cases that
 * PROVE the clamp do exactly that.
 */
const SEEDED_COVERAGE_AGE_MS = 200 * 24 * 60 * 60 * 1000;

/** One account, one active primary location. Registered for teardown. */
async function seedAccountWithLocation(): Promise<AccountWithLocation> {
  const tenant = await seedTenantAccount(sql(), {
    userName: 'Refusal Read Owner',
    accountDisplayName: 'Refusal Read Account',
  });
  seededTenants.push(tenant);
  const { businessId } = await seedLocation(sql(), tenant.accountId, {
    name: 'Refusal Read Location',
  });
  const coverageStart = new Date(Date.now() - SEEDED_COVERAGE_AGE_MS);
  await setAccountCreatedAt(tenant.accountId, coverageStart);
  await setLocationCreatedAt(businessId, coverageStart);
  return { tenant, accountId: tenant.accountId, businessId };
}

/** A second (or third) location under an account already seeded. */
async function addLocation(accountId: string, name = 'Sibling Location'): Promise<string> {
  const { businessId } = await seedLocation(sql(), accountId, { name, isPrimary: false });
  await setLocationCreatedAt(businessId, new Date(Date.now() - SEEDED_COVERAGE_AGE_MS));
  return businessId;
}

async function archiveLocation(businessId: string): Promise<void> {
  await sql()`UPDATE businesses SET archived_at = NOW() WHERE id = ${businessId}::uuid`;
}

async function setAccountCreatedAt(accountId: string, at: Date): Promise<void> {
  await sql()`UPDATE accounts SET created_at = ${at} WHERE id = ${accountId}::uuid`;
}

async function setLocationCreatedAt(businessId: string, at: Date): Promise<void> {
  await sql()`UPDATE businesses SET created_at = ${at} WHERE id = ${businessId}::uuid`;
}

/**
 * One `responses` row (plus the `reviews` parent it requires) so a `held_draft`
 * subject actually RESOLVES. `refusal_events.subject_id` carries no foreign key,
 * so an unresolved subject needs no seed at all — a fresh UUID is one.
 */
async function seedResponse(businessId: string): Promise<string> {
  const reviewId = randomUUID();
  const responseId = randomUUID();
  await sql()`
    INSERT INTO reviews (id, business_id, provider_review_id, provider_review_name, provider_location_name)
    VALUES (${reviewId}::uuid, ${businessId}::uuid, ${`prov-${reviewId}`}, ${`reviews/${reviewId}`}, ${`locations/${businessId}`})
  `;
  await sql()`
    INSERT INTO responses (id, review_id, business_id, response_text, original_draft_text)
    VALUES (${responseId}::uuid, ${reviewId}::uuid, ${businessId}::uuid, 'text', 'draft')
  `;
  return responseId;
}

interface SeedRefusalInput {
  accountId: string;
  /** null is the account-wide `autonomy_suspended` lane (C3). */
  businessId: string | null;
  category: RefusalCategory;
  source?: RefusalSource;
  subjectId?: string | null;
  occurredAt?: Date;
  /** Raw SQL fragment for a sub-millisecond fixture. Overrides `occurredAt`. */
  occurredAtSql?: postgresType.PendingQuery<postgresType.Row[]>;
  allRefusalCodes?: string[] | null;
}

/**
 * Insert one row, deriving every column migration 116's five CHECKs pair with
 * the lane. Passing a lane and a subject that C1 forbids raises here rather
 * than producing a row the read then reports on.
 */
async function seedRefusal(input: SeedRefusalInput): Promise<string> {
  const id = randomUUID();
  const source: RefusalSource = input.source
    ?? (input.businessId === null ? 'autonomy_suspended' : 'held_draft');

  // C1 — the lane determines the subject type, totally.
  const subjectType = source === 'autonomy_suspended'
    ? null
    : source === 'ask_withheld'
      ? 'solicitation_ask'
      : source === 'outreach_withheld'
        ? 'solicitation_outreach'
        : source === 'batch_halted'
          ? 'solicitation_batch'
          : 'response';

  // C2 — a subject is whole or absent.
  const subjectId = subjectType === null
    ? null
    : (input.subjectId ?? randomUUID());

  // C4 — only `held_draft` has no code. C5 — the array belongs to one lane and
  // the winner is a member of it.
  const allRefusalCodes = source === 'policy_gate_held'
    ? (input.allRefusalCodes ?? ['moderation_flagged', 'rating_band_excluded'])
    : null;
  const refusalCode = source === 'held_draft'
    ? null
    : (allRefusalCodes?.[0] ?? 'seeded_code');

  const occurredAt = input.occurredAtSql
    ?? sql()`${input.occurredAt ?? new Date()}`;

  await sql()`
    INSERT INTO refusal_events (
      id, account_id, business_id, refusal_source, refusal_code, all_refusal_codes,
      refusal_category, vocabulary_version, subject_type, subject_id, occurred_at
    )
    VALUES (
      ${id}::uuid,
      ${input.accountId}::uuid,
      ${input.businessId}::uuid,
      ${source},
      ${refusalCode},
      ${allRefusalCodes},
      ${input.category},
      ${REFUSAL_VOCABULARY_VERSION},
      ${subjectType},
      ${subjectId}::uuid,
      ${occurredAt}
    )
  `;
  return id;
}

describeWithDb(
  'getRefusalLog against live local Postgres',
  { enabled: Boolean(testDatabaseUrl), timeout: 120_000 },
  () => {
    beforeAll(async () => {
      const databaseUrl = assertLocalTestDatabaseUrl(testDatabaseUrl);
      featureDatabaseLock = await acquireLiveDbLock(databaseUrl);
      db = postgres(databaseUrl, {
        max: 4,
        prepare: false,
        connection: { statement_timeout: 30_000 },
      });
      await assertSchemaReady(db, [MIGRATION_116_REFUSAL_EVENTS]);
    }, LIVE_DB_LOCK_HOOK_TIMEOUT_MS);

    afterEach(async () => {
      // Newest-first, and children before parents: `refusal_events` and
      // `responses` both reference rows this suite seeded without cascade.
      for (const tenant of seededTenants.reverse()) {
        await sql()`DELETE FROM refusal_events WHERE account_id = ${tenant.accountId}::uuid`;
        await sql()`
          DELETE FROM responses WHERE business_id IN (
            SELECT id FROM businesses WHERE account_id = ${tenant.accountId}::uuid
          )
        `;
        await sql()`
          DELETE FROM reviews WHERE business_id IN (
            SELECT id FROM businesses WHERE account_id = ${tenant.accountId}::uuid
          )
        `;
        await sql()`DELETE FROM businesses WHERE account_id = ${tenant.accountId}::uuid`;
        await cleanupTenantAccount(sql(), tenant);
      }
      seededTenants.length = 0;
    }, 60_000);

    afterAll(async () => {
      try {
        if (db) await db.end({ timeout: 5 });
      } finally {
        await featureDatabaseLock?.release();
        featureDatabaseLock = undefined;
      }
    }, LIVE_DB_LOCK_HOOK_TIMEOUT_MS);

    // --- What the read projects (ADR 0023) ---

    it('renders the stored refusal_category and never re-derives it from refusal_code', async () => {
      const { accountId, businessId } = await seedAccountWithLocation();
      // The code says `no_consent`, which the vocabulary maps to `no_permission`.
      // The STORED category deliberately disagrees. A read that re-derived from
      // the code would report `no_permission` and this assertion would catch it.
      await seedRefusal({
        accountId,
        businessId,
        source: 'ask_withheld',
        category: 'wrong_moment',
      });

      const log = await getRefusalLog(sql(), { kind: 'account', accountId }, '30d');

      expect(log.entries[0]?.category).toBe('wrong_moment');
    });

    it('never selects all_refusal_codes', async () => {
      const { accountId, businessId } = await seedAccountWithLocation();
      await seedRefusal({
        accountId,
        businessId,
        source: 'policy_gate_held',
        category: 'unsafe_content',
        allRefusalCodes: ['moderation_flagged', 'daily_cap_reached'],
      });

      const log = await getRefusalLog(sql(), { kind: 'account', accountId }, '30d');

      // Both the FIELD and the VALUES. RLS filters rows, not columns, so this
      // omission is the whole access control (ADR 0023) — asserting the key is
      // absent would still pass if a value leaked under another name.
      expect(Object.keys(log.entries[0] ?? {}).sort()).toEqual(
        ['category', 'id', 'linkKind', 'occurredAt', 'subjectId', 'subjectType'],
      );
      const wire = JSON.stringify(log);
      expect(wire).not.toContain('moderation_flagged');
      expect(wire).not.toContain('daily_cap_reached');
      expect(wire).not.toContain('allRefusalCodes');
      expect(wire).not.toContain('refusalCode');
      expect(wire).not.toContain('refusalSource');
    });

    it('distinguishes a non-null unresolved subject from a lane with no subject', async () => {
      const { accountId, businessId } = await seedAccountWithLocation();
      const resolvable = await seedResponse(businessId);
      await seedRefusal({
        accountId,
        businessId,
        source: 'held_draft',
        category: 'unsafe_content',
        subjectId: resolvable,
        occurredAt: new Date(Date.now() - 3 * 60_000),
      });
      // A non-null id whose subject has aged away. `subject_id` carries no FK,
      // so a fresh UUID IS an unresolved subject.
      await seedRefusal({
        accountId,
        businessId,
        source: 'held_draft',
        category: 'unsafe_content',
        subjectId: randomUUID(),
        occurredAt: new Date(Date.now() - 2 * 60_000),
      });
      // A lane that points at nothing at all (C1/C3).
      await seedRefusal({
        accountId,
        businessId: null,
        source: 'autonomy_suspended',
        category: 'autonomy_paused',
        occurredAt: new Date(Date.now() - 60_000),
      });

      const log = await getRefusalLog(sql(), { kind: 'account', accountId }, '30d');
      const [suspension, unresolved, resolved] = log.entries;

      // The row is KEPT in every case; only the link is contingent.
      expect(log.total).toBe(3);
      expect(resolved?.subjectId).toBe(resolvable);
      expect(resolved?.linkKind).toBe('review');
      expect(unresolved?.subjectId).not.toBeNull();
      expect(unresolved?.linkKind).toBeNull();
      expect(suspension?.subjectId).toBeNull();
      expect(suspension?.subjectType).toBeNull();
      expect(suspension?.linkKind).toBe('auto-approval');
    });

    // --- Scope: account vs location (invariant #8, CONTEXT.md Restraint tab) ---

    it('scopes an account read to account_id alone', async () => {
      const { accountId, businessId } = await seedAccountWithLocation();
      const sibling = await addLocation(accountId);
      await seedRefusal({ accountId, businessId, category: 'unsafe_content' });
      await seedRefusal({ accountId, businessId: sibling, category: 'below_our_bar' });
      await seedRefusal({
        accountId,
        businessId: null,
        source: 'autonomy_suspended',
        category: 'autonomy_paused',
      });

      const log = await getRefusalLog(sql(), { kind: 'account', accountId }, '30d');

      // Every location's rows AND the account-wide row, with no business filter.
      expect(log.total).toBe(3);
    });

    it('scopes a location read to account_id and (business_id = $2 OR business_id IS NULL)', async () => {
      const { accountId, businessId } = await seedAccountWithLocation();
      const sibling = await addLocation(accountId);
      await seedRefusal({ accountId, businessId, category: 'unsafe_content' });
      await seedRefusal({ accountId, businessId: sibling, category: 'below_our_bar' });
      await seedRefusal({
        accountId,
        businessId: null,
        source: 'autonomy_suspended',
        category: 'autonomy_paused',
      });

      const log = await getRefusalLog(sql(), { kind: 'location', accountId, businessId }, '30d');

      // This location's row plus the account-wide one. Never the sibling's.
      expect(log.total).toBe(2);
      expect(log.entries.map((e) => e.category).sort()).toEqual(['autonomy_paused', 'unsafe_content']);
    });

    it("isolates one account's refusals from another account's in the same window", async () => {
      const a = await seedAccountWithLocation();
      const b = await seedAccountWithLocation();
      await seedRefusal({ accountId: a.accountId, businessId: a.businessId, category: 'unsafe_content' });
      await seedRefusal({
        accountId: b.accountId,
        businessId: b.businessId,
        source: 'ask_withheld',
        category: 'no_permission',
      });

      const log = await getRefusalLog(sql(), { kind: 'account', accountId: a.accountId }, '30d');

      expect(log.total).toBe(1);
      expect(log.entries[0]?.category).toBe('unsafe_content');
    });

    it("isolates one location's refusals from a sibling location's in the same account", async () => {
      const { accountId, businessId } = await seedAccountWithLocation();
      const sibling = await addLocation(accountId);
      await seedRefusal({ accountId, businessId, category: 'unsafe_content' });
      await seedRefusal({
        accountId,
        businessId: sibling,
        source: 'ask_withheld',
        category: 'no_permission',
      });

      const log = await getRefusalLog(sql(), { kind: 'location', accountId, businessId }, '30d');

      expect(log.total).toBe(1);
      expect(log.entries[0]?.category).toBe('unsafe_content');
    });

    // --- The account-wide suspension, which is the read's hardest case (I7) ---

    it('returns one row per location view for a single account-wide suspension', async () => {
      const { accountId, businessId } = await seedAccountWithLocation();
      const sibling = await addLocation(accountId);
      await seedRefusal({
        accountId,
        businessId: null,
        source: 'autonomy_suspended',
        category: 'autonomy_paused',
      });

      const first = await getRefusalLog(sql(), { kind: 'location', accountId, businessId }, '30d');
      const second = await getRefusalLog(
        sql(),
        { kind: 'location', accountId, businessId: sibling },
        '30d',
      );

      // ONE suspension, and it appears under EVERY location once each — which is
      // why a per-location sum may legitimately exceed the account total.
      expect(first.total).toBe(1);
      expect(second.total).toBe(1);
      expect(first.entries[0]?.id).toBe(second.entries[0]?.id);
    });

    it('returns a single account-total row for a suspension and never multiplies it across locations', async () => {
      const { accountId } = await seedAccountWithLocation();
      const second = await addLocation(accountId);
      await seedRefusal({
        accountId,
        businessId: null,
        source: 'autonomy_suspended',
        category: 'autonomy_paused',
      });

      const log = await getRefusalLog(sql(), { kind: 'account', accountId }, '30d');

      // TWO locations exist. The suspension must appear ONCE, not twice — the
      // fan-out `EXISTS` (never a JOIN through `businesses`) exists to prevent.
      expect(second).toBeDefined();
      expect(log.total).toBe(1);
    });

    // --- Ordering and the empty window ---

    it('orders newest first within each category', async () => {
      const { accountId, businessId } = await seedAccountWithLocation();
      const base = Date.now();
      await seedRefusal({
        accountId, businessId, category: 'unsafe_content',
        occurredAt: new Date(base - 3 * 60_000), subjectId: randomUUID(),
      });
      await seedRefusal({
        accountId, businessId, category: 'unsafe_content',
        occurredAt: new Date(base - 60_000), subjectId: randomUUID(),
      });
      await seedRefusal({
        accountId, businessId, category: 'unsafe_content',
        occurredAt: new Date(base - 2 * 60_000), subjectId: randomUUID(),
      });

      const log = await getRefusalLog(sql(), { kind: 'account', accountId }, '30d');
      const times = log.entries.map((e) => Date.parse(e.occurredAt));

      expect(times).toEqual([...times].sort((a, b) => b - a));
      expect(times[0]).toBe(base - 60_000);
    });

    it('returns an empty log without error when refusal_events holds no rows', async () => {
      const { accountId } = await seedAccountWithLocation();

      const log = await getRefusalLog(sql(), { kind: 'account', accountId }, '30d');

      // An empty window is a FACT, not an error and not a missing result.
      expect(log.total).toBe(0);
      expect(log.entries).toEqual([]);
      expect(log.coverageStart).not.toBeNull();
    });

    // --- Archived locations: excluded from both totals ---

    it('excludes rows belonging to an archived location from the account total', async () => {
      const { accountId, businessId } = await seedAccountWithLocation();
      const archived = await addLocation(accountId, 'Archived Location');
      await seedRefusal({ accountId, businessId, category: 'unsafe_content' });
      await seedRefusal({ accountId, businessId: archived, category: 'below_our_bar' });
      await seedRefusal({
        accountId,
        businessId: null,
        source: 'autonomy_suspended',
        category: 'autonomy_paused',
      });
      await archiveLocation(archived);

      const log = await getRefusalLog(sql(), { kind: 'account', accountId }, '30d');

      // The archived location's row is gone; the ACCOUNT-WIDE row stays, because
      // it belongs to no location and the archive says nothing about it.
      expect(log.total).toBe(2);
      expect(log.entries.map((e) => e.category).sort()).toEqual(['autonomy_paused', 'unsafe_content']);
    });

    it('excludes rows belonging to an archived location from a location total', async () => {
      const { accountId, businessId } = await seedAccountWithLocation();
      const archived = await addLocation(accountId, 'Archived Location');
      await seedRefusal({ accountId, businessId, category: 'unsafe_content' });
      await seedRefusal({ accountId, businessId: archived, category: 'below_our_bar' });
      await archiveLocation(archived);

      const log = await getRefusalLog(sql(), { kind: 'location', accountId, businessId }, '30d');

      expect(log.total).toBe(1);
      expect(log.entries[0]?.category).toBe('unsafe_content');
    });

    it('returns no rows for a location that is archived', async () => {
      const { accountId, businessId } = await seedAccountWithLocation();
      await seedRefusal({ accountId, businessId, category: 'unsafe_content' });
      await seedRefusal({
        accountId,
        businessId: null,
        source: 'autonomy_suspended',
        category: 'autonomy_paused',
      });
      await archiveLocation(businessId);

      const log = await getRefusalLog(sql(), { kind: 'location', accountId, businessId }, '30d');

      // I9 is enforced by the READ, not only by its one route caller. The
      // account-wide row is withheld too: there is no location view to show it in.
      expect(log.total).toBe(0);
      expect(log.entries).toEqual([]);
    });

    // --- The footnote: an ACCOUNT-scope line, and only there (#1005) ---

    it('counts archived-location refusals in the account footnote for the same window', async () => {
      const { accountId, businessId } = await seedAccountWithLocation();
      const archived = await addLocation(accountId, 'Archived Location');
      await seedRefusal({ accountId, businessId, category: 'unsafe_content' });
      await seedRefusal({
        accountId, businessId: archived, source: 'ask_withheld', category: 'no_permission',
      });
      await seedRefusal({
        accountId, businessId: archived, source: 'batch_halted', category: 'wrong_moment',
      });
      await archiveLocation(archived);

      const log = await getRefusalLog(sql(), { kind: 'account', accountId }, '30d');

      // The two archived rows leave the TOTAL and reappear as a count. ONE
      // location held them, so `locationCount` is 1 and not 2.
      expect(log.total).toBe(1);
      expect(log.archivedLocations).toEqual({ refusalCount: 2, locationCount: 1 });
    });

    it('reports a zero archived-location footnote count when no archived location has refusals in the window', async () => {
      const { accountId, businessId } = await seedAccountWithLocation();
      const archived = await addLocation(accountId, 'Archived Location');
      await seedRefusal({ accountId, businessId, category: 'unsafe_content' });
      await archiveLocation(archived);

      const log = await getRefusalLog(sql(), { kind: 'account', accountId }, '30d');

      // An archived location that held nobody is a ZERO, not a null and not an
      // absent key — the tab decides whether to render the line, and it decides
      // from a number it was given.
      expect(log.archivedLocations).toEqual({ refusalCount: 0, locationCount: 0 });
    });

    it('reports no footnote at all in a location scope', async () => {
      const { accountId, businessId } = await seedAccountWithLocation();
      const archived = await addLocation(accountId, 'Archived Location');
      await seedRefusal({ accountId, businessId: archived, category: 'unsafe_content' });
      await archiveLocation(archived);

      const log = await getRefusalLog(sql(), { kind: 'location', accountId, businessId }, '30d');

      // A location view shows ONE ACTIVE location and therefore hides nothing.
      expect(log.archivedLocations).toBeNull();
    });

    // --- Archived periods (T4 fills these) ---

    it.todo('returns archived periods that intersect the window and omits periods that do not');
    it.todo('reads archived periods from account_audit_log and never re-derives a refusal from it');

    // --- Coverage start and the window bounds (E13, I15) ---

    it('clamps the account coverage start to accounts.created_at', async () => {
      const { accountId } = await seedAccountWithLocation();
      const createdAt = new Date('2026-05-04T09:08:07.000Z');
      await setAccountCreatedAt(accountId, createdAt);

      const log = await getRefusalLog(sql(), { kind: 'account', accountId }, '30d');

      expect(log.coverageStart).toBe(createdAt.toISOString());
    });

    it('clamps a location coverage start to businesses.created_at', async () => {
      const { accountId, businessId } = await seedAccountWithLocation();
      const accountCreatedAt = new Date('2026-05-04T09:08:07.000Z');
      const locationCreatedAt = new Date('2026-06-11T10:11:12.000Z');
      await setAccountCreatedAt(accountId, accountCreatedAt);
      await setLocationCreatedAt(businessId, locationCreatedAt);

      const log = await getRefusalLog(sql(), { kind: 'location', accountId, businessId }, '30d');

      // The LOCATION's start, not the account's — a location added later was not
      // being watched before it existed.
      expect(log.coverageStart).toBe(locationCreatedAt.toISOString());
    });

    it('returns windowStart clamped to accounts.created_at when the account was created inside the selected window', async () => {
      const { accountId } = await seedAccountWithLocation();
      const createdAt = new Date(Date.now() - 2 * 24 * 60 * 60 * 1000);
      await setAccountCreatedAt(accountId, createdAt);

      const log = await getRefusalLog(sql(), { kind: 'account', accountId }, '30d');

      // A two-day-old account selecting 30d must not be told we found nothing
      // across 28 days we were not recording. The clamp is what makes the empty
      // sentence TRUE (E13).
      expect(log.windowStart).toBe(createdAt.toISOString());
      expect(Date.parse(log.windowStart)).toBeGreaterThan(
        Date.parse(log.windowEnd) - 30 * 24 * 60 * 60 * 1000,
      );
    });

    it('excludes Refusals after windowEnd from entries and the archived-location footnote', async () => {
      const { accountId, businessId } = await seedAccountWithLocation();
      // `occurred_at` is WRITER-supplied, not a database clock, so a row dated
      // after the range the tab prints is representable and must be excluded.
      //
      // Both fixtures carry `+ interval '419 microseconds'`: a JS `Date` binds
      // with zero microseconds, so a bound tested only against JS-round-tripped
      // values is tested at a precision the fixture cannot express (CLAUDE.md,
      // the #520 note). These rows have real sub-millisecond parts.
      await seedRefusal({
        accountId,
        businessId,
        category: 'unsafe_content',
        occurredAtSql: sql()`NOW() - interval '1 hour' + interval '419 microseconds'`,
      });
      await seedRefusal({
        accountId,
        businessId,
        category: 'below_our_bar',
        subjectId: randomUUID(),
        occurredAtSql: sql()`NOW() + interval '1 hour' + interval '419 microseconds'`,
      });
      // The same two-sided fixture on an ARCHIVED location, so the footnote's
      // own upper bound is exercised rather than assumed.
      const archived = await addLocation(accountId, 'Archived Location');
      await seedRefusal({
        accountId,
        businessId: archived,
        category: 'unsafe_content',
        occurredAtSql: sql()`NOW() - interval '1 hour' + interval '419 microseconds'`,
      });
      await seedRefusal({
        accountId,
        businessId: archived,
        category: 'below_our_bar',
        subjectId: randomUUID(),
        occurredAtSql: sql()`NOW() + interval '1 hour' + interval '419 microseconds'`,
      });
      await archiveLocation(archived);

      const log = await getRefusalLog(sql(), { kind: 'account', accountId }, '30d');

      // The past row survives its microseconds; the future row is excluded (E17).
      expect(log.total).toBe(1);
      expect(log.entries[0]?.category).toBe('unsafe_content');
      // The FOOTNOTE half of this title. The archived location holds one row
      // inside the window and one after it; only the first may be counted, or
      // the tab states a number for a wider range than the one it prints.
      expect(log.archivedLocations).toEqual({ refusalCount: 1, locationCount: 1 });
    });
  },
);
