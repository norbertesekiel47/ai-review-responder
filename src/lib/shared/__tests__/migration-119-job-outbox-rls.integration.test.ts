// Security-posture assertions for migration 119 — deny-all RLS on
// `job_outbox` (#1171). The table carries no tenant column and sits OUTSIDE
// `TENANT_TABLES` (`REVIEWED_NOT_TENANT_SCOPED`), and `ci:rls-audit` audits
// only that list, so THIS suite is the regression guard for the boundary — the
// role `migration-117-admin-audit-log.integration.test.ts` plays for
// `admin_audit_log`, and the file this one follows. The migration header owns
// the drift's provenance; it is not restated here.
//
// ── what this suite executes ────────────────────────────────────────────────
//
// No DDL (`ci:live-db-suites` R2). `pnpm test:db:setup` provisions the
// container to head; every case reads the catalogue or the checked-in
// migration file. It takes the cross-process live-DB lock because table RLS
// and ACLs are GLOBAL facts another suite's DDL could perturb.
//
// There is no `assertSchemaReady` precondition, and that is the house answer
// rather than an omission: 119 creates no relation, column, index or
// constraint for `SchemaRequirement` to name, which is exactly migration 097's
// situation — `schema-ready.ts` records that 097 "gets no requirement of its
// own … its suite inspects the migration SQL text instead". Title 1 is the
// real detector of a container behind head, and it carries that message.
//
// ── the two guards, and which one is load-bearing where ─────────────────────
//
// CATALOGUE (titles 1, 2, 4) proves the posture that EXISTS. Title 4 asks the
// question TWICE, because two red-team rounds proved that either half alone
// leaves a hole:
//
//   ARM A reads `relacl` and `attacl` through `aclexplode` — who is NAMED in
//   the ACL, table and column, every privilege type including ones this
//   PostgreSQL does not have yet. Round 1's lesson: `TRUNCATE` is exempt from
//   row policies entirely, so `GRANT TRUNCATE … TO authenticated` would let a
//   client role empty the dispatch spine with RLS on and zero policies still
//   true — an enumeration of SELECT/INSERT never sees it.
//
//   ARM B asks what the roles can actually DO, over a privilege list derived
//   from `acldefault` rather than spelled. Round 2's lesson: Arm A filters on
//   grantee NAME, so `GRANT … TO PUBLIC` (grantee OID 0) sailed past it with
//   the suite 6/6 green while `has_table_privilege('anon', …)` returned true.
//   Arm B also catches a grant reaching `anon` through role MEMBERSHIP, and
//   one whose SQL text never contains the word GRANT.
//
// A future migration's GRANT — named, PUBLIC, inherited or concatenated — is
// applied by `pnpm test:db:setup` on every container, so this case genuinely
// fails on that regression. Verified by mutation for all four shapes.
//
// FILE TEXT (title 3) proves what migration 119 ITSELF may contain, and it is
// the ONLY environment-independent guard against a WIDENED revoke — which is
// the dangerous mutation here, not a missing one. It parses top-level
// STATEMENTS rather than matching lines: a red-team round appended
// `SELECT 1; REVOKE ALL ON job_outbox FROM service_role;` to one line and
// survived a line-anchored regex.
//
// ── stated limits: cases that cannot fail in this environment ──────────────
//
// Title 2 (FORCE off) is vacuous against REVERSION: `relforcerowsecurity`
// defaults to false, so it is green on a container 119 never touched. It earns
// its place as a guard against a future statement that turns FORCE on — which
// would deny the outbox to its only writer — not as proof 119 ran.
//
// The suite asserts NOTHING about the owner's or `service_role`'s privileges,
// and the omission is load-bearing. A red-team mutation ran
// `REVOKE ALL ON job_outbox FROM <owner>`, left `relacl = {}`, and an earlier
// draft of title 4 still PASSED: the local and CI owner is the container
// superuser (`POSTGRES_USER: test`), and `has_table_privilege` is
// unconditionally true for a superuser. `service_role` is environment-
// dependent for the opposite reason — Supabase's default privileges on both
// projects, none locally. Neither property can be established from a catalogue
// read here, so both are guarded by title 3's exact-match statement assertion
// instead of by an assertion that could only be true by accident.

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
import { REVIEWED_NOT_TENANT_SCOPED, TENANT_TABLES } from '../../../../scripts/ci/tenant-tables';

const TABLE = 'job_outbox';
const MIGRATION_FILE = 'supabase/migrations/119_job_outbox_rls.sql';
const BEHIND_HEAD = 'job_outbox RLS posture is not at migration head — run pnpm test:db:setup';

/**
 * Top-level statements of ONE known migration file — not a general SQL parser,
 * and it does not need to be. It masks dollar-quoted bodies and single-quoted
 * strings so their semicolons cannot split a statement, strips line comments,
 * then splits on `;`.
 *
 * Statements rather than lines because a line-anchored regex cannot see a
 * second statement sharing a line, which is precisely how a widened revoke
 * evaded the earlier form.
 *
 * THE ORDER IS LOAD-BEARING. Comments are stripped BEFORE strings are masked,
 * because prose apostrophes ("the table's owner", "Supabase's") read as
 * string delimiters otherwise and swallow every statement between two of them
 * — the first form of this helper found ZERO revokes in a file that plainly
 * contains one. The inverse hazard, a `--` inside a string literal, does not
 * exist in this file and would fail loudly rather than silently.
 */
