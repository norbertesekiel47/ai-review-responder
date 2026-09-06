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
import { ARCHIVAL_EVENT_LIMIT, ENTRY_LIMIT, getRefusalLog } from '../read';

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
async function seedResponse(businessId: string): Promise<{ responseId: string; reviewId: string }> {
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
  return { responseId, reviewId };
}

/**
 * One `account_audit_log` row. `event_type` is deliberately UNTYPED here: two
 * cases seed non-archival types on purpose, to prove the read filters rather
 * than assumes.
 */
async function seedArchivalEvent(
  accountId: string,
  businessId: string,
  eventType: string,
  createdAt: Date,
): Promise<void> {
  await sql()`
    INSERT INTO account_audit_log (id, account_id, location_id, event_type, created_at)
    VALUES (${randomUUID()}::uuid, ${accountId}::uuid, ${businessId}::uuid, ${eventType}, ${createdAt})
  `;
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
        await sql()`DELETE FROM account_audit_log WHERE account_id = ${tenant.accountId}::uuid`;
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
        ['category', 'id', 'linkKind', 'occurredAt', 'reviewId', 'subjectId', 'subjectType'],
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
        subjectId: resolvable.responseId,
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
      // The third of the exactly three links the ticket names. Three fixtures
      // already EXECUTED this arm and none asserted it, so returning null from
      // it survived the whole suite (red team F17).
      await seedRefusal({
        accountId,
        businessId,
        source: 'ask_withheld',
        category: 'no_permission',
        occurredAt: new Date(Date.now() - 4 * 60_000),
      });

      const log = await getRefusalLog(sql(), { kind: 'account', accountId }, '30d');
      const [suspension, unresolved, resolved, noPermission] = log.entries;

      // The row is KEPT in every case; only the link is contingent.
      expect(log.total).toBe(4);
      expect(noPermission?.linkKind).toBe('contacts');
      expect(resolved?.subjectId).toBe(resolvable.responseId);
      // The REVIEW id, resolved server-side — not the subject id. The only
      // review route takes a review id, so projecting the response id would
      // build a link to a page that cannot exist.
      expect(resolved?.reviewId).toBe(resolvable.reviewId);
      expect(resolved?.linkKind).toBe('review');
      expect(unresolved?.reviewId).toBeNull();
      expect(unresolved?.subjectId).not.toBeNull();
      expect(unresolved?.linkKind).toBeNull();
      expect(suspension?.subjectId).toBeNull();
      expect(suspension?.subjectType).toBeNull();
      expect(suspension?.linkKind).toBe('auto-approval');
    });

    // --- Scope: account vs location (invariant #8, docs/context/refusal-ledger.md Restraint tab) ---

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

    // --- The four properties the comments call load-bearing and no test
    // --- asserted. Each of these was a surviving mutation in red-team round 1.

    it('keys the review link on the LANE, so a policy_gate_held response with held_draft\'s category gets none', async () => {
      const { accountId, businessId } = await seedAccountWithLocation();
      const held = await seedResponse(businessId);
      const gated = await seedResponse(businessId);
      await seedRefusal({
        accountId, businessId, source: 'held_draft', category: 'unsafe_content',
        subjectId: held.responseId, occurredAt: new Date(Date.now() - 2 * 60_000),
      });
      // SAME category, SAME subject type, and a subject that RESOLVES — the only
      // difference is the lane. Re-keying `resolveLinkKind` on the category was a
      // mutation that survived the entire suite, because no fixture had a
      // resolvable subject on the other unsafe_content lane.
      await seedRefusal({
        accountId, businessId, source: 'policy_gate_held', category: 'unsafe_content',
        subjectId: gated.responseId, occurredAt: new Date(Date.now() - 60_000),
      });

      const log = await getRefusalLog(sql(), { kind: 'account', accountId }, '30d');
      const [gatedRow, heldRow] = log.entries;

      expect(heldRow?.linkKind).toBe('review');
      expect(heldRow?.reviewId).toBe(held.reviewId);
      expect(gatedRow?.linkKind).toBeNull();
      // The row is KEPT and its review is RESOLVABLE — it simply may not link.
      expect(gatedRow?.reviewId).toBe(gated.reviewId);
    });

    it('bounds the LOCATION arm at windowEnd, not only the account arm', async () => {
      const { accountId, businessId } = await seedAccountWithLocation();
      await seedRefusal({
        accountId, businessId, category: 'unsafe_content',
        occurredAtSql: sql()`NOW() - interval '1 hour' + interval '419 microseconds'`,
      });
      await seedRefusal({
        accountId, businessId, category: 'below_our_bar', subjectId: randomUUID(),
        occurredAtSql: sql()`NOW() + interval '1 hour' + interval '419 microseconds'`,
      });

      const log = await getRefusalLog(sql(), { kind: 'location', accountId, businessId }, '30d');

      // The length assertion is load-bearing in the same way as in the
      // windowStart case below. `entries[0]` catches a FUTURE row only because
      // it sorts FIRST; that is sort-order luck, not a bound.
      expect(log.entries).toHaveLength(1);
      expect(log.total).toBe(1);
      expect(log.entries[0]?.category).toBe('unsafe_content');
    });

    it('bounds the ACCOUNT arm at windowStart, so a row older than the window is excluded', async () => {
      const { accountId, businessId } = await seedAccountWithLocation();
      const day = 24 * 60 * 60 * 1000;
      await seedRefusal({
        accountId, businessId, category: 'unsafe_content',
        occurredAt: new Date(Date.now() - 2 * day),
      });
      // 45 days back, OUTSIDE a 30d window but INSIDE the 200-day coverage the
      // helper seeds — so only the lower bound can exclude it. Every other
      // fixture in this suite is minutes old, which is why deleting this bound
      // was invisible.
      await seedRefusal({
        accountId, businessId, category: 'below_our_bar', subjectId: randomUUID(),
        occurredAt: new Date(Date.now() - 45 * day),
      });

      const thirty = await getRefusalLog(sql(), { kind: 'account', accountId }, '30d');
      // `total` alone does NOT assert this arm. It comes from the SEPARATE
      // COUNT statement, which keeps its own lower bound — deleting the ENTRY
      // arm's `>= windowStart` left every assertion here green (red team F3).
      // `entries[0]` cannot catch it either: the out-of-window row is the
      // OLDEST, so `ORDER BY occurred_at DESC` puts it LAST. The length is what
      // pins the entry arm.
      expect(thirty.entries).toHaveLength(1);
      expect(thirty.total).toBe(1);
      expect(thirty.entries[0]?.category).toBe('unsafe_content');

      // Non-vacuous: a 90d window reaches it, so the row exists and the 30d
      // result is a BOUND rather than a missing seed.
      const ninety = await getRefusalLog(sql(), { kind: 'account', accountId }, '90d');
      expect(ninety.total).toBe(2);
    });

    it('bounds the LOCATION arm at windowStart, on the entry list and on the total alike', async () => {
      const { accountId, businessId } = await seedAccountWithLocation();
      const day = 24 * 60 * 60 * 1000;
      await seedRefusal({
        accountId, businessId, category: 'unsafe_content',
        occurredAt: new Date(Date.now() - 2 * day),
      });
      // 45 days back: outside a 30d window, inside the 200-day coverage the
      // helper seeds. The account arm had this case; the LOCATION arm did not,
      // so deleting either of its two lower bounds was invisible (red team
      // F14 on the entry arm, F15 on the COUNT).
      await seedRefusal({
        accountId, businessId, category: 'below_our_bar', subjectId: randomUUID(),
        occurredAt: new Date(Date.now() - 45 * day),
      });

      const thirty = await getRefusalLog(
        sql(), { kind: 'location', accountId, businessId }, '30d',
      );
      // Both statements, separately. `entries` pins the entry arm and `total`
      // pins the COUNT; one without the other leaves an arm unasserted.
      expect(thirty.entries).toHaveLength(1);
      expect(thirty.total).toBe(1);
      expect(thirty.entries[0]?.category).toBe('unsafe_content');

      // Non-vacuous: a 90d window reaches it, so the row exists and the 30d
      // result is a BOUND rather than a missing seed.
      const ninety = await getRefusalLog(
        sql(), { kind: 'location', accountId, businessId }, '90d',
      );
      expect(ninety.entries).toHaveLength(2);
      expect(ninety.total).toBe(2);
    });

    it('resolves a review only when the response belongs to the same location', async () => {
      const { accountId, businessId } = await seedAccountWithLocation();
      const sibling = await addLocation(accountId);
      // The response lives under the SIBLING; the Refusal is filed against this
      // location. `resp.business_id = r.business_id` is what must reject it, and
      // deleting that correlation was a surviving mutation.
      const foreign = await seedResponse(sibling);
      await seedRefusal({
        accountId, businessId, source: 'held_draft', category: 'unsafe_content',
        subjectId: foreign.responseId,
      });

      const log = await getRefusalLog(sql(), { kind: 'location', accountId, businessId }, '30d');

      expect(log.total).toBe(1);
      expect(log.entries[0]?.reviewId).toBeNull();
      expect(log.entries[0]?.linkKind).toBeNull();
    });

    it('caps entries at ENTRY_LIMIT while total stays the true window count', async () => {
      const { accountId, businessId } = await seedAccountWithLocation();
      const extra = 3;
      for (let i = 0; i < ENTRY_LIMIT + extra; i += 1) {
        await seedRefusal({
          accountId, businessId, category: 'unsafe_content', subjectId: randomUUID(),
          occurredAt: new Date(Date.now() - i * 1000),
        });
      }

      const log = await getRefusalLog(sql(), { kind: 'account', accountId }, '30d');

      // The LIST is capped; the COUNT is not. Deriving total from entries.length
      // would under-report exactly when the window has most to report.
      expect(log.entries).toHaveLength(ENTRY_LIMIT);
      expect(log.total).toBe(ENTRY_LIMIT + extra);
      expect(log.truncated).toBe(true);
      // Newest-first survives the cap, so the rows dropped are the oldest.
      const times = log.entries.map((e) => Date.parse(e.occurredAt));
      expect(times).toEqual([...times].sort((a, b) => b - a));

      // The SAME data read in a LOCATION scope. The two scope arms are spelled
      // out separately (`ci:tenant-scope` reads query blocks), so each carries
      // its own `LIMIT` and an account-only assertion leaves the location arm
      // unpinned — the arm where the volume actually lands, because
      // `ask_withheld` rows carry a `business_id` (red team F13).
      const perLocation = await getRefusalLog(
        sql(), { kind: 'location', accountId, businessId }, '30d',
      );
      expect(perLocation.entries).toHaveLength(ENTRY_LIMIT);
      expect(perLocation.total).toBe(ENTRY_LIMIT + extra);
      expect(perLocation.truncated).toBe(true);
    }, 60_000);

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
      // Outside the window. The footnote states a count for THE SAME window the
      // tab prints, so this row must not reach it — its lower bound was
      // asserted by nothing (red team F16), the upper bound being the only one
      // any fixture exercised.
      await seedRefusal({
        accountId, businessId: archived, source: 'ask_withheld', category: 'no_permission',
        occurredAt: new Date(Date.now() - 45 * 24 * 60 * 60 * 1000),
      });
      await archiveLocation(archived);

      const log = await getRefusalLog(sql(), { kind: 'account', accountId }, '30d');

      // The two archived rows leave the TOTAL and reappear as a count. ONE
      // location held them, so `locationCount` is 1 and not 2.
      expect(log.total).toBe(1);
      expect(log.archivedLocations).toEqual({ refusalCount: 2, locationCount: 1 });

      // Non-vacuous: a 90d window reaches the third row, so the 30d count is a
      // BOUND rather than a missing seed.
      const ninety = await getRefusalLog(sql(), { kind: 'account', accountId }, '90d');
      expect(ninety.archivedLocations).toEqual({ refusalCount: 3, locationCount: 1 });
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

    // --- Archived periods, read from the audit log and never re-derived ---

    it('returns archived periods that intersect the window and omits periods that do not', async () => {
      const { accountId, businessId } = await seedAccountWithLocation();
      const day = 24 * 60 * 60 * 1000;
      // Closed WELL before a 30d window opens — omitted.
      await seedArchivalEvent(accountId, businessId, 'location_archived', new Date(Date.now() - 120 * day));
      await seedArchivalEvent(accountId, businessId, 'location_reactivated', new Date(Date.now() - 100 * day));
      // Opens and closes INSIDE the window — rendered.
      await seedArchivalEvent(accountId, businessId, 'location_archived', new Date(Date.now() - 10 * day));
      await seedArchivalEvent(accountId, businessId, 'location_reactivated', new Date(Date.now() - 5 * day));

      const log = await getRefusalLog(sql(), { kind: 'location', accountId, businessId }, '30d');

      expect(log.archivedPeriods).toHaveLength(1);
      expect(Date.parse(log.archivedPeriods[0]?.archivedAt ?? '')).toBeGreaterThan(
        Date.now() - 11 * day,
      );
      expect(log.archivedPeriods[0]?.reactivatedAt).not.toBeNull();
      // An ACCOUNT view has no archived-period line at all — the line names one
      // location's gaps, and an account view is not showing one location.
      const account = await getRefusalLog(sql(), { kind: 'account', accountId }, '30d');
      expect(account.archivedPeriods).toEqual([]);
    });

    it('bounds the archival-event read and keeps the NEWEST events, not the oldest', async () => {
      const { accountId, businessId } = await seedAccountWithLocation();
      // A BOUND PROBE, not realistic history. Repeated archives cannot occur in
      // production (archive refuses an archived location), but the pairing
      // handles them — `openedAt ??=` keeps the FIRST — which is exactly what
      // makes the dropped row observable: the surviving earliest event is what
      // dates the open period.
      //
      // `account_audit_log` is never swept, so this read was the one unbounded
      // query in the module (red team F24). An ASCENDING `LIMIT` would be the
      // wrong fix — it keeps the oldest events and drops the ones nearest the
      // window — so this pins the DIRECTION as much as the cap.
      await sql()`
        INSERT INTO account_audit_log (id, account_id, location_id, event_type, created_at)
        SELECT gen_random_uuid(), ${accountId}::uuid, ${businessId}::uuid, 'location_archived',
               NOW() - interval '150 days' + make_interval(hours => i)
        FROM generate_series(0, ${ARCHIVAL_EVENT_LIMIT}) AS i
      `;

      const log = await getRefusalLog(sql(), { kind: 'location', accountId, businessId }, '30d');

      // One OPEN period: nothing ever reactivated.
      expect(log.archivedPeriods).toHaveLength(1);
      expect(log.archivedPeriods[0]?.reactivatedAt).toBeNull();
      expect(log.archivedPeriodsTruncated).toBe(true);

      // ARCHIVAL_EVENT_LIMIT + 1 rows were seeded one hour apart, so the cap
      // drops exactly the oldest. Unbounded, the period would date from the
      // very first event; bounded, it dates from the second.
      const oldest = Date.now() - 150 * 24 * 60 * 60 * 1000;
      const started = Date.parse(log.archivedPeriods[0]?.archivedAt ?? '');
      expect(started - oldest).toBeGreaterThan(30 * 60 * 1000);
      expect(started - oldest).toBeLessThan(90 * 60 * 1000);
    });

    it.each([0, ARCHIVAL_EVENT_LIMIT, ARCHIVAL_EVENT_LIMIT + 1])('discloses archival truncation only when more than the event limit exists (%i)', async (eventCount) => {
      const { accountId, businessId } = await seedAccountWithLocation();
      await sql()`
        INSERT INTO account_audit_log (id, account_id, location_id, event_type, created_at)
        SELECT gen_random_uuid(), ${accountId}::uuid, ${businessId}::uuid,
               CASE WHEN i % 2 = 0 THEN 'location_archived' ELSE 'location_reactivated' END,
               NOW() - interval '20 days' + make_interval(hours => i)
        FROM generate_series(0, ${eventCount - 1}) AS i
      `;
      const log = await getRefusalLog(sql(), { kind: 'location', accountId, businessId }, '30d');
      expect(log.archivedPeriodsTruncated).toBe(eventCount > ARCHIVAL_EVENT_LIMIT);
      expect(log.total).toBe(0);
      expect(log.truncated).toBe(false);
      const account = await getRefusalLog(sql(), { kind: 'account', accountId }, '30d');
      expect(account.archivedPeriodsTruncated).toBe(false);
    });

    it('qualifies archived periods when an older in-window period was omitted', async () => {
      const { accountId, businessId } = await seedAccountWithLocation();
      const oldest = new Date(Date.now() - 20 * 24 * 60 * 60 * 1000);
      await sql()`
        INSERT INTO account_audit_log (id, account_id, location_id, event_type, created_at)
        SELECT gen_random_uuid(), ${accountId}::uuid, ${businessId}::uuid,
               CASE WHEN i % 2 = 0 THEN 'location_archived' ELSE 'location_reactivated' END,
               ${oldest}::timestamptz + make_interval(hours => i)
        FROM generate_series(0, ${ARCHIVAL_EVENT_LIMIT + 1}) AS i
      `;
      const log = await getRefusalLog(sql(), { kind: 'location', accountId, businessId }, '30d');
      expect(log.archivedPeriodsTruncated).toBe(true);
      expect(log.archivedPeriods).toHaveLength(ARCHIVAL_EVENT_LIMIT / 2);
      expect(log.archivedPeriods[0]?.archivedAt).toBe(new Date(oldest.getTime() + 2 * 60 * 60 * 1000).toISOString());
      expect(log.archivedPeriods.at(-1)).toEqual({
        archivedAt: new Date(oldest.getTime() + ARCHIVAL_EVENT_LIMIT * 60 * 60 * 1000).toISOString(),
        reactivatedAt: new Date(oldest.getTime() + (ARCHIVAL_EVENT_LIMIT + 1) * 60 * 60 * 1000).toISOString(),
      });
      expect(log.total).toBe(0);
    });

    it('reads archived periods from account_audit_log and never re-derives a refusal from it', async () => {
      const { accountId, businessId } = await seedAccountWithLocation();
      const day = 24 * 60 * 60 * 1000;
      await seedArchivalEvent(accountId, businessId, 'location_archived', new Date(Date.now() - 8 * day));
      await seedArchivalEvent(accountId, businessId, 'location_reactivated', new Date(Date.now() - 4 * day));
      // Audit rows that are NOT archival at all. A read that treated the log as
      // a Refusal source would count these; this one must not see them.
      await seedArchivalEvent(accountId, businessId, 'subscription_cancelled', new Date(Date.now() - 6 * day));
      await seedArchivalEvent(accountId, businessId, 'location_added', new Date(Date.now() - 7 * day));

      const log = await getRefusalLog(sql(), { kind: 'location', accountId, businessId }, '30d');

      // ONE period, and ZERO Refusals: the audit log is CONTEXT (when were we
      // not watching), never a lane. `refusal_events` holds no row here.
      expect(log.archivedPeriods).toHaveLength(1);
      expect(log.total).toBe(0);
      expect(log.entries).toEqual([]);
    });

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
