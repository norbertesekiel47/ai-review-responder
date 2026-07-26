// Live-DB suite for the #546 rival picker read/write pair.
//
// These belong on a real Postgres because the whole point of
// `setNamedRivalPick` is a single `UPDATE … FROM` whose membership predicates
// (latest snapshot date, is_self, blank-title) are evaluated by the database,
// not by TypeScript. A mocked `sql` would assert the string we wrote, never
// the behaviour it produces.
//
// Gated on TEST_DATABASE_POOL_URL; skips cleanly (and loudly) without one.

import { afterAll, beforeAll, beforeEach, expect, it } from 'vitest';
import postgres from 'postgres';
import type postgresType from 'postgres';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { v7 as uuidv7 } from 'uuid';
import { cleanupTenantAccount, seedTenantAccount } from '@/lib/shared/__tests__/live-db-tenant';
import { describeWithDb } from '@/__tests__/helpers/describe-with-db';
import { asLocationId } from '@/lib/shared/ids';
import type { LocationId } from '@/lib/shared/ids';
import {
  RivalPickNotFoundError,
  RivalPickStaleError,
  loadRivalPickerView,
  resolveNamedRival,
  setNamedRivalPick,
  type RivalPickerView,
} from '../named-rival';

const testDatabaseUrl = process.env.TEST_DATABASE_POOL_URL;

const KEYWORD = 'coffee shop';
const SEARCH_LOCATION = 'Austin, Texas, United States';
const EARLIER_DATE = '2026-07-10';
const LATER_DATE = '2026-07-17';

const SELF = 'ChIJ-self-location';
const ALPHA = 'ChIJ-alpha-coffee';
const BRAVO = 'ChIJ-bravo-beans';
const DELTA = 'ChIJ-delta-drip';
const ZULU = 'ChIJ-zulu-roast';
const BLANK_TITLE = 'ChIJ-blank-title';

interface PackEntry {
  placeId: string | null;
  title: string;
  rankPosition: number | null;
  reviewCount: number | null;
  rating: number | null;
  isSelf?: boolean;
}

// One pack shaped to exercise every exclusion and both ordering keys at once:
// the is_self row, a NULL place_id row, an empty-string place_id row and a
// whitespace-only title row must all stay out of `options`, while the two
// NULL-rank rivals must fall to the end ordered by place_id (delta < zulu).
const FULL_PACK: PackEntry[] = [
  { placeId: SELF, title: 'Our Cafe', rankPosition: 2, reviewCount: 100, rating: 4.5, isSelf: true },
  { placeId: ALPHA, title: 'Alpha Coffee', rankPosition: 1, reviewCount: 300, rating: 4.6 },
  { placeId: null, title: 'Ghost Roasters', rankPosition: 3, reviewCount: 500, rating: 4.1 },
  { placeId: BRAVO, title: 'Bravo Beans', rankPosition: 4, reviewCount: 150, rating: 4.4 },
  { placeId: '', title: 'Blank Id Cafe', rankPosition: 5, reviewCount: 400, rating: 4.0 },
  { placeId: BLANK_TITLE, title: '   ', rankPosition: 6, reviewCount: 600, rating: 4.8 },
  { placeId: ZULU, title: 'Zulu Roast', rankPosition: null, reviewCount: 120, rating: 4.2 },
  { placeId: DELTA, title: 'Delta Drip', rankPosition: null, reviewCount: 90, rating: 4.9 },
];

function packWithout(excluded: string): PackEntry[] {
  return FULL_PACK.filter((entry) => entry.placeId !== excluded);
}

let db: postgresType.Sql | undefined;
let workerDb: postgresType.Sql | undefined;

const tenant = {
  userId: randomUUID(),
  accountId: randomUUID(),
};
const ownerEmail = `rival-picker-${tenant.accountId}@test.local`;

const outsider = {
  userId: randomUUID(),
  accountId: randomUUID(),
};
const outsiderEmail = `rival-outsider-${outsider.accountId}@test.local`;

