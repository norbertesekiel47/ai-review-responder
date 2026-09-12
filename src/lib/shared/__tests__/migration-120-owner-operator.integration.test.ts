// Shape assertions for migration 120 — the Owner Operator tables
// (agent_conversations, agent_turns, agent_proposals,
// agent_unsupported_requests): deny-all RLS, revoked client grants, and the two
// unique constraints on agent_turns. Follows
// migration-116-refusal-events.integration.test.ts for shape and for the
// cross-process live-DB lock, and asserts the schema with assertSchemaReady
// rather than applying any DDL at run time (ci:live-db-suites R2).
//
// Title 2 lives OUTSIDE describeWithDb on purpose: it reads TENANT_TABLES /
// TENANT_SCOPE_COLUMNS through a module import and needs no database, so
// gating it on the live DB would make it a silent skip rather than a failure
// on a keyless run (the 116 suite does the same for its title 19).
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import postgres from 'postgres';
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
  MIGRATION_120_OWNER_OPERATOR,
} from '@/lib/shared/__tests__/helpers/schema-ready';
import { TENANT_SCOPE_COLUMNS, TENANT_TABLES } from '../../../../scripts/ci/tenant-tables';

const OWNER_OPERATOR_TABLES = [
  'agent_conversations',
  'agent_turns',
  'agent_proposals',
  'agent_unsupported_requests',
] as const;

const testDatabaseUrl = resolveTestDatabaseUrl();
let db: postgres.Sql | undefined;
let lock: LiveDbLock | undefined;

describe('migration 120 owner operator — registry', () => {
  it('migration 120 registers all four tables in TENANT_TABLES and TENANT_SCOPE_COLUMNS', () => {
    const tenantTables: readonly string[] = TENANT_TABLES;
    for (const table of OWNER_OPERATOR_TABLES) {
      expect(tenantTables, table).toContain(table);
      // account_id alone: none of the four carries a business_id tenant column.
      // agent_turns.location_id and agent_proposals.location_id are targets,
      // not tenant identity — a per-location read still narrows by account.
      expect(TENANT_SCOPE_COLUMNS[table], table).toEqual(['account_id']);
    }
  });
});

describeWithDb(
  'migration 120 owner operator',
  { enabled: Boolean(testDatabaseUrl), timeout: 180_000 },
  () => {
    beforeAll(async () => {
      const databaseUrl = assertLocalTestDatabaseUrl(testDatabaseUrl);
      lock = await acquireLiveDbLock(databaseUrl);
      db = postgres(databaseUrl, {
        max: 2,
        prepare: false,
        connection: { statement_timeout: 30_000 },
      });
      await assertSchemaReady(db, [MIGRATION_120_OWNER_OPERATOR]);
    }, LIVE_DB_LOCK_HOOK_TIMEOUT_MS);

    afterAll(async () => {
      try {
        if (db) await db.end({ timeout: 5 });
      } finally {
        await lock?.release();
        lock = undefined;
      }
    }, LIVE_DB_LOCK_HOOK_TIMEOUT_MS);

    it('migration 120 creates the four owner-operator tables with deny-all RLS, revoked client grants, and the two unique constraints', async () => {
      const sql = db!;

      const relations = await sql<{ relname: string; relrowsecurity: boolean }[]>`
        SELECT c.relname, c.relrowsecurity
        FROM pg_class c
        JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname = 'public'
          AND c.relname = ANY(${[...OWNER_OPERATOR_TABLES]}::text[])
        ORDER BY c.relname
      `;
      expect(relations.map((r) => r.relname)).toEqual([...OWNER_OPERATOR_TABLES].sort());
      expect(relations.every((r) => r.relrowsecurity)).toBe(true);

      // Indexed access rather than array destructuring throughout: the repo
      // compiles with noUncheckedIndexedAccess, so a destructured row is
      // `T | undefined` and `[{ x }] = rows` does not typecheck.
      const policyRows = await sql<{ policy_count: number }[]>`
        SELECT COUNT(*)::int AS policy_count
        FROM pg_policies
        WHERE schemaname = 'public'
          AND tablename = ANY(${[...OWNER_OPERATOR_TABLES]}::text[])
      `;
      expect(policyRows[0]!.policy_count).toBe(0);

      for (const table of OWNER_OPERATOR_TABLES) {
        for (const role of ['anon', 'authenticated']) {
          for (const privilege of ['SELECT', 'INSERT', 'UPDATE', 'DELETE']) {
            const grantRows = await sql<{ granted: boolean }[]>`
              SELECT has_table_privilege(${role}, ${`public.${table}`}, ${privilege}) AS granted
            `;
            expect(grantRows[0]!.granted, `${role} ${privilege} on ${table}`).toBe(false);
          }
        }
      }

      const constraints = await sql<{ conname: string; contype: string }[]>`
        SELECT con.conname, con.contype
        FROM pg_constraint con
        JOIN pg_class c ON c.oid = con.conrelid
        WHERE c.relname = 'agent_turns'
          AND con.conname IN (
            'agent_turns_account_client_key_uniq',
            'agent_turns_conversation_sequence_uniq'
          )
        ORDER BY con.conname
      `;
      expect(constraints).toEqual([
        { conname: 'agent_turns_account_client_key_uniq', contype: 'u' },
        { conname: 'agent_turns_conversation_sequence_uniq', contype: 'u' },
      ]);
    });
  },
);
