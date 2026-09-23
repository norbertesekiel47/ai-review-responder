// Security-posture assertions for migrations 040 (`040_rls_tightening.sql`)
// and 041 (`041_rls_missing_revokes.sql`) — the write-surface narrowing on
// `businesses` and `channel_enrollments` (#1384, invariant #8). Migration 035
// gave owners a broad `account_id = owner_account_id()` UPDATE policy on both
// tables plus INSERT on `channel_enrollments`; RLS restricts ROWS, never
// COLUMNS, so 040 narrows the write surface with table-level REVOKE +
// column-level GRANT instead, and removes the INSERT policy on
// `channel_enrollments` entirely. 041 is a follow-up REVOKE-only patch for
// three `businesses` and two `channel_enrollments` columns 040 missed.
//
// This ONE suite covers BOTH files, as the predecessor suite did — 041 has no
// suite of its own. Converts from regex-over-SQL-text to executing both
// migrations and asserting via `readPublicCatalogue`, per #1301/#1384
// (`migration-guard.ts`'s own header owns the red-team history behind that
// decision). Listed in `MIGRATION_SHAPE_FILES`
// (`scripts/ci/live-db-suites-audit.ts`) and holds the cross-process live-DB
// lock in `beforeAll`, as every entry there must.
//
// ── default-ACL workaround (#1301/118) ───────────────────────────────────
//
// A real Supabase project's platform grants `authenticated`/`anon` broad
// table-level DML on every table it creates; this test container's bootstrap
// does not (confirmed 2026-09-22, `SELECT count(*) FROM pg_default_acl`
// returns 0 — the same fact migration 118's suite documents). So
// `businesses`/`channel_enrollments` never had table-level UPDATE/INSERT
// granted to `authenticated` here to begin with, and 040/041's REVOKE would
// have nothing to remove. `degrade()` restores the wide-open pre-040 grant
// FIRST (`GRANT UPDATE ON businesses TO authenticated`, `GRANT INSERT, UPDATE
// ON channel_enrollments TO authenticated`) — the same technique 118's suite
// uses before dropping its table — to make the REVOKE falsifiable.
//
// ── retired assertions (ci:weakened-checks) ──────────────────────────────
//
// RETIRED, no replacement (dead scope): the `notification_preference` entry
// in the predecessor's safe-column list — that column was DROPPED by
// migration 022, three migrations before 040 was written.
// RETIRED → the single derived case below (`grants UPDATE only on the exact
// safe-column list…`), for every per-column `REVOKEs UPDATE(%s)`/safe-column
// case and the two REVOKE-count assertions (28 columns' worth): it queries
// `has_column_privilege` for every column and compares the returned set to
// the safe list EXACTLY — strictly stronger, since a REVOKE that targeted the
// WRONG column left the intended one privileged and the enumerated checks
// could not see it; this asks "what CAN be updated" instead.
// RETIRED → the pinned policy-definition + count cases below, for the
// businesses/channel_enrollments UPDATE-policy quartets and the
// insert-removal cases — the pinned literals are the catalogue's OWN
// rendering (`pg_get_expr`), and the policy-count-of-two on
// `channel_enrollments` catches an insert policy under ANY name.
// RETIRED, no replacement (author's syntax, not a DB effect): `migration 041
// exists as a separate file`, the DO-block-wrapping check, and the two
// "REVOKE is idempotent" cases.
// RETIRED → `assertOnlyTablesMoved` below, for `does NOT affect any table
// other than…` — byte-identical, not merely "no REVOKE/DROP POLICY text
// mentions this table's name".
// RETIRED → whole-table equality in the executing cases, for `does NOT drop
// …_owner_select` and the three `combined state — migrations 035 + 040 + 041`
// cases: a table equal to its own head state necessarily carries every policy
// those cases enumerated and no policy they did not.
//
// ── the two oracles ───────────────────────────────────────────────────────
//
// ORACLE A (titles 2-3): pinned head-posture literals, captured independently
// of the migration files by introspecting this container at head
// (2026-09-22). Catches a WEAKENED migration oracle B alone cannot: `pnpm
// test:db:setup` provisions the container FROM the migrations under test, so
// a weakened 040/041 yields a weakened BEFORE and `AFTER == BEFORE` would
// pass regardless.
//
// ORACLE B (titles 4-5): degrades both tables to the pre-040 posture inside a
// transaction that ALWAYS rolls back, proves the degrade landed, applies BOTH
// files VERBATIM in order, and diffs the whole `public` catalogue against the
// before-read, including every OTHER table (migration 119's off-target
// `GRANT ALL` red-team round is why).
//
// ── mutation evidence (#1384) ─────────────────────────────────────────────
//
// Mutated `BUSINESSES_SAFE_COLUMNS` (removed `'tone'`) and re-ran against the
// unmodified container: 2 of 5 cases went red — oracle A's safe-column case
// and oracle B's own trailing derived-column re-check (the catalogue-wide
// `toEqual` had already passed by that point, which is the expected shape:
// only the derived-column check reads this constant). The registry case and
// `re-applying 040+041 moves no other table in public` stayed green. Reverted;
// diff showed zero drift.
//
// No row is seeded, so the carried-forward `SET CONSTRAINTS ALL IMMEDIATE`
// rule does not apply. The registry case is DB-free and cannot silently
// skip; the other four sit behind `describeWithDb`.

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
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
  assertDegradeLanded,
  assertOnlyTablesMoved,
  nonEmptyNames,
  readMigrationSql,
  readPublicCatalogue,
  withRolledBackTransaction,
} from '@/lib/shared/__tests__/helpers/migration-guard';
import { auditLiveDbFile } from '../../../../scripts/ci/live-db-suites-audit';

