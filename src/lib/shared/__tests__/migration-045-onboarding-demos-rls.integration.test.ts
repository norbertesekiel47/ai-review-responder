// Security-posture assertions for migration 045 — RLS on `onboarding_demos`
// (#1384, invariant #8). `onboarding_demos` is a tenant-scoped table introduced
// in migration 032; rows are created and mutated by owner-authenticated route
// handlers and service-role workers, but a bare `authenticated`-role read
// through Supabase's anon PostgREST surface had no row filter at all until 045.
// 045 is two statements: `ALTER TABLE onboarding_demos ENABLE ROW LEVEL
// SECURITY;` and one SELECT-only owner policy scoped through BOTH the demo's
// own `user_id` and its `business_id`'s owning account.
//
// ── this suite now EXECUTES DDL, deliberately (#1384) ───────────────────────
//
// It is listed in `MIGRATION_SHAPE_FILES` (`scripts/ci/live-db-suites-audit.ts`)
// — the sanctioned exemption from R2 for suites where APPLYING the migration IS
// the subject — and it takes the cross-process live-DB lock in `beforeAll`, as
// every entry in that set is enforced to do.
//
// WHY. The predecessor suite proved 045 by pattern-matching its SQL TEXT: one
// `toMatch` against a five-line regex reconstructing the whole USING clause
// verbatim, whitespace and all. #1301's five red-team rounds against this exact
// family of suite (035/040/045's own siblings 048/049/051/117/118) each
// defeated a different hand-rolled approximation of a SQL lexer — a newline
// inside `CREATE\nPOLICY`, a block comment inside `DISABLE/**/ROW LEVEL
// SECURITY`, `--` inside a string literal, a comment standing in as evidence —
// and each fix closed one lexical class while the next pass found another
// instance of it. The verdict each time was that the APPROACH was wrong, not
// the code: a regex that reconstructs a predicate character-for-character is
// exactly as fragile as the text it matches. This suite stops parsing the
// checked-in file and starts running it: PostgreSQL is the parser.
//
// ── the retired text-matching cases, and where each assertion went ─────────
//
// RETIRED: `enables RLS on onboarding_demos` (`/ALTER TABLE onboarding_demos\s+
// ENABLE ROW LEVEL SECURITY/i`) → the pinned head-posture case below
// (`rowsecurity=true force=false`), plus the executing case, which disables RLS
// and proves the file turns it back on.
//
// RETIRED: `adds a SELECT-only owner policy…` (the five-line USING-clause
// regex, plus three `not.toMatch` calls for `_owner_insert`/`_update`/
// `_delete`) → the pinned catalogue-rendered policy literal below (captured by
// introspection, independent of the migration file: `pg_get_expr` reformats
// the predicate — parenthesises every operand, rewrites the two subqueries as
// `( SELECT … FROM … WHERE … )`, casts `auth_id`/`auth.uid()` to `text`
// explicitly — so a regex reconstructing the SOURCE text could never have
// matched what PostgreSQL actually stores; it worked only because it matched
// the file, not the effect), plus the policy-count-of-one assertion in the
// same case, which subsumes "no insert/update/delete policy" more strongly
// than three negative regexes could: it catches a policy under ANY name, not
// only the three spellings the retired regexes anticipated.
//
// Nothing else was removed — there was nothing else to remove; the retired
// suite was two `it` blocks.
//
// ── the two oracles ──────────────────────────────────────────────────────────
//
// ORACLE A (title 2) is the pinned head posture — literals captured
// independently of the migration file by introspecting this container at head
// (2026-09-22: `psql` against `pg_policies`/`pg_get_expr`, recorded below as
// `OWNER_SELECT_DEFINITION`). This is what catches a WEAKENED migration:
// `pnpm test:db:setup` provisions the container FROM the migration under test,
// so oracle B alone is circular — a weakened 045 yields a weakened BEFORE
// reading and `AFTER == BEFORE` would pass regardless.
//
// ORACLE B (titles 3-4) degrades `onboarding_demos` to the pre-045 posture
// inside a transaction that ALWAYS rolls back, proves the degrade landed so
// the case cannot pass vacuously against a no-op migration, applies the
// checked-in file VERBATIM, and diffs the whole `public` catalogue against the
// before-read — including every OTHER table, because a migration may harden
// the one table it names while doing arbitrary damage elsewhere (migration
// 119's `GRANT ALL ON admin_audit_log TO anon;` red-team round).
//
// ── mutation evidence (#1384, recorded per the carried-forward #1301 rule) ──
//
// Mutated `OWNER_SELECT_DEFINITION` below (replaced the `user_id` half of the
// predicate with the literal text `MUTATED_WRONG_PREDICATE`) and re-ran this
// suite against the UNMODIFIED container: 2 of 4 cases went red —
// `onboarding_demos carries row security enabled with exactly the one owner
// policy at head` (oracle A, `AssertionError: … expected 'SELECT
// PERMISSIVE…MUTATED_WRONG_PREDICATE…' to be 'SELECT PERMISSIVE…' `) and
// `re-applying 045 restores row security and the owner policy after they are
// dropped` (oracle B, same mismatch on the post-reapply catalogue read). The
// registry case and `re-applying 045 moves no other table in public` stayed
// green, exactly as expected — neither reads the predicate text. Reverted
// immediately after (`diff` against the pre-mutation copy showed zero drift).
// This is the proof the pinned literal is load-bearing and not a restatement
// of whatever the container happens to hold.
//
// ── stated limit ────────────────────────────────────────────────────────────
//
// This suite does not seed any row, so the carried-forward `SET CONSTRAINTS
// ALL IMMEDIATE` rule (`users.fk_users_account` is `DEFERRABLE INITIALLY
// DEFERRED`, and a pending trigger event in a never-committing transaction
// blocks a later `ALTER TABLE … ADD CONSTRAINT`) does not apply here — noted
// for completeness, not silently dropped.
//
// The DB-free registry case is the only one that cannot silently skip; the
// other three sit behind `describeWithDb` and need a database.

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
} from '@/lib/shared/__tests__/helpers/migration-guard';
import { auditLiveDbFile } from '../../../../scripts/ci/live-db-suites-audit';

