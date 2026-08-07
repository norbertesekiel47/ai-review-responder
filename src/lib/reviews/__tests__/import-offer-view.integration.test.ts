// src/lib/reviews/__tests__/import-offer-view.integration.test.ts
//
// T0 EVAL suite for #677 — titles 40–43 and 66–67 of the intake's 69, authored
// VERBATIM before implementation.
//
// readImportOfferView is a three-table join (businesses × zernio_backfill_runs ×
// job_outbox) with row-selection precedence and an outbox-status → banner-state
// mapping. Live, not mocked (plan §2, round-1 F108): every title below is a
// property of the JOIN, and a mocked `sql` tag can only prove which template was
// interpolated.
//
// The three precedence rules under test are each a round-1 finding, not a
// preference:
//
//  - `completed_at` decides done, NEVER `imported_count`. The count DEFAULTs to 0
//    (100_….sql:65-67) and is written incrementally
//    (ZernioBackfillWorker.ts:379), so a mid-run read with a positive partial
//    count is still `importing`, and `empty` requires
//    `completed_at IS NOT NULL AND imported_count = 0`.
//  - Outbox status maps per the draft-status precedent (:95-143): the in-flight
//    set → `importing`; every terminal non-`completed` status → `failed`. Import
//    the set, never re-spell it (invariant #2).
//  - Row selection is explicit: run and outbox rows scoped to THIS business_id
//    and account, newest first. A stale or foreign row must never win the join
//    (invariant #8).
//
// Live-DB conventions (CLAUDE.md gotcha, `ci:live-db-suites`): named
// `*.integration.test.ts`, gated by describeWithDb, asserts its schema, and
// NEVER applies migration SQL.
//
import { randomUUID } from 'node:crypto';
import { afterAll, afterEach, beforeAll, expect, it } from 'vitest';
import postgres from 'postgres';
import type postgresType from 'postgres';
import { describeWithDb } from '@/__tests__/helpers/describe-with-db';
import {
  cleanupTenantAccount,
  seedTenantAccount,
  type TenantSeed,
} from '@/lib/shared/__tests__/live-db-tenant';
import {
  assertSchemaReady,
  MIGRATION_100_IMPORT_CONSENT,
} from '@/lib/shared/__tests__/helpers/schema-ready';
import { readImportOfferView } from '../import-offer-view';

const testDatabaseUrl = process.env.TEST_DATABASE_POOL_URL;

let db: postgresType.Sql | undefined;
let tenant: TenantSeed | undefined;
let foreign: TenantSeed | undefined;
const businessId = randomUUID();

function sql(): postgresType.Sql {
  if (!db) throw new Error('import-offer-view database was not initialized');
  return db;
}

async function setConsent(decision: string, expiresAtSql: string | null): Promise<void> {
  await sql().unsafe(
    `UPDATE businesses
        SET import_decision = '${decision}',
            import_decision_at = ${decision === 'pending' ? 'NULL' : 'now()'},
            import_offer_expires_at = ${expiresAtSql ? `(${expiresAtSql})` : 'NULL'}
      WHERE id = '${businessId}'::uuid`,
  );
}

/** A run row. `completedAtSql` null => still running. */
async function seedRun(opts: {
  businessId?: string;
  completedAtSql?: string | null;
  importedCount?: number;
  createdAtSql?: string;
  runReason?: string;
}): Promise<void> {
  // The four NOT NULL provenance columns have no defaults — a run row cannot be
  // seeded without them, and omitting one surfaces as a null-violation rather
  // than as a view bug.
  await sql().unsafe(
    `INSERT INTO zernio_backfill_runs (
       id, business_id, zernio_account_id, zernio_location_id,
       subscription_tier, subscription_activated_at,
       run_reason, imported_count, completed_at, created_at
     ) VALUES (
       '${randomUUID()}'::uuid,
       '${opts.businessId ?? businessId}'::uuid,
       'zacct-view', 'zloc-view',
       'copilot', now() - interval '60 days',
       '${opts.runReason ?? 'initial'}',
       ${opts.importedCount ?? 0},
       ${opts.completedAtSql ? `(${opts.completedAtSql})` : 'NULL'},
       ${opts.createdAtSql ?? 'now()'}
     )`,
  );
}