const location = asLocationId(randomUUID());
const notConfiguredLocation = asLocationId(randomUUID());
const awaitingPackLocation = asLocationId(randomUUID());
const allLocations = [location, notConfiguredLocation, awaitingPackLocation];

function sql(): postgresType.Sql {
  if (!db) throw new Error('rival-picker integration database was not initialized');
  return db;
}

/** A genuinely separate connection standing in for RankingTrackingWorker. */
function worker(): postgresType.Sql {
  if (!workerDb) throw new Error('rival-picker worker database was not initialized');
  return workerDb;
}

// Advisory-lock key serializing the DDL apply below across parallel vitest
// files — 089 re-adds an analytics_events CHECK under ACCESS EXCLUSIVE, and
// racing that against a sibling DB suite deadlocks (same reasoning as the
// shared 074 helper).
const MIGRATION_APPLY_LOCK_KEY = 'repworth_migration_546_rival_pick_apply';

function readMigration(file: string): string {
  return readFileSync(resolve(process.cwd(), 'supabase/migrations', file), 'utf-8');
}

/**
 * Applies the two migrations this suite depends on when they are missing.
 *
 * 089 adds the three `businesses` pick columns and extends the
 * analytics_events CHECK; 085 widens `competitor_snapshots.rating` to
 * NUMERIC(2,1), which is what makes Postgres.js hand the column back as a
 * string for `parseCompetitorRating` to parse. Both are probed first: an
 * unconditional re-apply takes locks that contend with parallel suites.
 */
async function applyRivalPickMigrationsIfMissing(target: postgresType.Sql): Promise<void> {
  await target`SELECT pg_advisory_lock(hashtext(${MIGRATION_APPLY_LOCK_KEY}))`;
  try {
    const [ratingColumn] = await target<{ data_type: string }[]>`
      SELECT data_type FROM information_schema.columns
      WHERE table_schema = 'public'
        AND table_name = 'competitor_snapshots'
        AND column_name = 'rating'
    `;
    if (ratingColumn && ratingColumn.data_type !== 'numeric') {
      await target.unsafe(readMigration('085_competitor_rating_numeric.sql'));
    }

    const [pickColumn] = await target<{ applied: boolean }[]>`
      SELECT EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_schema = 'public'
          AND table_name = 'businesses'
          AND column_name = 'rival_picked_at'
      ) AS applied
    `;
    if (!pickColumn?.applied) {
      await target.unsafe(readMigration('089_competitor_rival_pick.sql'));
    }
  } finally {
    await target`SELECT pg_advisory_unlock(hashtext(${MIGRATION_APPLY_LOCK_KEY}))`;
  }
}

async function insertLocation(
  id: LocationId,
  accountId: string,
  email: string,
  options: { keywords: string[]; searchLocation: string | null },
): Promise<void> {
  await sql()`
    INSERT INTO businesses (
      id, name, owner_name, owner_email, account_id, subscription_status,
      tracked_keywords, ranking_search_location
    ) VALUES (
      ${id}::uuid, 'Rival Picker Location', 'Rival Picker Owner', ${email},
      ${accountId}::uuid, 'active',
      ${sql().json(options.keywords)}, ${options.searchLocation}
    )
  `;
}

