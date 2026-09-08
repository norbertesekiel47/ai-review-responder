// Live-Postgres eval for `revokeAdmin` (#1182).
//
// Titles are VERBATIM from `.feature/intake.json` `tests_to_add`.
//
// WHY THIS FILE EXISTS BESIDE `revoke-admin.test.ts`. The unit suite proves the
// module EMITS the right statements against a mock `sql`, and a mock has no
// constraints, so it is blind to the two claims that actually matter:
//
//   * `admin_audit_log.actor_user_id` is `NOT NULL REFERENCES users(id)` with
//     no ON DELETE action (117_admin_audit_log.sql:51). The self-actor design
//     — the REVOKED admin is the actor of its own `admin_revoked` row — is only
//     legal because that admin's `users` row is still there. That is the whole
//     reason the reset is a revoke and not a deletion, and only a real database
//     proves the FK resolves.
//   * "the users row is untouched" is a claim about rows, not about statements.
//     A mock can only say which SQL was issued; the live DB can say the row is
//     byte-for-byte the same afterwards.
//
// Applies NO migration SQL and executes NO DDL: `pnpm test:db:setup` provisions
// the schema, this file ASSERTS it with `assertSchemaReady` and seeds with
// INSERT only (#573; `ci:live-db-suites` R2).
//
// No cross-process live-DB lock: every row is keyed to a per-run unique
// `@revoke-admin.test` email, and `users_email_key` / `users_auth_id_key` are
// per-value uniques a sibling suite cannot collide with.

import { randomUUID } from 'node:crypto';
import { afterAll, afterEach, beforeAll, expect, it, vi } from 'vitest';
import postgres from 'postgres';
import type postgresType from 'postgres';
import type { SupabaseClient } from '@supabase/supabase-js';
import { describeWithDb } from '@/__tests__/helpers/describe-with-db';
import {
  assertLocalTestDatabaseUrl,
  resolveTestDatabaseUrl,
} from '@/lib/shared/__tests__/helpers/live-db-lock';
import {
  assertSchemaReady,
  type SchemaRequirement,
} from '@/lib/shared/__tests__/helpers/schema-ready';
import { revokeAdmin, REVOKE_BAN_DURATION, RESTORE_BAN_DURATION } from '../../revoke-admin';

/**
 * Declared locally rather than added to `schema-ready.ts`, matching the
 * `mint-admin.integration.test.ts` sibling: that helper is outside this
 * branch's `allowed_edit_surface`.
 */
const MIGRATION_117_ADMIN_AUDIT_LOG: SchemaRequirement = {
  migration: '117_admin_audit_log',
  tables: ['admin_audit_log'],
  columns: ['admin_audit_log.actor_user_id', 'admin_audit_log.event_type'],
  indexes: ['idx_admin_audit_actor_created'],
};

const testDatabaseUrl = resolveTestDatabaseUrl();
const EMAIL_DOMAIN = '@revoke-admin.test';

const TEST_OPERATOR = {
  os_user: 'test-operator',
  host: 'test-host',
  provenance: 'unauthenticated_shell',
} as const;

let db: postgresType.Sql | undefined;
const seededEmails: string[] = [];

function uniqueEmail(): string {
  const email = `revoke-${Date.now()}-${randomUUID().slice(0, 8)}${EMAIL_DOMAIN}`;
  seededEmails.push(email);
  return email;
}

/**
 * Supabase Auth double. The live database proves the Postgres half; there is
 * no GoTrue in a `postgres:16` container, and the local test DB deliberately
 * has no `auth.users` relation at all (`scripts/ci/test-db-bootstrap.sql`) —
 * which is exactly the `banProbe: 'unavailable'` path this suite exercises.
 */
function supabaseDouble(options: { error?: { message: string } } = {}) {
  const updateUserById = vi.fn(async () => ({
    data: { user: { id: 'auth-id' } },
    error: options.error ?? null,
  }));
  const deleteUser = vi.fn(async () => ({ data: null, error: null }));
  const client = {
    auth: { admin: { updateUserById, deleteUser } },
  } as unknown as SupabaseClient;
  return { client, updateUserById, deleteUser };
}

/** Seed one admin identity the way `mint-admin.ts` would leave it. */
async function seedAdmin(
  sql: postgresType.Sql,
  email: string,
): Promise<{ userId: string; authId: string }> {
  const userId = randomUUID();
  const authId = randomUUID();
  await sql`
    INSERT INTO users (id, name, email, role, auth_id, account_id)
    VALUES (${userId}::uuid, 'Live Revoke Admin', ${email}, 'admin', ${authId}, NULL)
  `;
  return { userId, authId };
}

