// Security-posture assertions for migration 049 — deny-all RLS on
// `analytics_events` (#1171 fallout, plan section for #1301). Migration 046
// created `analytics_events` without RLS — the only table-creating migration
// in the repo that skipped it — so `account_id`, `user_id`, `business_id`,
// `distinct_id` and event properties were reachable through Supabase's anon
// PostgREST API. 049 is one statement: `ALTER TABLE analytics_events ENABLE
// ROW LEVEL SECURITY;`. Deny-all is the design: server code reaches the table
// only through the RLS-bypassing Postgres.js `postgres` role.
//
// ── this suite EXECUTES DDL, deliberately ───────────────────────────────────
//
// It is listed in `MIGRATION_SHAPE_FILES` (`scripts/ci/live-db-suites-audit.ts`)
// — the sanctioned exemption from R2 for suites where APPLYING the migration
// IS the subject. The predecessor suite proved the migration by pattern-
// matching its SQL TEXT and lost five red-team passes on #1171: a newline
// inside `CREATE\nPOLICY`, a block comment inside `DISABLE/**/ROW LEVEL
// SECURITY`, `--` inside a string literal, and a comment standing in as
// evidence, among others. Every fix closed one lexical class and the next
// pass found another instance of it — the APPROACH was wrong, not the code.
// This suite stops parsing the file and starts running it, on the shared
// `migration-guard.ts` helper: PostgreSQL is the parser now.
//
// ── the two oracles ──────────────────────────────────────────────────────────
//
// ORACLE A (title 2) is the pinned head posture — literals captured
// independently of the migration file (`docs/reviews/fix-1301-migration-guard-execution/oracle-a-literals.txt`,
// "row security posture at head"). This is what catches a WEAKENED migration:
// `pnpm test:db:setup` provisions the container FROM the migration under
// test, so oracle B alone is circular — a weakened 049 yields a weakened
// BEFORE reading and `AFTER == BEFORE` would pass regardless.
//
// ORACLE B (titles 3-4) degrades `analytics_events` to the pre-049 posture
// inside a transaction that ALWAYS rolls back, proves the degrade landed so
// the case cannot pass vacuously against a no-op migration, applies the
// checked-in file VERBATIM, and diffs the whole `public` catalogue against
// the before-read — including every OTHER table, because a migration may
// harden the one table it names while doing arbitrary damage elsewhere
// (migration 119's `GRANT ALL ON admin_audit_log TO anon;` red-team round).
// `rowSecurity` is a BOOLEAN catalogue property with its own selector-free
// variant in `DegradeTarget` — no `absent`/`present` list is needed because
// the value comparison alone IS the proof that the degrade landed, so this
// case cannot pass vacuously against a no-op migration.
//
// ── stated limits ────────────────────────────────────────────────────────────
//
// 049 establishes exactly one property (RLS enabled, zero policies) on one
// table, so there is no un-guarded remainder the way FORCE or a second table
// would leave one. The DB-free registry case is the only one that cannot
// silently skip; the other three sit behind `describeWithDb` and need a
// database.

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

const TABLE = 'analytics_events';
const MIGRATION_FILE = '049_analytics_events_rls.sql';
const SUITE_FILE = 'src/lib/shared/__tests__/migration-049-analytics-events-rls.integration.test.ts';
const BEHIND_HEAD = 'analytics_events RLS posture is not at migration head — run pnpm test:db:setup';

const testDatabaseUrl = resolveTestDatabaseUrl();

let db: postgresType.Sql | undefined;
let featureDatabaseLock: LiveDbLock | undefined;

function sql(): postgresType.Sql {
  if (!db) throw new Error('migration 049 integration database was not initialized');
  return db;
}

// ── registry: no database needed, so this one can never silently skip ───────

