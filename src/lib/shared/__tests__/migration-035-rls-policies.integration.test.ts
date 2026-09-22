// Security-posture assertions for migration 035 — the owner_account_id()
// helper and every RLS policy it establishes across ~22 protected tables
// (#1384, invariant #8). Three predicate SHAPES cover every table: direct
// `account_id = owner_account_id()` (accounts uses `id` instead, since
// `accounts.id` IS the account id), a `business_id IN (SELECT id FROM
// businesses WHERE account_id = owner_account_id())` JOIN for tables scoped
// by location, and a `handle IN (…)` bridge through `channel_enrollments`
// for the two (now-removed — see RETIRED SCOPE) SMS opt-out tables.
//
// ── this suite now EXECUTES DDL, deliberately (#1384) ───────────────────────
//
// It is listed in `MIGRATION_SHAPE_FILES` (`scripts/ci/live-db-suites-audit.ts`)
// — the sanctioned exemption from R2 for suites where APPLYING the migration IS
// the subject — and it takes the cross-process live-DB lock in `beforeAll`, as
// every entry in that set is enforced to do.
//
// WHY. The predecessor suite proved 035 by pattern-matching its SQL TEXT: one
// regex per table (25 policies' worth), several `it.each` loops reconstructing
// the same USING clause per table family, and a handful of pure text-shape
// checks (`DROP POLICY IF EXISTS` count equals `CREATE POLICY` count, a total
// policy count of 25). #1301's five red-team rounds against this exact suite
// family each defeated a different hand-rolled approximation of a SQL lexer —
// a newline inside `CREATE\nPOLICY`, a block comment inside `DISABLE/**/ROW
// LEVEL SECURITY`, `--` inside a string literal, a comment standing in as
// evidence. The verdict every time was that the APPROACH was wrong, not the
// code. This suite stops parsing the checked-in file and starts running it:
// PostgreSQL is the parser.
//
// ── the wrinkle unique to 035: two of its target tables are GONE ────────────
//
// `sms_sender_opt_outs` and `sms_sender_opt_out_events` — Group 3 of 035's own
// file — were DROPPED WHOLE by migration 061 ("RLS policies
// (sms_sender_opt_*_owner_select, migration 035) drop implicitly", 061's own
// header). Verified 2026-09-22: replaying `035_rls_policies.sql` verbatim
// against this container's head schema throws `relation "sms_sender_opt_outs"
// does not exist` at the `CREATE POLICY` statement (`DROP POLICY IF EXISTS …
// ON sms_sender_opt_outs` is a silent no-op when the TABLE doesn't exist —
// only `CREATE POLICY` errors). There is no longer a live security boundary
// for Group 3 to protect, and there is no way to prove what 035's Group 3 does
// against a database that no longer has anywhere for it to act.
//
// `degrade()` below creates a bare two-column-free stand-in for each dropped
// table (`CREATE TABLE sms_sender_opt_outs (handle text);` — just enough for
// 035's `handle IN (…)` predicate to resolve) SOLELY so the checked-in file
// can be replayed VERBATIM end-to-end without splitting it — `readMigrationSql`'s
// own JSDoc is explicit that trimming or splitting the file defeats the point
// of executing it at all. The stand-ins are dropped again (with their
// SMS policies, which DROP TABLE removes automatically) immediately after the
// reapply and BEFORE any catalogue read an assertion uses, so this suite makes
// no claim whatsoever about what 035's Group 3 predicate says — that claim is
// retired, not replaced, because there is nothing left to make it about.
// `sms_sender_opt_outs and sms_sender_opt_out_events remain absent at head` is
// a standing tripwire: if a future migration ever resurrects either table,
// that case goes red and is this suite's signal to reconsider the retirement.
//
// ── the second wrinkle: businesses/channel_enrollments are layered on ───────
//
// Migration 040 drops and recreates `businesses_owner_update` and
// `channel_enrollments_owner_update` with the IDENTICAL predicate text 035
// first writes (verified by introspection — 040 only changes the column-level
// GRANT/REVOKE around them, not the USING/CHECK clause), so reapplying 035
// alone reproduces them unchanged. `channel_enrollments_owner_insert` is
// different: 040 removes it PERMANENTLY (owners must not self-verify a channel
// enrollment) and nothing recreates it, so replaying 035 alone — which DOES
// create it, faithfully, because that is what 035's checked-in text says —
// necessarily diverges from head on this one policy. `businesses` and the
// other two `channel_enrollments` policies are compared whole-table against
// head; `channel_enrollments` gets its own case that excludes the insert
// policy from the equality check and separately pins its historical predicate
// — see "re-applying 035 recreates channel_enrollments_owner_insert…" below.
// Migration 040's own suite (`migration-040-rls-tightening.integration.test.ts`)
// owns proving that policy is GONE at head and owns every REVOKE/GRANT this
// suite does not touch.
//
// ── the retired text-matching cases, and where each assertion went ─────────
//
// RETIRED, no replacement — the whole predecessor "Group 3: SMS tables" describe
// block (both tables' policy-existence and predicate-shape cases): see the
// wrinkle above. Nothing catalogue-based can replace an assertion about a
// table that no longer exists.
//
// RETIRED → the per-table loops below (`it`-internal `for` loops over
// `DIRECT_TABLES`/`JOIN_TABLES`, matching the predecessor's own `it.each`
// idiom), for: every `VAL-AUTH-0xx` policy-existence/predicate case in Groups
// 1 and 2, the `it.each(businessScopedTables)` predicate loop, the
// `it.each(tablesRequiringDirectPolicies)` / `it.each(tablesRequiringJoinPolicies)`
// "comprehensive table coverage" loops, and the `all business-scoped tables
// are SELECT-only` negative-regex loop. Each retired case matched SOURCE TEXT;
// each replacement queries `pg_policy` directly and compares the catalogue's
// OWN rendering (`pg_get_expr`) against a literal captured by introspection,
// independent of the migration file.
//
// RETIRED → `businesses_owner_select`/`channel_enrollments_owner_select`/
// `businesses_owner_update` catalogue checks below, for: `has SELECT policy
// for authenticated role`, `uses id = owner_account_id() predicate`, `does NOT
// have INSERT/UPDATE/DELETE policies` (accounts), the businesses SELECT/UPDATE
// predicate cases, and the `channel_enrollments` SELECT/INSERT/UPDATE
// existence + predicate cases (VAL-AUTH-002/003).
//
// RETIRED, no replacement (not a security invariant, and now FALSE besides):
// `uses DROP POLICY IF EXISTS before every CREATE POLICY` (a 1:1 count check)
// and `uses CREATE OR REPLACE for the helper function`. These tested the
// AUTHOR'S CHOSEN SYNTAX, not an effect on the database; `DROP POLICY IF
// EXISTS` before `CREATE POLICY` is what makes a migration file re-runnable,
// which is a property of the SQL text a catalogue read cannot observe either
// way. `total policy count matches expected (25)` is RETIRED with a stronger
// reason: 25 was true THEN and is FALSE now — migration 061 removed two of
// them, so a suite still asserting 25 would itself be red on an unmodified,
// fully-migrated head. The per-table completeness this suite now proves
// (`policy_count = 1` per single-policy table, `= 2` for businesses and for
// channel_enrollments) is a stronger, per-table version of the same claim, and
// one that stays TRUE at head rather than describing a moment in migration
// history that has since moved.
//
// RETIRED → `all direct-account_id policies use owner_account_id() … / all
// business_id JOIN policies filter through … / no policy references a bare
// business_id without account_id verification` (VAL-AUTH-022): these regexed
// EVERY policy's text for the substring `owner_account_id()`/`account_id`. The
// per-table literal comparisons below are STRICTLY stronger — a predicate that
// merely CONTAINS the right substring while being semantically wrong (say,
// `account_id = owner_account_id() OR true`) would have passed the retired
// regex and fails every literal comparison here.
//
// ── the two oracles ──────────────────────────────────────────────────────────
//
// ORACLE A (titles 2-4) is the pinned head posture — literals captured
// independently of the migration file by introspecting this container at head
// (2026-09-22). This is what catches a WEAKENED migration: `pnpm test:db:setup`
// provisions the container FROM the migration under test, so oracle B alone is
// circular — a weakened 035 yields a weakened BEFORE reading and
// `AFTER == BEFORE` would pass regardless.
//
// ORACLE B (titles 6-8) degrades the 18 single-policy tables plus `accounts`,
// `businesses` and `channel_enrollments`'s SELECT policies to the pre-035
// posture inside a transaction that ALWAYS rolls back, proves the degrade
// landed so no case can pass vacuously against a no-op migration, applies the
// checked-in file VERBATIM (against the SMS stand-ins — see the wrinkle
// above), and diffs the whole `public` catalogue against the before-read —
// including every OTHER table (migration 119's off-target `GRANT ALL ON
// admin_audit_log TO anon;` red-team round is why).
//
// ── mutation evidence (#1384, recorded per the carried-forward #1301 rule) ──
//
// Mutated `ACCOUNTS_SELECT_DEFINITION` below (changed `id =
// owner_account_id()` to the literal text `id = owner_account_id() OR true` —
// exactly the "contains the right substring but is semantically wrong" shape
// the retired VAL-AUTH-022 substring regex could not have caught) and re-ran
// this suite against the UNMODIFIED container: exactly 1 of 8 cases went red —
// `every direct-account_id and business_id-join SELECT policy…` (oracle A,
// `AssertionError: … expected 'SELECT PERMISSIVE…id = owner_account_id())…' to
// deeply equal 'SELECT PERMISSIVE…id = owner_account_id()) OR true)…'`). Every
// OTHER case, including both oracle-B executing cases that touch `accounts`,
// stayed green — and that is the correct, informative result, not a gap:
// oracle B's "re-applying 035 restores…" case compares the container's OWN
// before/after catalogue readings to EACH OTHER, never to
// `ACCOUNTS_SELECT_DEFINITION`, so it cannot see a mutation to a constant it
// never reads. This is #1301's "oracle B alone is circular" warning made
// concrete: a weakened PINNED LITERAL is exactly the class of defect only
// oracle A can catch, which is why the suite carries both rather than one.
// Reverted immediately after (`diff` against the pre-mutation copy showed
// zero drift).
//
// ── stated limit ────────────────────────────────────────────────────────────
//
// This suite does not seed any row, so the carried-forward `SET CONSTRAINTS
// ALL IMMEDIATE` rule (`users.fk_users_account` is `DEFERRABLE INITIALLY
// DEFERRED`) does not apply here — noted for completeness, not silently
// dropped.
//
// The DB-free registry case is the only one that cannot silently skip; the
// other seven sit behind `describeWithDb` and need a database.

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
  nonEmptyNames,
  readMigrationSql,
  readPublicCatalogue,
  withRolledBackTransaction,
} from '@/lib/shared/__tests__/helpers/migration-guard';
import { auditLiveDbFile } from '../../../../scripts/ci/live-db-suites-audit';

