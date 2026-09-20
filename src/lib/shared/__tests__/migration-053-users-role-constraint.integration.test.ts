// Migration 053 — retire the legacy `sales_partner` role and enforce the
// owner/admin allowlist on `users.role` (#50, deferred from #43; rebuilt for
// #1301). The file has exactly two statements:
//
//   1. `UPDATE users SET role = 'admin' WHERE role = 'sales_partner'` — DML,
//      the only DML in any of the seven migration-guard suites' subjects.
//   2. a `DO $$` block that adds `CHECK (role IN ('owner','admin'))` as
//      constraint `users_role_check`, guarded by a `pg_constraint` lookup
//      scoped to `conname = 'users_role_check'` AND `t.relname = 'users'` AND
//      `n.nspname = 'public'`.
//
// ── why this suite EXECUTES the file instead of reading it ───────────────────
//
// The predecessor (`migration-053-structure.test.ts`, deleted with this file's
// arrival) proved all of the above by pattern-matching the migration's SQL
// TEXT — including asserting the `DO` guard's relation scoping by grepping for
// `t.relname = 'users'`. That approach lost five red-team passes on #1171:
// line-anchored counting, then `CREATE\nPOLICY` split across a newline, then
// `DISABLE/**/ROW LEVEL SECURITY`, then `--` inside a string literal, then a
// comment standing in as evidence. Each fix closed one lexical class and the
// next pass found another instance of it, and the fifth pass's verdict was
// that the APPROACH was wrong rather than the code. So this suite stops
// parsing the file and starts running it, on the shared `migration-guard.ts`
// harness. PostgreSQL is the parser now, and it cannot be evaded by any
// spelling.
//
// It is listed in `MIGRATION_SHAPE_FILES` (`scripts/ci/live-db-suites-audit.ts`)
// — the sanctioned exemption from R2 for files where APPLYING the migration IS
// the subject — and it holds the cross-process live-DB lock for its whole
// lifetime, which every member of that allowlist is enforced to do.
//
// ── the two oracles, and why neither alone is enough ────────────────────────
//
// ORACLE A — the PINNED literals (titles 2 and 9). The exact
// `pg_get_constraintdef` rendering of `users_role_check`, taken from
// `.feature/oracle-a-literals.txt`, which was captured from the container
// independently of the migration file. That independence is the whole point:
// oracle B alone is CIRCULAR on a freshly provisioned database, because
// `pnpm test:db:setup` builds the container FROM the migration under test. Widen
// the allowlist to include `sales_partner` and the BEFORE reading carries the
// widened constraint, the re-apply restores the widened constraint, and
// `AFTER == BEFORE` passes. Oracle A is what fails.
//
// ORACLE B — degrade, prove the degrade landed, apply the checked-in file
// VERBATIM, diff the whole `public` catalogue (titles 3 to 8). Everything runs
// inside `withRolledBackTransaction`, which always rolls back, so no seeded row
// and no dropped constraint ever reaches the shared container. NOTHING here is
// seeded outside that wrapper.
//
// ── the two decoys, and why their ORDER is load-bearing ─────────────────────
//
// Titles 6 and 7 prove the `DO` guard's scoping by planting a CHECK constraint
// named `users_role_check` somewhere the guard must NOT match, and they plant
// it while the REAL constraint is ABSENT. A first attempt at this placed the
// decoy after the real constraint had been restored, which tests nothing: with
// the real constraint present, a scoped lookup and an unscoped one both find a
// row and both skip the `ADD CONSTRAINT`, so the two are indistinguishable.
// The decoy only discriminates while `public.users` is unprotected.
//
// The two decoys challenge two DIFFERENT filters, so neither is redundant:
//
//   `public.accounts` (title 6) challenges `t.relname = 'users'`. A guard
//   matching `conname` alone would find it, skip the `ADD CONSTRAINT`, and
//   leave `users` with no allowlist at all.
//
//   `decoy_1301.users` (title 7) challenges `n.nspname = 'public'`. A guard
//   that dropped the schema filter would match a same-named constraint on a
//   same-named table in another schema and skip for the same reason.
//
// `CREATE SCHEMA decoy_1301` rolls back with everything else. The claim that a
// table in that schema cannot register as a moved `public` table is VERIFIED
// against the harness in title 7 rather than assumed: `readPublicCatalogue`
// keys tables by bare name, so a reader that was not schema-scoped would
// collide `decoy_1301.users` with `public.users`, and the case asserts the
// table count and the column count are unchanged by the decoy's creation.
//
// ── the cross-cutting case (title 9) reaches beyond this suite's table ──────
//
// `migration guards reject weakened index predicates and role allowlists on a
// freshly provisioned database` asserts TWO pinned literals in one case:
// `idx_impersonation_active_actor`'s `pg_get_indexdef` (an object of migration
// 048, including its `WHERE (ended_at IS NULL)` predicate) and
// `users_role_check`'s `pg_get_constraintdef`. That is deliberate, not sloppy
// scoping: `readPublicCatalogue` reads EVERY table in `public`, so one case can
// carry both halves of the cross-suite claim that oracle A is independent of
// the migration files — the claim that a container provisioned from a weakened
// migration fails somewhere. It lives HERE because 053's allowlist is one of
// the two halves. The 048 suite keeps its own per-suite head expectations; this
// case does not replace them. `assertSchemaReady` therefore names 048's
// requirement alongside 053's, so a behind-head container fails with the
// actionable `pnpm test:db:setup` message instead of an undefined-object error.
//
// ── one stated fact about `users` ───────────────────────────────────────────
//
// `users` carries exactly ONE row-security policy at head (`users_self_select`)
// and `rowsecurity=true force=false`. Title 2 pins that count, so no later
// catalogue comparison in this suite can be written against an assumed-empty
// policy list; the full-table equality diffs in titles 3 and 6 carry the policy
// along with everything else.
//
// The DB-free registry case (title 1) is the only one that cannot silently
// skip; every other case sits behind `describeWithDb` and needs a database.

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
  assertDegradeLanded,
  assertOnlyTablesMoved,
  readMigrationSql,
  readPublicCatalogue,
  withRolledBackTransaction,
  type PublicCatalogue,
} from '@/lib/shared/__tests__/helpers/migration-guard';
import {
  assertSchemaReady,
  MIGRATION_048_IMPERSONATION_SESSIONS,
  MIGRATION_053_USERS_ROLE_CONSTRAINT,
} from '@/lib/shared/__tests__/helpers/schema-ready';
import { auditLiveDbFile } from '../../../../scripts/ci/live-db-suites-audit';