async function seedOutbox(status: string, createdAtSql = 'now()', aggregate = businessId): Promise<void> {
  await sql().unsafe(
    `INSERT INTO job_outbox (id, topic, aggregate_type, aggregate_id, payload, status, created_at)
     VALUES (
       '${randomUUID()}'::uuid, 'zernio_initial_backfill', 'business',
       '${aggregate}'::uuid, '{}'::jsonb, '${status}', ${createdAtSql}
     )`,
  );
}

function view() {
  return readImportOfferView(sql(), businessId, tenant!.accountId);
}

describeWithDb('readImportOfferView against live Postgres', { timeout: 30_000 }, () => {
  beforeAll(async () => {
    db = postgres(testDatabaseUrl!, { max: 2, prepare: false });
    await assertSchemaReady(db, [MIGRATION_100_IMPORT_CONSENT]);
    tenant = await seedTenantAccount(db, {
      userName: 'View Owner',
      accountDisplayName: 'View Account',
    });
    foreign = await seedTenantAccount(db, {
      userName: 'Foreign View Owner',
      accountDisplayName: 'Foreign View Account',
    });
    await sql()`
      INSERT INTO businesses (id, name, owner_name, owner_email, account_id, subscription_status)
      VALUES (${businessId}::uuid, 'View Location', 'View Owner',
              ${tenant.ownerEmail}, ${tenant.accountId}::uuid, 'active')
    `;
  });

  afterEach(async () => {
    await sql()`DELETE FROM zernio_backfill_runs WHERE business_id = ${businessId}::uuid`;
    await sql()`DELETE FROM job_outbox WHERE aggregate_id = ${businessId}::uuid`;
  });

  afterAll(async () => {
    if (!db) return;
    await sql()`DELETE FROM zernio_backfill_runs WHERE business_id = ${businessId}::uuid`;
    await sql()`DELETE FROM job_outbox WHERE aggregate_id = ${businessId}::uuid`;
    await sql()`DELETE FROM businesses WHERE id = ${businessId}::uuid`;
    for (const t of [tenant, foreign]) if (t) await cleanupTenantAccount(sql(), t);
    await db.end({ timeout: 5 });
  });
  // The partial-count trap. This is the title that fails if the view reads
  // `imported_count > 0` as "done" — the most natural wrong implementation.
  it('readImportOfferView reports importing for an incomplete run even when imported_count is already positive', async () => {
    await setConsent('accepted', null);
    await seedRun({ completedAtSql: null, importedCount: 42 });
    await seedOutbox('dispatched');

    // imported_count is written INCREMENTALLY (ZernioBackfillWorker.ts:379), so a
    // positive count mid-run says nothing about doneness. completed_at decides.
    expect(await view()).toEqual({ state: 'importing' });
  });

  it('readImportOfferView returns empty only when the run completed with imported_count zero', async () => {
    await setConsent('accepted', null);
    await seedRun({ completedAtSql: 'now()', importedCount: 0 });

    expect(await view()).toEqual({ state: 'empty' });

    // And a completed run with a positive count is NOT empty — the pair is what
    // makes "only when" meaningful.
    await sql()`DELETE FROM zernio_backfill_runs WHERE business_id = ${businessId}::uuid`;
    await seedRun({ completedAtSql: 'now()', importedCount: 1 });

    expect(await view()).toEqual({ state: 'imported', count: 1 });
  });

  it('readImportOfferView reports failed for a terminal non-completed outbox row', async () => {
    await setConsent('accepted', null);
    await seedOutbox('failed');

    expect(await view()).toEqual({ state: 'failed' });

    // Every terminal non-completed status maps to failed, per the draft-status
    // precedent — the client has nothing else to do with them.
    await sql()`DELETE FROM job_outbox WHERE aggregate_id = ${businessId}::uuid`;
    await seedOutbox('cancelled');

    expect(await view()).toEqual({ state: 'failed' });
  });

  it('readImportOfferView ignores stale and foreign-account runs and outbox rows', async () => {
    await setConsent('accepted', null);

    // A completed INITIAL run plus a NEWER, still-running REACTIVATION run.
    //
    // Two `initial` runs cannot coexist — the DB carries
    // `zernio_backfill_runs_one_initial_per_business`, a UNIQUE partial index on
    // `(business_id) WHERE run_reason = 'initial'`. This fixture was originally
    // written with two initial runs and the constraint rejected it, which is what
    // surfaced the real question: reactivation runs DO recur, so "newest run wins"
    // would flip this banner back to "importing" every time an archived location
    // was reactivated, long after the one-time import finished. The view therefore
    // scopes run rows to `run_reason = 'initial'`.
    await seedRun({
      completedAtSql: "now() - interval '30 days'",
      importedCount: 99,
      createdAtSql: "now() - interval '30 days'",
      runReason: 'initial',
    });
    await seedRun({
      completedAtSql: null,
      importedCount: 0,
      createdAtSql: 'now()',
      runReason: 'reactivation',
    });

    // The completed INITIAL run decides, and the newer reactivation run is ignored.
    expect(await view()).toEqual({ state: 'imported', count: 99 });

    // A FOREIGN account's rows for a different business must not leak in
    // (invariant #8). Seed a completed run + outbox against another business.
    const foreignBusiness = randomUUID();
    await sql()`
      INSERT INTO businesses (id, name, owner_name, owner_email, account_id, subscription_status)
      VALUES (${foreignBusiness}::uuid, 'Foreign', 'Foreign Owner',
              ${foreign!.ownerEmail}, ${foreign!.accountId}::uuid, 'active')
    `;
    await seedRun({ businessId: foreignBusiness, completedAtSql: 'now()', importedCount: 500 });
    await seedOutbox('completed', 'now()', foreignBusiness);

    // Our own state is untouched by the foreign rows — still our count, not 500.
    expect(await view()).toEqual({ state: 'imported', count: 99 });

    // Reading the FOREIGN business under OUR account returns none — the account
    // predicate, not just the business id, is doing work.
    expect(await readImportOfferView(sql(), foreignBusiness, tenant!.accountId))
      .toEqual({ state: 'none' });

    await sql()`DELETE FROM zernio_backfill_runs WHERE business_id = ${foreignBusiness}::uuid`;
    await sql()`DELETE FROM job_outbox WHERE aggregate_id = ${foreignBusiness}::uuid`;
    await sql()`DELETE FROM businesses WHERE id = ${foreignBusiness}::uuid`;
  });

  // Titles 66–67 (round-2): revision 2's view suite asserted only the negative
  // and mid-run cases, so the two states the owner actually SEES on a happy path
  // had no live coverage at all.
  it('readImportOfferView reports the imported count for a completed run against live Postgres', async () => {
    await setConsent('accepted', null);
    await seedRun({ completedAtSql: 'now()', importedCount: 17 });
    await seedOutbox('completed');

    expect(await view()).toEqual({ state: 'imported', count: 17 });
  });

  it('readImportOfferView returns the offer state for a live pending offer against live Postgres', async () => {
    await setConsent('pending', "now() + interval '5 days'");

    const result = await view();

    expect(result.state).toBe('offer');
    expect(new Date((result as { expiresAt: string }).expiresAt).getTime())
      .toBeGreaterThan(Date.now());

    // A pending row with a NULL deadline is migration 100's DEFAULT, not an offer.
    // Showing a banner for it would invite a POST the guarded transition rejects
    // as no_offer — the round-1 Critical, seen from the UI side.
    await setConsent('pending', null);
    expect(await view()).toEqual({ state: 'none' });

    // Declined and derived-expired both mean "never show it again".
    await setConsent('declined', "now() + interval '5 days'");
    expect(await view()).toEqual({ state: 'none' });

    await setConsent('pending', "now() - interval '1 second'");
    expect(await view()).toEqual({ state: 'none' });
  });
});
