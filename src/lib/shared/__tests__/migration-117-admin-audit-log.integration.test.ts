// Shape + behaviour assertions for migration 117 — `admin_audit_log`, the
// admin control-plane actor trail (#468). One row is one action taken by an
// ADMIN, keyed on the admin's `users.id`, with no `account_id` by design:
// admins carry `role='admin'` and a NULL `account_id`, so the per-account
// `account_audit_log` (034) had no sink for them at all. Because the table
// carries no tenant column it sits OUTSIDE `TENANT_TABLES`, and `ci:rls-audit`
// audits only that list — so THIS suite is the regression guard for the
// security boundary: RLS enabled with zero policies, client-role privileges
// revoked, two indexes, an FK with no referential action, and the real writer
// (`writeAdminAuditLog`) actually persisting a row.
//
// ── this suite now EXECUTES DDL, deliberately (#1301) ───────────────────────
//
// It is listed in `MIGRATION_SHAPE_FILES` (`scripts/ci/live-db-suites-audit.ts`)
// — the sanctioned exemption from R2 for suites where APPLYING the migration IS
// the subject — and it takes the cross-process live-DB lock in `beforeAll`, as
// every entry in that set is enforced to do. Before #1301 this file executed no
// DDL and its header said so; that sentence has been replaced rather than
// quietly dropped, because the reason it changed is the whole point of the
// rebuild.
//
// WHY. One case here proved the migration by pattern-matching its SQL TEXT, and
// that approach lost five red-team passes on #1171: a newline inside
// `CREATE\nPOLICY`, a block comment inside `DISABLE/**/ROW LEVEL SECURITY`,
// `--` inside a string literal, and a comment standing in as evidence, among
// others. Each fix closed one lexical class and the next pass found another
// instance of it. The verdict was that the APPROACH was wrong, not the code —
// a hand-rolled lexer keeps losing to the construct nobody enumerated. So the
// text-matching case is gone and the file is RUN instead of read: PostgreSQL is
// the parser now.
//
// ── the retired text-matching case, and where each of its four assertions went
//
// RETIRED: `the migration file enables RLS with no policy and revokes the
// client roles`. It read `117_admin_audit_log.sql` off disk and matched four
// regexes. `ci:weakened-checks` will report this file as having lost `expect(`
// calls and assign the explanation to a reviewer; this paragraph is that
// explanation. Every one of the four HAS a catalogue equivalent, so none is
// retired for want of one — each moved from "the file spells it" to "the
// database is in that state":
//
//   * `/ALTER TABLE admin_audit_log ENABLE ROW LEVEL SECURITY;/`
//       → `admin_audit_log carries row security enabled and no policy at head`
//         (`pg_class.relrowsecurity`), plus the executing case, which turns RLS
//         OFF and proves the file turns it back on.
//   * `not /CREATE POLICY/i`
//       → the `pg_policies` count of `'0'` in the same head case, which catches
//         a policy created by ANY spelling — including one this regex never
//         saw, which is precisely how the regex lost.
//   * `/REVOKE ALL ON admin_audit_log FROM anon, authenticated;/`
//       → `admin_audit_log grants no privilege to anon or authenticated at head`
//         (three arms over `aclexplode` / `has_table_privilege` /
//         `has_column_privilege`) and `re-applying 117 revokes every PostgreSQL
//         17 table privilege from both client roles`, which GRANTS every
//         privilege back and proves the file removes all of them. The text
//         match could not tell `REVOKE ALL` from `REVOKE SELECT` spelled
//         creatively; the derived-privilege pair can.
//   * `/actor_user_id UUID NOT NULL REFERENCES users\(id\),/` and
//     `not /ON DELETE (CASCADE|SET NULL|SET DEFAULT)/i`
//       → the preserved ten-column inventory (type + `NOT NULL`) and the
//         preserved FK case, which reads `confdeltype = 'a'` AND proves the
//         behaviour with a real `23503`. A referential action added anywhere
//         ELSE in the file would have tripped the old blanket regex and is
//         caught here by `re-applying 117 moves no other table in public`.
//
// Nothing else was removed. Seven pre-#1301 cases are preserved UNCHANGED on a
// plan reviewer's explicit instruction: the `REVIEWED_NOT_TENANT_SCOPED` /
// `TENANT_TABLES` membership case with its `actor_user_id` rationale, the
// RLS-true / FORCE-false / zero-policies / role-privilege block, the ten-column
// inventory, the two index cases, the FK `NO ACTION` case with its `23503`
// behavioural assertion, the real-writer round-trip, and the missing-actor
// `23503` case.
//
// ── the two oracles ─────────────────────────────────────────────────────────
//
// ORACLE A (the head cases) pins the posture the container actually carries
// after `pnpm test:db:setup`, from literals captured independently of the
// migration file (`docs/reviews/fix-1301-migration-guard-execution/oracle-a-literals.txt`). This is what catches a
// WEAKENED migration: `pnpm test:db:setup` provisions the container FROM the
// migration under test, so oracle B alone is circular — a weakened 117 yields a
// weakened BEFORE reading and `AFTER == BEFORE` would pass regardless.
//
// ORACLE B (the three `re-applying 117 …` cases) degrades `admin_audit_log`
// inside a transaction that ALWAYS rolls back, proves the degrade landed so no
// case can pass vacuously, applies the checked-in file VERBATIM, and diffs the
// whole `public` catalogue against the before-read.
//
// ── the degrade GRANTS, and why it grants ALL ───────────────────────────────
//
// `GRANT ALL ON admin_audit_log TO anon, authenticated` — not `GRANT SELECT`.
// Granting only SELECT cannot distinguish `REVOKE ALL` from `REVOKE SELECT`:
// both leave a SELECT-only grant revoked, so the case would pass against a
// migration weakened to `REVOKE SELECT`. Granting every privilege and asserting
// every one is gone is what makes the two distinguishable.
//
// The privilege list is DERIVED (`aclexplode(acldefault('r', <owner oid>))`) and
// NEVER spelled: PostgreSQL 16 defines seven table privileges and 17 defines
// eight (17 adds `MAINTAIN`), so a hardcoded list breaks on one major or the
// other. This repo learned that the hard way — migration 122 carries a
// `server_version_num` guard for the same keyword.
//
// The grant half of the degrade moves in the OPPOSITE direction to the rest of
// it: it ADDS privileges where the index and RLS halves REMOVE an object and a
// flag. So it uses the harness's `present` selector, not `absent` —
// `assertDegradeLanded`'s JSDoc requires an additive degrade to name objects
// that were NOT in `before` and ARE in `after`, and passing `absent` for them
// would fail as vacuous by construction.
//
// ── stated limit ────────────────────────────────────────────────────────────
//
// The `CREATE TABLE` body is NOT guarded by the executing cases. 117 opens with
// `CREATE TABLE IF NOT EXISTS`, the table exists at head, and the degrade
// deliberately does not drop it (unlike 118, whose table no later migration
// touches, `admin_audit_log` is the actor trail every admin action writes to
// and leaving it in place keeps the degrade to the three properties 117's later
// statements own) — so PostgreSQL skips that statement with a notice and the
// columns it declares are never re-created inside the transaction. The
// preserved head cases are what guard it: the ten-column inventory with exact
// types, nullability and defaults, the two index definitions, and the actor
// FK's `NO ACTION`. Oracle A owns the table body; oracle B owns RLS, the grants
// and the indexes.
//
// The two registry cases need no database and so can never silently skip; every
// other case sits behind `describeWithDb`.

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import postgres from 'postgres';
import type postgresType from 'postgres';
import { describeWithDb } from '@/__tests__/helpers/describe-with-db';
import { writeAdminAuditLog } from '@/lib/audit/log';
import {
  acquireLiveDbLock,
  assertLocalTestDatabaseUrl,
  LIVE_DB_LOCK_HOOK_TIMEOUT_MS,
  resolveTestDatabaseUrl,
  type LiveDbLock,
} from '@/lib/shared/__tests__/helpers/live-db-lock';
import {
  assertSchemaReady,
  MIGRATION_117_ADMIN_AUDIT_LOG,
} from '@/lib/shared/__tests__/helpers/schema-ready';
import {
  assertDegradeLanded,
  clientGrantNames,
  CLIENT_ROLES,
  deriveColumnPrivileges,
  deriveTablePrivileges,
  assertOnlyTablesMoved,
  nonEmptyNames,
  readMigrationSql,
  readPublicCatalogue,
  withRolledBackTransaction,
} from '@/lib/shared/__tests__/helpers/migration-guard';
import { auditLiveDbFile } from '../../../../scripts/ci/live-db-suites-audit';
import {
  REVIEWED_NOT_TENANT_SCOPED,
  TENANT_TABLES,
} from '../../../../scripts/ci/tenant-tables';

