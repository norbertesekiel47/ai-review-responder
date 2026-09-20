// Shape + security-posture assertions for migration 118 — `poller_heartbeats`,
// the durable background-loop liveness table (#949). One row is one background
// loop's proof of life: the wall-clock time that loop last COMPLETED a cycle.
//
// WHY THIS TABLE IS LOAD-BEARING. `isJudgeHealthy`
// (src/lib/responses/judge-health.ts) reads it, and Judge availability is a
// POSTING PRECONDITION under architecture invariant #3 — `applyJudgeGate` /
// `applyJudgeGateInTx` (worker/jobs/publisher/judge-gate.ts) and the release
// phase's Judge split both refuse to post when the probe says the Judge is
// unhealthy. A `poller_heartbeats` that lost its deny-all posture, its
// `last_cycle_at` default or its semantics is therefore a change to whether
// RepWorth posts on a customer's behalf, not a change to a bookkeeping table.
//
// Platform-scoped: no `account_id`, so NOT a `TENANT_TABLES` member (it sits in
// `REVIEWED_NOT_TENANT_SCOPED`) and deliberately ABSENT from
// `TABLE_DISPOSITIONS` — the migration header owns both arguments and they are
// not restated here.
//
// ── this suite EXECUTES DDL, deliberately ───────────────────────────────────
//
// It is listed in `MIGRATION_SHAPE_FILES` (`scripts/ci/live-db-suites-audit.ts`)
// — the sanctioned exemption from R2 for suites where APPLYING the migration IS
// the subject — and it takes the cross-process live-DB lock in `beforeAll`, as
// every entry in that set is enforced to do. The predecessor approach for this
// family of suites proved a migration by pattern-matching its SQL TEXT and lost
// five red-team passes on #1171: `CREATE\nPOLICY`, `DISABLE/**/ROW LEVEL
// SECURITY`, `--` inside a string literal, a comment standing in as evidence.
// Each fix closed one lexical class and the next pass found another instance of
// it, so the APPROACH was wrong rather than the code. This suite runs the file
// instead of reading it: PostgreSQL is the parser.
//
// ── the two oracles ─────────────────────────────────────────────────────────
//
// ORACLE A (titles 2-4) pins the HEAD posture from literals captured
// independently of the migration file (`docs/reviews/fix-1301-migration-guard-execution/oracle-a-literals.txt`). This
// is what catches a WEAKENED migration: `pnpm test:db:setup` provisions the
// container FROM the migration under test, so oracle B alone is circular — a
// weakened 118 yields a weakened BEFORE reading and `AFTER == BEFORE` passes
// regardless. That circularity is not specific to index predicates; it applies
// to comments and column defaults exactly as much, which is why title 4 pins
// the table comment, the `last_cycle_at` column comment and the default as the
// catalogue renders it (`now()`) as three INDEPENDENT literals rather than
// asserting they merely exist.
//
// ORACLE B (titles 5-8) degrades `poller_heartbeats` inside a transaction that
// ALWAYS rolls back, proves the degrade landed so no case can pass vacuously
// against a no-op migration, applies the checked-in file VERBATIM, and diffs
// the whole `public` catalogue against the before-read.
//
// ── why the degrade drops the WHOLE table ───────────────────────────────────
//
// 118 is the one migration in #1301's list that may be dropped whole: no later
// migration alters `poller_heartbeats` (122's deny-all sweep names twenty
// tables and this is not one of them), so `DROP TABLE poller_heartbeats`
// followed by a verbatim re-apply reproduces head exactly. The re-created table
// takes a NEW OID, which the catalogue reader tolerates BY DESIGN and not by
// luck: `CataloguedTable.table` is the name and its JSDoc says "Never an OID:
// one suite drops and recreates its table, which changes the OID while nothing
// meaningful changed" — this is that suite. Every dimension the reader renders
// (`pg_get_indexdef`, `pg_get_constraintdef`, `format_type`, `obj_description`,
// `aclexplode`) is OID-resolved at read time, so a new OID changes no rendering.
//
// Because the table is GONE after the degrade, the vacuity check must use the
// table-removal form — `assertTableRemoved(before, degraded, TABLE)`. Any
// property-named form would dereference a table that is not there, and the
// harness raises that explicitly. Dropping the vacuity check instead would be
// the worst of the three options: this is the one suite whose degrade is
// TOTAL, so a silently skipped degrade would be least visible here.
//
// ── why the REVOKE has to be CHALLENGED ─────────────────────────────────────
//
// Migration 122 stripped the owner's schema-level default table privileges, and
// the test container carries NO `pg_default_acl` entry at all (verified
// 2026-09-20: `SELECT count(*) FROM pg_default_acl` returns 0). A fresh
// `CREATE TABLE` therefore grants `anon` and `authenticated` NOTHING, so 118's
// own `REVOKE ALL ... FROM anon, authenticated` would have nothing to remove
// and title 7 would pass with that line DELETED from the migration. The degrade
// restores permissive defaults FIRST:
//
//   ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON TABLES TO anon, authenticated;
//   DROP TABLE poller_heartbeats;
//
// so the re-created table INHERITS every client privilege and 118's REVOKE is
// the only thing that can take them away. Title 7 proves the inheritance is
// real rather than asserting it: it creates a throwaway probe table under the
// same default ACL and reads every derived privilege off the probe's own grants
// before dropping it.
//
// Two hazards in that step, both MEASURED rather than assumed (2026-09-20, this
// container):
//   * `ALTER DEFAULT PRIVILEGES` affects only tables created AFTERWARDS, so it
//     must not perturb existing ones — after the statement, zero tables in
//     `public` carried `anon` in `relacl`, and title 6's
//     `assertOnlyTablesMoved` reports `poller_heartbeats` as the only mover.
//   * It must roll back with the transaction — `pg_default_acl` read OUTSIDE
//     the transaction is unchanged afterwards, which title 7 asserts on every
//     run rather than trusting the one measurement.
//
// ── stated limits ───────────────────────────────────────────────────────────
//
// TWO, and the first was previously written as "None".
//
// 1. THE `CREATE TABLE` BODY IS NOT INDEPENDENTLY PROVEN HERE. The whole table
//    is dropped and re-created, so every object 118 declares — both columns
//    with their types and nullability, the natural-key primary index and
//    constraint, the table comment, the column comment, the `last_cycle_at`
//    default, RLS enabled with zero policies, and the client-role REVOKE — is
//    produced by the executing cases. But "produced by the executing cases"
//    and "proven" are not the same thing: the comment, the default and the
//    column comment carry PINNED LITERALS below and are genuinely proven,
//    while the rest are proven only by the `after == before` comparison this
//    very header calls circular (#1301 F-H). The independent literals for the
//    table body live in `helpers/migration-guard.integration.test.ts`, whose
//    `readPublicCatalogue reports every catalogue dimension for a known table`
//    case pins them for `poller_heartbeats` off a container at head. That is
//    the file to change if the table's shape changes — not this one.
//
// 2. THE SCHEMA DEFAULT ACLs ARE NOT RESTORED BY 118, and this suite no longer
//    implies they are. Measured through the whole cycle on PostgreSQL 17.11:
//    the degrade's `ALTER DEFAULT PRIVILEGES … GRANT ALL` survives the
//    re-apply, all sixteen entries intact. 118's REVOKE reaches what its own
//    TABLE inherited; the schema-level default is migration 122's subject.
//    Both off-target calls declare `{ schemaDefaultAcls: 'changed' }`, which
//    is an assertion — it throws if nothing changed — not an exemption.
//
// Unlike 117, no `CREATE TABLE IF NOT EXISTS` is skipped here, because the
// table really is absent when the file runs.
//
// The DB-free registry case is the only one that cannot silently skip; every
// other case sits behind `describeWithDb` and needs a database.

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
  assertSchemaReady,
  MIGRATION_118_POLLER_HEARTBEATS,
} from '@/lib/shared/__tests__/helpers/schema-ready';
import {
  assertTableRemoved,
  clientGrantNames,
  CLIENT_ROLES,
  deriveColumnPrivileges,
  deriveTablePrivileges,
  assertOnlyTablesMoved,
  readMigrationSql,
  readPublicCatalogue,
  schemaOnly,
  withRolledBackTransaction,
} from '@/lib/shared/__tests__/helpers/migration-guard';
import { auditLiveDbFile } from '../../../../scripts/ci/live-db-suites-audit';

