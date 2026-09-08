// Live-Postgres eval for `mintAdmin` (#1178, tracer T1 — RED before T4).
//
// Titles 28-30, VERBATIM from `.feature/intake.json` `tests_to_add`.
//
// WHY THIS FILE EXISTS BESIDE `mint-admin.test.ts`. The unit suite proves the
// module EMITS the right statements in the right order, inside `sql.begin`.
// A mock `sql` has no constraints, so it is blind to the two claims that
// actually matter here — the same blindness `admin-onboarding-service.test.ts`
// records for its own rollback ordering (a mock passed for months while the
// function could not delete a single row in production):
//
//   * `admin_audit_log.actor_user_id` is `NOT NULL REFERENCES users(id)` with
//     no ON DELETE action (117_admin_audit_log.sql:51). The self-actor design
//     — the minted admin is the actor of its own `admin_minted` row — is only
//     legal because both rows land in ONE transaction with the `users` INSERT
//     first. Only a real database proves that FK resolves.
//   * A failing audit write must take the `users` row down with it. Under a
//     mock, "both statements were issued inside begin()" and "both rows are
//     gone after a rollback" are different claims and only the second is the
//     invariant.
//
// Applies NO migration SQL and executes NO DDL: `pnpm test:db:setup`
// provisions the schema, this file ASSERTS it with `assertSchemaReady` and
// seeds with INSERT only (#573; `ci:live-db-suites` R2).
//
// No cross-process live-DB lock. Unlike the refusal-ledger and attribution
// suites, nothing here touches a GLOBAL partial unique index or a
// platform-wide sweep: every row is keyed to a per-run unique
// `@mint-admin.test` email, and `users_email_key` / `users_auth_id_key` are
// per-value uniques that a sibling suite cannot collide with.

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
import { mintAdmin, type MintAdminResult } from '../../mint-admin';

/**
 * Declared locally rather than added to `schema-ready.ts`: that helper is
 * outside this branch's `allowed_edit_surface`, and the refusal-ledger suite
 * declares migration 116's requirement inline for exactly the same reason.
 *
 * The COLUMN is named as well as the table: a database with the table but
 * without `actor_user_id` would fail on the INSERT with an undefined-column
 * error rather than the actionable `pnpm test:db:setup` message.
 */
const MIGRATION_117_ADMIN_AUDIT_LOG: SchemaRequirement = {
  migration: '117_admin_audit_log',
  tables: ['admin_audit_log'],
  columns: ['admin_audit_log.actor_user_id', 'admin_audit_log.event_type'],
  indexes: ['idx_admin_audit_actor_created'],
};

const testDatabaseUrl = resolveTestDatabaseUrl();
const EMAIL_DOMAIN = '@mint-admin.test';

let db: postgresType.Sql | undefined;
const mintedEmails: string[] = [];

function uniqueEmail(): string {
  const email = `mint-${Date.now()}-${randomUUID().slice(0, 8)}${EMAIL_DOMAIN}`;
  mintedEmails.push(email);
  return email;
}

/**
 * Supabase Auth double. The live database proves the Postgres half; there is
 * no GoTrue in a `postgres:16` container, and the local test DB deliberately
 * has no `auth.users` relation at all
 * (`scripts/ci/test-db-bootstrap.sql`) — which is exactly the
 * `authProbe: 'unavailable'` path.
 */
function supabaseDouble(authId: string) {
  const deleteUser = vi.fn(async () => ({ data: null, error: null }));
  const client = {
    auth: {
      admin: {
        createUser: vi.fn(async () => ({ data: { user: { id: authId } }, error: null })),
        deleteUser,
        generateLink: vi.fn(async () => ({
          data: { properties: { hashed_token: 'hashed-token' } },
          error: null,
        })),
      },
    },
  } as unknown as SupabaseClient;
  return { client, deleteUser };
}