function topLevelStatements(sql: string): string[] {
  return sql
    .replace(/\$\$[\s\S]*?\$\$/g, 'DOLLAR_QUOTED_BODY')
    .replace(/--[^\n]*/g, '')
    .replace(/'(?:[^']|'')*'/g, 'STRING_LITERAL')
    .split(';')
    .map((statement) => statement.replace(/\s+/g, ' ').trim())
    .filter(Boolean);
}

function migrationSql(): string {
  return readFileSync(join(process.cwd(), MIGRATION_FILE), 'utf8');
}

const testDatabaseUrl = resolveTestDatabaseUrl();

let db: postgresType.Sql | undefined;
let featureDatabaseLock: LiveDbLock | undefined;

function sql(): postgresType.Sql {
  if (!db) throw new Error('migration 119 integration database was not initialized');
  return db;
}

// ── registry + file text: no database needed, so never a silent skip ────────

describe('migration 119 registries', () => {
  it('job_outbox stays REVIEWED_NOT_TENANT_SCOPED and NOT a TENANT_TABLES member', () => {
    // Deliberate (owner decision, 2026-09-07): TENANT_TABLES membership also
    // switches on `ci:tenant-scope`, which demands an account_id/business_id
    // predicate on every binding. job_outbox carries neither column and 55
    // production files bind it in SQL, so membership would cost dozens of
    // allowlist entries and audit nothing real. This suite is the guard
    // instead.
    const reviewed = REVIEWED_NOT_TENANT_SCOPED.find((entry) => entry.table === TABLE);
    expect(reviewed?.reason).toMatch(/[Tt]ransactional outbox/);
    const tenantTables: readonly string[] = TENANT_TABLES;
    expect(tenantTables).not.toContain(TABLE);
  });

  it('migration 119 revokes every anon and authenticated privilege on job_outbox', () => {
    const statements = topLevelStatements(migrationSql());
    const revokes = statements.filter((statement) => /^REVOKE\b/i.test(statement));

    expect(revokes).toHaveLength(1);

    // Asserted as an EXACT match, not as a list of forbidden role names. A
    // negative list has to anticipate every spelling a widening mutation might
    // use (`SERVICE_ROLE`, `Postgres`, lowercase `public`); an exact match
    // admits exactly one statement and cannot be widened at all.
    expect(revokes[0]).toMatch(/^REVOKE ALL ON job_outbox FROM anon, authenticated$/i);

    // A later GRANT inside this same file would restore what the REVOKE took.
    expect(statements.filter((statement) => /^GRANT\b/i.test(statement))).toEqual([]);

    // Belt for the statement parser's one blind spot: it MASKS dollar-quoted
    // bodies, so `EXECUTE 'REVOKE ALL ON job_outbox FROM service_role'` inside
    // the guarded DO block would be invisible above. Counted on
    // comment-stripped text with the bodies left intact, so the two checks
    // cannot share a hiding place.
    const executable = migrationSql().replace(/--[^\n]*/g, '');
    expect(executable.match(/\bREVOKE\b/gi)).toHaveLength(1);
    expect(executable.match(/\bGRANT\b/gi)).toBeNull();
  });

  it('migration 119 grants no policy and does not force row level security', () => {
    const text = migrationSql();
    expect(text).toMatch(/ALTER TABLE job_outbox ENABLE ROW LEVEL SECURITY;/);
    // Matched against the raw text, not the statement list: the ALTER sits
    // inside a guarded DO block whose body the statement parser masks, and
    // ANY occurrence of the two forbidden forms is a defect wherever it hides.
    expect(text).not.toMatch(/CREATE POLICY/i);
    // FORCE would apply RLS to the table OWNER, the role every worker connects
    // as. It is the one statement in this file that could take the platform
    // down.
    expect(text).not.toMatch(/FORCE ROW LEVEL SECURITY/i);
    // A self-cancelling DISABLE appended below the ENABLE leaves the file
    // reading as if it hardens the table while shipping the drift it exists to
    // close. Red team appended exactly that and passed every other case.
    expect(text).not.toMatch(/DISABLE ROW LEVEL SECURITY/i);
  });
});