const TABLE = 'admin_audit_log';
const MIGRATION_FILE = '117_admin_audit_log.sql';
const SUITE_FILE = 'src/lib/shared/__tests__/migration-117-admin-audit-log.integration.test.ts';
const ACTOR_INDEX = 'idx_admin_audit_actor_created';
const EVENT_INDEX = 'idx_admin_audit_event_created';
const ACTOR_FK = 'admin_audit_log_actor_user_id_fkey';
const FOREIGN_KEY_VIOLATION = '23503';
const BEHIND_HEAD = 'admin_audit_log posture is not at migration head — run pnpm test:db:setup';

const TABLE_COMMENT =
  'Admin control-plane actor trail (#468): one row per admin action, keyed on the admin ' +
  'user; no account_id by design. Admin-only (deny-all RLS, client-role privileges ' +
  'revoked). Keep forever. The only writer is writeAdminAuditLog (src/lib/audit/log.ts); ' +
  'application code supplies UUIDv7 ids.';

const testDatabaseUrl = resolveTestDatabaseUrl();

let db: postgresType.Sql | undefined;
let featureDatabaseLock: LiveDbLock | undefined;
let adminUserId: string | undefined;

function sql(): postgresType.Sql {
  if (!db) throw new Error('migration 117 integration database was not initialized');
  return db;
}