const MIGRATION_FILE = '035_rls_policies.sql';
const SUITE_FILE = 'src/lib/shared/__tests__/migration-035-rls-policies.integration.test.ts';
const BEHIND_HEAD = 'RLS policy posture is not at migration head — run pnpm test:db:setup';

/** `pg_get_expr`'s rendering of `account_id = owner_account_id()` — the shape
 * every direct-account_id table but `accounts` itself uses. */
const ACCOUNT_ID_SELECT_DEFINITION =
  'SELECT PERMISSIVE roles=authenticated using=(account_id = owner_account_id()) check=(none)';

/** `accounts.id` IS the account id, so its predicate compares `id` instead. */
const ACCOUNTS_SELECT_DEFINITION =
  'SELECT PERMISSIVE roles=authenticated using=(id = owner_account_id()) check=(none)';

/** `pg_get_expr`'s rendering of the `business_id IN (…)` join predicate —
 * reformatted by PostgreSQL (subquery on its own lines, `businesses.id`/
 * `businesses.account_id` qualified) relative to how 035's file spells it. */
const JOIN_SELECT_DEFINITION =
  'SELECT PERMISSIVE roles=authenticated using=(business_id IN ( SELECT businesses.id\n' +
  '   FROM businesses\n' +
  '  WHERE (businesses.account_id = owner_account_id()))) check=(none)';

