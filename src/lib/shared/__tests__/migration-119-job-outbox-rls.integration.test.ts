// Security-posture assertions for migration 119 — deny-all RLS on
// `job_outbox` (#1171). The table is the transactional outbox dispatch spine
// (invariant #2), it carries no tenant column, and it sits OUTSIDE
// `TENANT_TABLES` (`REVIEWED_NOT_TENANT_SCOPED`). `ci:rls-audit` only audits
// that list, so THIS suite is the regression guard for the boundary — the
// same role `migration-117-admin-audit-log.integration.test.ts` plays for
// `admin_audit_log`, and the pattern this file follows.
//
// ── the drift it closes ─────────────────────────────────────────────────────
//
// Production (`udeyaqnvpojbwgoaxwdg`, created 2026-04-05) shipped with the
// Supabase `ensure_rls` DDL event trigger, which switched RLS on after every
// CREATE TABLE. Staging (`kubdiqdhqbhwmqfditeg`, created 2026-05-30) was
// provisioned after Supabase dropped it from the template. Migration 107
// removed the trigger but deliberately left its past output alone, recording
// that the `job_outbox` repair belonged in its own reviewed migration. This is
// that migration; 107's header is the provenance.
//
// The observable gap on staging was not disclosure alone: `anon` held INSERT
// with RLS off, and `OutboxPoller` dispatches whatever rows it finds. Anyone
// holding the public staging anon key could enqueue a job.
//
// ── what this suite deliberately does NOT do ────────────────────────────────
//
// It executes NO DDL (`ci:live-db-suites` R2). `pnpm test:db:setup` provisions
// the container to head and every case reads the catalogue or reads the
// checked-in migration file.
//
// It does NOT prove the REVOKE against the local catalogue. The local test
// container never runs Supabase's `ALTER DEFAULT PRIVILEGES`, so
// `scripts/ci/test-db-bootstrap.sql` grants `anon`/`authenticated` USAGE on
// the schema and nothing on any table. A privilege assertion there passes
// whether or not the REVOKE exists — vacuous, and a vacuous green is worse
// than no case. The REVOKE's guard is therefore the migration FILE TEXT
// (title 3, DB-free so it can never silently skip), and its proof in the two
// real environments is post-apply introspection recorded on the PR. The
// catalogue case (title 4) still runs, because on staging and production the
// grants ARE present before apply and absent after, and because the assertion
// that `postgres` and `service_role` keep their privileges is NOT vacuous
// anywhere.
//
// It takes the cross-process live-DB lock: table-level RLS and privileges are
// GLOBAL facts another suite's DDL could perturb.
//
// ── why assertSchemaReady cannot gate this one ──────────────────────────────
//
// 119 adds no relation, column, index or constraint, so `SchemaRequirement`
// has nothing to name beyond `job_outbox` itself, which has existed since 001.
// A container provisioned BEFORE 119 therefore passes the precondition. Title
// 1 is the real detector, and its failure message says so.

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
  type SchemaRequirement,
} from '@/lib/shared/__tests__/helpers/schema-ready';
import { REVIEWED_NOT_TENANT_SCOPED, TENANT_TABLES } from '../../../../scripts/ci/tenant-tables';

const TABLE = 'job_outbox';
const MIGRATION_FILE = 'supabase/migrations/119_job_outbox_rls.sql';
const BEHIND_HEAD = `job_outbox RLS posture is not at migration head — run pnpm test:db:setup`;