function admin(): string {
  if (!adminUserId) throw new Error('migration 117 integration admin was not seeded');
  return adminUserId;
}

/**
 * The three properties 117 establishes, undone. The grant half moves in the
 * OPPOSITE direction to the other two, which is why the assertions on it use
 * `present` rather than `absent`.
 */
async function degrade(tx: postgresType.TransactionSql): Promise<void> {
  await tx.unsafe('GRANT ALL ON admin_audit_log TO anon, authenticated;');
  await tx.unsafe(`DROP INDEX public.${ACTOR_INDEX}, public.${EVENT_INDEX};`);
  await tx.unsafe('ALTER TABLE admin_audit_log DISABLE ROW LEVEL SECURITY;');
}

// ── registry + audit wiring: no database needed, so never a silent skip ─────

describe('migration 117 registries', () => {
  it('admin_audit_log is REVIEWED_NOT_TENANT_SCOPED and NOT a TENANT_TABLES member', () => {
    const reviewed = REVIEWED_NOT_TENANT_SCOPED.find((entry) => entry.table === TABLE);
    expect(reviewed?.reason).toMatch(/actor_user_id/);
    const tenantTables: readonly string[] = TENANT_TABLES;
    expect(tenantTables).not.toContain(TABLE);
  });

  it('migration 117 suite is registered in MIGRATION_SHAPE_FILES', () => {
    // `MIGRATION_SHAPE_FILES` is a module-private `const` inside
    // `scripts/ci/live-db-suites-audit.ts` — not exported — so this case reads
    // its EFFECT through the audit's own exported entry point rather than the
    // set. That is STRONGER than a membership read, not a weakened stand-in:
    // this file's real checked-in text executes DDL (the `.unsafe()` calls in
    // `degrade` and the verbatim applies below) and names the cross-process
    // lock marker, so running the real audit over that real text yields zero
    // findings ONLY because this exact path is an allowlist member AND the lock
    // call is present. Drop the entry, typo it, or rename `acquireLiveDbLock`
    // away and this case reports a `runtime-ddl` or `unlocked-ddl` finding — a
    // membership read would catch the first two and miss the third.
    //
    // Distinct from the case above, which is about the TENANT registries
    // (`ci:tenant-scope` / `ci:rls-audit`) rather than the live-DB DDL
    // allowlist. Two registries, two cases; neither subsumes the other.
    const ownSourceText = readFileSync(join(process.cwd(), SUITE_FILE), 'utf8');
    expect(auditLiveDbFile(SUITE_FILE, ownSourceText)).toEqual([]);
  });
});