const BUSINESSES_UPDATE_DEFINITION =
  'UPDATE PERMISSIVE roles=authenticated using=(account_id = owner_account_id()) ' +
  'check=(account_id = owner_account_id())';
const CHANNEL_ENROLLMENTS_UPDATE_DEFINITION = BUSINESSES_UPDATE_DEFINITION;

/** The Group 3 predicate 035 creates and 040 never touches — recreated only
 * inside `degrade()` (see the header's wrinkle) so its removal-by-040 stays
 * falsifiable, and pinned here so `it('re-applies … recreates …')` proves 035
 * ALONE still writes this exact text rather than merely "some policy". */
const CHANNEL_ENROLLMENTS_INSERT_DEFINITION =
  'INSERT PERMISSIVE roles=authenticated using=(none) check=(account_id = owner_account_id())';

/** `pg_proc` rendering of `owner_account_id()`'s body — the literal text
 * between the migration's `AS $$ … $$`, unindented by nothing (PostgreSQL
 * stores it verbatim, leading/trailing newline included). */
const OWNER_ACCOUNT_ID_BODY = '\n  SELECT account_id FROM users WHERE auth_id = auth.uid()::text\n';

/** Group 1 tables (direct `account_id`) that 040/041 never touch — `accounts`
 * is handled separately below because its predicate compares `id`, not
 * `account_id`. */