const TABLE = 'onboarding_demos';
const POLICY = 'onboarding_demos_owner_select';
const MIGRATION_FILE = '045_onboarding_demos_rls.sql';
const SUITE_FILE =
  'src/lib/shared/__tests__/migration-045-onboarding-demos-rls.integration.test.ts';
const BEHIND_HEAD = 'onboarding_demos RLS posture is not at migration head — run pnpm test:db:setup';

/**
 * As the catalogue RENDERS it (`pg_get_expr`), not as 045's file SPELLS it.
 * Captured by introspection against this container at head (2026-09-22),
 * deliberately independent of the migration file — that independence is what
 * makes this an oracle rather than a restatement. See the mutation-evidence
 * note above for proof it is load-bearing.
 */
const OWNER_SELECT_DEFINITION =
  'SELECT PERMISSIVE roles=authenticated using=((user_id = ( SELECT users.id\n' +
  '   FROM users\n' +
  "  WHERE ((users.auth_id)::text = (auth.uid())::text))) AND (business_id IN ( SELECT businesses.id\n" +
  '   FROM businesses\n' +
  '  WHERE (businesses.account_id = owner_account_id())))) check=(none)';

const testDatabaseUrl = resolveTestDatabaseUrl();

let db: postgresType.Sql | undefined;
let featureDatabaseLock: LiveDbLock | undefined;

function sql(): postgresType.Sql {
  if (!db) throw new Error('migration 045 integration database was not initialized');
  return db;
}

/** The one property 045 establishes, undone. */
async function degrade(tx: postgresType.TransactionSql): Promise<void> {
  await tx.unsafe(`DROP POLICY IF EXISTS ${POLICY} ON ${TABLE};`);
  await tx.unsafe(`ALTER TABLE ${TABLE} DISABLE ROW LEVEL SECURITY;`);
}

// ── registry: no database needed, so this one can never silently skip ───────

describe('migration 045 registries', () => {
  it('migration 045 suite is registered in MIGRATION_SHAPE_FILES', () => {
    // `MIGRATION_SHAPE_FILES` is a module-private `const` inside
    // `scripts/ci/live-db-suites-audit.ts` — not exported — so this case reads
    // its EFFECT through the audit's own exported entry point rather than a
    // hardcoded copy of the set. That is STRONGER than a membership read: this
    // file's real checked-in text executes DDL (`degrade`, below) and names
    // the cross-process lock marker, so running the real audit over that real
    // text yields zero findings ONLY because this exact path is an allowlist
    // member AND the lock call is present. Drop the entry, typo it, or rename
    // `acquireLiveDbLock` away and this case reports a `runtime-ddl` or
    // `unlocked-ddl` finding — a membership read would catch the first two and
    // miss the third.
    const ownSourceText = readFileSync(join(process.cwd(), SUITE_FILE), 'utf8');
    expect(auditLiveDbFile(SUITE_FILE, ownSourceText)).toEqual([]);
  });
});