describeWithDb(
  'migration 117 admin_audit_log',
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
      // The shared requirement from `schema-ready.ts` rather than a local copy
      // of it: one authoritative owner per fact, and its failure message names
      // `pnpm test:db:setup`.
      await assertSchemaReady(db, [MIGRATION_117_ADMIN_AUDIT_LOG]);
      // An admin is exactly the actor the account sink cannot hold:
      // role='admin', NULL account_id.
      adminUserId = randomUUID();
      await db`
        INSERT INTO users (id, name, email, role, account_id)
        VALUES (${adminUserId}::uuid, 'Migration 117 Admin', ${`admin-117-${adminUserId}@test.local`}, 'admin', NULL)
      `;
    }, LIVE_DB_LOCK_HOOK_TIMEOUT_MS);

    afterEach(async () => {
      await sql()`DELETE FROM admin_audit_log WHERE actor_user_id = ${admin()}::uuid`;
    }, 60_000);

    afterAll(async () => {
      try {
        if (db && adminUserId) {
          await db`DELETE FROM admin_audit_log WHERE actor_user_id = ${adminUserId}::uuid`;
          await db`DELETE FROM users WHERE id = ${adminUserId}::uuid`;
        }
      } finally {
        try {
          if (db) await db.end({ timeout: 5 });
        } finally {
          await featureDatabaseLock?.release();
          featureDatabaseLock = undefined;
        }
      }
    }, LIVE_DB_LOCK_HOOK_TIMEOUT_MS);

    // ── structural ──────────────────────────────────────────────────────────

    it('enables deny-all RLS (no FORCE), defines zero policies, and grants the client roles nothing', async () => {
      const [security] = await sql()<
        {
          rls_enabled: boolean;
          rls_forced: boolean;
          policy_count: string;
          anon_select: boolean;
          anon_insert: boolean;
          anon_update: boolean;
          anon_delete: boolean;
          authed_select: boolean;
          authed_insert: boolean;
          authed_update: boolean;
          authed_delete: boolean;
        }[]
      >`
        SELECT
          cls.relrowsecurity AS rls_enabled,
          cls.relforcerowsecurity AS rls_forced,
          (
            SELECT count(*)::text FROM pg_policies
             WHERE schemaname = 'public' AND tablename = ${TABLE}
          ) AS policy_count,
          has_table_privilege('anon', 'public.admin_audit_log', 'SELECT') AS anon_select,
          has_table_privilege('anon', 'public.admin_audit_log', 'INSERT') AS anon_insert,
          has_table_privilege('anon', 'public.admin_audit_log', 'UPDATE') AS anon_update,
          has_table_privilege('anon', 'public.admin_audit_log', 'DELETE') AS anon_delete,
          has_table_privilege('authenticated', 'public.admin_audit_log', 'SELECT') AS authed_select,
          has_table_privilege('authenticated', 'public.admin_audit_log', 'INSERT') AS authed_insert,
          has_table_privilege('authenticated', 'public.admin_audit_log', 'UPDATE') AS authed_update,
          has_table_privilege('authenticated', 'public.admin_audit_log', 'DELETE') AS authed_delete
        FROM pg_class cls
        WHERE cls.oid = 'public.admin_audit_log'::regclass
      `;

      // FORCE stays OFF: the only writer reaches the table through the
      // RLS-bypassing postgres role, and forcing RLS would lock it out too.
      expect(security).toEqual({
        rls_enabled: true,
        rls_forced: false,
        policy_count: '0',
        anon_select: false,
        anon_insert: false,
        anon_update: false,
        anon_delete: false,
        authed_select: false,
        authed_insert: false,
        authed_update: false,
        authed_delete: false,
      });
    });

    // ── ORACLE A: pinned head posture, independent of the migration file ────

    it('head posture pins the admin_audit_log table comment', async () => {
      // #1301 RT-12. No suite in this family pinned its table comment, and
      // deleting 117's `COMMENT ON TABLE` survived 13 of 13 red-team runs.
      // Oracle B cannot carry it either: the comment is re-applied by the
      // migration, so a weakened file yields a weakened `before` and
      // `after === before` still passes. Only a literal pinned HERE breaks
      // that circle. Migration 118 already pinned its own, with a written
      // rationale; this is the missed sibling case.
      await withRolledBackTransaction(sql(), async (tx) => {
        const catalogue = await readPublicCatalogue(tx);
        expect(catalogue.tables[TABLE]?.comment, BEHIND_HEAD).toBe(TABLE_COMMENT);
      });
    });

    it('admin_audit_log carries row security enabled and no policy at head', async () => {
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
        WHERE cls.oid = 'public.admin_audit_log'::regclass
      `;

      // Literals from `docs/reviews/fix-1301-migration-guard-execution/oracle-a-literals.txt` ("row security posture
      // at head"): admin_audit_log: rowsecurity=true force=false policies=0.
      // Captured by introspection, DELIBERATELY not derived from the migration
      // file — that independence is what catches a weakened 117 on a freshly
      // provisioned container, where oracle B alone would be circular.
      //
      // Deliberately overlapping with the preserved deny-all case above: that
      // one is the pre-#1301 assertion, kept unchanged on a plan reviewer's
      // explicit instruction, and this one carries the behind-head message and
      // the oracle-A provenance that make a container diagnosis actionable.
      expect(security?.rls_enabled, BEHIND_HEAD).toBe(true);
      expect(security?.policy_count, BEHIND_HEAD).toBe('0');
      expect(security?.rls_forced, BEHIND_HEAD).toBe(false);
    });

    it('admin_audit_log grants no privilege to anon or authenticated at head', async () => {
      // Oracle A, "client-role grants on the four deny-all tables — MUST be
      // empty at head". Asked three ways, because each arm closes a hole the
      // others leave open (the three-arm shape migration 119's suite reached
      // over five red-team passes). Strictly stronger than the four
      // `has_table_privilege` verbs in the preserved case above, which see
      // neither TRUNCATE nor a column grant.

      // ARM A — the ACL itself, table AND column, via `aclexplode`: ground
      // truth a superuser's implicit privileges cannot mask, covering EVERY
      // privilege type rather than the four an enumeration named. Grantee OID 0
      // (`PUBLIC`) is matched explicitly, because a filter on grantee NAME
      // alone let `GRANT ... TO PUBLIC` through with 119's suite fully green.
      const acl = await sql()<{ role: string; privilege_type: string; scope: string }[]>`
        SELECT acl.grantee::regrole::text AS role, acl.privilege_type, 'table' AS scope
          FROM pg_class cls
          CROSS JOIN LATERAL aclexplode(cls.relacl) AS acl
         WHERE cls.oid = 'public.admin_audit_log'::regclass
           AND (acl.grantee = 0 OR acl.grantee::regrole::text IN ('anon', 'authenticated'))
        UNION ALL
        SELECT acl.grantee::regrole::text, acl.privilege_type, 'column'
          FROM pg_attribute att
          CROSS JOIN LATERAL aclexplode(att.attacl) AS acl
         WHERE att.attrelid = 'public.admin_audit_log'::regclass
           AND (acl.grantee = 0 OR acl.grantee::regrole::text IN ('anon', 'authenticated'))
         ORDER BY 3, 1, 2
      `;
      expect(acl, BEHIND_HEAD).toEqual([]);

      // ARM B — EFFECTIVE privilege, a different question: it also catches a
      // grant reaching a client role through role MEMBERSHIP, and a grant whose
      // text never contains the word GRANT. The privilege list is DERIVED from
      // `acldefault`, never spelled.
      const effective = await sql()<{ role: string; privilege_type: string }[]>`
        WITH server_privileges AS (
          SELECT DISTINCT acl.privilege_type
            FROM aclexplode(acldefault('r', (
                   SELECT relowner FROM pg_class WHERE oid = 'public.admin_audit_log'::regclass
                 ))) AS acl
        ),
        client_roles AS (SELECT unnest(${[...CLIENT_ROLES]}::text[]) AS role)
        SELECT client_roles.role, server_privileges.privilege_type
          FROM client_roles
          CROSS JOIN server_privileges
         WHERE has_table_privilege(
                 client_roles.role, 'public.admin_audit_log', server_privileges.privilege_type
               )
         ORDER BY 1, 2
      `;
      expect(effective, BEHIND_HEAD).toEqual([]);

      // Arm B fails OPEN if the derived list is ever empty — an empty CROSS
      // JOIN yields no rows and the assertion above passes vacuously.
      const [derived] = await sql()<{ privilege_count: string }[]>`
        SELECT count(DISTINCT acl.privilege_type)::text AS privilege_count
          FROM aclexplode(acldefault('r', (
                 SELECT relowner FROM pg_class WHERE oid = 'public.admin_audit_log'::regclass
               ))) AS acl
      `;
      expect(Number(derived?.privilege_count)).toBeGreaterThanOrEqual(7);

      // ARM C — COLUMN-level effective privilege: the intersection A and B
      // leave open, since Arm A filters on grantee NAME and Arm B's
      // `has_table_privilege` does not consider column grants at all. The column-level
      // privilege set is DERIVED, not spelled: `acldefault('c', …)` is empty,
      // so `deriveColumnPrivileges` asks `has_column_privilege` about each of
      // this major's table privileges and keeps the ones it recognises. The
      // literal it replaces restated its own length, so it could not have
      // failed on a PostgreSQL that added a fifth (#1301 RT-7); this does.
            const columnPrivileges = await deriveColumnPrivileges(sql(), 'admin_audit_log', 'id');
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
            ON att.attrelid = 'public.admin_audit_log'::regclass
           AND att.attnum > 0
           AND NOT att.attisdropped
         WHERE has_column_privilege(
                 client_roles.role, 'public.admin_audit_log', att.attname,
                 column_privileges.privilege_type
               )
         ORDER BY 1, 2, 3
      `;
      expect(columnEffective, BEHIND_HEAD).toEqual([]);
    });

    it('creates the ten locked columns with their exact types, nullability and defaults, and no account column', async () => {
      const columns = await sql()<
        { column_name: string; udt_name: string; is_nullable: string; column_default: string | null }[]
      >`
        SELECT column_name, udt_name, is_nullable, column_default
          FROM information_schema.columns
         WHERE table_schema = 'public' AND table_name = ${TABLE}
         ORDER BY column_name
      `;

      expect(columns).toEqual([
        { column_name: 'actor_user_id', udt_name: 'uuid', is_nullable: 'NO', column_default: null },
        { column_name: 'created_at', udt_name: 'timestamptz', is_nullable: 'NO', column_default: 'now()' },
        { column_name: 'entity_id', udt_name: 'text', is_nullable: 'YES', column_default: null },
        { column_name: 'entity_type', udt_name: 'text', is_nullable: 'YES', column_default: null },
        { column_name: 'event_type', udt_name: 'text', is_nullable: 'NO', column_default: null },
        { column_name: 'id', udt_name: 'uuid', is_nullable: 'NO', column_default: null },
        { column_name: 'ip', udt_name: 'text', is_nullable: 'YES', column_default: null },
        { column_name: 'payload', udt_name: 'jsonb', is_nullable: 'NO', column_default: "'{}'::jsonb" },
        { column_name: 'request_id', udt_name: 'text', is_nullable: 'YES', column_default: null },
        { column_name: 'user_agent', udt_name: 'text', is_nullable: 'YES', column_default: null },
      ]);
    });

    it('indexes the actor and the event type, both newest-first', async () => {
      const indexes = await sql()<{ indexname: string; indexdef: string }[]>`
        SELECT indexname, indexdef FROM pg_indexes
         WHERE schemaname = 'public' AND tablename = ${TABLE}
         ORDER BY indexname
      `;
      const byName = new Map(indexes.map((index) => [index.indexname, index.indexdef]));
      expect(byName.get(ACTOR_INDEX)).toContain('(actor_user_id, created_at DESC)');
      expect(byName.get(EVENT_INDEX)).toContain('(event_type, created_at DESC)');
    });

    it('the actor FK carries NO referential action, so deleting a referenced admin fails instead of cascading', async () => {
      const [fk] = await sql()<{ confdeltype: string; confupdtype: string }[]>`
        SELECT confdeltype, confupdtype FROM pg_constraint
         WHERE conname = ${ACTOR_FK} AND conrelid = 'public.admin_audit_log'::regclass
      `;
      // 'a' = NO ACTION.
      expect(fk).toEqual({ confdeltype: 'a', confupdtype: 'a' });

      await writeAdminAuditLog(sql(), {
        actorUserId: admin(),
        eventType: 'mfa_factor_unenrolled',
        payload: { factor_id: 'factor-fk' },
      });
      await expect(sql()`DELETE FROM users WHERE id = ${admin()}::uuid`).rejects.toMatchObject({
        code: FOREIGN_KEY_VIOLATION,
        constraint_name: ACTOR_FK,
      });
    });

    // ── ORACLE B: degrade, prove it landed, apply verbatim, diff ────────────

    it('re-applying 117 restores the revoked client grants after they are granted', async () => {
      // `withRolledBackTransaction` ALWAYS rolls back, which is what makes the
      // degrade/apply cycle safe on the SHARED container: later migrations
      // layer on `public`, so a persistent degrade would corrupt it for every
      // other suite.
      await withRolledBackTransaction(sql(), async (tx) => {
        const before = await readPublicCatalogue(tx);
        const privileges = await deriveTablePrivileges(tx, TABLE);
        await degrade(tx);
        const degraded = await readPublicCatalogue(tx);

        // All THREE halves of the degrade, each proven to have landed so no arm
        // can pass vacuously against a no-op migration.
        //
        // The grant half is ADDITIVE, so it uses `present`: the harness
        // requires every named object to be ABSENT from `before` and PRESENT in
        // the degraded reading, which is the opposite direction from the index
        // half. Passing `absent` here would fail as vacuous by construction.
        assertDegradeLanded(before, degraded, {
          table: TABLE,
          property: 'grants',
          present: nonEmptyNames(clientGrantNames(privileges)),
        });
        assertDegradeLanded(before, degraded, {
          table: TABLE,
          property: 'indexes',
          absent: [ACTOR_INDEX, EVENT_INDEX],
        });
        // `rowSecurity` is a BOOLEAN property: no name list applies, so it has
        // its own selector-free variant in `DegradeTarget` — the value
        // comparison inside `assertDegradeLanded` IS the proof.
        assertDegradeLanded(before, degraded, {
          table: TABLE,
          property: 'rowSecurity',
        });

        await tx.unsafe(readMigrationSql(MIGRATION_FILE));
        const after = await readPublicCatalogue(tx);

        // The re-apply must restore all three at once: the revoked grants, both
        // index definitions, and RLS. Comparing the whole `CataloguedTable`
        // rather than three properties separately also catches a re-apply that
        // restored them while changing something else about the table.
        expect(after.tables[TABLE]).toEqual(before.tables[TABLE]);
      });
    });

    it('re-applying 117 moves no other table in public', async () => {
      await withRolledBackTransaction(sql(), async (tx) => {
        const before = await readPublicCatalogue(tx);
        const privileges = await deriveTablePrivileges(tx, TABLE);
        await degrade(tx);
        const degraded = await readPublicCatalogue(tx);

        // The degrade must LAND before the re-apply gets credit for undoing it;
        // `assertDegradeLanded`'s JSDoc owns why all seven cases call this.
        assertDegradeLanded(before, degraded, {
          table: TABLE,
          property: 'grants',
          present: nonEmptyNames(clientGrantNames(privileges)),
        });
        assertDegradeLanded(before, degraded, {
          table: TABLE,
          property: 'indexes',
          absent: [ACTOR_INDEX, EVENT_INDEX],
        });
        assertDegradeLanded(before, degraded, {
          table: TABLE,
          property: 'rowSecurity',
        });

        await tx.unsafe(readMigrationSql(MIGRATION_FILE));
        const after = await readPublicCatalogue(tx);

        // A migration may harden the one table it names while doing arbitrary
        // damage elsewhere: appending `GRANT ALL ON admin_audit_log TO anon;`
        // to migration 119 passed its whole suite once, and the grant really
        // landed (#1171). Every table outside `[admin_audit_log]` must come out
        // byte-identical — RLS flags, policies, columns, indexes, constraints,
        // comments and both table and column ACLs.
        assertOnlyTablesMoved(before, after, [TABLE]);
      });
    });

    it('re-applying 117 revokes every PostgreSQL 17 table privilege from both client roles', async () => {
      // THE CASE THAT DISTINGUISHES `REVOKE ALL` FROM `REVOKE SELECT`. The
      // degrade grants EVERY privilege this major defines to BOTH client roles;
      // the re-applied catalogue must grant NONE of them. A migration weakened
      // to `REVOKE SELECT` leaves the other seven behind and fails here, while
      // a SELECT-only degrade would have passed against it.
      //
      // The list is DERIVED (`aclexplode(acldefault('r', <owner oid>))`), never
      // spelled: 16 defines seven table privileges and 17 defines eight
      // (`MAINTAIN`), so a hardcoded list breaks on one major or the other.
      await withRolledBackTransaction(sql(), async (tx) => {
        const before = await readPublicCatalogue(tx);
        const privileges = await deriveTablePrivileges(tx, TABLE);
        const grants = clientGrantNames(privileges);

        await degrade(tx);
        const degraded = await readPublicCatalogue(tx);

        // HALF ONE: the degraded catalogue grants every derived privilege to
        // both roles. Without it, "none after" would be satisfied by a degrade
        // that granted nothing at all.
        const degradedGrantNames = (degraded.tables[TABLE]?.grants ?? []).map(
          (entry) => entry.name,
        );
        for (const grant of grants) {
          expect(degradedGrantNames, 'the GRANT ALL degrade did not land').toContain(grant);
        }

        await tx.unsafe(readMigrationSql(MIGRATION_FILE));
        const after = await readPublicCatalogue(tx);

        // HALF TWO: the re-applied catalogue grants none of them. The owner's
        // own grants must survive, so the list is not merely empty — a
        // `REVOKE ALL ... FROM PUBLIC` or a revoke that caught the owner would
        // fail here rather than read as success.
        const afterGrantNames = (after.tables[TABLE]?.grants ?? []).map((entry) => entry.name);
        expect(afterGrantNames).not.toEqual([]);
        for (const grant of grants) {
          expect(afterGrantNames).not.toContain(grant);
        }
        expect(after.tables[TABLE]?.grants).toEqual(before.tables[TABLE]?.grants);
      });
    });

    // ── behavioural ─────────────────────────────────────────────────────────

    it('writeAdminAuditLog persists a row keyed on the admin, with payload and optional metadata round-tripped', async () => {
      await writeAdminAuditLog(sql(), {
        actorUserId: admin(),
        eventType: 'mfa_factor_enrolled',
        payload: { factor_id: 'factor-1', factor_status_before: 'unverified' },
        entityType: 'mfa_factor',
        entityId: 'factor-1',
        ip: '203.0.113.10',
        userAgent: 'Vitest',
        requestId: 'req-117',
      });

      const rows = await sql()<
        {
          actor_user_id: string;
          event_type: string;
          payload: unknown;
          entity_type: string | null;
          entity_id: string | null;
          ip: string | null;
          user_agent: string | null;
          request_id: string | null;
        }[]
      >`
        SELECT actor_user_id, event_type, payload, entity_type, entity_id, ip, user_agent, request_id
          FROM admin_audit_log
         WHERE actor_user_id = ${admin()}::uuid
      `;
      const payload = rows[0]?.payload;
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({
        actor_user_id: admin(),
        event_type: 'mfa_factor_enrolled',
        entity_type: 'mfa_factor',
        entity_id: 'factor-1',
        ip: '203.0.113.10',
        user_agent: 'Vitest',
        request_id: 'req-117',
      });
      expect(typeof payload === 'string' ? JSON.parse(payload) : payload).toEqual({
        factor_id: 'factor-1',
        factor_status_before: 'unverified',
      });
    });

    it('rejects a row for an actor that is not a users row, by the named FK', async () => {
      await expect(
        writeAdminAuditLog(sql(), {
          actorUserId: randomUUID(),
          eventType: 'mfa_challenge_failed',
          payload: {},
        }),
      ).rejects.toMatchObject({ code: FOREIGN_KEY_VIOLATION, constraint_name: ACTOR_FK });
    });
  },
);
