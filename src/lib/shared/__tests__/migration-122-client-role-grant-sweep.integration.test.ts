// Guard suite for migration 122 (#1176): anon and authenticated lose TRUNCATE,
// REFERENCES, TRIGGER and MAINTAIN on every public table, every privilege on
// the twenty deny-all tables, and those four rights from the owning role's
// default table privileges — while DML elsewhere, owner and service_role
// privileges, RLS, policies and column grants stay put.
//
// This suite EXECUTES DDL, deliberately: it is listed in MIGRATION_SHAPE_FILES
// (`scripts/ci/live-db-suites-audit.ts`). It degrades the container to the
// measured Supabase posture, proves the degrade landed, applies the checked-in
// file verbatim, diffs the catalogue against a BEFORE, and restores the
// original grants and default ACL — verified — before any `it` runs. Every `it`
// only asserts over the snapshots captured here.
//
// Version coverage: CI and e2e run postgres:17 (#1307 RT-4), so the
// MAINTAIN branch executes here. REVOKED_RIGHTS is derived from
// `acldefault` rather than spelled out — by design, so the move needed
// no suite change. Measured: acldefault('r', <owner>) yields eight
// privileges including MAINTAIN on PG17, seven without it on PG16; this
// suite passes 8 of 8 on 17. The mandatory PG17 post-apply query in
// `.claude/reference/migrations-log.md` entry 122 remains the proof for
// the two live Supabase projects, not this container — a different
// target, not superseded. The container's major is owned by
// `scripts/test-db-setup.sh` (REQUIRED_PG_MAJOR, #1379), and beforeAll
// refuses a server below it — so a PG16 container fails here instead of
// passing while asserting one right fewer.

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeAll, expect, it } from 'vitest';
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
import { assertServerMajor } from '@/lib/shared/__tests__/helpers/schema-ready';

const MIGRATION_FILE = 'supabase/migrations/122_client_role_grant_sweep.sql';
const DENY_ALL_TABLES = [
  'agent_outcomes',
  'agent_run_steps',
  'agent_runs',
  'analytics_events',
  'auto_approval_policies',
  'flagged_responses',
  'google_connections',
  'impersonation_sessions',
  'inbound_events',
  'judge_verdicts',
  'owner_leads',
  'poller_cursors',
  'prospect_demos',
  'refusal_events',
  'review_escalations',
  'solicitation_consent',
  'solicitation_send_breaker',
  'solicitation_suppression_corrections',
  'solicitation_suppressions',
  'solicitation_unsubscribe_tokens',
] as const;
const CANDIDATE_REVOKED_RIGHTS = ['TRUNCATE', 'REFERENCES', 'TRIGGER', 'MAINTAIN'] as const;
const CLIENT_ROLES = ['anon', 'authenticated'] as const;
const RESTORED_ROLES = ['anon', 'authenticated', 'service_role'] as const;
const DML = ['SELECT', 'INSERT', 'UPDATE', 'DELETE'] as const;
const OWNER_PROBE = 'public.__migration_122_owner_probe';
const DEFAULT_PROBE = 'public.__migration_122_default_probe';
const OWNER_GUARD_MESSAGE =
  'migration 122 must be applied by the role that owns every table in public';

interface TableSnapshot {
  rls: boolean;
  force: boolean;
  policyCount: number;
  policies: string;
  columnAcl: string[];
  acl: string[];
  clientEffective: string[];
}

interface Catalogue {
  tables: Record<string, TableSnapshot>;
  sequenceAcl: string;
  functionAcl: string;
  defaultAcl: string[];
  defaultProbe: string[];
}

interface TableGrant {
  relname: string;
  grantee: string;
  privilege_type: string;
  is_grantable: boolean;
}

interface ColumnGrant extends TableGrant {
  attname: string;
}

interface DefaultGrant {
  owner: string;
  grantee: string;
  privilege_type: string;
  is_grantable: boolean;
}

interface RoleGrants {
  tables: TableGrant[];
  columns: ColumnGrant[];
  defaults: DefaultGrant[];
}

const testDatabaseUrl = resolveTestDatabaseUrl();

let db: postgresType.Sql | undefined;
let featureDatabaseLock: LiveDbLock | undefined;