const TABLE = 'users';
const CONSTRAINT = 'users_role_check';
const MIGRATION_FILE = '053_users_role_constraint.sql';
const SUITE_FILE =
  'src/lib/shared/__tests__/migration-053-users-role-constraint.integration.test.ts';
const BEHIND_HEAD =
  'users role-allowlist posture is not at migration head — run pnpm test:db:setup';

/**
 * ORACLE A. The exact `pg_get_constraintdef` rendering of `users_role_check`,
 * copied byte for byte from `.feature/oracle-a-literals.txt` — captured from
 * the container, NOT derived from `053_users_role_constraint.sql`. The column
 * is `VARCHAR`, so PostgreSQL renders the allowlist as a `character varying`
 * ARRAY cast to `text[]` rather than as the source's `role IN ('owner',
 * 'admin')`; re-deriving this string from the migration text is exactly the
 * mistake this literal exists to prevent.
 */
const USERS_ROLE_CHECK_DEF =
  "CHECK (((role)::text = ANY ((ARRAY['owner'::character varying, " +
  "'admin'::character varying])::text[])))";

/**
 * ORACLE A, the other half of title 9. Migration 048's partial unique index,
 * whose `WHERE (ended_at IS NULL)` predicate is what enforces one active
 * impersonation session per actor. Also from `.feature/oracle-a-literals.txt`.
 */
const ACTIVE_ACTOR_INDEX_DEF =
  'CREATE UNIQUE INDEX idx_impersonation_active_actor ON ' +
  'public.impersonation_sessions USING btree (actor_user_id) ' +
  'WHERE (ended_at IS NULL)';

/** The degrade. Dropping the CHECK is also what makes the fixtures insertable. */
const DROP_ROLE_CHECK = 'ALTER TABLE users DROP CONSTRAINT users_role_check;';