const TABLE = 'poller_heartbeats';
const MIGRATION_FILE = '118_poller_heartbeats.sql';
const SUITE_FILE = 'src/lib/shared/__tests__/migration-118-poller-heartbeats.integration.test.ts';
const BEHIND_HEAD =
  'poller_heartbeats posture is not at migration head — run pnpm test:db:setup';

/**
 * A throwaway table created under the degraded (permissive) default ACL, purely
 * so title 7 can OBSERVE the inheritance it depends on. It is created and
 * dropped inside the same rolled-back transaction, before the degraded
 * catalogue is read, so it never appears in a catalogue any assertion compares.
 */
const DEFAULT_ACL_PROBE_TABLE = 'poller_heartbeats_default_acl_probe';

// ── ORACLE A literals, from `docs/reviews/fix-1301-migration-guard-execution/oracle-a-literals.txt` ────────────────
//
// Captured by introspecting the container, DELIBERATELY not derived from the
// migration file: that independence is the whole point. A literal copied out of
// `118_poller_heartbeats.sql` would agree with a weakened 118 by construction.

const TABLE_COMMENT =
  'Durable background-loop liveness (#949): one row per poller, last_cycle_at = the time that loop last COMPLETED a cycle. Platform-scoped — no account_id, not a tenant table, not in TABLE_DISPOSITIONS. Deny-all RLS with client-role privileges revoked. Written only by recordPollerCycle (src/lib/shared/poller-liveness.ts); each poller name has exactly one writer.';