let serverPrivileges: string[] = [];
let revokedRights: string[] = [];
let currentUser = '';
let original: Catalogue;
let ownerGuardError: string | null = null;
let ownerGuardAfter: Catalogue;
let lockContention: { code: string | null; elapsedMs: number } | undefined;
let lockContentionAfter: Catalogue;
let before: Catalogue;
let after: Catalogue;
let afterSecond: Catalogue;

function sql(): postgresType.Sql {
  if (!db) throw new Error('migration 122 integration database was not initialized');
  return db;
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function quoteIdent(name: string): string {
  return `"${name.replaceAll('"', '""')}"`;
}

function table(catalogue: Catalogue, name: string): TableSnapshot {
  const snapshot = catalogue.tables[name];
  if (!snapshot) throw new Error(`migration 122 catalogue has no table ${name}`);
  return snapshot;
}

function clientRight(role: string, privilege: string): string {
  return `${role}:${privilege}`;
}

const PROBE_ROLLBACK = new Error('migration 122 default probe rollback sentinel');

// Every pg_default_acl entry — all roles, object types and scopes — as sorted
// `role|namespace-or-*|objtype|grantee|privilege|grantable` strings.
async function readDefaultAcl(): Promise<string[]> {
  const rows = await sql()<{ entry: string }[]>`
    SELECT d.defaclrole::regrole::text
           || '|' || CASE WHEN d.defaclnamespace = 0 THEN '*' ELSE d.defaclnamespace::regnamespace::text END
           || '|' || d.defaclobjtype::text
           || '|' || CASE WHEN x.grantee = 0 THEN 'PUBLIC' ELSE x.grantee::regrole::text END
           || '|' || x.privilege_type
           || '|' || x.is_grantable::text AS entry
      FROM pg_default_acl d
      CROSS JOIN LATERAL aclexplode(d.defaclacl) AS x
     ORDER BY 1
  `;
  return rows.map((row) => row.entry);
}

async function readCatalogue(): Promise<Catalogue> {
  const rows = await sql()<
    {
      relname: string;
      rls: boolean;
      force: boolean;
      policy_count: number;
      policies: string;
      column_acl: string[];
      acl: string[];
      client_effective: string[];
    }[]
  >`
    WITH server_privileges AS (
      SELECT DISTINCT acl.privilege_type
        FROM aclexplode(acldefault('r', current_user::regrole)) AS acl
    )
    SELECT
      c.relname,
      c.relrowsecurity AS rls,
      c.relforcerowsecurity AS force,
      (SELECT count(*)::int FROM pg_policy p WHERE p.polrelid = c.oid) AS policy_count,
      coalesce((
        SELECT jsonb_agg(jsonb_build_array(p.polname, p.polcmd, p.polpermissive,
            p.polroles::text, pg_get_expr(p.polqual, p.polrelid),
            pg_get_expr(p.polwithcheck, p.polrelid)) ORDER BY p.polname)
          FROM pg_policy p WHERE p.polrelid = c.oid
      ), '[]'::jsonb)::text AS policies,
      coalesce((
        SELECT array_agg(a.attname || '=' || a.attacl::text ORDER BY a.attname)
          FROM pg_attribute a
         WHERE a.attrelid = c.oid AND a.attnum > 0 AND NOT a.attisdropped
           AND a.attacl IS NOT NULL
      ), '{}'::text[]) AS column_acl,
      coalesce((
        SELECT array_agg(entry ORDER BY entry)
          FROM (
            SELECT (CASE WHEN x.grantee = 0 THEN 'PUBLIC' ELSE x.grantee::regrole::text END)
                   || ':' || x.privilege_type || ':' || x.is_grantable::text AS entry
              FROM aclexplode(coalesce(c.relacl, acldefault('r', c.relowner))) AS x
          ) entries
      ), '{}'::text[]) AS acl,
      coalesce((
        SELECT array_agg(r.role || ':' || sp.privilege_type ORDER BY r.role, sp.privilege_type)
          FROM unnest(ARRAY['anon', 'authenticated']) AS r(role)
          CROSS JOIN server_privileges sp
         WHERE has_table_privilege(r.role, c.oid, sp.privilege_type)
      ), '{}'::text[]) AS client_effective
    FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public' AND c.relkind IN ('r', 'p')
    ORDER BY c.relname
  `;

  const [schemaAcl] = await sql()<{ sequence_acl: string; function_acl: string }[]>`
    SELECT
      coalesce((
        SELECT jsonb_agg(jsonb_build_array(c.relname, c.relacl::text) ORDER BY c.relname)
          FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
         WHERE n.nspname = 'public' AND c.relkind = 'S'
      ), '[]'::jsonb)::text AS sequence_acl,
      coalesce((
        SELECT jsonb_agg(jsonb_build_array(p.oid::regprocedure::text, p.proacl::text)
                         ORDER BY p.oid::regprocedure::text)
          FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
         WHERE n.nspname = 'public'
      ), '[]'::jsonb)::text AS function_acl
  `;

  const defaultAcl = await readDefaultAcl();

  // A table created by the owning role reads the default privileges as they
  // really apply; the transaction always rolls back, so it never commits.
  let defaultProbe: string[] = [];
  try {
    await sql().begin(async (tx) => {
      await tx.unsafe(`CREATE TABLE ${DEFAULT_PROBE} (id int)`);
      const probeRows = await tx<{ entry: string }[]>`
        WITH server_privileges AS (
          SELECT DISTINCT acl.privilege_type
            FROM aclexplode(acldefault('r', current_user::regrole)) AS acl
        )
        SELECT r.role || ':' || sp.privilege_type AS entry
          FROM unnest(ARRAY['anon', 'authenticated', 'service_role']) AS r(role)
          CROSS JOIN server_privileges sp
         WHERE has_table_privilege(r.role, ${DEFAULT_PROBE}::regclass, sp.privilege_type)
         ORDER BY 1
      `;
      defaultProbe = probeRows.map((row) => row.entry);
      throw PROBE_ROLLBACK;
    });
  } catch (error) {
    if (error !== PROBE_ROLLBACK) throw error;
  }

  return {
    tables: Object.fromEntries(
      rows.map((row) => [
        row.relname,
        {
          rls: row.rls,
          force: row.force,
          policyCount: row.policy_count,
          policies: row.policies,
          columnAcl: row.column_acl,
          acl: row.acl,
          clientEffective: row.client_effective,
        },
      ]),
    ),
    sequenceAcl: schemaAcl?.sequence_acl ?? '',
    functionAcl: schemaAcl?.function_acl ?? '',
    defaultAcl,
    defaultProbe,
  };
}

async function readRoleGrants(): Promise<RoleGrants> {
  const roles = [...RESTORED_ROLES];
  const tables = await sql()<TableGrant[]>`
    SELECT c.relname, x.grantee::regrole::text AS grantee, x.privilege_type, x.is_grantable
      FROM pg_class c
      JOIN pg_namespace n ON n.oid = c.relnamespace
      CROSS JOIN LATERAL aclexplode(c.relacl) AS x
     WHERE n.nspname = 'public' AND c.relkind IN ('r', 'p')
       AND x.grantee <> 0 AND x.grantee::regrole::text = ANY(${roles}::text[])
     ORDER BY 1, 2, 3
  `;
  const columns = await sql()<ColumnGrant[]>`
    SELECT c.relname, a.attname, x.grantee::regrole::text AS grantee, x.privilege_type,
           x.is_grantable
      FROM pg_attribute a
      JOIN pg_class c ON c.oid = a.attrelid
      JOIN pg_namespace n ON n.oid = c.relnamespace
      CROSS JOIN LATERAL aclexplode(a.attacl) AS x
     WHERE n.nspname = 'public' AND c.relkind IN ('r', 'p')
       AND a.attnum > 0 AND NOT a.attisdropped
       AND x.grantee <> 0 AND x.grantee::regrole::text = ANY(${roles}::text[])
     ORDER BY 1, 2, 3, 4
  `;
  const defaults = await sql()<DefaultGrant[]>`
    SELECT d.defaclrole::regrole::text AS owner, x.grantee::regrole::text AS grantee,
           x.privilege_type, x.is_grantable
      FROM pg_default_acl d
      CROSS JOIN LATERAL aclexplode(d.defaclacl) AS x
     WHERE d.defaclnamespace = 'public'::regnamespace AND d.defaclobjtype = 'r'
       AND x.grantee <> 0 AND x.grantee::regrole::text = ANY(${roles}::text[])
     ORDER BY 1, 2, 3
  `;
  return { tables: [...tables], columns: [...columns], defaults: [...defaults] };
}

// A mutant that flips RLS or FORCE on some table would otherwise leave the
// shared container dirty for every later suite (red-team RT-3). Policies are
// not restored: 122 creates none, and a policy mutant fails the policies
// assertion loudly; `pnpm test:db:setup` is the repair for that case.
function rowSecurityStatements(original: Catalogue['tables'], current: Catalogue['tables']): string[] {
  const statements: string[] = [];
  for (const [name, snapshot] of Object.entries(original)) {
    const now = current[name];
    if (!now) continue;
    const target = `public.${quoteIdent(name)}`;
    if (now.rls !== snapshot.rls) {
      statements.push(`ALTER TABLE ${target} ${snapshot.rls ? 'ENABLE' : 'DISABLE'} ROW LEVEL SECURITY`);
    }
    if (now.force !== snapshot.force) {
      statements.push(`ALTER TABLE ${target} ${snapshot.force ? 'FORCE' : 'NO FORCE'} ROW LEVEL SECURITY`);
    }
  }
  return statements;
}

// Step 8: put the three roles' table grants, column grants and schema-public
// default table entries back exactly as `originalGrants` read them, restore
// every table's RLS and FORCE flags, then prove it — including the FULL
// pg_default_acl snapshot.
async function restore(
  originalGrants: RoleGrants,
  originalCatalogue: Catalogue,
): Promise<void> {
  const originalDefaultAcl = originalCatalogue.defaultAcl;
  // A failed verbatim apply leaves an aborted transaction open on this single
  // connection; ROLLBACK repairs it (and only warns when none is open).
  await sql().unsafe('ROLLBACK');
  const roles = RESTORED_ROLES.join(', ');
  const flagStatements = rowSecurityStatements(originalCatalogue.tables, (await readCatalogue()).tables);
  await sql().begin(async (tx) => {
    for (const statement of flagStatements) await tx.unsafe(statement);
    await tx.unsafe(`REVOKE ALL ON ALL TABLES IN SCHEMA public FROM ${roles}`);
    await tx.unsafe(`ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE ALL ON TABLES FROM ${roles}`);
    for (const grant of originalGrants.tables) {
      await tx.unsafe(
        `GRANT ${grant.privilege_type} ON public.${quoteIdent(grant.relname)} TO ${quoteIdent(grant.grantee)}`
          + (grant.is_grantable ? ' WITH GRANT OPTION' : ''),
      );
    }
    for (const grant of originalGrants.columns) {
      await tx.unsafe(
        `GRANT ${grant.privilege_type} (${quoteIdent(grant.attname)}) ON public.${quoteIdent(grant.relname)}`
          + ` TO ${quoteIdent(grant.grantee)}`
          + (grant.is_grantable ? ' WITH GRANT OPTION' : ''),
      );
    }
    for (const grant of originalGrants.defaults) {
      await tx.unsafe(
        `ALTER DEFAULT PRIVILEGES FOR ROLE ${quoteIdent(grant.owner)} IN SCHEMA public`
          + ` GRANT ${grant.privilege_type} ON TABLES TO ${quoteIdent(grant.grantee)}`
          + (grant.is_grantable ? ' WITH GRANT OPTION' : ''),
      );
    }
    await tx.unsafe(`DROP TABLE IF EXISTS ${OWNER_PROBE}`);
    await tx.unsafe(`DROP TABLE IF EXISTS ${DEFAULT_PROBE}`);
  });

  const restored = await readRoleGrants();
  const restoredDefaultAcl = await readDefaultAcl();
  const restoredCatalogue = await readCatalogue();
  if (
    rowSecurityStatements(originalCatalogue.tables, restoredCatalogue.tables).length > 0
    || JSON.stringify(restored.tables) !== JSON.stringify(originalGrants.tables)
    || JSON.stringify(restored.columns) !== JSON.stringify(originalGrants.columns)
    || JSON.stringify([...restoredDefaultAcl].sort()) !== JSON.stringify([...originalDefaultAcl].sort())
  ) {
    throw new Error(
      'migration 122 suite failed to restore the container grants — run pnpm test:db:setup',
    );
  }
}

describeWithDb(
  'migration 122 client-role grant sweep',
  { enabled: Boolean(testDatabaseUrl), timeout: 180_000 },
  () => {
    beforeAll(async () => {
      // Read the file FIRST: a missing or unreadable migration fails here,
      // before the lock, the connection or any DDL touches the container.
      const migration = readFileSync(join(process.cwd(), MIGRATION_FILE), 'utf8');

      const databaseUrl = assertLocalTestDatabaseUrl(testDatabaseUrl);
      featureDatabaseLock = await acquireLiveDbLock(databaseUrl);
      // max: 1 — the file carries its own BEGIN/COMMIT, which postgres.js
      // refuses through `unsafe` on a pooled client.
      db = postgres(databaseUrl, {
        max: 1,
        prepare: false,
        connection: { statement_timeout: 30_000 },
      });
      // Before any DDL: below PG17 the MAINTAIN branch cannot execute (#1379).
      await assertServerMajor(sql());

      const [identity] = await sql()<{ current_user: string }[]>`SELECT current_user::text`;
      currentUser = identity?.current_user ?? '';
      const privilegeRows = await sql()<{ privilege_type: string }[]>`
        SELECT DISTINCT acl.privilege_type
          FROM aclexplode(acldefault('r', current_user::regrole)) AS acl
         ORDER BY 1
      `;
      serverPrivileges = privilegeRows.map((row) => row.privilege_type);
      const candidates: readonly string[] = CANDIDATE_REVOKED_RIGHTS;
      revokedRights = candidates.filter((right) => serverPrivileges.includes(right));

      // 1. The untouched container.
      original = await readCatalogue();
      const originalGrants = await readRoleGrants();

      let applyFailure: unknown;
      try {
        // 2. Owner guard: a public table owned by another role must make the
        //    file refuse before it changes anything.
        await sql().unsafe(
          `CREATE TABLE ${OWNER_PROBE} (id int); ALTER TABLE ${OWNER_PROBE} OWNER TO service_role;`,
        );
        try {
          await sql().unsafe(migration);
          ownerGuardError = null;
        } catch (error) {
          ownerGuardError = messageOf(error);
        }
        await sql().unsafe('ROLLBACK');
        await sql().unsafe(`DROP TABLE ${OWNER_PROBE}`);
        ownerGuardAfter = await readCatalogue();

        // 2b. Lock contention (red-team RT-1, INV-9): another session holds the
        //     `reviews` catalogue row through an uncommitted GRANT. The file's
        //     `SET LOCAL lock_timeout` must make it fail fast with 55P03, not
        //     queue until the statement timeout (57014) — proven by hand
        //     2026-09-17: 5.0 s with the line, 30.0 s without it. The applier
        //     gets its own 15 s statement timeout so a mutant fails in bounded
        //     time; everything rolls back, so the container is untouched.
        const holder = postgres(databaseUrl, { max: 1, prepare: false });
        const applier = postgres(databaseUrl, {
          max: 1,
          prepare: false,
          connection: { statement_timeout: 15_000 },
        });
        try {
          await holder.unsafe('BEGIN');
          await holder.unsafe('GRANT SELECT ON public.reviews TO anon');
          const startedAt = Date.now();
          let code: string | null = null;
          try {
            await applier.unsafe(migration);
          } catch (error) {
            code = typeof error === 'object' && error !== null && 'code' in error
              ? String(error.code)
              : messageOf(error);
          }
          lockContention = { code, elapsedMs: Date.now() - startedAt };
          await applier.unsafe('ROLLBACK');
        } finally {
          await holder.unsafe('ROLLBACK');
          await holder.end({ timeout: 5 });
          await applier.end({ timeout: 5 });
        }
        lockContentionAfter = await readCatalogue();

        // 3. Degrade to the measured Supabase posture without granting DML the
        //    container lacks; `reviews` and `users` are the positive controls,
        //    and migration 040's column-only grants stay the negative ones.
        const rights = revokedRights.join(', ');
        const denyAll = DENY_ALL_TABLES.map((name) => `public.${name}`).join(', ');
        await sql().begin(async (tx) => {
          await tx.unsafe(`GRANT ALL ON ${denyAll} TO anon, authenticated`);
          await tx.unsafe(`GRANT ${rights} ON ALL TABLES IN SCHEMA public TO anon, authenticated`);
          await tx.unsafe('GRANT SELECT, INSERT, UPDATE, DELETE ON public.reviews TO anon, authenticated');
          await tx.unsafe('GRANT SELECT ON public.users TO authenticated');
          await tx.unsafe('GRANT ALL ON ALL TABLES IN SCHEMA public TO service_role');
          await tx.unsafe(
            'ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON TABLES TO anon, authenticated, service_role',
          );
        });

        // 4–7. BEFORE, apply verbatim, AFTER, apply again, AFTER-SECOND.
        before = await readCatalogue();
        await sql().unsafe(migration);
        after = await readCatalogue();
        await sql().unsafe(migration);
        afterSecond = await readCatalogue();
      } catch (error) {
        applyFailure = error;
      }

      // 8. Restore, and never let a restore failure hide an apply failure.
      let restoreFailure: unknown;
      try {
        await restore(originalGrants, original);
      } catch (error) {
        restoreFailure = error;
      }
      if (applyFailure !== undefined && restoreFailure !== undefined) {
        throw new Error(
          `migration 122 suite: apply failed (${messageOf(applyFailure)}) and restore failed (${messageOf(restoreFailure)})`,
          { cause: applyFailure },
        );
      }
      if (applyFailure !== undefined) throw applyFailure;
      if (restoreFailure !== undefined) throw restoreFailure;
    }, LIVE_DB_LOCK_HOOK_TIMEOUT_MS);

    afterAll(async () => {
      try {
        if (db) await db.end({ timeout: 5 });
      } finally {
        await featureDatabaseLock?.release();
        featureDatabaseLock = undefined;
      }
    }, LIVE_DB_LOCK_HOOK_TIMEOUT_MS);

    it('migration 122 removes TRUNCATE, REFERENCES, TRIGGER and MAINTAIN from anon and authenticated on every public table', () => {
      // Fail-open guards: an empty derived list would make every check vacuous.
      expect(serverPrivileges.length).toBeGreaterThanOrEqual(7);
      expect(revokedRights.length).toBeGreaterThanOrEqual(3);
      expect(Object.keys(before.tables).length).toBeGreaterThan(0);

      for (const [name, snapshot] of Object.entries(before.tables)) {
        for (const role of CLIENT_ROLES) {
          for (const right of revokedRights) {
            expect(snapshot.clientEffective, `degrade missing ${role}:${right} on ${name}`).toContain(
              clientRight(role, right),
            );
          }
        }
      }
      for (const [name, snapshot] of Object.entries(after.tables)) {
        const leftover = snapshot.clientEffective.filter((entry) =>
          revokedRights.includes(entry.split(':')[1] ?? ''),
        );
        expect(leftover, `revoked right survives on ${name}`).toEqual([]);
      }
    });

    it('migration 122 removes every anon and authenticated privilege from the twenty deny-all tables', () => {
      expect(DENY_ALL_TABLES).toHaveLength(20);
      for (const name of DENY_ALL_TABLES) {
        const afterTable = table(after, name);
        expect(afterTable.rls, `${name} RLS`).toBe(true);
        expect(afterTable.policyCount, `${name} policies`).toBe(0);
        expect(table(before, name).clientEffective.length, `degrade on ${name}`).toBeGreaterThan(0);
        expect(afterTable.clientEffective, `client privileges on ${name}`).toEqual([]);
      }
    });

    it('migration 122 keeps anon and authenticated DML on tables outside the deny-all list and leaves owner and service_role privileges unchanged', () => {
      const reviewsBefore = table(before, 'reviews').clientEffective;
      for (const role of CLIENT_ROLES) {
        for (const verb of DML) {
          expect(reviewsBefore, `control ${role}:${verb} on reviews`).toContain(clientRight(role, verb));
        }
      }
      expect(table(before, 'users').clientEffective).toContain('authenticated:SELECT');
      expect(table(after, 'users').clientEffective).toContain('authenticated:SELECT');
      expect(table(before, 'businesses').clientEffective).not.toContain('authenticated:UPDATE');
      expect(table(before, 'channel_enrollments').clientEffective).not.toContain('authenticated:INSERT');
      expect(table(before, 'channel_enrollments').clientEffective).not.toContain('authenticated:UPDATE');

      const denyAll: readonly string[] = DENY_ALL_TABLES;
      for (const [name, snapshot] of Object.entries(before.tables)) {
        if (denyAll.includes(name)) continue;
        const expected = snapshot.clientEffective.filter(
          (entry) => !revokedRights.includes(entry.split(':')[1] ?? ''),
        );
        expect(table(after, name).clientEffective, `client privileges on ${name}`).toEqual(expected);
      }

      const nonClient = (acl: string[]) =>
        acl.filter((entry) => {
          const grantee = entry.split(':')[0] ?? '';
          return grantee !== 'anon' && grantee !== 'authenticated';
        });
      for (const [name, snapshot] of Object.entries(before.tables)) {
        expect(nonClient(table(after, name).acl), `non-client ACL on ${name}`).toEqual(
          nonClient(snapshot.acl),
        );
      }
    });

    it('migration 122 changes no RLS flag, policy or column grant on any public table', () => {
      expect(Object.keys(after.tables)).toEqual(Object.keys(before.tables));
      for (const [name, snapshot] of Object.entries(before.tables)) {
        const afterTable = table(after, name);
        expect(afterTable.rls, `${name} rls`).toBe(snapshot.rls);
        expect(afterTable.force, `${name} force`).toBe(snapshot.force);
        expect(afterTable.policies, `${name} policies`).toBe(snapshot.policies);
        expect(afterTable.columnAcl, `${name} column ACL`).toEqual(snapshot.columnAcl);
      }
      expect(after.sequenceAcl).toBe(before.sequenceAcl);
      expect(after.functionAcl).toBe(before.functionAcl);
    });

    it("migration 122 removes the four rights from the owning role's default table privileges and keeps default DML", () => {
      for (const role of CLIENT_ROLES) {
        for (const right of revokedRights) {
          expect(before.defaultProbe, `degrade default ${role}:${right}`).toContain(clientRight(role, right));
          expect(after.defaultProbe, `default ${role}:${right}`).not.toContain(clientRight(role, right));
        }
        for (const verb of DML) {
          expect(after.defaultProbe, `default ${role}:${verb}`).toContain(clientRight(role, verb));
        }
      }
      const serviceRole = (probe: string[]) => probe.filter((entry) => entry.startsWith('service_role:'));
      expect(serviceRole(after.defaultProbe)).toEqual(serviceRole(before.defaultProbe));

      const clientRoles: readonly string[] = CLIENT_ROLES;
      const expectedDefaultAcl = before.defaultAcl.filter((entry) => {
        const [role, namespace, objtype, grantee, privilege] = entry.split('|');
        return !(
          role === currentUser
          && namespace === 'public'
          && objtype === 'r'
          && clientRoles.includes(grantee ?? '')
          && revokedRights.includes(privilege ?? '')
        );
      });
      expect(after.defaultAcl).toEqual(expectedDefaultAcl);
    });

    it('migration 122 is a no-op when applied a second time', () => {
      expect(afterSecond).toEqual(after);
    });

    it('migration 122 refuses to run when a public table is owned by a role other than the applier', () => {
      expect(ownerGuardError).toContain(OWNER_GUARD_MESSAGE);
      expect(ownerGuardAfter).toEqual(original);
    });

    it('migration 122 fails fast with a lock timeout when another session holds a catalogue row lock', () => {
      // 55P03 = lock_not_available (the file's `SET LOCAL lock_timeout`);
      // 57014 = query_canceled (the 15 s statement timeout a missing
      // lock_timeout would fall through to).
      expect(lockContention?.code).toBe('55P03');
      expect(lockContention?.elapsedMs).toBeLessThan(12_000);
      expect(lockContentionAfter).toEqual(original);
    });
  },
);