/** Mirrors 084 replace-pack: delete then reinsert the whole pack for a date. */
async function replacePack(
  target: postgresType.Sql,
  businessId: LocationId,
  snapshotDate: string,
  entries: PackEntry[],
): Promise<void> {
  await target.begin(async (tx) => {
    await tx`
      INSERT INTO ranking_snapshots (id, business_id, keyword, rank_position, search_location, snapshot_date, source)
      VALUES (${uuidv7()}::uuid, ${businessId}::uuid, ${KEYWORD}, 2, ${SEARCH_LOCATION}, ${snapshotDate}::date, 'serpapi')
      ON CONFLICT (business_id, keyword, snapshot_date)
      DO UPDATE SET search_location = EXCLUDED.search_location
    `;
    await tx`
      DELETE FROM competitor_snapshots
      WHERE business_id = ${businessId}::uuid
        AND keyword = ${KEYWORD}
        AND snapshot_date = ${snapshotDate}::date
    `;
    for (const entry of entries) {
      await tx`
        INSERT INTO competitor_snapshots (
          id, business_id, keyword, search_location, snapshot_date,
          rank_position, place_id, title, rating, review_count, is_self
        ) VALUES (
          ${uuidv7()}::uuid, ${businessId}::uuid, ${KEYWORD}, ${SEARCH_LOCATION}, ${snapshotDate}::date,
          ${entry.rankPosition}, ${entry.placeId}, ${entry.title},
          ${entry.rating}, ${entry.reviewCount}, ${entry.isSelf ?? false}
        )
      `;
    }
  });
}

async function readPickColumns(): Promise<{
  rival_place_id: string | null;
  rival_title_snapshot: string | null;
  rival_picked_at: Date | null;
}> {
  const [row] = await sql()<{
    rival_place_id: string | null;
    rival_title_snapshot: string | null;
    rival_picked_at: Date | null;
  }[]>`
    SELECT rival_place_id, rival_title_snapshot, rival_picked_at
    FROM businesses WHERE id = ${location}::uuid
  `;
  if (!row) throw new Error('pick columns row missing');
  return row;
}

interface AnalyticsRow {
  event_key: string;
  event_name: string;
  distinct_id: string;
  account_id: string | null;
  user_id: string | null;
  business_id: string | null;
  properties: Record<string, unknown> | string;
}

async function readAnalyticsEvents(): Promise<AnalyticsRow[]> {
  const rows = await sql()<AnalyticsRow[]>`
    SELECT event_key, event_name, distinct_id, account_id, user_id, business_id, properties
    FROM analytics_events
    WHERE account_id = ${tenant.accountId}::uuid
    ORDER BY event_key ASC
  `;
  return rows;
}

// PgBouncer can hand JSONB back as a string (CLAUDE.md carve-out). This is a
// TEST read of a column the production allowlist already covers elsewhere.
function properties(row: AnalyticsRow): Record<string, unknown> {
  return typeof row.properties === 'string'
    ? (JSON.parse(row.properties) as Record<string, unknown>)
    : row.properties;
}

function optionPlaceIds(view: RivalPickerView): string[] {
  if (view.state !== 'ready') throw new Error(`expected a ready view, got ${view.state}`);
  return view.options.map((option) => option.placeId);
}

function ownerView(): Promise<RivalPickerView> {
  return loadRivalPickerView(sql(), { accountId: tenant.accountId, businessId: location });
}

function pick(placeId: string | null): Promise<RivalPickerView> {
  return setNamedRivalPick(sql(), {
    accountId: tenant.accountId,
    businessId: location,
    placeId,
    userId: tenant.userId,
  });
}