describe('migration 049 registries', () => {
  it('migration 049 suite is registered in MIGRATION_SHAPE_FILES', () => {
    // `MIGRATION_SHAPE_FILES` itself is a module-private `const` inside
    // `scripts/ci/live-db-suites-audit.ts` — not exported, so this case reads
    // its EFFECT through the audit's own exported entry point rather than the
    // set. This suite's own checked-in text executes DDL (multiple `.unsafe()`
    // calls below) and holds the cross-process lock; running the real audit
    // against that real text produces zero findings ONLY because this file's
    // exact path is a member of the allowlist AND names the lock marker. A
    // typo'd or dropped entry — or a lock call renamed away — would surface a
    // `runtime-ddl` or `unlocked-ddl` finding here, which is a stronger, live
    // check than reading membership off a hardcoded copy of the set.
    const ownSourceText = readFileSync(join(process.cwd(), SUITE_FILE), 'utf8');
    expect(auditLiveDbFile(SUITE_FILE, ownSourceText)).toEqual([]);
  });
});

describeWithDb(
  'migration 049 analytics_events deny-all RLS',
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

    it('analytics_events carries row security enabled at head', async () => {
      const [security] = await sql()<{ rls_enabled: boolean; policy_count: string }[]>`
        SELECT
          cls.relrowsecurity AS rls_enabled,
          (
            SELECT count(*)::text FROM pg_policies
             WHERE schemaname = 'public' AND tablename = ${TABLE}
          ) AS policy_count
        FROM pg_class cls
        WHERE cls.oid = 'public.analytics_events'::regclass
      `;

      // Literal from `docs/reviews/fix-1301-migration-guard-execution/oracle-a-literals.txt` ("row security posture
      // at head"): analytics_events: rowsecurity=true force=false policies=0.
      // Independent of the migration file — this is what catches a weakened
      // 049 on a freshly provisioned container, where oracle B alone would be
      // circular (`pnpm test:db:setup` provisions FROM the migration under
      // test, so a weakened migration yields a weakened BEFORE and
      // `AFTER == BEFORE` would pass).
      expect(security?.rls_enabled, BEHIND_HEAD).toBe(true);

      // Zero policies IS the guarantee, not an omission: deny-all is the
      // design, so any policy at all would be a wider door than the product
      // needs.
      expect(security?.policy_count, BEHIND_HEAD).toBe('0');
    });

    // ── ORACLE B: degrade, prove it landed, apply verbatim, diff ─────────────

    it('re-applying 049 restores row security after it is disabled', async () => {
      // `withRolledBackTransaction` ALWAYS rolls back, which is what makes
      // running the degrade/apply cycle once per title safe for the shared
      // container: later migrations layer on `public`, so a persistent
      // degrade would corrupt it for every other suite.
      await withRolledBackTransaction(sql(), async (tx) => {
        const before = await readPublicCatalogue(tx);
        await tx.unsafe('ALTER TABLE analytics_events DISABLE ROW LEVEL SECURITY;');
        const degraded = await readPublicCatalogue(tx);

        // `rowSecurity` is a BOOLEAN property: no `absent`/`present` name list
        // applies, so it has its own selector-free variant in `DegradeTarget` —
        // the value comparison inside `assertDegradeLanded` IS the proof that
        // the degrade really landed, so this case cannot pass vacuously against
        // a no-op migration.
        assertDegradeLanded(before, degraded, {
          table: TABLE,
          property: 'rowSecurity',
        });

        await tx.unsafe(readMigrationSql(MIGRATION_FILE));
        const after = await readPublicCatalogue(tx);

        expect(after.tables[TABLE]).toEqual(before.tables[TABLE]);
      });
    });

    it('re-applying 049 moves no other table in public', async () => {
      await withRolledBackTransaction(sql(), async (tx) => {
        const before = await readPublicCatalogue(tx);
        await tx.unsafe('ALTER TABLE analytics_events DISABLE ROW LEVEL SECURITY;');
        const degraded = await readPublicCatalogue(tx);

        // The degrade must LAND before the re-apply gets credit for undoing it;
        // `assertDegradeLanded`'s JSDoc owns why all seven cases call this.
        assertDegradeLanded(before, degraded, {
          table: TABLE,
          property: 'rowSecurity',
        });

        await tx.unsafe(readMigrationSql(MIGRATION_FILE));
        const after = await readPublicCatalogue(tx);

        // A migration may harden the one table it names while doing arbitrary
        // damage elsewhere (migration 119's off-target `GRANT ALL ON
        // admin_audit_log TO anon;` red-team round). Every table outside
        // `[analytics_events]` must come out byte-identical.
        assertOnlyTablesMoved(before, after, [TABLE]);
      });
    });
  },
);
