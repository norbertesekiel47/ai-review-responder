// Shape + behaviour assertions for migration 117 — `admin_audit_log`, the
// admin control-plane actor trail (#468). Because the table carries no tenant
// column it sits OUTSIDE `TENANT_TABLES`, and `ci:rls-audit` only audits that
// list — so THIS suite is the regression guard for the security boundary:
// RLS enabled, zero policies, client-role privileges revoked, and the real
// writer (`writeAdminAuditLog`) actually persisting a row.
//
// It executes NO DDL (`ci:live-db-suites` R2): `pnpm test:db:setup` provisions
// the container to head and every case reads the catalogue, reads the
// checked-in migration file, or writes rows under its own seeded admin user.
// It takes the cross-process live-DB lock because it asserts a GLOBAL fact
// (table privileges) that another suite's DDL could perturb.

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
  type SchemaRequirement,
} from '@/lib/shared/__tests__/helpers/schema-ready';
import {
  REVIEWED_NOT_TENANT_SCOPED,
  TENANT_TABLES,
} from '../../../../scripts/ci/tenant-tables';

const TABLE = 'admin_audit_log';
const MIGRATION_FILE = 'supabase/migrations/117_admin_audit_log.sql';
const ACTOR_INDEX = 'idx_admin_audit_actor_created';
const EVENT_INDEX = 'idx_admin_audit_event_created';
const ACTOR_FK = 'admin_audit_log_actor_user_id_fkey';
const FOREIGN_KEY_VIOLATION = '23503';

const MIGRATION_117_ADMIN_AUDIT_LOG: SchemaRequirement = {
  migration: '117_admin_audit_log',
  tables: [TABLE],
  indexes: [ACTOR_INDEX, EVENT_INDEX],
  constraints: [{ table: TABLE, name: ACTOR_FK }],
};

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

// ── registry + file text: no database needed, so never a silent skip ────────

describe('migration 117 registries', () => {
  it('admin_audit_log is REVIEWED_NOT_TENANT_SCOPED and NOT a TENANT_TABLES member', () => {
    const reviewed = REVIEWED_NOT_TENANT_SCOPED.find((entry) => entry.table === TABLE);
    expect(reviewed?.reason).toMatch(/actor_user_id/);
    const tenantTables: readonly string[] = TENANT_TABLES;
    expect(tenantTables).not.toContain(TABLE);
  });

  it('the migration file enables RLS with no policy and revokes the client roles', () => {
    const text = readFileSync(join(process.cwd(), MIGRATION_FILE), 'utf8');
    expect(text).toMatch(/ALTER TABLE admin_audit_log ENABLE ROW LEVEL SECURITY;/);
    expect(text).not.toMatch(/CREATE POLICY/i);
    expect(text).toMatch(/REVOKE ALL ON admin_audit_log FROM anon, authenticated;/);
    // No referential action: a users delete must fail, never cascade the trail away.
    expect(text).toMatch(/actor_user_id UUID NOT NULL REFERENCES users\(id\),/);
    expect(text).not.toMatch(/ON DELETE (CASCADE|SET NULL|SET DEFAULT)/i);
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
        max: 4,
        prepare: false,
        connection: { statement_timeout: 30_000 },
      });
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