/** Decoy 1 — same name, same schema, DIFFERENT relation (`t.relname`). */
const DECOY_ON_ACCOUNTS =
  'ALTER TABLE accounts ADD CONSTRAINT users_role_check CHECK (id IS NOT NULL);';
const DECOY_ON_ACCOUNTS_DEF = 'CHECK ((id IS NOT NULL))';

/** Decoy 2 — same name, same relation name, DIFFERENT schema (`n.nspname`). */
const DECOY_SCHEMA = 'decoy_1301';
const DECOY_IN_OTHER_SCHEMA =
  'CREATE SCHEMA decoy_1301;' +
  ' CREATE TABLE decoy_1301.users (role text);' +
  ' ALTER TABLE decoy_1301.users ADD CONSTRAINT users_role_check CHECK (role IS NOT NULL);';
const DECOY_IN_OTHER_SCHEMA_DEF = 'CHECK ((role IS NOT NULL))';

/**
 * Fixed UUID literals, not `randomUUID()`: a failure message that names the row
 * should be reproducible, and the transaction always rolls back so no
 * uniqueness pressure ever accumulates on the shared container.
 */
const SALES_PARTNER_ID = '0530f1a1-0000-4053-8000-000000000001';
const OWNER_ID = '0530f1a1-0000-4053-8000-000000000002';
const ADMIN_ID = '0530f1a1-0000-4053-8000-000000000003';
const SECOND_OWNER_ID = '0530f1a1-0000-4053-8000-000000000004';

const LEGACY_ROLE = 'sales_partner';

interface UserRow {
  id: string;
  name: string;
  email: string;
  phone: string | null;
  role: string;
  auth_id: string | null;
  created_at: Date;
  updated_at: Date;
  account_id: string | null;
}

const testDatabaseUrl = resolveTestDatabaseUrl();

let db: postgresType.Sql | undefined;
let featureDatabaseLock: LiveDbLock | undefined;

function sql(): postgresType.Sql {
  if (!db) throw new Error('migration 053 integration database was not initialized');
  return db;
}

/**
 * Seeds the three role fixtures. Callable ONLY after `DROP_ROLE_CHECK`: the
 * `sales_partner` row violates the head constraint, and that ordering is
 * load-bearing rather than incidental — it is also the proof that the
 * constraint really was dropped.
 */
async function seedRoleFixtures(tx: postgresType.TransactionSql): Promise<void> {
  await tx`
    INSERT INTO users (id, name, email, role, phone)
    VALUES
      (${SALES_PARTNER_ID}, 'Migration 053 legacy partner',
       'migration-053-sales-partner@repworth.test', ${LEGACY_ROLE}, '+15550530001'),
      (${OWNER_ID}, 'Migration 053 owner',
       'migration-053-owner@repworth.test', 'owner', '+15550530002'),
      (${ADMIN_ID}, 'Migration 053 admin',
       'migration-053-admin@repworth.test', 'admin', '+15550530003')
  `;
}

/**
 * Fires the deferred FK checks the seeding just queued, so the migration's
 * `ALTER TABLE users ADD CONSTRAINT` is not refused.
 *
 * NOT a workaround — a property of `users` that has to be handled explicitly.
 * `fk_users_account` is `DEFERRABLE INITIALLY DEFERRED`, so every INSERT into
 * `users` queues a trigger event that stays pending until COMMIT, and
 * PostgreSQL refuses `ALTER TABLE` on a relation with pending trigger events
 * (`cannot ALTER TABLE "users" because it has pending trigger events`) — which
 * is exactly how the first run of this suite failed. In production 053 runs as
 * its own migration with nothing pending; the pending events exist here only
 * because the fixtures and the apply share one transaction, which is what keeps
 * the shared container clean. Settling them restores the production condition
 * rather than relaxing it: the checks really run, and they pass because every
 * seeded row leaves the nullable `account_id` NULL.
 */
async function settleDeferredFkEvents(tx: postgresType.TransactionSql): Promise<void> {
  await tx`SET CONSTRAINTS ALL IMMEDIATE`;
}

/** Every column of the seeded rows, ordered, for a full-row equality diff. */
async function readSeededRows(tx: postgresType.TransactionSql): Promise<UserRow[]> {
  return tx<UserRow[]>`
    SELECT id, name, email, phone, role, auth_id, created_at, updated_at, account_id
      FROM users
     WHERE id IN (${SALES_PARTNER_ID}, ${OWNER_ID}, ${ADMIN_ID}, ${SECOND_OWNER_ID})
     ORDER BY id
  `;
}