describeWithDb(
  'migration 045 onboarding_demos RLS',
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

    it('onboarding_demos carries row security enabled with exactly the one owner policy at head', async () => {
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
        WHERE cls.oid = ${`public.${TABLE}`}::regclass
      `;

      // Literals from introspecting this container at head (2026-09-22):
      // onboarding_demos: rowsecurity=true force=false policies=1. Independent
      // of the migration file — this is what catches a weakened 045 on a
      // freshly provisioned container, where oracle B alone would be circular.
      expect(security?.rls_enabled, BEHIND_HEAD).toBe(true);
      expect(security?.rls_forced, BEHIND_HEAD).toBe(false);
      // Exactly one — not "at least one" — because this IS the completeness
      // proof the three retired `not.toMatch(/_owner_insert|_update|_delete/)`
      // regexes were reaching for, and it catches a policy under ANY name, not
      // only the three spellings those regexes anticipated.
      expect(security?.policy_count, BEHIND_HEAD).toBe('1');

      const [policy] = await sql()<{ definition: string }[]>`
        SELECT
          (CASE polcmd WHEN 'r' THEN 'SELECT' WHEN 'a' THEN 'INSERT' WHEN 'w' THEN 'UPDATE'
                WHEN 'd' THEN 'DELETE' ELSE 'ALL' END)
          || ' ' || (CASE WHEN polpermissive THEN 'PERMISSIVE' ELSE 'RESTRICTIVE' END)
          || ' roles=' || coalesce((
               SELECT string_agg(role_name, ',' ORDER BY role_name)
                 FROM (
                   SELECT (CASE WHEN role_oid = 0 THEN 'PUBLIC' ELSE role_oid::regrole::text END)
                            AS role_name
                     FROM unnest(polroles) AS role_oid
                 ) roles
             ), '(none)')
          || ' using=' || coalesce(pg_get_expr(polqual, polrelid), '(none)')
          || ' check=' || coalesce(pg_get_expr(polwithcheck, polrelid), '(none)')
            AS definition
        FROM pg_policy
        WHERE polname = ${POLICY} AND polrelid = ${`public.${TABLE}`}::regclass
      `;
      expect(policy?.definition, BEHIND_HEAD).toBe(OWNER_SELECT_DEFINITION);
    });

    // ── ORACLE B: degrade, prove it landed, apply verbatim, diff ────────────

    it('re-applying 045 restores row security and the owner policy after they are dropped', async () => {
      // `withRolledBackTransaction` ALWAYS rolls back, which is what makes the
      // degrade/apply cycle safe on the SHARED container: later migrations
      // layer on `public`, so a persistent degrade would corrupt it for every
      // other suite.
      await withRolledBackTransaction(sql(), async (tx) => {
        const before = await readPublicCatalogue(tx);
        await degrade(tx);
        const degraded = await readPublicCatalogue(tx);

        // Both halves of the degrade, each proven to have landed so neither
        // arm can pass vacuously against a no-op migration.
        assertDegradeLanded(before, degraded, {
          table: TABLE,
          property: 'policies',
          absent: [POLICY],
        });
        // `rowSecurity` is a BOOLEAN property: no name list applies, so it has
        // its own selector-free variant in `DegradeTarget` — the value
        // comparison inside `assertDegradeLanded` IS the proof.
        assertDegradeLanded(before, degraded, { table: TABLE, property: 'rowSecurity' });

        await tx.unsafe(readMigrationSql(MIGRATION_FILE));
        const after = await readPublicCatalogue(tx);

        // The re-apply must restore both the flag and the exact policy text at
        // once. Comparing the whole `CataloguedTable` rather than the two
        // properties separately also catches a re-apply that restored them
        // while changing something else about the table (a stray FORCE, a
        // widened grant).
        expect(after.tables[TABLE]).toEqual(before.tables[TABLE]);
        expect(
          after.tables[TABLE]?.policies.find((entry) => entry.name === POLICY)?.definition,
        ).toBe(OWNER_SELECT_DEFINITION);
      });
    });

    it('re-applying 045 moves no other table in public', async () => {
      await withRolledBackTransaction(sql(), async (tx) => {
        const before = await readPublicCatalogue(tx);
        await degrade(tx);
        const degraded = await readPublicCatalogue(tx);

        assertDegradeLanded(before, degraded, {
          table: TABLE,
          property: 'policies',
          absent: [POLICY],
        });
        assertDegradeLanded(before, degraded, { table: TABLE, property: 'rowSecurity' });

        await tx.unsafe(readMigrationSql(MIGRATION_FILE));
        const after = await readPublicCatalogue(tx);

        // A migration may harden the one table it names while doing arbitrary
        // damage elsewhere (migration 119's off-target `GRANT ALL ON
        // admin_audit_log TO anon;` red-team round). Every table outside
        // `[onboarding_demos]` must come out byte-identical.
        assertOnlyTablesMoved(before, after, [TABLE]);
      });
    });
  },
);
