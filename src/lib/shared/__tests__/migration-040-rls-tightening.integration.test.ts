// Security-posture assertions for migrations 040 (`040_rls_tightening.sql`)
// and 041 (`041_rls_missing_revokes.sql`) — the write-surface narrowing on
// `businesses` and `channel_enrollments` (#1384, invariant #8). Migration 035
// gave owners a broad `account_id = owner_account_id()` UPDATE policy on both
// tables plus INSERT on `channel_enrollments`; a security review found that
// predicate alone lets an owner rewrite `subscription_tier`,
// `stripe_customer_id`, `is_primary`, `channel_enrollments.status`, and more,
// or self-verify a channel enrollment outright. RLS policies restrict ROWS,
// never COLUMNS, so 040 narrows the write surface with table-level
// REVOKE + column-level GRANT instead, and removes the INSERT policy on
// `channel_enrollments` entirely (enrollment now requires service-role).
// 041 is a follow-up REVOKE-only patch for three `businesses` and two
// `channel_enrollments` columns migration 040 missed (added by earlier
// migrations 007/014/022).
//
// This ONE suite covers BOTH files, as the predecessor suite did — 041 has no
// suite of its own, and splitting one now would be a name with no reader.
//
// ── this suite now EXECUTES DDL, deliberately (#1384) ───────────────────────
//
// It is listed in `MIGRATION_SHAPE_FILES` (`scripts/ci/live-db-suites-audit.ts`)
// — the sanctioned exemption from R2 for suites where APPLYING the migration IS
// the subject — and it takes the cross-process live-DB lock in `beforeAll`, as
// every entry in that set is enforced to do.
//
// WHY. The predecessor suite proved both files by pattern-matching their SQL
// TEXT: 30-plus separate regexes reconstructing `REVOKE UPDATE (<col>) ON
// businesses FROM authenticated` per column, a five-line USING/CHECK
// reconstruction for each narrowed policy, and a handful of pure text-shape
// checks (does a `DO $$ BEGIN` block wrap the REVOKEs, does the string
// "REVOKE UPDATE" appear more than zero times). #1301's five red-team rounds
// against this exact suite family each defeated a different hand-rolled
// approximation of a SQL lexer. The verdict every time was that the APPROACH
// was wrong, not the code. This suite stops parsing the checked-in files and
// starts running them: PostgreSQL is the parser, and `has_column_privilege`
// is the arbiter of what a column grant actually means — not a regex counting
// how many times the word REVOKE appears.
//
// ── the challenge: this container carries no default ACL (#1301/118) ────────
//
// A real Supabase project's platform grants `authenticated`/`anon` broad
// table-level DML on every table it creates; this test container's bootstrap
// does not replicate that (`scripts/ci/test-db-bootstrap.sql`; confirmed
// 2026-09-22, `SELECT count(*) FROM pg_default_acl` returns 0, exactly what
// migration 118's suite already documents). So `businesses` and
// `channel_enrollments` never had table-level UPDATE/INSERT granted to
// `authenticated` here to begin with — 040/041's REVOKE would have NOTHING to
// remove, and this suite's "reapply narrows the grants" case would pass
// against a version of 040 with every REVOKE deleted. `degrade()` below
// restores the wide-open pre-040 grant FIRST (`GRANT UPDATE ON businesses TO
// authenticated`, `GRANT INSERT, UPDATE ON channel_enrollments TO
// authenticated`) for exactly the reason migration 118's suite restores
// permissive default privileges before dropping its table: to make the
// REVOKE falsifiable rather than vacuous.
//
// ── the retired text-matching cases, and where each assertion went ─────────
//
// RETIRED, no replacement (dead scope): the `notification_preference` entry
// in the predecessor's `safeBusinessColumns` list. That column was DROPPED by
// migration 022 — three migrations before 040 — so the "does NOT REVOKE
// UPDATE(notification_preference)" case tested a column that has not existed
// since before 040 was written. It is not carried forward in any form; there
// is nothing left to assert about a column that is not there.
//
// RETIRED → the single derived case below (`grants UPDATE only on the exact
// safe-column list…`), for ALL of: every per-column
// `REVOKEs UPDATE(%s) … (migration 040)` / `(migration 041)` / `combined:` case
// (28 columns' worth: 19+3 businesses, 12+2 channel_enrollments), every
// `does NOT REVOKE UPDATE(%s) …` safe-column case, and the two `total REVOKE
// count across 040+041 covers all sensitive columns` counting assertions. The
// derived case queries `has_column_privilege` for every column of each table
// and asserts the returned set equals the safe-column list EXACTLY — which is
// strictly stronger than the retired per-column checks: a REVOKE that targeted
// the WRONG column (a typo, a column from the wrong table) left the intended
// column privileged and the enumerated regex checks could not see it, because
// each one only asked about the column it already expected to find revoked.
// The derived case asks the opposite question — "what CAN be updated" — so a
// column that should have lost UPDATE but did not is caught regardless of
// which REVOKE statement was supposed to remove it.
//
// RETIRED → the pinned policy-definition + count cases below, for: `drops the
// old permissive businesses_owner_update policy` / `creates a new narrowed …`
// / `UPDATE policy uses account_id = owner_account_id()…` / `has a WITH CHECK
// clause` (and the identical quartet for `channel_enrollments_owner_update`),
// plus `drops the channel_enrollments_owner_insert policy` / `does NOT
// recreate…` / `owner cannot INSERT … via anon key`. The pinned literals are
// the catalogue's OWN rendering of the predicate (`pg_get_expr`), captured by
// introspection independent of the migration files; the policy-count-of-two
// on `channel_enrollments` subsumes "insert is gone" more strongly than a
// negative regex, because it catches an insert policy under ANY name.
//
// RETIRED, no replacement (not a security invariant): `migration 041 exists as
// a separate migration file`, `does NOT create or drop any RLS policies —
// only REVOKEs`, `all REVOKEs are inside a DO block for transactional safety`,
// and the two "REVOKE statements are safe to re-run" cases. These tested the
// AUTHOR'S CHOSEN SYNTAX (a `DO $$ BEGIN` wrapper, a REVOKE rather than some
// other statement), not an effect on the database — REVOKE is transactional
// and idempotent in PostgreSQL regardless of whether it sits inside a DO
// block, so wrapping it proves nothing a catalogue read could confirm either
// way. `does NOT affect any table other than businesses and
// channel_enrollments` is retired in favour of `assertOnlyTablesMoved` below,
// which is strictly stronger (byte-identical, not merely "no REVOKE/DROP
// POLICY text mentions this table's name").
//
// RETIRED → whole-table equality (`after.tables[…] toEqual before.tables[…]`)
// in the executing cases: `does NOT drop businesses_owner_select policy` /
// `does NOT drop channel_enrollments_owner_select policy`, and the three
// `combined state — migrations 035 + 040 + 041` cases (`businesses has exactly
// SELECT + UPDATE policies`, `channel_enrollments has SELECT + UPDATE policies
// only`, `all other table policies from migration 035 are untouched`). A
// table compared byte-for-byte to its own head state necessarily has every
// policy the predecessor enumerated and no policy it did not — the whole
// point of comparing the OBJECT rather than re-deriving a policy count by hand.
//
// ── the two oracles ──────────────────────────────────────────────────────────
//
// ORACLE A (titles 2-3) is the pinned head posture — literals captured
// independently of the migration files by introspecting this container at head
// (2026-09-22). This is what catches a WEAKENED migration: `pnpm test:db:setup`
// provisions the container FROM the migrations under test, so oracle B alone
// is circular — a weakened 040/041 yields a weakened BEFORE reading and
// `AFTER == BEFORE` would pass regardless.
//
// ORACLE B (titles 4-5) degrades both tables to the pre-040 posture inside a
// transaction that ALWAYS rolls back, proves the degrade landed so no case can
// pass vacuously against a no-op migration, applies BOTH checked-in files
// VERBATIM in order, and diffs the whole `public` catalogue against the
// before-read — including every OTHER table (migration 119's off-target
// `GRANT ALL ON admin_audit_log TO anon;` red-team round is why).
//
// ── mutation evidence (#1384, recorded per the carried-forward #1301 rule) ──
//
// Mutated `BUSINESSES_SAFE_COLUMNS` below (removed `'tone'` from the array,
// simulating a 040 that GRANTed one fewer safe column than the real file does
// — the array is compared for EQUALITY, so removing an entry that IS still
// granted makes the comparison fail exactly the way a REGRESSION that widened
// the safe list would) and re-ran this suite against the UNMODIFIED container:
// 2 of 5 cases went red — `businesses and channel_enrollments grant UPDATE
// only on the exact safe-column list…` (oracle A, `AssertionError: … expected
// […9 items, including "tone"…] to deeply equal […8 items…]`) and `re-applying
// 040+041 restores the narrowed grants and removes the restored insert
// policy` (oracle B — its own trailing `restoredBusinessesColumns` check hits
// the same mismatch, one statement after `after.tables.businesses toEqual
// before.tables.businesses` had already passed, which is the expected shape:
// the catalogue-wide comparison cannot see a difference in what the TEST
// itself expects, only the derived-column re-check can). The registry case
// and `re-applying 040+041 moves no other table in public` stayed green,
// exactly as expected — neither reads `BUSINESSES_SAFE_COLUMNS`. Reverted
// immediately after (`diff` against the pre-mutation copy showed zero drift).
// This is the proof the pinned safe-column list is load-bearing.
//
// ── stated limit ────────────────────────────────────────────────────────────
//
// This suite does not seed any row, so the carried-forward `SET CONSTRAINTS
// ALL IMMEDIATE` rule (`users.fk_users_account` is `DEFERRABLE INITIALLY
// DEFERRED`) does not apply here — noted for completeness, not silently
// dropped.
//
// The DB-free registry case is the only one that cannot silently skip; the
// other four sit behind `describeWithDb` and need a database.

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