const MIGRATION_040_FILE = '040_rls_tightening.sql';
const MIGRATION_041_FILE = '041_rls_missing_revokes.sql';
const SUITE_FILE = 'src/lib/shared/__tests__/migration-040-rls-tightening.integration.test.ts';
const BEHIND_HEAD =
  'businesses/channel_enrollments write-surface posture is not at migration head — run pnpm test:db:setup';

/**
 * Exactly the columns 040's own `GRANT UPDATE (…) ON businesses TO
 * authenticated` names, sorted — the ONLY businesses columns an owner may
 * write via the anon key at head. Every other column (22 of them, across 040's
 * 19 + 041's 3) must come back ungranted, and this list is what `it('…exact
 * safe-column list…')` compares the DERIVED grant set against.
 */
const BUSINESSES_SAFE_COLUMNS = [
  'avoid_facts',
  'display_label',
  'highlight_facts',
  'owner_phone',
  'products_services',
  'sample_responses',
  'staff_names',
  'tone',
  'updated_at',
] as const;

/** Same shape as `BUSINESSES_SAFE_COLUMNS`, for channel_enrollments. */
const ENROLLMENT_SAFE_COLUMNS = ['unsubscribed_at', 'unsubscribed_reason', 'updated_at'] as const;

/** As the catalogue RENDERS it (`pg_get_expr`) — identical USING/CHECK text to
 * 035's original policy; 040 narrows the WRITE SURFACE via REVOKE/GRANT on
 * columns, not the row predicate. Captured by introspection at head
 * (2026-09-22). */
const BUSINESSES_UPDATE_DEFINITION =
  'UPDATE PERMISSIVE roles=authenticated using=(account_id = owner_account_id()) ' +
  'check=(account_id = owner_account_id())';
const CHANNEL_ENROLLMENTS_UPDATE_DEFINITION = BUSINESSES_UPDATE_DEFINITION;

/** The historical 035 predicate for the policy 040 permanently removes — used
 * only to recreate it during `degrade()` so the removal is falsifiable. */
const CHANNEL_ENROLLMENTS_INSERT_POLICY_SQL = `
  CREATE POLICY channel_enrollments_owner_insert ON channel_enrollments
    FOR INSERT TO authenticated
    WITH CHECK (account_id = owner_account_id());
`;

const testDatabaseUrl = resolveTestDatabaseUrl();

let db: postgresType.Sql | undefined;
let featureDatabaseLock: LiveDbLock | undefined;

function sql(): postgresType.Sql {
  if (!db) throw new Error('migration 040 integration database was not initialized');
  return db;
}

/**
 * Every column of `table` that `authenticated` can currently UPDATE, derived
 * via `has_column_privilege` rather than read off any one ACL representation —
 * this is what makes it catch a grant reached through table-level privilege,
 * a column-level grant, or role membership all the same way. Sorted so the
 * comparison against a literal array is unambiguous.
 */