// 119 creates nothing, so the only object it can name is the table it hardens.
// Kept for the provisioning-marker path, not as proof the migration ran.
const MIGRATION_119_JOB_OUTBOX_RLS: SchemaRequirement = {
  migration: '119_job_outbox_rls',
  tables: [TABLE],
};

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
    // predicate on every binding. job_outbox carries neither column and is
    // bound by 78 production files, so membership would cost dozens of
    // allowlist entries and audit nothing real. This suite is the guard
    // instead.
    const reviewed = REVIEWED_NOT_TENANT_SCOPED.find((entry) => entry.table === TABLE);
    expect(reviewed?.reason).toMatch(/[Tt]ransactional outbox/);
    const tenantTables: readonly string[] = TENANT_TABLES;
    expect(tenantTables).not.toContain(TABLE);
  });

  it('migration 119 revokes every anon and authenticated privilege on job_outbox', () => {
    const text = readFileSync(join(process.cwd(), MIGRATION_FILE), 'utf8');

    expect(text).toMatch(/REVOKE ALL ON job_outbox FROM anon, authenticated;/);

    // The dangerous mutation is a WIDER revoke, not a missing one: stripping
    // `postgres` or `service_role` would stop every worker in the platform,
    // and no catalogue case in this file could distinguish that from a correct
    // apply on a container whose roles were never granted anything.
    const revokes = text.match(/^\s*REVOKE\b.*$/gim) ?? [];
    expect(revokes).toHaveLength(1);
    expect(revokes[0]).not.toMatch(/\b(postgres|service_role|PUBLIC)\b/);
  });

  it('migration 119 grants no policy and does not force row level security', () => {
    const text = readFileSync(join(process.cwd(), MIGRATION_FILE), 'utf8');
    expect(text).toMatch(/ALTER TABLE job_outbox ENABLE ROW LEVEL SECURITY;/);
    expect(text).not.toMatch(/CREATE POLICY/i);
    // FORCE would apply RLS to the table OWNER, which is the role every worker
    // connects as. It is the one statement in this file that could take the
    // platform down, so it is asserted absent in text as well as in catalogue.
    expect(text).not.toMatch(/FORCE ROW LEVEL SECURITY/i);
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
      await assertSchemaReady(db, [MIGRATION_119_JOB_OUTBOX_RLS]);
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
      // topic and payload for every tenant; there is no owner-facing read of
      // this table, so any policy at all would be a wider door than the
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
      expect(relation?.rls_forced).toBe(false);
    });

    it("migration 119 leaves the job_outbox owner's privileges intact and denies the client roles", async () => {
      // The owner is DERIVED, never spelled: it is `postgres` on both Supabase
      // projects but NOT in the local container (the first draft hardcoded
      // 'postgres' and failed with `role "postgres" does not exist`). The
      // property under test is "the role that owns the table keeps its
      // privileges" — which is what a widened REVOKE would break — not the
      // spelling of its name.
      //
      // `service_role` is deliberately NOT asserted here. It holds Supabase's
      // default privileges on both projects and NONE in the local container,
      // because `scripts/ci/test-db-bootstrap.sql` grants it schema USAGE only.
      // "Unchanged by this migration" is not a property a single post-state
      // read can establish, and pinning either value would encode one
      // environment's accident as a guarantee. The guard that does hold
      // everywhere is the file-text case above: exactly one REVOKE line, naming
      // neither the owner, nor `service_role`, nor PUBLIC.
      const [privileges] = await sql()<
        {
          anon_select: boolean;
          anon_insert: boolean;
          authed_select: boolean;
          authed_insert: boolean;
          owner_select: boolean;
          owner_insert: boolean;
          owner_update: boolean;
          owner_delete: boolean;
        }[]
      >`
        SELECT
          has_table_privilege('anon', 'public.job_outbox', 'SELECT') AS anon_select,
          has_table_privilege('anon', 'public.job_outbox', 'INSERT') AS anon_insert,
          has_table_privilege('authenticated', 'public.job_outbox', 'SELECT') AS authed_select,
          has_table_privilege('authenticated', 'public.job_outbox', 'INSERT') AS authed_insert,
          has_table_privilege(owner.role, 'public.job_outbox', 'SELECT') AS owner_select,
          has_table_privilege(owner.role, 'public.job_outbox', 'INSERT') AS owner_insert,
          has_table_privilege(owner.role, 'public.job_outbox', 'UPDATE') AS owner_update,
          has_table_privilege(owner.role, 'public.job_outbox', 'DELETE') AS owner_delete
        FROM (
          SELECT pg_get_userbyid(cls.relowner) AS role
            FROM pg_class cls
           WHERE cls.oid = 'public.job_outbox'::regclass
        ) AS owner
      `;

      // The four owner arms are the load-bearing half — NOT vacuous on any
      // container, and exactly what a widened REVOKE would break. The
      // anon/authenticated arms are vacuous locally (the bootstrap grants them
      // nothing) and load-bearing on staging and production, where Supabase's
      // default privileges did grant them.
      expect(privileges).toEqual({
        anon_select: false,
        anon_insert: false,
        authed_select: false,
        authed_insert: false,
        owner_select: true,
        owner_insert: true,
        owner_update: true,
        owner_delete: true,
      });
    });
  },
);
