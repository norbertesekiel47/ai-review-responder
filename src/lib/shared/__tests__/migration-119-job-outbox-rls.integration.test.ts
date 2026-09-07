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
    // MEMBERSHIP, not prose: the earlier form asserted the reason text matched
    // /[Tt]ransactional outbox/, which a reworded-but-still-correct entry would
    // break and a removed entry with matching prose elsewhere would not catch.
    const reviewed = REVIEWED_NOT_TENANT_SCOPED.find((entry) => entry.table === TABLE);
    expect(reviewed).toBeDefined();
    const tenantTables: readonly string[] = TENANT_TABLES;
    expect(tenantTables).not.toContain(TABLE);
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
        // max: 1, not 2 — the apply-and-assert case runs the checked-in
        // migration verbatim through `unsafe`, and that file opens its own
        // BEGIN/COMMIT. postgres.js refuses a transaction-bearing `unsafe` on a
        // pooled client (`UNSAFE_TRANSACTION: Only use sql.begin, sql.reserved
        // or max: 1`) because it cannot guarantee the statements land on one
        // backend. Every case here is sequential, so a single connection costs
        // nothing.
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

      // Arm B fails OPEN if the derived privilege list is ever empty — an
      // empty CROSS JOIN yields no rows and the assertion above passes
      // vacuously. Unreachable today, and asserted anyway, because "the guard
      // silently checks nothing" is the exact failure this suite keeps
      // rediscovering.
      const [derived] = await sql()<{ privilege_count: string }[]>`
        SELECT count(DISTINCT acl.privilege_type)::text AS privilege_count
          FROM aclexplode(
                 acldefault('r', (
                   SELECT relowner FROM pg_class WHERE oid = 'public.job_outbox'::regclass
                 ))
               ) AS acl
      `;
      expect(Number(derived?.privilege_count)).toBeGreaterThanOrEqual(7);

      // ARM C — COLUMN-level effective privilege, which is the intersection
      // arms A and B leave open between them. Arm A reads `attacl` but filters
      // on grantee NAME, and Arm B's `has_table_privilege` does not consider
      // column grants at all. So a column grant to a role that `anon` INHERITS
      // is named nowhere Arm A looks and invisible to Arm B — proven: with
      // `GRANT SELECT (payload) ON job_outbox TO <role anon inherits>`, Arm A
      // reported nothing and this arm reports `anon | payload | SELECT`.
      // `anon` and `authenticated` are `rolinherit = true` on the container and
      // on both Supabase projects.
      //
      // The column-applicable set is intersected rather than derived:
      // `acldefault('c', …)` is empty, because columns have no DEFAULT
      // privileges. The four below are fixed by the SQL standard while the
      // TABLE set is not, and the assertion on the count means a PostgreSQL
      // that ever adds a fifth fails loudly here instead of quietly
      // under-covering.
      const columnPrivileges = ['SELECT', 'INSERT', 'UPDATE', 'REFERENCES'];
      const columnEffective = await sql()<
        { role: string; attname: string; privilege_type: string }[]
      >`
        WITH column_privileges AS (
          SELECT unnest(${columnPrivileges}::text[]) AS privilege_type
        ),
        client_roles AS (
          SELECT unnest(ARRAY['anon', 'authenticated']) AS role
        )
        SELECT client_roles.role, att.attname, column_privileges.privilege_type
          FROM client_roles
          CROSS JOIN column_privileges
          JOIN pg_attribute att
            ON att.attrelid = 'public.job_outbox'::regclass
           AND att.attnum > 0
           AND NOT att.attisdropped
         WHERE has_column_privilege(
                 client_roles.role,
                 'public.job_outbox',
                 att.attname,
                 column_privileges.privilege_type
               )
         ORDER BY 1, 2, 3
      `;

      expect(columnEffective).toEqual([]);
    });

    // ── the environment-independent guard: EXECUTE the file, do not parse it ─

    it('migration 119 revokes every anon and authenticated privilege on job_outbox', async () => {
      // This case is the whole reason the suite sits in MIGRATION_SHAPE_FILES.
      // Four red-team passes each defeated a regex approximation of a SQL
      // lexer — whitespace, then `/**/`, then `--` inside a string literal,
      // then a comment standing in as evidence. Each fix closed one lexical
      // class and the next pass found another instance of it. Executing the
      // file closes every one of them at once and cannot be evaded by any
      // spelling, because PostgreSQL is the parser.
      //
      // Safe by the same argument 074 and 088 make: the cross-process live-DB
      // lock is already held (beforeAll), so no sibling suite holds row locks
      // on job_outbox while the ALTER takes ACCESS EXCLUSIVE.
      const migration = readFileSync(join(process.cwd(), MIGRATION_FILE), 'utf8');

      // The posture, whole. `non_client_acl` is the half a POST-STATE read
      // could never judge: D2 recorded that the owner's and `service_role`'s
      // privileges are environment-dependent, so "migration 119 leaves them
      // intact" was unassertable and the guarantee was pushed onto a text
      // guard — which four passes then defeated. Applying the file gives a
      // BEFORE, so "unchanged" becomes a comparison rather than a claim.
      // `relacl IS NULL` is carried explicitly because it is not the same
      // state as an empty ACL: NULL means built-in defaults (owner holds
      // everything), `{}` means someone revoked from the owner.
      const readPosture = async () => {
        const [row] = await sql()<
          {
            rls: boolean;
            force: boolean;
            policies: string;
            client_privileges: string;
            acl_is_default: boolean;
            non_client_acl: string;
          }[]
        >`
          SELECT
            cls.relrowsecurity AS rls,
            cls.relforcerowsecurity AS force,
            (
              SELECT count(*)::text FROM pg_policies
               WHERE schemaname = 'public' AND tablename = ${TABLE}
            ) AS policies,
            (
              SELECT count(*)::text
                FROM aclexplode(cls.relacl) AS acl
               WHERE acl.grantee::regrole::text IN ('anon', 'authenticated')
            ) AS client_privileges,
            cls.relacl IS NULL AS acl_is_default,
            coalesce((
              SELECT string_agg(
                       acl.grantee::regrole::text || ':' || acl.privilege_type, ','
                       ORDER BY acl.grantee::regrole::text, acl.privilege_type
                     )
                FROM aclexplode(cls.relacl) AS acl
               WHERE acl.grantee::regrole::text NOT IN ('anon', 'authenticated')
            ), '') AS non_client_acl
          FROM pg_class cls
          WHERE cls.oid = 'public.job_outbox'::regclass
        `;
        return row;
      };

      try {
        // 1. Degrade to the PRE-119 posture — exactly what staging carried:
        //    RLS off, client roles holding Supabase's default grants.
        //
        //    `service_role` is granted too, and that is not cosmetic. It holds
        //    Supabase's defaults on BOTH real projects and NOTHING on this
        //    container, so without this line a hostile `REVOKE ALL … FROM
        //    service_role` is a local no-op and step 5's diff sees nothing —
        //    measured: the vector passed 5/5 until this grant was added.
        //    Constructing the real pre-119 baseline is what makes the
        //    comparison mean the same thing here as in production.
        await sql().unsafe(
          'ALTER TABLE job_outbox DISABLE ROW LEVEL SECURITY;'
            + ' GRANT ALL ON job_outbox TO anon, authenticated, service_role;',
        );

        // 2. Prove the degrade LANDED. Without this the case could pass
        //    vacuously against a no-op migration — the failure mode every
        //    earlier form of this guard actually had.
        const before = await readPosture();
        expect(before?.rls).toBe(false);
        expect(Number(before?.client_privileges)).toBeGreaterThan(0);

        // 3. Apply the checked-in file VERBATIM. No stripping, no rewriting:
        //    whatever ships is what runs here.
        await sql().unsafe(migration);

        // 4. Assert the posture the file actually produced. Every property the
        //    four defeated text guards were trying to express, now read off the
        //    catalogue after real execution.
        const after = await readPosture();
        expect(after?.rls).toBe(true); // an ENABLE that never ran, or a DISABLE
        expect(after?.force).toBe(false); // the one statement that stops the platform
        expect(after?.policies).toBe('0'); // any CREATE POLICY, however spelled
        expect(after?.client_privileges).toBe('0'); // a missing or re-granted REVOKE

        // 5. And the half no post-state read could ever judge: the file must
        //    not touch the owner or `service_role`. A hostile `REVOKE ALL …
        //    FROM service_role` hidden behind `--` inside a string literal
        //    defeated every text guard and is invisible to an at-head
        //    assertion, because both roles are environment-dependent. Against a
        //    BEFORE it is simply a diff.
        expect(after?.non_client_acl).toBe(before?.non_client_acl);
        expect(after?.acl_is_default).toBe(before?.acl_is_default);
      } finally {
        // Undo step 1 explicitly, THEN re-apply. The migration alone is not a
        // sufficient restore: it revokes `anon` and `authenticated` but never
        // `service_role`, so the grant step 1 adds for the diff would outlive
        // the case and leave the container holding a privilege it began
        // without. Both statements are idempotent, so this is also the repair
        // path for a failure anywhere between steps 1 and 4.
        //
        // If the PROCESS dies mid-case, nothing here runs and the container is
        // left degraded — `pnpm test:db:setup` is the fix, and the next run's
        // title-1 names that command in its failure message.
        await sql().unsafe('REVOKE ALL ON job_outbox FROM anon, authenticated, service_role;');
        await sql().unsafe(migration);
      }
    });
  },
);