const LAST_CYCLE_AT_COMMENT =
  'Set to NOW() after a cycle finishes WITHOUT throwing. A failed or still-running cycle deliberately leaves it stale — a cycle that did not complete is not proof of life.';

/** As the CATALOGUE renders it, not as the migration spells it (`NOW()`). */
const LAST_CYCLE_AT_DEFAULT = 'now()';

const testDatabaseUrl = resolveTestDatabaseUrl();

let db: postgresType.Sql | undefined;
let featureDatabaseLock: LiveDbLock | undefined;

function sql(): postgresType.Sql {
  if (!db) throw new Error('migration 118 integration database was not initialized');
  return db;
}

/**
 * The degrade, in the order that makes 118's REVOKE falsifiable: permissive
 * default privileges FIRST, so the table the migration re-creates inherits
 * them, THEN the drop.
 */
async function degrade(tx: postgresType.TransactionSql): Promise<void> {
  await tx.unsafe(
    'ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON TABLES TO anon, authenticated;',
  );
  await tx.unsafe('DROP TABLE poller_heartbeats;');
}

/** The owner's schema-level default table ACL, as text — read to prove it rolls back. */
async function readDefaultTableAcl(handle: postgresType.Sql): Promise<string[]> {
  const rows = await handle<{ entry: string }[]>`
    SELECT defaclrole::regrole::text || '|' || defaclobjtype::text || '|'
             || defaclnamespace::regnamespace::text || '|' || coalesce(defaclacl::text, '(null)')
             AS entry
      FROM pg_default_acl
     ORDER BY 1
  `;
  return rows.map((row) => row.entry);
}

// ── registry: no database needed, so this one can never silently skip ───────

describe('migration 118 registries', () => {
  it('migration 118 suite is registered in MIGRATION_SHAPE_FILES', () => {
    // `MIGRATION_SHAPE_FILES` is a module-private `const` inside
    // `scripts/ci/live-db-suites-audit.ts` — not exported — so this case reads
    // its EFFECT through the audit's own exported entry point rather than the
    // set. That is STRONGER than a membership read, not a weakened stand-in:
    // this file's real checked-in text executes DDL (several `.unsafe()` calls
    // below) and names the cross-process lock marker, so running the real audit
    // over that real text yields zero findings ONLY because this exact path is
    // an allowlist member AND the lock call is present. Drop the entry, typo
    // it, or rename `acquireLiveDbLock` away and this case reports a
    // `runtime-ddl` or `unlocked-ddl` finding — a membership read would catch
    // the first two and miss the third.
    const ownSourceText = readFileSync(join(process.cwd(), SUITE_FILE), 'utf8');
    expect(auditLiveDbFile(SUITE_FILE, ownSourceText)).toEqual([]);
  });
});