function constraintDefinition(
  catalogue: PublicCatalogue,
  table: string,
  name: string,
): string | undefined {
  return catalogue.tables[table]?.constraints.find((entry) => entry.name === name)?.definition;
}

// ── registry: no database needed, so this one can never silently skip ───────

describe('migration 053 registries', () => {
  it('migration 053 suite is registered in MIGRATION_SHAPE_FILES', () => {
    // `MIGRATION_SHAPE_FILES` is a module-private `const` inside
    // `scripts/ci/live-db-suites-audit.ts`, so this case reads its EFFECT
    // through the audit's own exported entry point rather than a hardcoded
    // copy of the set. This file's real checked-in text executes DDL (the
    // `tx.unsafe` degrades below) and names the cross-process lock marker, so
    // running the real audit against that real text yields zero findings ONLY
    // while this exact path is a member of the allowlist. A dropped or
    // misspelled entry surfaces as `runtime-ddl` here, and a lock call renamed
    // away surfaces as `unlocked-ddl` — both stronger than asserting set
    // membership against a copy that could itself drift.
    const ownSourceText = readFileSync(join(process.cwd(), SUITE_FILE), 'utf8');
    expect(auditLiveDbFile(SUITE_FILE, ownSourceText)).toEqual([]);
  });
});

describeWithDb(
  'migration 053 users role allowlist',
  { enabled: Boolean(testDatabaseUrl), timeout: 180_000 },
  () => {
    beforeAll(async () => {
      const databaseUrl = assertLocalTestDatabaseUrl(testDatabaseUrl);
      featureDatabaseLock = await acquireLiveDbLock(databaseUrl);
      db = postgres(databaseUrl, {
        // max: 1, not 2 — every case runs the checked-in migration verbatim
        // through `unsafe` inside a transaction it also owns
        // (`withRolledBackTransaction`), and postgres.js refuses a
        // transaction-bearing `unsafe` on a pooled client
        // (`UNSAFE_TRANSACTION: Only use sql.begin, sql.reserved or max: 1`)
        // because it cannot guarantee the statements land on one backend.
        // Every case here is sequential, so a single connection costs nothing.
        max: 1,
        prepare: false,
        connection: { statement_timeout: 30_000 },
      });
      // 048's requirement is named because title 9 asserts one of 048's
      // objects; see the header.
      await assertSchemaReady(sql(), [
        MIGRATION_053_USERS_ROLE_CONSTRAINT,
        MIGRATION_048_IMPERSONATION_SESSIONS,
      ]);
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

    it('users carries the users_role_check constraint at head', async () => {
      let head: PublicCatalogue | undefined;
      await withRolledBackTransaction(sql(), async (tx) => {
        head = await readPublicCatalogue(tx);
      });
      if (!head) throw new Error('readPublicCatalogue returned nothing');
      const users = head.tables[TABLE];

      // The literal, byte for byte. A widened allowlist — `sales_partner` added
      // back to the CHECK — changes this string and fails here even on a
      // container provisioned FROM the weakened migration, which is the one
      // failure oracle B structurally cannot see.
      expect(constraintDefinition(head, TABLE, CONSTRAINT), BEHIND_HEAD).toBe(
        USERS_ROLE_CHECK_DEF,
      );

      // No stray legacy row survives at head. 053's UPDATE is the statement
      // that guarantees it, and #43 blocks the role at every runtime auth path.
      const [legacy] = await sql()<{ legacy_rows: string }[]>`
        SELECT count(*)::text AS legacy_rows FROM users WHERE role = ${LEGACY_ROLE}
      `;
      expect(legacy?.legacy_rows, BEHIND_HEAD).toBe('0');

      // The stated `users` fact (see the header): RLS on, FORCE off, exactly
      // ONE policy. Pinned so no comparison in this suite is written against
      // an assumed-empty policy list, and so a policy added or removed on the
      // owner-facing table is a loud failure rather than a silent change.
      expect(users?.rowSecurity, BEHIND_HEAD).toBe(true);
      expect(users?.forceRowSecurity, BEHIND_HEAD).toBe(false);
      expect(users?.policies.map((entry) => entry.name), BEHIND_HEAD).toEqual([
        'users_self_select',
      ]);
    });

    // ── ORACLE B: degrade, prove it landed, apply verbatim, diff ────────────

    it('re-applying 053 restores users_role_check after it is dropped', async () => {
      await withRolledBackTransaction(sql(), async (tx) => {
        const before = await readPublicCatalogue(tx);
        await tx.unsafe(DROP_ROLE_CHECK);
        const degraded = await readPublicCatalogue(tx);

        // Names the property AND the individual object: the harness throws if
        // `users_role_check` was already absent from BEFORE (a vacuous check in
        // the other direction) or survived into the degraded reading, so this
        // case cannot pass against a no-op migration.
        assertDegradeLanded(before, degraded, {
          table: TABLE,
          property: 'constraints',
          absent: [CONSTRAINT],
        });

        await tx.unsafe(readMigrationSql(MIGRATION_FILE));
        const after = await readPublicCatalogue(tx);

        // The restored constraint must match the PINNED literal, not merely
        // the before-reading: byte-identical to oracle A closes the circular
        // self-comparison on a freshly provisioned container.
        expect(constraintDefinition(after, TABLE, CONSTRAINT)).toBe(USERS_ROLE_CHECK_DEF);
        // And the rest of `users` — columns, defaults, indexes, policies,
        // grants, comments — must come back exactly as it was.
        expect(after.tables[TABLE]).toEqual(before.tables[TABLE]);
      });
    });

    it('re-applying 053 converts a stray sales_partner row to admin', async () => {
      await withRolledBackTransaction(sql(), async (tx) => {
        // The drop comes FIRST because the `sales_partner` fixture violates the
        // head constraint. That ordering is the point, not a workaround: the
        // legacy value is unrepresentable at head, which is what 053 bought.
        await tx.unsafe(DROP_ROLE_CHECK);
        await seedRoleFixtures(tx);
        await settleDeferredFkEvents(tx);

        const seeded = await readSeededRows(tx);
        expect(seeded.map((row) => row.role)).toEqual([
          LEGACY_ROLE, // SALES_PARTNER_ID …0001
          'owner', //     OWNER_ID         …0002
          'admin', //     ADMIN_ID         …0003
        ]);

        // ONE apply, and the roles are asserted right here. The old text guard
        // proved the `WHERE` clause EXISTED; these three rows prove it is
        // EXCLUSIVE, which is the property that matters. An `UPDATE` with the
        // `WHERE` removed would promote every owner in the table to admin, and
        // no amount of regex over the file text could see it.
        await tx.unsafe(readMigrationSql(MIGRATION_FILE));

        const converted = await readSeededRows(tx);
        expect(converted.map((row) => ({ id: row.id, role: row.role }))).toEqual([
          { id: SALES_PARTNER_ID, role: 'admin' },
          { id: OWNER_ID, role: 'owner' },
          { id: ADMIN_ID, role: 'admin' },
        ]);
      });
    });

    it('re-applying 053 moves no other table in public', async () => {
      await withRolledBackTransaction(sql(), async (tx) => {
        const before = await readPublicCatalogue(tx);
        await tx.unsafe(DROP_ROLE_CHECK);
        await tx.unsafe(readMigrationSql(MIGRATION_FILE));
        const after = await readPublicCatalogue(tx);

        // A migration may harden the one table it names while doing arbitrary
        // damage elsewhere — appending `GRANT ALL ON admin_audit_log TO anon;`
        // to migration 119 passed that whole suite once, and the grant really
        // landed (#1171). Every table outside `[users]` must come out
        // byte-identical.
        assertOnlyTablesMoved(before, after, [TABLE]);
      });
    });

    it('re-applying 053 is idempotent and ignores same-named constraints outside public.users', async () => {
      await withRolledBackTransaction(sql(), async (tx) => {
        const before = await readPublicCatalogue(tx);

        // Order is load-bearing: the decoy is planted while `public.users` is
        // UNPROTECTED. With the real constraint present a scoped and an
        // unscoped lookup both find a row and both skip, so the decoy would
        // discriminate nothing (see the header).
        await tx.unsafe(DROP_ROLE_CHECK);
        await tx.unsafe(DECOY_ON_ACCOUNTS);
        await seedRoleFixtures(tx);
        await settleDeferredFkEvents(tx);
        const degraded = await readPublicCatalogue(tx);

        assertDegradeLanded(before, degraded, {
          table: TABLE,
          property: 'constraints',
          absent: [CONSTRAINT],
        });
        // The decoy itself must have LANDED, or the case proves nothing about
        // the guard. `present` is the same three-part contract with its
        // polarity reversed: absent from BEFORE, there now.
        assertDegradeLanded(before, degraded, {
          table: 'accounts',
          property: 'constraints',
          present: [CONSTRAINT],
        });

        // FIRST apply. A guard matching `conname` alone would find the
        // `accounts` decoy, skip the `ADD CONSTRAINT`, and leave `users` with
        // no allowlist — the assertion below is what catches that.
        await tx.unsafe(readMigrationSql(MIGRATION_FILE));
        const afterFirst = await readPublicCatalogue(tx);
        const rowsAfterFirst = await readSeededRows(tx);

        expect(constraintDefinition(afterFirst, TABLE, CONSTRAINT)).toBe(USERS_ROLE_CHECK_DEF);
        expect(constraintDefinition(afterFirst, 'accounts', CONSTRAINT)).toBe(
          DECOY_ON_ACCOUNTS_DEF,
        );
        expect(afterFirst.tables[TABLE]).toEqual(before.tables[TABLE]);

        // SECOND apply — the already-present branch of the `DO` guard, which a
        // single apply after a drop never exercises. It is the branch that
        // makes the migration re-runnable, and the one that would raise
        // `duplicate_object` if the guard were removed.
        await tx.unsafe(readMigrationSql(MIGRATION_FILE));
        const afterSecond = await readPublicCatalogue(tx);

        // The catalogue does not move, and neither does any row: the second
        // apply's `UPDATE` finds no `sales_partner` (the first apply converted
        // it) so every one of the seeded rows must come back identical, every
        // column included.
        expect(afterSecond).toEqual(afterFirst);
        expect(await readSeededRows(tx)).toEqual(rowsAfterFirst);
        assertOnlyTablesMoved(degraded, afterSecond, [TABLE]);
      });
    });

    it('re-applying 053 ignores a same-named constraint in another schema', async () => {
      await withRolledBackTransaction(sql(), async (tx) => {
        const before = await readPublicCatalogue(tx);

        await tx.unsafe(DROP_ROLE_CHECK);
        await tx.unsafe(DECOY_IN_OTHER_SCHEMA);
        const degraded = await readPublicCatalogue(tx);

        assertDegradeLanded(before, degraded, {
          table: TABLE,
          property: 'constraints',
          absent: [CONSTRAINT],
        });

        // The decoy must EXIST, and it is invisible to the harness by design —
        // `readPublicCatalogue` reads schema `public` only — so its presence is
        // read straight off the catalogue here.
        const decoyBefore = await tx<{ definition: string }[]>`
          SELECT pg_get_constraintdef(con.oid) AS definition
            FROM pg_constraint con
            JOIN pg_class rel ON rel.oid = con.conrelid
            JOIN pg_namespace nsp ON nsp.oid = rel.relnamespace
           WHERE con.conname = ${CONSTRAINT}
             AND rel.relname = ${TABLE}
             AND nsp.nspname = ${DECOY_SCHEMA}
        `;
        expect(decoyBefore.map((row) => row.definition)).toEqual([
          DECOY_IN_OTHER_SCHEMA_DEF,
        ]);

        // VERIFIED, not assumed (header): the harness keys tables by BARE name,
        // so a reader that was not schema-scoped would collide
        // `decoy_1301.users` — a one-column table — with `public.users`.
        expect(Object.keys(degraded.tables)).toEqual(Object.keys(before.tables));
        expect(degraded.tables[TABLE]?.columns.length).toBe(before.tables[TABLE]?.columns.length);

        // A guard that dropped `n.nspname = 'public'` would match the decoy and
        // skip, leaving `public.users` unprotected.
        await tx.unsafe(readMigrationSql(MIGRATION_FILE));
        const after = await readPublicCatalogue(tx);

        expect(constraintDefinition(after, TABLE, CONSTRAINT)).toBe(USERS_ROLE_CHECK_DEF);
        // The decoy is untouched: 053 adds to `public.users` and nothing else.
        const decoyAfter = await tx<{ definition: string }[]>`
          SELECT pg_get_constraintdef(con.oid) AS definition
            FROM pg_constraint con
            JOIN pg_class rel ON rel.oid = con.conrelid
            JOIN pg_namespace nsp ON nsp.oid = rel.relnamespace
           WHERE con.conname = ${CONSTRAINT}
             AND rel.relname = ${TABLE}
             AND nsp.nspname = ${DECOY_SCHEMA}
        `;
        expect(decoyAfter).toEqual(decoyBefore);
        // The decoy schema's table still does not register as a moved or
        // appeared `public` table.
        assertOnlyTablesMoved(degraded, after, [TABLE]);
      });
    });

    it('migration re-application preserves existing rows except the intended sales_partner conversion', async () => {
      await withRolledBackTransaction(sql(), async (tx) => {
        await tx.unsafe(DROP_ROLE_CHECK);
        await seedRoleFixtures(tx);
        // A fourth row carrying values in the columns the UPDATE must not
        // touch: `auth_id` and `account_id` are the two that decide identity
        // and tenancy, so a stray `SET` reaching them is the damage worth
        // pinning.
        await tx`
          INSERT INTO users (id, name, email, role, phone, auth_id)
          VALUES (${SECOND_OWNER_ID}, 'Migration 053 second owner',
                  'migration-053-second-owner@repworth.test', 'owner', '+15550530004',
                  'migration-053-auth-id')
        `;
        await settleDeferredFkEvents(tx);

        const beforeRows = await readSeededRows(tx);
        // Non-vacuity: four rows, one of them legacy. An empty snapshot would
        // make every assertion below trivially true — and `users` is EMPTY on a
        // freshly provisioned container, so the rows have to be seeded here.
        expect(beforeRows).toHaveLength(4);
        expect(beforeRows.filter((row) => row.role === LEGACY_ROLE)).toHaveLength(1);

        await tx.unsafe(readMigrationSql(MIGRATION_FILE));

        const afterRows = await readSeededRows(tx);
        // Every column of every row survives; the ONLY difference anywhere is
        // the legacy row's `role`. `users` has no triggers, so `updated_at` is
        // part of the comparison rather than an exception to it.
        expect(afterRows).toEqual(
          beforeRows.map((row) =>
            row.role === LEGACY_ROLE ? { ...row, role: 'admin' } : row,
          ),
        );
      });
    });

    // ── the cross-cutting oracle-A case this suite owns ─────────────────────

    it('migration guards reject weakened index predicates and role allowlists on a freshly provisioned database', async () => {
      // Deliberately reaches beyond this suite's own table. `pnpm test:db:setup`
      // provisions the container FROM the migrations under test, so a
      // degrade-and-re-apply diff is circular: a weakened file yields a
      // weakened BEFORE and `AFTER == BEFORE` passes. Only a literal written
      // independently of those files fails. `readPublicCatalogue` reads every
      // table in `public`, so this one case carries both halves of that claim —
      // migration 048's partial-unique predicate and migration 053's role
      // allowlist. See the header for why the ownership sits here.
      let head: PublicCatalogue | undefined;
      await withRolledBackTransaction(sql(), async (tx) => {
        head = await readPublicCatalogue(tx);
      });
      if (!head) throw new Error('readPublicCatalogue returned nothing');
      const catalogue = head;

      // Delete `WHERE ended_at IS NULL` from migration 048 and the index
      // becomes a plain unique on `actor_user_id`, which forbids a SECOND
      // session for an actor who already closed one. The predicate is the
      // whole guarantee, and it is inside this string.
      const activeActor = catalogue.tables['impersonation_sessions']?.indexes.find(
        (entry) => entry.name === 'idx_impersonation_active_actor',
      );
      expect(activeActor?.definition, BEHIND_HEAD).toBe(ACTIVE_ACTOR_INDEX_DEF);

      // Add `sales_partner` back to migration 053's allowlist and this string
      // changes. Both halves are literals in this file, so both fail on a
      // container built from a weakened migration.
      expect(constraintDefinition(catalogue, TABLE, CONSTRAINT), BEHIND_HEAD).toBe(
        USERS_ROLE_CHECK_DEF,
      );
    });
  },
);