describeWithDb(
  'revokeAdmin against live local Postgres',
  { enabled: Boolean(testDatabaseUrl), timeout: 60_000 },
  () => {
    beforeAll(async () => {
      const databaseUrl = assertLocalTestDatabaseUrl(testDatabaseUrl);
      db = postgres(databaseUrl, { max: 1, prepare: false });
      await assertSchemaReady(db, [MIGRATION_117_ADMIN_AUDIT_LOG]);
    }, 60_000);

    afterEach(async () => {
      if (!db || seededEmails.length === 0) return;
      // admin_audit_log FIRST: actor_user_id carries no ON DELETE action, so
      // the users delete would raise 23503 the other way round.
      await db`
        DELETE FROM admin_audit_log
        WHERE actor_user_id IN (SELECT id FROM users WHERE email IN ${db(seededEmails)})
      `;
      await db`DELETE FROM users WHERE email IN ${db(seededEmails)}`;
      seededEmails.length = 0;
    }, 30_000);

    afterAll(async () => {
      if (db) await db.end({ timeout: 5 });
    }, 30_000);

    it('revoke writes exactly one admin_revoked row whose actor FK resolves to the revoked admin', async () => {
      if (!db) throw new Error('revoke-admin integration database was not initialized');
      const email = uniqueEmail();
      const { userId, authId } = await seedAdmin(db, email);
      const { client, updateUserById } = supabaseDouble();

      const result = await revokeAdmin(db, client, {
        email,
        action: 'revoke',
        dryRun: false,
        operator: TEST_OPERATOR,
      });

      expect(result).toMatchObject({
        status: 'changed',
        action: 'revoke',
        identity: { userId, authId },
      });
      expect(updateUserById).toHaveBeenCalledWith(authId, {
        ban_duration: REVOKE_BAN_DURATION,
      });

      // The self-actor design: the NOT NULL FK to users(id) resolves precisely
      // because the revoke left that row in place.
      const audit = await db<
        { event_type: string; entity_id: string | null; payload: unknown }[]
      >`
        SELECT event_type, entity_id, payload FROM admin_audit_log
        WHERE actor_user_id = ${userId}::uuid
      `;
      expect(audit).toHaveLength(1);
      expect(audit[0]).toMatchObject({ event_type: 'admin_revoked', entity_id: userId });
      // Postgres.js + PgBouncer can hand JSONB back as a string.
      const payload = typeof audit[0]?.payload === 'string'
        ? (JSON.parse(audit[0].payload as string) as Record<string, unknown>)
        : (audit[0]?.payload as Record<string, unknown>);
      expect(payload).toMatchObject({
        source: 'scripts/revoke-admin.ts',
        action: 'revoke',
        users_row_preserved: true,
        actor_is_subject: true,
        attribution: 'bootstrap_self_actor',
      });
    });

    it('restore writes exactly one admin_restored row', async () => {
      if (!db) throw new Error('revoke-admin integration database was not initialized');
      const email = uniqueEmail();
      const { userId, authId } = await seedAdmin(db, email);
      const { client, updateUserById } = supabaseDouble();

      const result = await revokeAdmin(db, client, {
        email,
        action: 'restore',
        dryRun: false,
        operator: TEST_OPERATOR,
      });

      // The local test DB has no `auth.users`, so the ban-state probe reports
      // `unavailable` and the transition is attempted rather than skipped.
      expect(result).toMatchObject({ status: 'changed', action: 'restore' });
      expect(updateUserById).toHaveBeenCalledWith(authId, {
        ban_duration: RESTORE_BAN_DURATION,
      });

      const audit = await db<{ event_type: string }[]>`
        SELECT event_type FROM admin_audit_log WHERE actor_user_id = ${userId}::uuid
      `;
      expect(audit).toHaveLength(1);
      expect(audit[0]?.event_type).toBe('admin_restored');
    });

    it('neither revoke nor restore deletes or updates the users row', async () => {
      if (!db) throw new Error('revoke-admin integration database was not initialized');
      const email = uniqueEmail();
      const { userId } = await seedAdmin(db, email);

      const before = await db<Record<string, unknown>[]>`
        SELECT to_jsonb(u) AS row FROM users u WHERE id = ${userId}::uuid
      `;

      for (const action of ['revoke', 'restore'] as const) {
        const { client } = supabaseDouble();
        const result = await revokeAdmin(db, client, {
          email,
          action,
          dryRun: false,
          operator: TEST_OPERATOR,
        });
        expect(result.status).toBe('changed');
      }

      const after = await db<Record<string, unknown>[]>`
        SELECT to_jsonb(u) AS row FROM users u WHERE id = ${userId}::uuid
      `;
      expect(after).toHaveLength(1);
      // The owner's decision in one assertion: `users` rows are FK targets, so
      // the reset must leave the row byte-for-byte alone — role included.
      expect(after[0]?.row).toEqual(before[0]?.row);
    });

    it('refuses an email with no users row without touching the Auth API', async () => {
      if (!db) throw new Error('revoke-admin integration database was not initialized');
      const { client, updateUserById } = supabaseDouble();

      const result = await revokeAdmin(db, client, {
        email: `absent-${randomUUID().slice(0, 8)}${EMAIL_DOMAIN}`,
        action: 'revoke',
        dryRun: false,
        operator: TEST_OPERATOR,
      });

      expect(result).toMatchObject({ status: 'refused', reason: 'users_row_missing' });
      expect(updateUserById).not.toHaveBeenCalled();
    });

    it('leaves the admin_audit_log untouched when the Auth ban fails', async () => {
      if (!db) throw new Error('revoke-admin integration database was not initialized');
      const email = uniqueEmail();
      const { userId } = await seedAdmin(db, email);
      const { client } = supabaseDouble({ error: { message: 'network unreachable' } });

      const result = await revokeAdmin(db, client, {
        email,
        action: 'revoke',
        dryRun: false,
        operator: TEST_OPERATOR,
      });

      expect(result).toMatchObject({ status: 'failed', authOutcome: 'unknown' });
      const audit = await db`
        SELECT id FROM admin_audit_log WHERE actor_user_id = ${userId}::uuid
      `;
      expect(audit).toHaveLength(0);
    });
  },
);
