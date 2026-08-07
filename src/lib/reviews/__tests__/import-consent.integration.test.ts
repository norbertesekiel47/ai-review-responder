// src/lib/reviews/__tests__/import-consent.integration.test.ts
//
// T0 EVAL suite for #677 — Import consent: the predicate, the offer, the
// acceptance transaction. Titles 1–13, 57–60, 62 of the intake's 70
// (`tests_to_add`), authored VERBATIM before any implementation.
//
// WHY LIVE POSTGRES (plan §2): this feature's load-bearing semantics are in the
// SQL, not in the bindings. The expiry derivation is evaluated by Postgres
// `now()`; the F3 terminal-state contract is a `WHERE` predicate on an `UPDATE`;
// the acceptance is a transaction that must roll back as a unit; and titles 11,
// 12 and 62 are races. A mocked `sql` tag cannot falsify any of those.
//
// There is deliberately NO mocked twin for import-consent.ts (plan §2). That
// makes titles 8–9 load-bearing here: this suite must itself assert business-id
// binding and the no-row / no-offer classifications, because no other suite does.
//
// Live-DB conventions (CLAUDE.md gotcha, `ci:live-db-suites`): named
// `*.integration.test.ts`, gated by describeWithDb, asserts its schema via
// assertSchemaReady, and NEVER applies migration SQL.
//
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, expect, it } from 'vitest';
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

const testDatabaseUrl = process.env.TEST_DATABASE_POOL_URL;

let db: postgresType.Sql | undefined;
let tenant: TenantSeed | undefined;
const businessId = randomUUID();

function sql(): postgresType.Sql {
  if (!db) throw new Error('import-consent integration database was not initialized');
  return db;
}

describeWithDb('import consent against live Postgres', { timeout: 30_000 }, () => {
  beforeAll(async () => {
    db = postgres(testDatabaseUrl!, { max: 4, prepare: false });
    // max:4, not max:1 — titles 11, 61 and 62 are concurrency races that need
    // genuinely separate sessions. A single-connection pool serializes them and
    // the race silently cannot occur, which is how a green run proves nothing.
    await assertSchemaReady(db, [MIGRATION_100_IMPORT_CONSENT]);
    tenant = await seedTenantAccount(db, {
      userName: 'Import Consent Owner',
      accountDisplayName: 'Import Consent Account',
    });

    await sql()`
      INSERT INTO businesses (
        id, name, owner_name, owner_email, account_id, subscription_status
      ) VALUES (
        ${businessId}::uuid, 'Import Consent Location', 'Import Consent Owner',
        ${tenant.ownerEmail}, ${tenant.accountId}::uuid, 'active'
      )
    `;
  });

  afterAll(async () => {
    if (!db) return;
    if (tenant) {
      await sql()`DELETE FROM analytics_events WHERE account_id = ${tenant.accountId}::uuid`;
      await sql()`DELETE FROM job_outbox WHERE aggregate_id::text = ${businessId}`;
      await sql()`DELETE FROM zernio_connections WHERE business_id = ${businessId}::uuid`;
      await sql()`DELETE FROM businesses WHERE id = ${businessId}::uuid`;
      await cleanupTenantAccount(sql(), tenant);
    }
    await db.end({ timeout: 5 });
  });

  // ── The derived-expiry predicate (spec §5.3) ────────────────────────────────

  it.todo('importConsentStateSql derives expired only for a pending offer whose deadline has passed');

  it.todo('importConsentStateSql returns the stored decision unchanged for accepted and declined rows whatever the deadline');

  it.todo('importConsentStateSql treats a pending offer with a NULL deadline as pending never expired');

  it.todo('importConsentStateSql evaluates the deadline with Postgres now at the inclusive boundary');

  // ── createImportOffer: the junction write ───────────────────────────────────

  it.todo('createImportOffer stamps a deadline seven days out on a pending row with no deadline');

  it.todo('createImportOffer is idempotent on a second junction and never extends the deadline');

  it.todo('createImportOffer never writes to a row whose import decision is already answered');

  it.todo('readImportConsent binds the requested business and returns null for a business with no row');

  // ── recordImportDecision: the F3 guarded transition ─────────────────────────

  it.todo('recordImportDecision rejects a pending row with a NULL deadline as no offer and leaves every consent column unchanged');

  it.todo('recordImportDecision rejects at the exact deadline boundary and leaves the row byte-identical');

  it.todo('concurrent accept and decline preserve the first committed terminal decision and the loser writes nothing');

  it.todo('property: no sequence of import consent writes ever overwrites a terminal decision');

  // ── Schema contract ─────────────────────────────────────────────────────────
  //
  // The ONE title in this file that is meaningful before any implementation
  // lands, and it is asserted rather than deferred on purpose (plan §2, round-1
  // F113): MIGRATION_100_IMPORT_CONSENT proves the columns and the constraint
  // NAME, and migration 101 did not change the name — so a DB stopped at 100
  // passes assertSchemaReady while still carrying the four-valued CHECK. This
  // asserts the constraint DEFINITION instead of trusting the helper.
  //
  // 'expired' must NOT be a storable value: expiry is derived, never stored
  // (#670). A four-valued CHECK would let a writer persist 'expired' and split
  // the single source of truth the derivation exists to be.
  it('the import consent suite asserts the three-valued import_decision CHECK from migration 101', async () => {
    const [row] = await sql()<{ definition: string }[]>`
      SELECT pg_get_constraintdef(oid) AS definition
      FROM pg_constraint
      WHERE conname = 'businesses_import_decision_check'
        AND conrelid = 'businesses'::regclass
    `;

    expect(row, 'businesses_import_decision_check is absent — DB is behind migration 100').toBeDefined();

    const definition = row!.definition;
    expect(definition).toContain("'pending'");
    expect(definition).toContain("'accepted'");
    expect(definition).toContain("'declined'");
    // The assertion that migration 101 exists at all, and the one the named
    // schema requirement structurally cannot make.
    expect(definition).not.toContain("'expired'");
  });

  // ── Junction eligibility inside createImportOffer's SQL (round-2 High) ──────
  //
  // Both halves are proven by the helper, not by its callers: activation
  // non-NULL AND an active zernio_connections row. Titles 57 and 58 are the two
  // one-sided cases.

  it.todo('createImportOffer creates no offer when the subscription is activated but no active connection exists');

  it.todo('createImportOffer creates no offer when a connection exists but the subscription was never activated');

  it.todo('createImportOffer never rewrites a deadline that already exists');

  // Revision 4 (owner adjudication): there is NO junction anchor. A self-healed
  // offer deliberately starts a fresh 7 days at the repair, which gives the
  // owner a full window from the first moment they could have seen the offer.
  // This title pins that behaviour so a future reader does not "fix" it back
  // into an anchor — the anchor was self-invented and cost two review rounds.
  it.todo('a self-healed offer starts its seven days at the repair, not at the failed junction write');

  // The classification race the businesses row lock exists to remove: under READ
  // COMMITTED a concurrent self-heal could turn a NULL deadline into a live one
  // between the guarded UPDATE and the re-read, making the classifier report
  // already_answered for a row that is still answerable.
  it.todo('a concurrent self-heal during a decision does not misclassify a live pending offer as already answered');
});