describeWithDb(
  'migration 119 job_outbox deny-all RLS',
  { enabled: Boolean(testDatabaseUrl), timeout: 180_000 },
  () => {
    beforeAll(async () => {
      const databaseUrl = assertLocalTestDatabaseUrl(testDatabaseUrl);
      featureDatabaseLock = await acquireLiveDbLock(databaseUrl);
      db = postgres(databaseUrl, {
        max: 2,
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

    // ── structural ──────────────────────────────────────────────────────────

    it('migration 119 enables row level security on job_outbox and defines zero policies', async () => {
      const [security] = await sql()<{ rls_enabled: boolean; policy_count: string }[]>`
        SELECT
          cls.relrowsecurity AS rls_enabled,
          (
            SELECT count(*)::text FROM pg_policies
             WHERE schemaname = 'public' AND tablename = ${TABLE}
          ) AS policy_count
        FROM pg_class cls
        WHERE cls.oid = 'public.job_outbox'::regclass
      `;

      expect(security?.rls_enabled, BEHIND_HEAD).toBe(true);

      // Zero policies IS the guarantee, not an omission. Outbox rows carry
      // topic and payload for every tenant and there is no owner-facing read
      // of this table, so any policy at all would be a wider door than the
      // product needs.
      expect(security?.policy_count).toBe('0');
    });

    it('migration 119 leaves FORCE row level security off so the owner-role worker keeps dispatching', async () => {
      const [relation] = await sql()<{ rls_forced: boolean }[]>`
        SELECT cls.relforcerowsecurity AS rls_forced
          FROM pg_class cls
         WHERE cls.oid = 'public.job_outbox'::regclass
      `;

      // Postgres exempts a table's OWNER from RLS only while FORCE is off, and
      // every enqueue, claim and dispatch reaches job_outbox through the owner
      // role over Postgres.js. Turning FORCE on with zero policies would deny
      // the outbox to its only writer and stop all async work.
      //
      // Vacuous against REVERSION — false is the default — so this guards a
      // future statement, not migration 119 having run. See the header.
      expect(relation?.rls_forced).toBe(false);
    });

    it('migration 119 leaves no anon or authenticated privilege in the job_outbox table or column ACLs', async () => {
      // `aclexplode` over `relacl`/`attacl` rather than `has_table_privilege`
      // per verb, for two reasons the header states in full: the ACL is the
      // ground truth a superuser's implicit privileges cannot mask, and
      // asserting the client roles appear NOWHERE covers every privilege type
      // — TRUNCATE, REFERENCES, TRIGGER, MAINTAIN — instead of the two an
      // enumeration remembered to name.
      // ARM A — the ACL, table and column. Catches a direct grant to either
      // client role AND to PUBLIC (grantee OID 0, which renders as `-`): a
      // red-team round proved that filtering on grantee NAME alone let
      // `GRANT SELECT, INSERT ON job_outbox TO PUBLIC` through with the suite
      // 6/6 green, while `has_table_privilege('anon', …)` returned true.
      const acl = await sql()<{ role: string; privilege_type: string; scope: string }[]>`
        SELECT acl.grantee::regrole::text AS role, acl.privilege_type, 'table' AS scope
          FROM pg_class cls
          CROSS JOIN LATERAL aclexplode(cls.relacl) AS acl
         WHERE cls.oid = 'public.job_outbox'::regclass
           AND (acl.grantee = 0 OR acl.grantee::regrole::text IN ('anon', 'authenticated'))
        UNION ALL
        SELECT acl.grantee::regrole::text, acl.privilege_type, 'column'
          FROM pg_attribute att
          CROSS JOIN LATERAL aclexplode(att.attacl) AS acl
         WHERE att.attrelid = 'public.job_outbox'::regclass
           AND (acl.grantee = 0 OR acl.grantee::regrole::text IN ('anon', 'authenticated'))
         ORDER BY 3, 1, 2
      `;

      expect(acl).toEqual([]);

      // ARM B — EFFECTIVE privilege, which is not the same question. Arm A
      // reads who is named in the ACL; this asks what the role can actually
      // do, so it also catches a grant reaching `anon` through role
      // MEMBERSHIP, and a grant whose text never contains the word GRANT
      // (a `DO` block executing `'GRA' || 'NT ALL …'` really does grant, and
      // no text guard can see it — this arm can).
      //
      // The privilege list is DERIVED, never spelled: `acldefault('r', owner)`
      // is the built-in owner ACL for a relation, so exploding it yields every
      // privilege type THIS server has. That is load-bearing across
      // environments — the local container is PostgreSQL 16 (7 types) and both
      // Supabase projects are 17 (8, `MAINTAIN` added). A hardcoded list would
      // either miss one there or raise `unrecognized privilege type` here.
      //
      // `has_table_privilege` is sound for these two roles even though it was
      // the wrong tool for the OWNER: the superuser short-circuit that made
      // the owner arms unfalsifiable does not apply to `anon` or
      // `authenticated`, which are NOLOGIN non-superuser roles.
      const effective = await sql()<{ role: string; privilege_type: string }[]>`
        WITH server_privileges AS (
          SELECT DISTINCT acl.privilege_type
            FROM aclexplode(
                   acldefault('r', (
                     SELECT relowner FROM pg_class WHERE oid = 'public.job_outbox'::regclass
                   ))
                 ) AS acl
        ),
        client_roles AS (
          SELECT unnest(ARRAY['anon', 'authenticated']) AS role
        )
        SELECT client_roles.role, server_privileges.privilege_type
          FROM client_roles
          CROSS JOIN server_privileges
         WHERE has_table_privilege(
                 client_roles.role, 'public.job_outbox', server_privileges.privilege_type
               )
         ORDER BY 1, 2
      `;

      expect(effective).toEqual([]);
    });
  },
);