describeWithDb('rival picker — live picker view + atomic pick write', { timeout: 30_000 }, () => {
  beforeAll(async () => {
    db = postgres(testDatabaseUrl!, { max: 1, prepare: false });
    workerDb = postgres(testDatabaseUrl!, { max: 1, prepare: false });
    await applyRivalPickMigrationsIfMissing(sql());

    await seedTenantAccount(sql(), {
      userId: tenant.userId,
      accountId: tenant.accountId,
      ownerEmail,
      userName: 'Rival Picker Owner',
      accountDisplayName: 'Rival Picker Account',
    });
    await seedTenantAccount(sql(), {
      userId: outsider.userId,
      accountId: outsider.accountId,
      ownerEmail: outsiderEmail,
      userName: 'Rival Picker Outsider',
      accountDisplayName: 'Rival Picker Outsider Account',
    });

    await insertLocation(location, tenant.accountId, ownerEmail, {
      keywords: [KEYWORD, 'espresso bar'],
      searchLocation: SEARCH_LOCATION,
    });
    await insertLocation(notConfiguredLocation, tenant.accountId, ownerEmail, {
      keywords: [],
      searchLocation: SEARCH_LOCATION,
    });
    await insertLocation(awaitingPackLocation, tenant.accountId, ownerEmail, {
      keywords: [KEYWORD],
      searchLocation: SEARCH_LOCATION,
    });
  });

  afterAll(async () => {
    try {
      if (!db) return;
      await sql()`DELETE FROM analytics_events WHERE account_id IN (${tenant.accountId}::uuid, ${outsider.accountId}::uuid)`;
      await sql()`DELETE FROM competitor_snapshots WHERE business_id = ANY(${allLocations}::uuid[])`;
      await sql()`DELETE FROM ranking_snapshots WHERE business_id = ANY(${allLocations}::uuid[])`;
      await sql()`DELETE FROM businesses WHERE id = ANY(${allLocations}::uuid[])`;
      await cleanupTenantAccount(sql(), outsider);
      await cleanupTenantAccount(sql(), tenant);
      await db.end({ timeout: 5 });
      await workerDb?.end({ timeout: 5 });
    } finally {
      db = undefined;
      workerDb = undefined;
    }
  });

  beforeEach(async () => {
    await sql()`DELETE FROM analytics_events WHERE account_id = ${tenant.accountId}::uuid`;
    await sql()`
      UPDATE businesses
      SET rival_place_id = NULL, rival_title_snapshot = NULL, rival_picked_at = NULL
      WHERE id = ANY(${allLocations}::uuid[])
    `;
    await sql()`DELETE FROM competitor_snapshots WHERE business_id = ANY(${allLocations}::uuid[])`;
    await sql()`DELETE FROM ranking_snapshots WHERE business_id = ANY(${allLocations}::uuid[])`;
    await replacePack(sql(), location, EARLIER_DATE, FULL_PACK);
  });

  it('excludes is_self and blank-place_id rows from the pickable options and orders by rank then place_id', async () => {
    const view = await ownerView();

    expect(view.state).toBe('ready');
    // rank 1, rank 4, then the two NULL-rank rivals by place_id (delta < zulu).
    expect(optionPlaceIds(view)).toEqual([ALPHA, BRAVO, DELTA, ZULU]);
    expect(optionPlaceIds(view)).not.toContain(SELF);
    expect(optionPlaceIds(view)).not.toContain('');
    // Blank-title exclusion is deliberate: selectAutoDefaultRival already
    // refuses whitespace-only titles, so offering one here would let an owner
    // pick a rival the digest could never name.
    expect(optionPlaceIds(view)).not.toContain(BLANK_TITLE);

    if (view.state !== 'ready') throw new Error('unreachable');
    expect(view.keyword).toBe(KEYWORD);
    expect(view.pick).toBeNull();
    expect(view.options[0]).toEqual({
      placeId: ALPHA,
      title: 'Alpha Coffee',
      rankPosition: 1,
      reviewCount: 300,
      rating: 4.6,
    });
  });

  it('lists a pick absent from the latest pack as the selected option using the stored title snapshot', async () => {
    await pick(BRAVO);
    await replacePack(sql(), location, EARLIER_DATE, packWithout(BRAVO));

    const view = await ownerView();

    expect(optionPlaceIds(view)).not.toContain(BRAVO);
    if (view.state !== 'ready') throw new Error('unreachable');
    expect(view.pick).toEqual({
      placeId: BRAVO,
      title: 'Bravo Beans',
      inLatestPack: false,
    });
  });

  it('shows the not-configured state for a location with no primary tracked keyword', async () => {
    const view = await loadRivalPickerView(sql(), {
      accountId: tenant.accountId,
      businessId: notConfiguredLocation,
    });

    expect(view).toEqual({ state: 'not_configured', businessId: notConfiguredLocation });
  });

  it('shows the teaser state for a configured location with no persisted pack yet', async () => {
    const view = await loadRivalPickerView(sql(), {
      accountId: tenant.accountId,
      businessId: awaitingPackLocation,
    });

    expect(view).toEqual({
      state: 'awaiting_pack',
      businessId: awaitingPackLocation,
      keyword: KEYWORD,
    });
  });

  it('derives the stored title snapshot from the pack row and ignores any client-supplied title', async () => {
    // `SetNamedRivalPickInput` has no `title` field, so a client-supplied name
    // has no channel into the write. Forcing one through anyway proves it is
    // dropped rather than persisted into a column that reaches a rendered email.
    const smuggled = {
      accountId: tenant.accountId,
      businessId: location,
      placeId: BRAVO,
      userId: tenant.userId,
      title: 'Attacker Renamed Rival',
      rivalTitleSnapshot: 'Attacker Renamed Rival',
    } as unknown as Parameters<typeof setNamedRivalPick>[1];

    const view = await setNamedRivalPick(sql(), smuggled);

    const stored = await readPickColumns();
    expect(stored.rival_place_id).toBe(BRAVO);
    expect(stored.rival_title_snapshot).toBe('Bravo Beans');
    expect(stored.rival_picked_at).toBeInstanceOf(Date);
    if (view.state !== 'ready') throw new Error('unreachable');
    expect(view.pick).toEqual({ placeId: BRAVO, title: 'Bravo Beans', inLatestPack: true });
  });

  it('rejects a pick whose place_id is absent from the latest pack with 409 pack_refreshed', async () => {
    await expect(pick('ChIJ-never-in-any-pack')).rejects.toBeInstanceOf(RivalPickStaleError);

    const stored = await readPickColumns();
    expect(stored.rival_place_id).toBeNull();
    expect(await readAnalyticsEvents()).toHaveLength(0);
  });

  it("rejects a pick targeting the location's own is_self pack row", async () => {
    await expect(pick(SELF)).rejects.toBeInstanceOf(RivalPickStaleError);

    const stored = await readPickColumns();
    expect(stored.rival_place_id).toBeNull();
  });

  it('clears the pick and returns the location to the Auto-default rival when Auto-selected is chosen', async () => {
    await pick(ALPHA);
    expect((await readPickColumns()).rival_place_id).toBe(ALPHA);

    const view = await pick(null);

    const stored = await readPickColumns();
    expect(stored).toEqual({
      rival_place_id: null,
      rival_title_snapshot: null,
      rival_picked_at: null,
    });
    if (view.state !== 'ready') throw new Error('unreachable');
    expect(view.pick).toBeNull();

    // The digest falls back to the Auto-default rival — nearest ahead by
    // reviews is Zulu Roast (120 vs our 100), not the picked Alpha (300).
    const delta = await resolveNamedRival(sql(), location);
    expect(delta).toMatchObject({
      kind: 'rival',
      line: { rivalName: 'Zulu Roast', source: 'auto_default', gap: 20 },
    });
  });

  it('records a durable competitor_rival_picked analytics event on set and on clear', async () => {
    await pick(BRAVO);
    await pick(null);

    const rows = await readAnalyticsEvents();
    expect(rows).toHaveLength(2);
    expect(rows.every((row) => row.event_name === 'competitor_rival_picked')).toBe(true);
    expect(new Set(rows.map((row) => row.event_key)).size).toBe(2);

    const set = rows.find((row) => properties(row).action === 'set');
    const cleared = rows.find((row) => properties(row).action === 'cleared');

    expect(set).toBeDefined();
    expect(set!.distinct_id).toBe(tenant.accountId);
    expect(set!.account_id).toBe(tenant.accountId);
    expect(set!.user_id).toBe(tenant.userId);
    expect(set!.business_id).toBe(location);
    // businessId must ALSO ride the properties blob: AnalyticsDispatchPoller
    // forwards only `properties` to PostHog, so the column never leaves Postgres.
    expect(properties(set!)).toEqual({ action: 'set', placeId: BRAVO, businessId: location });

    expect(cleared).toBeDefined();
    expect(properties(cleared!)).toEqual({ action: 'cleared', placeId: null, businessId: location });
  });

  it('does not store a pick when the pack is replaced concurrently with the request', async () => {
    // The owner's browser rendered a picker view listing Bravo…
    expect(optionPlaceIds(await ownerView())).toContain(BRAVO);

    // …and RankingTrackingWorker replaces the SAME date's pack without Bravo
    // on its own connection before the submit lands. The write must validate
    // against committed state, never against the view the client was rendered
    // from.
    await replacePack(worker(), location, EARLIER_DATE, packWithout(BRAVO));

    await expect(pick(BRAVO)).rejects.toBeInstanceOf(RivalPickStaleError);

    const stored = await readPickColumns();
    expect(stored.rival_place_id).toBeNull();
    expect(await readAnalyticsEvents()).toHaveLength(0);
  });

  it('does not store a pick when a newer snapshot date lands mid-request', async () => {
    expect(optionPlaceIds(await ownerView())).toContain(BRAVO);

    // A NEWER date's pack lands without Bravo while the earlier date's rows —
    // which DO contain Bravo — stay persisted. This is the interleaving that
    // catches a pre-resolved `latestSnapshotDate`: any statement that does not
    // compute MAX(snapshot_date) itself happily matches Bravo's stale row.
    await replacePack(worker(), location, LATER_DATE, packWithout(BRAVO));

    await expect(pick(BRAVO)).rejects.toBeInstanceOf(RivalPickStaleError);

    const stored = await readPickColumns();
    expect(stored.rival_place_id).toBeNull();

    const [stale] = await sql()<{ count: number }[]>`
      SELECT COUNT(*)::int AS count FROM competitor_snapshots
      WHERE business_id = ${location}::uuid
        AND snapshot_date = ${EARLIER_DATE}::date
        AND place_id = ${BRAVO}
    `;
    // Proves the rejection came from the latest-date predicate, not from the
    // row having disappeared.
    expect(stale?.count).toBe(1);
  });

  it('writes exactly one analytics event when the same pick is submitted twice', async () => {
    await pick(BRAVO);
    const first = await readPickColumns();

    await pick(BRAVO);
    const second = await readPickColumns();

    // A retried request must not move rival_picked_at: it seeds the event key,
    // and a moving key would double-count one owner action.
    expect(second.rival_picked_at?.toISOString()).toBe(first.rival_picked_at?.toISOString());
    expect(await readAnalyticsEvents()).toHaveLength(1);

    // The same is true of a retried clear: the second one matches no row.
    await pick(null);
    await pick(null);
    expect(await readAnalyticsEvents()).toHaveLength(2);
  });

  it("returns 404 and writes no analytics event for a businessId outside the caller's account", async () => {
    await expect(
      loadRivalPickerView(sql(), { accountId: outsider.accountId, businessId: location }),
    ).rejects.toBeInstanceOf(RivalPickNotFoundError);

    await expect(
      setNamedRivalPick(sql(), {
        accountId: outsider.accountId,
        businessId: location,
        placeId: BRAVO,
        userId: outsider.userId,
      }),
    ).rejects.toBeInstanceOf(RivalPickNotFoundError);

    // A foreign CLEAR must not be mistaken for the benign "already cleared"
    // no-op that also updates zero rows.
    await expect(
      setNamedRivalPick(sql(), {
        accountId: outsider.accountId,
        businessId: location,
        placeId: null,
        userId: outsider.userId,
      }),
    ).rejects.toBeInstanceOf(RivalPickNotFoundError);

    expect((await readPickColumns()).rival_place_id).toBeNull();
    const [outsiderEvents] = await sql()<{ count: number }[]>`
      SELECT COUNT(*)::int AS count FROM analytics_events
      WHERE business_id = ${location}::uuid
    `;
    expect(outsiderEvents?.count).toBe(0);
  });
});