async function grantedUpdateColumns(
  handle: postgresType.Sql | postgresType.TransactionSql,
  table: string,
): Promise<string[]> {
  const rows = await handle<{ attname: string }[]>`
    SELECT att.attname
      FROM pg_attribute att
     WHERE att.attrelid = ${`public.${table}`}::regclass
       AND att.attnum > 0
       AND NOT att.attisdropped
       AND has_column_privilege('authenticated', ${`public.${table}`}, att.attname, 'UPDATE')
     ORDER BY att.attname
  `;
  return rows.map((row) => row.attname);
}

/**
 * The pre-040 posture, undone in the order that makes both REVOKEs and the
 * INSERT-policy removal falsifiable:
 *  1. Restore the wide-open table-level grant a real Supabase project's
 *     platform ACL would carry (see the header's "the challenge" section) —
 *     without this, businesses/channel_enrollments never had table-level
 *     UPDATE/INSERT granted to `authenticated` in THIS container to begin
 *     with, and 040/041's REVOKE would have nothing to remove.
 *  2. Remove the column-level narrowing 040+041 add, so the derived
 *     safe-column check starts from "everything granted" rather than
 *     "already narrowed".
 *  3. Recreate the INSERT policy 040 drops permanently, predicate copied
 *     verbatim from `035_rls_policies.sql` (VAL-AUTH-003) — 040 does not
 *     alter this predicate, it deletes the policy outright.
 */
async function degrade(tx: postgresType.TransactionSql): Promise<void> {
  await tx.unsafe('GRANT UPDATE ON businesses TO authenticated;');
  await tx.unsafe('GRANT INSERT, UPDATE ON channel_enrollments TO authenticated;');
  await tx.unsafe(
    `REVOKE UPDATE (${BUSINESSES_SAFE_COLUMNS.join(', ')}) ON businesses FROM authenticated;`,
  );
  await tx.unsafe(
    `REVOKE UPDATE (${ENROLLMENT_SAFE_COLUMNS.join(', ')}) ON channel_enrollments FROM authenticated;`,
  );
  await tx.unsafe(CHANNEL_ENROLLMENTS_INSERT_POLICY_SQL);
}

// ── registry: no database needed, so this one can never silently skip ───────

describe('migration 040 registries', () => {
  it('migration 040 suite is registered in MIGRATION_SHAPE_FILES', () => {
    // `MIGRATION_SHAPE_FILES` is a module-private `const` inside
    // `scripts/ci/live-db-suites-audit.ts` — not exported — so this case reads
    // its EFFECT through the audit's own exported entry point rather than a
    // hardcoded copy of the set. That is STRONGER than a membership read: this
    // file's real checked-in text executes DDL (`degrade`, above) and names
    // the cross-process lock marker, so running the real audit over that real
    // text yields zero findings ONLY because this exact path is an allowlist
    // member AND the lock call is present. Drop the entry, typo it, or rename
    // `acquireLiveDbLock` away and this case reports a `runtime-ddl` or
    // `unlocked-ddl` finding — a membership read would catch the first two and
    // miss the third.
    const ownSourceText = readFileSync(join(process.cwd(), SUITE_FILE), 'utf8');
    expect(auditLiveDbFile(SUITE_FILE, ownSourceText)).toEqual([]);
  });
});