const DIRECT_TABLES = [
  'api_costs',
  'notification_deliveries',
  'approval_audit_log',
  'account_audit_log',
] as const;

/** Group 2 tables (the `business_id IN (…)` join predicate) — none of these
 * 13 is touched by any migration after 035. */
const JOIN_TABLES = [
  'reviews',
  'responses',
  'approval_links',
  'weekly_summaries',
  'review_exceptions',
  'ranking_snapshots',
  'monthly_impact_emails',
  'onboarding_drip_log',
  'satisfaction_responses',
  'api_costs_daily_rollups',
  'zernio_connections',
  'zernio_finalize_incidents',
  'zernio_backfill_runs',
] as const;

/** Every table this suite proves 035 against, for `assertOnlyTablesMoved`. */
const REAL_TABLES = [...DIRECT_TABLES, ...JOIN_TABLES, 'accounts', 'businesses', 'channel_enrollments'];

/** Dropped whole by migration 061 — see the header's wrinkle section. */
const SMS_STANDIN_TABLES = ['sms_sender_opt_outs', 'sms_sender_opt_out_events'] as const;

const testDatabaseUrl = resolveTestDatabaseUrl();

let db: postgresType.Sql | undefined;
let featureDatabaseLock: LiveDbLock | undefined;

function sql(): postgresType.Sql {
  if (!db) throw new Error('migration 035 integration database was not initialized');
  return db;
}

/**
 * The pre-035 posture for every table this suite proves, undone — EXCLUDING
 * `businesses_owner_update`/`channel_enrollments_owner_update` (040 recreates
 * them with identical text, so degrading them here would attribute a 040-era
 * restoration to 035) and `channel_enrollments_owner_insert` (absent at head;
 * 035's own DROP POLICY IF EXISTS + CREATE POLICY handles its (re)creation
 * idempotently without any help from this function).
 *
 * Creates the two SMS stand-in tables described in the header's wrinkle
 * section — bare enough for 035's `handle IN (…)` predicate to resolve,
 * nothing else. `applyMigration035` (below) is what cleans them up again.
 */
async function degrade(tx: postgresType.TransactionSql): Promise<void> {
  await tx.unsafe(`CREATE TABLE ${SMS_STANDIN_TABLES[0]} (handle text);`);
  await tx.unsafe(`CREATE TABLE ${SMS_STANDIN_TABLES[1]} (handle text);`);
  for (const table of [...DIRECT_TABLES, ...JOIN_TABLES]) {
    await tx.unsafe(`DROP POLICY IF EXISTS ${table}_owner_select ON ${table};`);
  }
  await tx.unsafe('DROP POLICY IF EXISTS accounts_owner_select ON accounts;');
  await tx.unsafe('DROP POLICY IF EXISTS businesses_owner_select ON businesses;');
  await tx.unsafe('DROP POLICY IF EXISTS channel_enrollments_owner_select ON channel_enrollments;');
}

/**
 * Applies 035 VERBATIM and immediately removes the SMS stand-ins again
 * (`DROP TABLE` removes their policies with them — no `CASCADE` needed,
 * confirmed 2026-09-22), so every catalogue read that follows sees a `public`
 * schema with NEITHER SMS table in it, exactly like `before`. That is what
 * lets `assertOnlyTablesMoved` below name only `REAL_TABLES` — the stand-ins
 * never survive to be compared.
 */