describeWithDb(
  'migration 118 poller_heartbeats',
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
      // Behind-head detector with an ACTIONABLE message. Every case below
      // either reads or drops this table, and a container provisioned from a
      // draft that stopped at the CREATE TABLE would otherwise fail with an
      // undefined-column error mid-degrade instead of naming the fix.
      await assertSchemaReady(db, [MIGRATION_118_POLLER_HEARTBEATS]);
    }, LIVE_DB_LOCK_HOOK_TIMEOUT_MS);

    afterAll(async () => {
      try {
        if (db) await db.end({ timeout: 5 });
      } finally {
        await featureDatabaseLock?.release();
        featureDatabaseLock = undefined;
      }
    }, LIVE_DB_LOCK_HOOK_TIMEOUT_MS);

    // ── ORACLE A: pinned head posture, independent of the migration file ────

    it('poller_heartbeats carries row security enabled and no policy at head', async () => {
      const [security] = await sql()<
        { rls_enabled: boolean; rls_forced: boolean; policy_count: string }[]
      >`
        SELECT
          cls.relrowsecurity AS rls_enabled,
          cls.relforcerowsecurity AS rls_forced,
          (
            SELECT count(*)::text FROM pg_policies
             WHERE schemaname = 'public' AND tablename = ${TABLE}
          ) AS policy_count
        FROM pg_class cls
        WHERE cls.oid = 'public.poller_heartbeats'::regclass
      `;

      // Literals from `docs/reviews/fix-1301-migration-guard-execution/oracle-a-literals.txt` ("row security posture
      // at head"): poller_heartbeats: rowsecurity=true force=false policies=0.
      expect(security?.rls_enabled, BEHIND_HEAD).toBe(true);

      // Zero policies IS the guarantee, not an omission: deny-all is the
      // design. `recordPollerCycle` reaches the table through the
      // RLS-bypassing Postgres.js owner role, so any policy at all would be a
      // wider door than the product needs.
      expect(security?.policy_count, BEHIND_HEAD).toBe('0');

      // FORCE stays OFF: Postgres exempts a table's OWNER from RLS only while
      // FORCE is off, and the owner role is the table's only writer. Turning
      // FORCE on with zero policies would lock `recordPollerCycle` out and
      // freeze every poller's proof of life — which `isJudgeHealthy` would then
      // read as a dead Judge, blocking posting under invariant #3.
      expect(security?.rls_forced, BEHIND_HEAD).toBe(false);
    });

    it('poller_heartbeats grants no privilege to anon or authenticated at head', async () => {
      // Oracle A, "client-role grants on the four deny-all tables — MUST be
      // empty at head". Asked three ways, because each arm closes a hole the
      // others leave open (the three-arm shape migration 119's suite reached
      // over five red-team passes).

      // ARM A — the ACL itself, table AND column, via `aclexplode`. This is
      // ground truth a superuser's implicit privileges cannot mask, and it
      // covers EVERY privilege type rather than the two an enumeration
      // remembered to name — including TRUNCATE, which row policies do not
      // restrain at all. Grantee OID 0 (`PUBLIC`) is matched explicitly: a
      // filter on grantee NAME alone let `GRANT ... TO PUBLIC` through with
      // 119's suite fully green.
      const acl = await sql()<{ role: string; privilege_type: string; scope: string }[]>`
        SELECT acl.grantee::regrole::text AS role, acl.privilege_type, 'table' AS scope
          FROM pg_class cls
          CROSS JOIN LATERAL aclexplode(cls.relacl) AS acl
         WHERE cls.oid = 'public.poller_heartbeats'::regclass
           AND (acl.grantee = 0 OR acl.grantee::regrole::text IN ('anon', 'authenticated'))
        UNION ALL
        SELECT acl.grantee::regrole::text, acl.privilege_type, 'column'
          FROM pg_attribute att
          CROSS JOIN LATERAL aclexplode(att.attacl) AS acl
         WHERE att.attrelid = 'public.poller_heartbeats'::regclass
           AND (acl.grantee = 0 OR acl.grantee::regrole::text IN ('anon', 'authenticated'))
         ORDER BY 3, 1, 2
      `;
      expect(acl, BEHIND_HEAD).toEqual([]);

      // ARM B — EFFECTIVE privilege, which is a different question: it also
      // catches a grant reaching a client role through role MEMBERSHIP, and a
      // grant whose text never contains the word GRANT. The privilege list is
      // DERIVED from `acldefault`, never spelled — see
      // `deriveTablePrivileges`. `has_table_privilege` is sound for these two
      // roles (both NOLOGIN, non-superuser, `rolinherit = true`).
      const effective = await sql()<{ role: string; privilege_type: string }[]>`
        WITH server_privileges AS (
          SELECT DISTINCT acl.privilege_type
            FROM aclexplode(acldefault('r', (
                   SELECT relowner FROM pg_class WHERE oid = 'public.poller_heartbeats'::regclass
                 ))) AS acl
        ),
        client_roles AS (SELECT unnest(${[...CLIENT_ROLES]}::text[]) AS role)
        SELECT client_roles.role, server_privileges.privilege_type
          FROM client_roles
          CROSS JOIN server_privileges
         WHERE has_table_privilege(
                 client_roles.role, 'public.poller_heartbeats', server_privileges.privilege_type
               )
         ORDER BY 1, 2
      `;
      expect(effective, BEHIND_HEAD).toEqual([]);

      // Arm B fails OPEN if the derived list is ever empty — an empty CROSS
      // JOIN yields no rows and the assertion above passes vacuously.
      const [derived] = await sql()<{ privilege_count: string }[]>`
        SELECT count(DISTINCT acl.privilege_type)::text AS privilege_count
          FROM aclexplode(acldefault('r', (
                 SELECT relowner FROM pg_class WHERE oid = 'public.poller_heartbeats'::regclass
               ))) AS acl
      `;
      expect(Number(derived?.privilege_count)).toBeGreaterThanOrEqual(7);

      // ARM C — COLUMN-level effective privilege: the intersection A and B
      // leave open between them, since Arm A filters on grantee NAME and Arm
      // B's `has_table_privilege` does not consider column grants at all. A
      // column grant to a role `anon` INHERITS is named nowhere Arm A looks and
      // is invisible to Arm B. The column-level privilege set is DERIVED, not
      // spelled: `acldefault('c', …)` is empty, so `deriveColumnPrivileges`
      // asks `has_column_privilege` about each of this major's table
      // privileges and keeps the ones it recognises. The literal it replaces
      // restated its own length, so it could not have failed on a PostgreSQL
      // that added a fifth (#1301 RT-7); this does.
            const columnPrivileges = await deriveColumnPrivileges(sql(), 'poller_heartbeats', 'poller_name');
      // The floor lives in `deriveColumnPrivileges`, which THROWS below four, so a
      // silently narrowed probe never reaches this assertion (#1301 RT2-1).
      expect(columnPrivileges).toContain('SELECT');
      const columnEffective = await sql()<
        { role: string; attname: string; privilege_type: string }[]
      >`
        WITH column_privileges AS (SELECT unnest(${columnPrivileges}::text[]) AS privilege_type),
        client_roles AS (SELECT unnest(${[...CLIENT_ROLES]}::text[]) AS role)
        SELECT client_roles.role, att.attname, column_privileges.privilege_type
          FROM client_roles
          CROSS JOIN column_privileges
          JOIN pg_attribute att
            ON att.attrelid = 'public.poller_heartbeats'::regclass
           AND att.attnum > 0
           AND NOT att.attisdropped
         WHERE has_column_privilege(
                 client_roles.role, 'public.poller_heartbeats', att.attname,
                 column_privileges.privilege_type
               )
         ORDER BY 1, 2, 3
      `;
      expect(columnEffective, BEHIND_HEAD).toEqual([]);
    });

    it('poller_heartbeats pins its table comment, column comment and last_cycle_at default at head', async () => {
      // Three INDEPENDENT literals from `docs/reviews/fix-1301-migration-guard-execution/oracle-a-literals.txt`
      // ("118 comments and default"). Independence is the point: without them,
      // the executing cases below prove only that the re-apply reproduced
      // whatever the container already had — the circular oracle. A comment and
      // a column default are circular in exactly the way an index predicate is,
      // so all three are pinned rather than compared.
      const [row] = await sql()<
        {
          table_comment: string | null;
          column_comment: string | null;
          column_default: string | null;
        }[]
      >`
        SELECT
          obj_description('public.poller_heartbeats'::regclass, 'pg_class') AS table_comment,
          col_description('public.poller_heartbeats'::regclass, att.attnum) AS column_comment,
          pg_get_expr(def.adbin, def.adrelid) AS column_default
        FROM pg_attribute att
        LEFT JOIN pg_attrdef def ON def.adrelid = att.attrelid AND def.adnum = att.attnum
        WHERE att.attrelid = 'public.poller_heartbeats'::regclass
          AND att.attname = 'last_cycle_at'
      `;

      expect(row?.table_comment, BEHIND_HEAD).toBe(TABLE_COMMENT);
      expect(row?.column_comment, BEHIND_HEAD).toBe(LAST_CYCLE_AT_COMMENT);
      // `NOW()` in the migration, `now()` in the catalogue — the rendering is
      // what a re-apply has to reproduce, so the rendering is what is pinned.
      expect(row?.column_default, BEHIND_HEAD).toBe(LAST_CYCLE_AT_DEFAULT);
    });

    // ── ORACLE B: degrade, prove it landed, apply verbatim, diff ────────────

    it('re-applying 118 restores the table after it is dropped', async () => {
      // `withRolledBackTransaction` ALWAYS rolls back, which is what makes
      // dropping a table on the SHARED container safe: the drop, the permissive
      // default ACL and the re-apply all vanish when the sentinel fires.
      await withRolledBackTransaction(sql(), async (tx) => {
        const before = await readPublicCatalogue(tx);
        await degrade(tx);
        const degraded = await readPublicCatalogue(tx);

        // The table-removal form. Any property-named form would dereference a
        // table that is not there — and dropping the vacuity check instead
        // would be worse here than anywhere else in #1301, because this is the
        // one suite whose degrade is TOTAL.
        assertTableRemoved(before, degraded, TABLE);

        await tx.unsafe(readMigrationSql(MIGRATION_FILE));
        const after = await readPublicCatalogue(tx);

        // Every dimension at once: columns with types and nullability, the
        // natural-key primary index and constraint, the table and column
        // comments, the `last_cycle_at` default, RLS on / FORCE off / zero
        // policies, and the grant list. The re-created table carries a NEW OID;
        // the catalogue is keyed on NAME and every rendering is OID-resolved at
        // read time, so a new OID changes nothing here — the guarantee
        // `CataloguedTable.table`'s JSDoc states for exactly this suite.
        //
        // SCHEMA only, and the reason is this degrade specifically: it is
        // `DROP TABLE`, so the re-applied table is EMPTY whatever the table
        // held before. Row loss here is the degrade, not a regression, and
        // `poller_heartbeats` really does carry committed rows on a shared
        // container — a live poller writes one. Comparing `rowDigest` across
        // a drop would assert that the migration recreates rows it cannot see.
        // Every other dimension is still compared. See `schemaOnly`'s JSDoc.
        const afterTable = after.tables[TABLE];
        const beforeTable = before.tables[TABLE];
        if (!afterTable || !beforeTable) {
          throw new Error(`readPublicCatalogue did not return ${TABLE}`);
        }
        expect(schemaOnly(afterTable)).toEqual(schemaOnly(beforeTable));

        // And the row half, stated rather than dropped: a re-created table is
        // empty. That is the whole of what this degrade does to rows.
        expect(afterTable.rowDigest).toBe('empty rows=0');
      });
    });

    it('re-applying 118 moves no other table in public', async () => {
      await withRolledBackTransaction(sql(), async (tx) => {
        const before = await readPublicCatalogue(tx);
        await degrade(tx);
        const degraded = await readPublicCatalogue(tx);
        assertTableRemoved(before, degraded, TABLE);

        // `ALTER DEFAULT PRIVILEGES` affects only tables created AFTERWARDS,
        // so it must leave every existing table alone. This assertion is that
        // check as much as it is the off-target-DDL check: if the statement
        // perturbed a live table's ACL, it would be reported here as a mover.
        //
        // `schemaDefaultAcls: 'changed'` is an ASSERTION, not an exemption:
        // the degrade performs `ALTER DEFAULT PRIVILEGES … GRANT ALL`, so
        // `pg_default_acl` must have moved, and the call FAILS if it did not.
        // Before the catalogue read `pg_default_acl` at all, this suite
        // performed the one statement it could not detect, and appending that
        // same statement to a migration survived 4 of 4 red-team runs
        // (#1301 RT-4).
        assertOnlyTablesMoved(before, degraded, [TABLE], { schemaDefaultAcls: 'changed' });

        await tx.unsafe(readMigrationSql(MIGRATION_FILE));
        const after = await readPublicCatalogue(tx);

        // A migration may harden the one table it names while doing arbitrary
        // damage elsewhere: appending `GRANT ALL ON admin_audit_log TO anon;`
        // to migration 119 passed its whole suite once, and the grant really
        // landed (#1171). Every table outside `[poller_heartbeats]` must come
        // out byte-identical — RLS flags, policies, columns, indexes,
        // constraints, comments, both table and column ACLs, and the row
        // digest.
        //
        // `'changed'` again, and the reason is a MEASURED boundary rather than
        // a convenience. Re-applying 118 does NOT put `pg_default_acl` back:
        // measured through the whole cycle on PostgreSQL 17, all eight
        // privileges for both `anon` and `authenticated` survive the re-apply.
        // 118's REVOKE reaches what its own TABLE inherited, which the
        // "revokes every client privilege inherited from permissive default
        // ACLs" case proves directly; the SCHEMA default is migration 122's
        // subject, not 118's. Asserting `'unchanged'` here would be asserting
        // something false, and asserting nothing is how RT-4 got in.
        assertOnlyTablesMoved(before, after, [TABLE], { schemaDefaultAcls: 'changed' });
      });
    });

    it('re-applying 118 revokes every client privilege inherited from permissive default ACLs', async () => {
      // THE CHALLENGED REVOKE. Read the owner's default table ACL OUTSIDE the
      // transaction first, so the rollback can be verified rather than assumed:
      // a degrade that leaked `ALTER DEFAULT PRIVILEGES` out of the transaction
      // would silently re-grant every client privilege on every table created
      // afterwards, corrupting the shared container for every other suite.
      const defaultAclBefore = await readDefaultTableAcl(sql());

      await withRolledBackTransaction(sql(), async (tx) => {
        const before = await readPublicCatalogue(tx);

        // Step 1 of the degrade on its own, so the inheritance can be OBSERVED
        // before the table goes away.
        await tx.unsafe(
          'ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON TABLES TO anon, authenticated;',
        );

        const privileges = await deriveTablePrivileges(tx, TABLE);
        const inheritedGrants = clientGrantNames(privileges);

        // PROOF that the challenge is real, not an assumption. Migration 122
        // stripped the owner's schema-level default table privileges and this
        // container carries no `pg_default_acl` entry at all, so a fresh
        // `CREATE TABLE` normally grants the client roles NOTHING — which would
        // make 118's REVOKE unfalsifiable and let title 7 pass with that line
        // DELETED. A throwaway probe table created under the restored
        // permissive default ACL shows what the re-created `poller_heartbeats`
        // is about to inherit.
        await tx.unsafe(`CREATE TABLE ${DEFAULT_ACL_PROBE_TABLE} (probe integer);`);
        const probed = await readPublicCatalogue(tx);
        const probeGrantNames = (probed.tables[DEFAULT_ACL_PROBE_TABLE]?.grants ?? []).map(
          (entry) => entry.name,
        );
        for (const grant of inheritedGrants) {
          expect(
            probeGrantNames,
            'a table created under the degraded default ACL did not inherit the client grants, so 118\'s REVOKE would have nothing to remove',
          ).toContain(grant);
        }
        await tx.unsafe(`DROP TABLE ${DEFAULT_ACL_PROBE_TABLE};`);

        // Step 2: the table itself. The probe is already gone, so the degraded
        // catalogue differs from `before` in exactly one table.
        await tx.unsafe('DROP TABLE poller_heartbeats;');
        const degraded = await readPublicCatalogue(tx);
        assertTableRemoved(before, degraded, TABLE);

        await tx.unsafe(readMigrationSql(MIGRATION_FILE));
        const after = await readPublicCatalogue(tx);

        // The re-created table inherited every privilege the probe proved is
        // inheritable; 118's `REVOKE ALL ... FROM anon, authenticated` is the
        // only statement in the file that can remove them. Asserting the whole
        // derived set — rather than SELECT alone — is what distinguishes
        // `REVOKE ALL` from `REVOKE SELECT`: with only SELECT checked, a
        // migration weakened to `REVOKE SELECT` would still pass.
        const afterGrantNames = (after.tables[TABLE]?.grants ?? []).map((entry) => entry.name);
        for (const grant of inheritedGrants) {
          expect(afterGrantNames).not.toContain(grant);
        }

        // The POSITIVE half, and the twin of `117:664`. `not.toEqual([])` was
        // standing in for it: a non-empty list proves only that SOMETHING
        // survived, not that the right things did, so a revoke that also
        // caught the owner would pass it as long as one grant remained
        // (#1301 RT-13). Comparing the whole grant list against `before`
        // states the real contract — the re-apply restores exactly the ACL the
        // table had, grantor and GRANT OPTION included — and it subsumes the
        // proxy, because `before` is never empty.
        expect(after.tables[TABLE]?.grants).toEqual(before.tables[TABLE]?.grants);
      });

      // And the hazard the brief for this suite calls the riskiest step in
      // #1301: `ALTER DEFAULT PRIVILEGES` must roll back with the transaction.
      // Asserted on EVERY run, not trusted to a one-off measurement.
      expect(await readDefaultTableAcl(sql())).toEqual(defaultAclBefore);
    });

    it('re-applying 118 restores the last_cycle_at default and column comment', async () => {
      await withRolledBackTransaction(sql(), async (tx) => {
        const before = await readPublicCatalogue(tx);
        await degrade(tx);
        const degraded = await readPublicCatalogue(tx);
        assertTableRemoved(before, degraded, TABLE);

        await tx.unsafe(readMigrationSql(MIGRATION_FILE));
        const after = await readPublicCatalogue(tx);
        const table = after.tables[TABLE];

        // PINNED literals, not a comparison against `before`. Comparing to the
        // before-read is the circular oracle: `pnpm test:db:setup` provisions
        // the container FROM this migration, so a 118 that lost its
        // `COMMENT ON COLUMN` or its `DEFAULT NOW()` yields a before-read
        // missing them too, and `AFTER == BEFORE` passes. These three assertions
        // are what make the executing case catch a weakened file on a freshly
        // provisioned database.
        expect(
          table?.columnDefaults.find((entry) => entry.name === 'last_cycle_at')?.definition,
        ).toBe(LAST_CYCLE_AT_DEFAULT);
        expect(
          table?.columnComments.find((entry) => entry.name === 'last_cycle_at')?.definition,
        ).toBe(LAST_CYCLE_AT_COMMENT);
        expect(table?.comment).toBe(TABLE_COMMENT);

        // `last_cycle_at` is the ONLY column with a default and the ONLY one
        // with a comment: an exact-name lookup above would pass if the reader
        // (or the migration) had attached them to the wrong column as well, so
        // the inventory is pinned too.
        expect(table?.columnDefaults.map((entry) => entry.name)).toEqual(['last_cycle_at']);
        expect(table?.columnComments.map((entry) => entry.name)).toEqual(['last_cycle_at']);
      });
    });
  },
);