describeWithDb(
  'migration 040+041 businesses/channel_enrollments write-surface narrowing',
  { enabled: Boolean(testDatabaseUrl), timeout: 180_000 },
  () => {
    beforeAll(async () => {
      const databaseUrl = assertLocalTestDatabaseUrl(testDatabaseUrl);
      featureDatabaseLock = await acquireLiveDbLock(databaseUrl);
      db = postgres(databaseUrl, {
        // max: 1, not 2 — `readMigrationSql`'s JSDoc owns why. In short:
        // postgres.js refuses a transaction-bearing `unsafe` on a pooled client.
        max: 1,
        prepare: false,
        connection: { statement_timeout: 30_000 },
      });
    }, LIVE_DB_LOCK_HOOK_TIMEOUT_MS);

    afterAll(async () => {
      try {
        if (db) await db.end({ timeout: 5 });
      } finally {
        await featureDatabaseLock?.release();
        featureDatabaseLock = undefined;
      }
    }, LIVE_DB_LOCK_HOOK_TIMEOUT_MS);

    // ── ORACLE A: pinned head posture, independent of the migration files ───

    it('businesses_owner_update and channel_enrollments_owner_update carry the narrowed predicate, and channel_enrollments has no insert policy, at head', async () => {
      const policies = await sql()<{ table_name: string; name: string; definition: string }[]>`
        SELECT rel.relname AS table_name, pol.polname AS name,
               (CASE pol.polcmd WHEN 'r' THEN 'SELECT' WHEN 'a' THEN 'INSERT' WHEN 'w' THEN 'UPDATE'
                     WHEN 'd' THEN 'DELETE' ELSE 'ALL' END)
               || ' ' || (CASE WHEN pol.polpermissive THEN 'PERMISSIVE' ELSE 'RESTRICTIVE' END)
               || ' roles=' || coalesce((
                    SELECT string_agg(role_name, ',' ORDER BY role_name)
                      FROM (
                        SELECT (CASE WHEN role_oid = 0 THEN 'PUBLIC' ELSE role_oid::regrole::text END)
                                 AS role_name
                          FROM unnest(pol.polroles) AS role_oid
                      ) roles
                  ), '(none)')
               || ' using=' || coalesce(pg_get_expr(pol.polqual, pol.polrelid), '(none)')
               || ' check=' || coalesce(pg_get_expr(pol.polwithcheck, pol.polrelid), '(none)')
                 AS definition
          FROM pg_policy pol
          JOIN pg_class rel ON rel.oid = pol.polrelid
         WHERE rel.relname IN ('businesses', 'channel_enrollments')
         ORDER BY rel.relname, pol.polname
      `;
      const byName = new Map(policies.map((row) => [`${row.table_name}.${row.name}`, row.definition]));

      expect(byName.get('businesses.businesses_owner_update'), BEHIND_HEAD).toBe(
        BUSINESSES_UPDATE_DEFINITION,
      );
      expect(
        byName.get('channel_enrollments.channel_enrollments_owner_update'),
        BEHIND_HEAD,
      ).toBe(CHANNEL_ENROLLMENTS_UPDATE_DEFINITION);

      // Exactly two — select + update, no insert/delete — the completeness
      // proof the retired `does NOT recreate channel_enrollments_owner_insert`
      // negative regex was reaching for. Catches an insert policy under ANY
      // name, not only the one spelling the retired regex anticipated.
      const enrollmentPolicyNames = policies
        .filter((row) => row.table_name === 'channel_enrollments')
        .map((row) => row.name)
        .sort();
      expect(enrollmentPolicyNames, BEHIND_HEAD).toEqual([
        'channel_enrollments_owner_select',
        'channel_enrollments_owner_update',
      ]);
    });

    it('businesses and channel_enrollments grant UPDATE only on the exact safe-column list, and channel_enrollments grants no INSERT, at head', async () => {
      const businessesGranted = await grantedUpdateColumns(sql(), 'businesses');
      expect(businessesGranted, BEHIND_HEAD).toEqual([...BUSINESSES_SAFE_COLUMNS]);

      const enrollmentGranted = await grantedUpdateColumns(sql(), 'channel_enrollments');
      expect(enrollmentGranted, BEHIND_HEAD).toEqual([...ENROLLMENT_SAFE_COLUMNS]);

      const [insertPrivilege] = await sql()<{ has_insert: boolean }[]>`
        SELECT has_table_privilege('authenticated', 'public.channel_enrollments', 'INSERT') AS has_insert
      `;
      expect(insertPrivilege?.has_insert, BEHIND_HEAD).toBe(false);
    });

    // ── ORACLE B: degrade, prove it landed, apply verbatim, diff ────────────

    it('re-applying 040+041 restores the narrowed grants and removes the restored insert policy', async () => {
      // `withRolledBackTransaction` ALWAYS rolls back, which is what makes the
      // degrade/apply cycle safe on the SHARED container: later migrations
      // layer on `public`, so a persistent degrade would corrupt it for every
      // other suite.
      await withRolledBackTransaction(sql(), async (tx) => {
        const before = await readPublicCatalogue(tx);
        await degrade(tx);
        const degraded = await readPublicCatalogue(tx);

        // Every half of the degrade, each proven to have landed so no case can
        // pass vacuously against a no-op migration.
        assertDegradeLanded(before, degraded, {
          table: 'businesses',
          property: 'grants',
          present: nonEmptyNames(['authenticated:UPDATE']),
        });
        assertDegradeLanded(before, degraded, {
          table: 'businesses',
          property: 'grants',
          absent: nonEmptyNames(
            BUSINESSES_SAFE_COLUMNS.map((column) => `authenticated:UPDATE:${column}`),
          ),
        });
        assertDegradeLanded(before, degraded, {
          table: 'channel_enrollments',
          property: 'grants',
          present: nonEmptyNames(['authenticated:UPDATE', 'authenticated:INSERT']),
        });
        assertDegradeLanded(before, degraded, {
          table: 'channel_enrollments',
          property: 'grants',
          absent: nonEmptyNames(
            ENROLLMENT_SAFE_COLUMNS.map((column) => `authenticated:UPDATE:${column}`),
          ),
        });
        assertDegradeLanded(before, degraded, {
          table: 'channel_enrollments',
          property: 'policies',
          present: nonEmptyNames(['channel_enrollments_owner_insert']),
        });

        // Confirms the degrade is not merely a different ACL shape but a REAL
        // widening: every column of businesses becomes updatable through the
        // restored table-level grant, not only the safe ones.
        const degradedBusinessesColumns = await grantedUpdateColumns(tx, 'businesses');
        expect(degradedBusinessesColumns.length).toBeGreaterThan(BUSINESSES_SAFE_COLUMNS.length);
        for (const sensitive of ['subscription_tier', 'stripe_customer_id', 'account_id', 'is_primary']) {
          expect(degradedBusinessesColumns, 'the degrade did not really widen businesses').toContain(
            sensitive,
          );
        }

        await tx.unsafe(readMigrationSql(MIGRATION_040_FILE));
        await tx.unsafe(readMigrationSql(MIGRATION_041_FILE));
        const after = await readPublicCatalogue(tx);

        // Whole-table equality for BOTH tables at once: every policy, every
        // grant (table AND column), unchanged from head. This is strictly
        // stronger than re-deriving a policy/grant count by hand — the
        // predecessor's three `combined state — migrations 035 + 040 + 041`
        // cases and its two `does NOT drop …_owner_select` cases are all
        // subsumed here, because a table equal to its own head state
        // necessarily carries every policy those cases enumerated and no
        // policy they did not.
        expect(after.tables.businesses).toEqual(before.tables.businesses);
        expect(after.tables.channel_enrollments).toEqual(before.tables.channel_enrollments);

        const restoredBusinessesColumns = await grantedUpdateColumns(tx, 'businesses');
        expect(restoredBusinessesColumns).toEqual([...BUSINESSES_SAFE_COLUMNS]);
        const restoredEnrollmentColumns = await grantedUpdateColumns(tx, 'channel_enrollments');
        expect(restoredEnrollmentColumns).toEqual([...ENROLLMENT_SAFE_COLUMNS]);
      });
    });

    it('re-applying 040+041 moves no other table in public', async () => {
      await withRolledBackTransaction(sql(), async (tx) => {
        const before = await readPublicCatalogue(tx);
        await degrade(tx);
        const degraded = await readPublicCatalogue(tx);

        assertDegradeLanded(before, degraded, {
          table: 'businesses',
          property: 'grants',
          present: nonEmptyNames(['authenticated:UPDATE']),
        });
        assertDegradeLanded(before, degraded, {
          table: 'channel_enrollments',
          property: 'policies',
          present: nonEmptyNames(['channel_enrollments_owner_insert']),
        });

        await tx.unsafe(readMigrationSql(MIGRATION_040_FILE));
        await tx.unsafe(readMigrationSql(MIGRATION_041_FILE));
        const after = await readPublicCatalogue(tx);

        // A migration may harden the two tables it names while doing arbitrary
        // damage elsewhere (migration 119's off-target `GRANT ALL ON
        // admin_audit_log TO anon;` red-team round). Every table outside
        // `[businesses, channel_enrollments]` must come out byte-identical.
        assertOnlyTablesMoved(before, after, ['businesses', 'channel_enrollments']);
      });
    });
  },
);