async function applyMigration035(tx: postgresType.TransactionSql): Promise<void> {
  await tx.unsafe(readMigrationSql(MIGRATION_FILE));
  await tx.unsafe(`DROP TABLE ${SMS_STANDIN_TABLES[0]}, ${SMS_STANDIN_TABLES[1]};`);
}

// ── registry: no database needed, so this one can never silently skip ───────

describe('migration 035 registries', () => {
  it('migration 035 suite is registered in MIGRATION_SHAPE_FILES', () => {
    // `MIGRATION_SHAPE_FILES` is a module-private `const` inside
    // `scripts/ci/live-db-suites-audit.ts` — not exported — so this case reads
    // its EFFECT through the audit's own exported entry point rather than a
    // hardcoded copy of the set. That is STRONGER than a membership read: this
    // file's real checked-in text executes DDL (`degrade`/`applyMigration035`,
    // above) and names the cross-process lock marker, so running the real
    // audit over that real text yields zero findings ONLY because this exact
    // path is an allowlist member AND the lock call is present. Drop the
    // entry, typo it, or rename `acquireLiveDbLock` away and this case reports
    // a `runtime-ddl` or `unlocked-ddl` finding — a membership read would
    // catch the first two and miss the third.
    const ownSourceText = readFileSync(join(process.cwd(), SUITE_FILE), 'utf8');
    expect(auditLiveDbFile(SUITE_FILE, ownSourceText)).toEqual([]);
  });
});