describeWithDb(
  'mintAdmin against live local Postgres',
  { enabled: Boolean(testDatabaseUrl), timeout: 60_000 },
  () => {
    beforeAll(async () => {
      const databaseUrl = assertLocalTestDatabaseUrl(testDatabaseUrl);
      db = postgres(databaseUrl, { max: 1, prepare: false });
      await assertSchemaReady(db, [MIGRATION_117_ADMIN_AUDIT_LOG]);
    }, 60_000);

    afterEach(async () => {
      if (!db || mintedEmails.length === 0) return;
      // admin_audit_log FIRST: actor_user_id carries no ON DELETE action, so
      // the users delete would raise 23503 the other way round.
      await db`
        DELETE FROM admin_audit_log
        WHERE actor_user_id IN (SELECT id FROM users WHERE email IN ${db(mintedEmails)})
      `;
      await db`DELETE FROM users WHERE email IN ${db(mintedEmails)}`;
      mintedEmails.length = 0;
    }, 30_000);

    afterAll(async () => {
      if (db) await db.end({ timeout: 5 });
    }, 30_000);

    it('commits the users row and its admin_audit_log row in one transaction', async () => {
      if (!db) throw new Error('mint-admin integration database was not initialized');
      const email = uniqueEmail();
      const authId = randomUUID();
      const { client } = supabaseDouble(authId);

      const result = (await mintAdmin(db, client, {
        email,
        name: 'Live Mint Admin',
        appUrl: 'https://staging.repworth.net',
        dryRun: false,
      })) as Extract<MintAdminResult, { status: 'minted' }>;

      expect(result.status).toBe('minted');

      const [user] = await db<
        { id: string; role: string; auth_id: string | null; account_id: string | null }[]
      >`
        SELECT id::text, role, auth_id, account_id::text FROM users WHERE email = ${email}
      `;
      expect(user).toMatchObject({ role: 'admin', auth_id: authId, account_id: null });
      expect(user?.id).toBe(result.userId);

      // The self-actor design: the NOT NULL FK to users(id) resolves because
      // the audit row is written after the users INSERT in the SAME tx.
      const audit = await db<{ event_type: string; entity_id: string | null }[]>`
        SELECT event_type, entity_id FROM admin_audit_log
        WHERE actor_user_id = ${result.userId}::uuid
      `;
      expect(audit).toHaveLength(1);
      expect(audit[0]).toMatchObject({ event_type: 'admin_minted', entity_id: result.userId });
    });

    it('leaves no users row when the audit write fails', async () => {
      if (!db) throw new Error('mint-admin integration database was not initialized');
      const email = uniqueEmail();
      const authId = randomUUID();
      const { client, deleteUser } = supabaseDouble(authId);

      // Force the audit INSERT to fail with a real, server-raised, deterministic
      // rejection — 23503, because actor_user_id has no matching users row —
      // by handing mintAdmin a client whose transaction body is intercepted.
      // No DDL, no temporary constraint: the failure is injected by making the
      // audit sink unsatisfiable for THIS transaction only.
      const failing = Object.assign(
        (...args: Parameters<postgresType.Sql>) => db!(...args),
        db!,
        {
          begin: (callback: (tx: postgresType.TransactionSql) => Promise<unknown>) =>
            db!.begin(async (tx) => {
              const result = await callback(tx);
              // A constraint the transaction cannot satisfy: an audit row whose
              // actor is an id no users row carries.
              await tx`
                INSERT INTO admin_audit_log (id, actor_user_id, event_type, payload)
                VALUES (${randomUUID()}::uuid, ${randomUUID()}::uuid, 'forced_failure', '{}'::jsonb)
              `;
              return result;
            }),
        },
      ) as unknown as postgresType.Sql;

      const result = await mintAdmin(failing, client, {
        email,
        name: 'Live Mint Admin',
        appUrl: 'https://staging.repworth.net',
        dryRun: false,
      });

      expect(result.status).toBe('failed');
      const rows = await db`SELECT id FROM users WHERE email = ${email}`;
      expect(rows).toHaveLength(0);
      // 23503 is a class-23 SQLSTATE, so the rollback is CONFIRMED and the
      // orphaned Auth identity is cleaned up.
      expect(deleteUser).toHaveBeenCalledWith(authId);
    });

    it('refuses a second mint for the same email against the live schema', async () => {
      if (!db) throw new Error('mint-admin integration database was not initialized');
      const email = uniqueEmail();
      const first = supabaseDouble(randomUUID());
      const second = supabaseDouble(randomUUID());
      const input = {
        email,
        name: 'Live Mint Admin',
        appUrl: 'https://staging.repworth.net',
        dryRun: false,
      };

      const minted = await mintAdmin(db, first.client, input);
      expect(minted.status).toBe('minted');

      const again = await mintAdmin(db, second.client, input);

      expect(again).toMatchObject({ status: 'refused', reason: 'users_row_exists' });
      // The refusal is read-only: it never reached the Auth API, so there is
      // nothing to compensate and exactly one users row survives.
      expect(second.deleteUser).not.toHaveBeenCalled();
      const rows = await db`SELECT id FROM users WHERE email = ${email}`;
      expect(rows).toHaveLength(1);
    });
  },
);
