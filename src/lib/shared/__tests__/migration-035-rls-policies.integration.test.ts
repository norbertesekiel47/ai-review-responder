// Security-posture assertions for migration 035 — owner_account_id() and
// every RLS policy it establishes across ~22 tables (#1384, invariant #8).
// Converts from regex-over-SQL-text to executing the migration and asserting
// via `readPublicCatalogue`, per #1301/#1384 (`migration-guard.ts`'s own
// header owns the red-team history behind that decision). Listed in
// `MIGRATION_SHAPE_FILES` (`scripts/ci/live-db-suites-audit.ts`) and holds
// the cross-process live-DB lock in `beforeAll`, as every entry there must.
//
// ── SMS stand-in workaround ──────────────────────────────────────────────
//
// `sms_sender_opt_outs`/`sms_sender_opt_out_events` (035's Group 3) were
// dropped whole by migration 061 ("RLS policies drop implicitly", 061's own
// header) — verified 2026-09-22: replaying 035 verbatim against head now
// throws `relation "sms_sender_opt_outs" does not exist`. `degrade()` creates
// bare `(handle text)` stand-ins so the checked-in file can still be applied
// VERBATIM (`readMigrationSql`'s JSDoc forbids splitting it), then drops them
// again before any assertion reads the catalogue. Group 3 is RETIRED, not
// faked — see below. A standing tripwire (`sms_sender_opt_outs and
// sms_sender_opt_out_events remain absent at head`) re-flags this if either
// table is ever resurrected.
//
// `businesses`/`channel_enrollments` are also layered on by migration 040:
// its UPDATE-policy recreate uses IDENTICAL predicate text to 035's
// (verified), so reapplying 035 alone reproduces it unchanged; but 040
// permanently drops the INSERT policy 035 creates, so that one policy is
// excluded from the whole-table equality check and pinned separately —
// migration 040's own suite owns proving INSERT is gone at head.
//
// ── retired assertions (ci:weakened-checks) ──────────────────────────────
//
// RETIRED, no replacement: the whole "Group 3: SMS tables" describe block —
// no catalogue-based case can replace an assertion about a table that no
// longer exists (see the SMS workaround above).
// RETIRED → the per-table loops below: every `VAL-AUTH-0xx` Group 1/2 case,
// the `it.each` predicate/coverage loops, and the SELECT-only negative-regex
// loop — each matched SOURCE TEXT; each replacement queries `pg_policy` and
// compares the catalogue's own rendering against an introspected literal.
// RETIRED → the `businesses`/`channel_enrollments`/`accounts` catalogue
// checks below: the existence+predicate cases (VAL-AUTH-002/003).
// RETIRED, no replacement (author's syntax, not a DB effect): `DROP POLICY IF
// EXISTS` count-matches-`CREATE POLICY`, and `CREATE OR REPLACE` usage.
// RETIRED, no replacement (now FALSE, not just weak): `total policy count =
// 25` — migration 061 removed two; the per-table exact counts below are the
// stronger, still-true version of the same claim.
// RETIRED → the per-table literal comparisons (VAL-AUTH-022's substring
// regexes): a predicate that merely CONTAINS the right substring while being
// wrong (`… OR true`) passed the old regex and fails every literal here —
// proven by the mutation below.
//
// ── the two oracles ───────────────────────────────────────────────────────
//
// ORACLE A (titles 2-4): pinned head-posture literals, captured independently
// of the migration file by introspecting this container at head (2026-09-22).
// Catches a WEAKENED migration oracle B alone cannot: `pnpm test:db:setup`
// provisions the container FROM the migration under test, so a weakened 035
// yields a weakened BEFORE and `AFTER == BEFORE` would pass regardless.
//
// ORACLE B (titles 6-8): degrades the single-policy tables plus `accounts`/
// `businesses`/`channel_enrollments`'s SELECT policies inside a transaction
// that ALWAYS rolls back, proves the degrade landed, applies the file
// VERBATIM (against the SMS stand-ins), and diffs the whole `public`
// catalogue against the before-read, including every OTHER table (migration
// 119's off-target `GRANT ALL` red-team round is why).
//
// ── mutation evidence (#1384) ─────────────────────────────────────────────
//
// Mutated `ACCOUNTS_SELECT_DEFINITION` (`id = owner_account_id() OR true`)
// and re-ran against the unmodified container: exactly 1 of 8 cases went
// red — the oracle A predicate case. Every oracle-B case, including the ones
// that touch `accounts`, stayed green: oracle B compares the container's own
// before/after readings to each other, never to the pinned constant, so it
// cannot see a weakened literal — concrete proof of #1301's "oracle B alone
// is circular" warning. Reverted; diff showed zero drift.
//
// No row is seeded, so the carried-forward `SET CONSTRAINTS ALL IMMEDIATE`
// rule does not apply. The registry case is DB-free and cannot silently
// skip; the other seven sit behind `describeWithDb`.

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