describeWithDb(
  'migration 035 owner_account_id() + RLS policies',
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

    it('sms_sender_opt_outs and sms_sender_opt_out_events remain absent at head', async () => {
      // The standing tripwire the header's wrinkle section promises: if either
      // table is ever resurrected, this goes red and is the signal that 035's
      // Group 3 retirement needs reconsidering — not a stale assumption.
      const present = await sql()<{ table_name: string }[]>`
        SELECT table_name FROM information_schema.tables
         WHERE table_schema = 'public' AND table_name = ANY(${[...SMS_STANDIN_TABLES]})
      `;
      expect(present).toEqual([]);
    });

    it('creates owner_account_id() as STABLE, returning uuid, resolving through users.account_id, at head', async () => {
      const [fn] = await sql()<{ volatility: string; return_type: string; body: string }[]>`
        SELECT provolatile AS volatility, prorettype::regtype::text AS return_type, prosrc AS body
          FROM pg_proc WHERE proname = 'owner_account_id'
      `;
      expect(fn?.volatility, BEHIND_HEAD).toBe('s'); // STABLE
      expect(fn?.return_type, BEHIND_HEAD).toBe('uuid');
      expect(fn?.body, BEHIND_HEAD).toBe(OWNER_ACCOUNT_ID_BODY);
    });

    it('every direct-account_id and business_id-join SELECT policy carries the owner_account_id() predicate, exactly once per table, at head', async () => {
      const rows = await sql()<{ table_name: string; name: string; definition: string }[]>`
        SELECT rel.relname AS table_name, pol.polname AS name,
               (CASE pol.polcmd WHEN 'r' THEN 'SELECT' WHEN 'a' THEN 'INSERT' WHEN 'w' THEN 'UPDATE'
                     WHEN 'd' THEN 'DELETE' ELSE 'ALL' END)
               || ' ' || (CASE WHEN pol.polpermissive THEN 'PERMISSIVE' ELSE 'RESTRICTIVE' END)
               || ' roles=' || coalesce((
                    SELECT string_agg(role_name, ',' ORDER BY role_name)
                      FROM (
                        SELECT (CASE WHEN role_oid = 0 THEN 'PUBLIC' ELSE role_oid::regrole::text END)
                                 AS role_name
                          FROM unnest(pol.polroles) AS role_oid
                      ) roles
                  ), '(none)')
               || ' using=' || coalesce(pg_get_expr(pol.polqual, pol.polrelid), '(none)')
               || ' check=' || coalesce(pg_get_expr(pol.polwithcheck, pol.polrelid), '(none)')
                 AS definition
          FROM pg_policy pol
          JOIN pg_class rel ON rel.oid = pol.polrelid
         WHERE rel.relname = ANY(${[...DIRECT_TABLES, ...JOIN_TABLES, 'accounts']})
      `;
      const byTable = new Map<string, { name: string; definition: string }[]>();
      for (const row of rows) {
        const list = byTable.get(row.table_name) ?? [];
        list.push({ name: row.name, definition: row.definition });
        byTable.set(row.table_name, list);
      }

      for (const table of DIRECT_TABLES) {
        const policies = byTable.get(table) ?? [];
        expect(policies, `${BEHIND_HEAD} (${table})`).toEqual([
          { name: `${table}_owner_select`, definition: ACCOUNT_ID_SELECT_DEFINITION },
        ]);
      }
      for (const table of JOIN_TABLES) {
        const policies = byTable.get(table) ?? [];
        expect(policies, `${BEHIND_HEAD} (${table})`).toEqual([
          { name: `${table}_owner_select`, definition: JOIN_SELECT_DEFINITION },
        ]);
      }
      expect(byTable.get('accounts'), `${BEHIND_HEAD} (accounts)`).toEqual([
        { name: 'accounts_owner_select', definition: ACCOUNTS_SELECT_DEFINITION },
      ]);
    });

    it('businesses and channel_enrollments carry their select+update policies with the owner_account_id() predicate, and channel_enrollments carries no insert policy, at head', async () => {
      const rows = await sql()<{ table_name: string; name: string; definition: string }[]>`
        SELECT rel.relname AS table_name, pol.polname AS name,
               (CASE pol.polcmd WHEN 'r' THEN 'SELECT' WHEN 'a' THEN 'INSERT' WHEN 'w' THEN 'UPDATE'
                     WHEN 'd' THEN 'DELETE' ELSE 'ALL' END)
               || ' ' || (CASE WHEN pol.polpermissive THEN 'PERMISSIVE' ELSE 'RESTRICTIVE' END)
               || ' roles=' || coalesce((
                    SELECT string_agg(role_name, ',' ORDER BY role_name)
                      FROM (
                        SELECT (CASE WHEN role_oid = 0 THEN 'PUBLIC' ELSE role_oid::regrole::text END)
                                 AS role_name
                          FROM unnest(pol.polroles) AS role_oid
                      ) roles
                  ), '(none)')
               || ' using=' || coalesce(pg_get_expr(pol.polqual, pol.polrelid), '(none)')
               || ' check=' || coalesce(pg_get_expr(pol.polwithcheck, pol.polrelid), '(none)')
                 AS definition
          FROM pg_policy pol
          JOIN pg_class rel ON rel.oid = pol.polrelid
         WHERE rel.relname IN ('businesses', 'channel_enrollments')
         ORDER BY rel.relname, pol.polname
      `;
      const byKey = new Map(rows.map((row) => [`${row.table_name}.${row.name}`, row.definition]));

      expect(byKey.get('businesses.businesses_owner_select'), BEHIND_HEAD).toBe(
        ACCOUNT_ID_SELECT_DEFINITION,
      );
      expect(byKey.get('businesses.businesses_owner_update'), BEHIND_HEAD).toBe(
        BUSINESSES_UPDATE_DEFINITION,
      );
      expect(byKey.get('channel_enrollments.channel_enrollments_owner_select'), BEHIND_HEAD).toBe(
        ACCOUNT_ID_SELECT_DEFINITION,
      );
      expect(byKey.get('channel_enrollments.channel_enrollments_owner_update'), BEHIND_HEAD).toBe(
        CHANNEL_ENROLLMENTS_UPDATE_DEFINITION,
      );

      // No insert policy at head — 040 removed it permanently. Full ownership
      // of THIS fact belongs to migration 040's own suite; this is the
      // adjoining half of the same fact from 035's side.
      const enrollmentNames = rows
        .filter((row) => row.table_name === 'channel_enrollments')
        .map((row) => row.name)
        .sort();
      expect(enrollmentNames, BEHIND_HEAD).toEqual([
        'channel_enrollments_owner_select',
        'channel_enrollments_owner_update',
      ]);
    });

    // ── ORACLE B: degrade, prove it landed, apply verbatim, diff ────────────

    it('re-applying 035 restores every direct-account_id and business_id-join policy after they are dropped', async () => {
      // `withRolledBackTransaction` ALWAYS rolls back, which is what makes the
      // degrade/apply cycle — including the SMS stand-in create/drop — safe on
      // the SHARED container: later migrations layer on `public`, so a
      // persistent degrade would corrupt it for every other suite.
      await withRolledBackTransaction(sql(), async (tx) => {
        const before = await readPublicCatalogue(tx);
        await degrade(tx);
        const degraded = await readPublicCatalogue(tx);

        for (const table of [...DIRECT_TABLES, ...JOIN_TABLES, 'accounts']) {
          assertDegradeLanded(before, degraded, {
            table,
            property: 'policies',
            absent: nonEmptyNames([`${table}_owner_select`]),
          });
        }

        await applyMigration035(tx);
        const after = await readPublicCatalogue(tx);

        for (const table of [...DIRECT_TABLES, ...JOIN_TABLES, 'accounts']) {
          expect(after.tables[table], `${table} after reapply`).toEqual(before.tables[table]);
        }
      });
    });

    it('re-applying 035 recreates channel_enrollments_owner_insert with its original predicate, and leaves businesses/channel_enrollments select+update unchanged', async () => {
      await withRolledBackTransaction(sql(), async (tx) => {
        const before = await readPublicCatalogue(tx);
        await degrade(tx);
        const degraded = await readPublicCatalogue(tx);

        assertDegradeLanded(before, degraded, {
          table: 'businesses',
          property: 'policies',
          absent: nonEmptyNames(['businesses_owner_select']),
        });
        assertDegradeLanded(before, degraded, {
          table: 'channel_enrollments',
          property: 'policies',
          absent: nonEmptyNames(['channel_enrollments_owner_select']),
        });

        await applyMigration035(tx);
        const after = await readPublicCatalogue(tx);

        // businesses is untouched end to end: its update predicate is
        // 040-identical, and its select policy is 035's own to prove.
        expect(after.tables.businesses).toEqual(before.tables.businesses);

        // channel_enrollments diverges from head in exactly one way: 035
        // faithfully recreates the INSERT policy 040 later removes for good.
        // Comparing the table WITHOUT that one policy proves everything else
        // (select, update, columns, indexes, grants, comment, row digest) is
        // untouched; the two assertions after it are the positive proof that
        // the insert policy really is new (not merely unexamined) and carries
        // 035's exact historical text.
        const beforeEnrollments = before.tables.channel_enrollments;
        const afterEnrollments = after.tables.channel_enrollments;
        if (!beforeEnrollments || !afterEnrollments) {
          throw new Error('readPublicCatalogue did not return channel_enrollments');
        }
        const afterWithoutInsert = {
          ...afterEnrollments,
          policies: afterEnrollments.policies.filter(
            (entry) => entry.name !== 'channel_enrollments_owner_insert',
          ),
        };
        expect(afterWithoutInsert).toEqual(beforeEnrollments);

        expect(beforeEnrollments.policies.map((entry) => entry.name)).not.toContain(
          'channel_enrollments_owner_insert',
        );
        expect(
          afterEnrollments.policies.find((entry) => entry.name === 'channel_enrollments_owner_insert')
            ?.definition,
        ).toBe(CHANNEL_ENROLLMENTS_INSERT_DEFINITION);
      });
    });

    it('re-applying 035 moves no other table in public', async () => {
      await withRolledBackTransaction(sql(), async (tx) => {
        const before = await readPublicCatalogue(tx);
        await degrade(tx);
        const degraded = await readPublicCatalogue(tx);

        assertDegradeLanded(before, degraded, {
          table: 'accounts',
          property: 'policies',
          absent: nonEmptyNames(['accounts_owner_select']),
        });

        await applyMigration035(tx);
        const after = await readPublicCatalogue(tx);

        // A migration may harden the tables it names while doing arbitrary
        // damage elsewhere (migration 119's off-target `GRANT ALL ON
        // admin_audit_log TO anon;` red-team round). Every table outside
        // `REAL_TABLES` must come out byte-identical — and because
        // `applyMigration035` drops the SMS stand-ins before this reading, the
        // two SMS tables need no entry here: they simply are not present in
        // either catalogue.
        assertOnlyTablesMoved(before, after, REAL_TABLES);
      });
    });
  },
);
