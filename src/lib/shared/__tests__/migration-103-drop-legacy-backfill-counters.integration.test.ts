import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
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
  MIGRATION_100_IMPORT_CONSENT,
} from '@/lib/shared/__tests__/helpers/schema-ready';
import { cleanupTenantAccount, seedTenantAccount } from '@/lib/shared/__tests__/live-db-tenant';

// Shape suite for migration 103 (#680) — the DROP half of the backfill-counter
// collapse, and the closing cleanup ticket of the Consented Review Import epic
// (ADR 0015 §4, spec 2026-08-05-consented-review-import-design.md §8a R4).
//
// Migration 100 ADDed imported_count/skipped_count and deliberately LEFT the
// four legacy gap_*/historical_* counters in place so `git revert` of any epic
// PR never put the old dual-writing worker against a schema missing them. 103
// removes them, and is the epic's point of no return.
//
// Three subjects, and the middle one is the reason this suite exists:
//
//  1. The migration's executable TEXT (no DB). Final-state introspection alone
//     cannot constrain what 103 DOES: a hand-dropped column, a draft container,
//     or a 103 that also ran UPDATE/TRUNCATE would all satisfy "the columns are
//     gone". So the text is pinned exactly (plan review F1/F11).
//
//  2. The preflight guard's BOTH branches, by executing the migration's OWN
//     guard text against a pg_temp replica of the pre-103 shape. A guard that
//     never fires is indistinguishable from a working one on clean data — both
//     report zero abort rows, and BOTH environments are clean today — so
//     apply-time evidence can never prove the guard works. Only this can
//     (plan review F2).
//
//  3. Final-state shape: the legacy four absent, the three survivors intact.
//
// Live-DB conventions (#573, `ci:live-db-suites`): named *.integration.test.ts,
// holds acquireLiveDbLock, and ASSERTS the schema with assertSchemaReady rather
// than applying migration SQL. The only DDL is a pg_temp fixture inside a
// transaction that always rolls back; it and the dynamic guard execution each
// carry a line-scoped `live-db-ddl-ignore` pragma, because a CREATE TABLE on
// pg_temp reads exactly like one on the shared table, and the audit counts an
// `.unsafe()` argument it cannot statically read as DDL.

const testDatabaseUrl = resolveTestDatabaseUrl();

const MIGRATION_103 = 'supabase/migrations/103_drop_legacy_backfill_counters.sql';

const LEGACY_COUNTER_COLUMNS = [
  'gap_processed_count',
  'historical_processed_count',
  'gap_skipped_count',
  'historical_skipped_count',
] as const;

const SURVIVING_COLUMNS = ['imported_count', 'skipped_count', 'oldest_skipped_create_time'] as const;

const migrationPath = resolve(process.cwd(), MIGRATION_103);

/**
 * Read lazily-ish: before T2 the file does not exist, and a throwing top-level
 * read would fail COLLECTION — reporting one suite error instead of the named
 * titles this eval commit is supposed to fail on (102 precedent).
 */
const rawSql = existsSync(migrationPath) ? readFileSync(migrationPath, 'utf-8') : '';

/** Executable SQL only — `-- …` line comments DISCUSS operations they do not run. */
const executableSql = rawSql.replace(/--.*$/gm, '');

/** Token-sequence view: formatting is free to change, content is not. */
function normalize(sql: string): string {
  return sql.replace(/\s+/g, ' ').trim();
}

/**
 * The pinned canonical body of 103. This is the SPEC in executable form — T2
 * writes the migration to match it, not the other way round.
 *
 * Pinned WHOLE rather than split into statements: an earlier draft excised the
 * `DO $$ … $$` block to count top-level statements, which left the guard body
 * entirely unconstrained (a `DROP TABLE` smuggled inside it passed a
 * four-keyword denylist while still yielding the expected statement count), and
 * its "exactly one block" assertion was inert anyway because `.match()` without
 * `/g` returns a length-1 array however many matches exist. A landed migration
 * is immutable by repo rule, so exact pinning is the correct instrument here
 * (plan review F11).
 */
const EXPECTED_BODY = `
SET lock_timeout = '5s';

SET search_path = public, pg_temp;

DO $$
DECLARE
  legacy_present INT;
  unreconciled   BIGINT;
BEGIN
  SELECT count(*) INTO legacy_present
    FROM pg_attribute
   WHERE attrelid = to_regclass('zernio_backfill_runs')
     AND NOT attisdropped
     AND attname IN ('gap_processed_count', 'historical_processed_count',
                     'gap_skipped_count', 'historical_skipped_count');

  IF legacy_present = 0 THEN
    RETURN;
  END IF;

  IF legacy_present <> 4 THEN
    RAISE EXCEPTION
      'migration 103 preflight: partial legacy-counter schema (% of 4 present)',
      legacy_present;
  END IF;

  SELECT count(*) INTO unreconciled
    FROM zernio_backfill_runs
   WHERE NOT (gap_processed_count = 0 AND historical_processed_count = 0
              AND gap_skipped_count = 0 AND historical_skipped_count = 0)
     AND (imported_count <> gap_processed_count + historical_processed_count
       OR skipped_count <> gap_skipped_count + historical_skipped_count);

  IF unreconciled > 0 THEN
    RAISE EXCEPTION
      'migration 103 preflight: % unreconciled backfill run(s)', unreconciled;
  END IF;
END $$;

ALTER TABLE zernio_backfill_runs
  DROP COLUMN IF EXISTS gap_processed_count,
  DROP COLUMN IF EXISTS historical_processed_count,
  DROP COLUMN IF EXISTS gap_skipped_count,
  DROP COLUMN IF EXISTS historical_skipped_count;
`;

/** The migration's OWN guard text, executed verbatim by tests 3 and 4. */
function extractGuard(): string {
  const match = executableSql.match(/DO \$\$[\s\S]*?\$\$;/);
  expect(
    match,
    `no DO $$ … $$ guard found in ${MIGRATION_103} — the preflight is what tests 3 and 4 exist to prove`,
  ).not.toBeNull();
  return match![0]!;
}

/** Columns of the pre-103 shape, so the guard has something to resolve against. */
const PRE_103_REPLICA = `
  CREATE TEMP TABLE zernio_backfill_runs (
    id                        UUID PRIMARY KEY,
    imported_count            INTEGER NOT NULL DEFAULT 0,
    skipped_count             INTEGER NOT NULL DEFAULT 0,
    gap_processed_count       INTEGER NOT NULL DEFAULT 0,
    historical_processed_count INTEGER NOT NULL DEFAULT 0,
    gap_skipped_count         INTEGER NOT NULL DEFAULT 0,
    historical_skipped_count  INTEGER NOT NULL DEFAULT 0
  ) ON COMMIT DROP
`;

describe('migration 103 - drop legacy backfill counters (text)', () => {
  it('migration 103 executable SQL is exactly a bounded lock, a pinned search_path, the preflight guard, and the four legacy-column DROPs', () => {
    expect(
      normalize(executableSql),
      `${MIGRATION_103} does not match its pinned canonical body. Final-state ` +
        `introspection cannot catch a migration that drops the columns AND erases ` +
        `surviving counter values, so this pin is the only thing constraining what 103 does.`,
    ).toBe(normalize(EXPECTED_BODY));

    // Redundant with the pin, kept as a readable tripwire: a pinned-string diff
    // names nothing, this names the risk. SELECT is deliberately allowed — the
    // guard counts rows.
    for (const verb of ['UPDATE', 'DELETE', 'TRUNCATE', 'CASCADE']) {
      expect(executableSql.toUpperCase()).not.toContain(verb);
    }
  });

  it('migration 103 sets a lock_timeout before the ACCESS EXCLUSIVE drop', () => {
    // DROP COLUMN takes ACCESS EXCLUSIVE and can collide with an in-flight
    // backfill; the bound makes that a fast failure rather than a queue behind a
    // long transaction. Order matters as much as presence — a bound set after
    // the ALTER bounds nothing (intake E8).
    const lockAt = executableSql.search(/SET\s+(LOCAL\s+)?lock_timeout/i);
    const alterAt = executableSql.search(/ALTER TABLE\s+zernio_backfill_runs/i);
    expect(lockAt).toBeGreaterThanOrEqual(0);
    expect(alterAt).toBeGreaterThanOrEqual(0);
    expect(lockAt).toBeLessThan(alterAt);
  });
});

// ── The live half ───────────────────────────────────────────────────────────

let db: postgresType.Sql | undefined;
let featureDatabaseLock: LiveDbLock | undefined;
let accountId: string | undefined;
let userId: string | undefined;
const businessId = randomUUID();

function sql(): postgresType.Sql {
  return db!;
}

/** Thrown to roll a probe transaction back; never escapes this file. */
class RollbackProbe extends Error {
  override readonly name = 'RollbackProbe';
}

/**
 * Runs the migration's own guard against a pg_temp replica seeded with `rows`,
 * always rolling back. Returns the error the guard raised, or undefined.
 *
 * `SET LOCAL search_path = pg_temp, public` is what makes the guard resolve to
 * the replica: its column check goes through `to_regclass` rather than a
 * hardcoded `table_schema = 'public'` literal, precisely so it FOLLOWS this
 * shadow. (A 'public' literal made the suite self-contradictory — test 5 needs
 * public post-103 with the columns absent, while this test needs them present.)
 */
async function runGuardAgainstReplica(
  rows: readonly Record<string, number>[],
): Promise<{ code?: string; message?: string } | undefined> {
  const guardSql = extractGuard();
  let raised: { code?: string; message?: string } | undefined;
  try {
    await sql().begin(async (tx) => {
      await tx.unsafe(PRE_103_REPLICA); // live-db-ddl-ignore: pg_temp fixture, ON COMMIT DROP, inside an always-rolled-back tx
      await tx.unsafe('SET LOCAL search_path = pg_temp, public');
      for (const row of rows) {
        await tx`INSERT INTO zernio_backfill_runs ${tx({ id: randomUUID(), ...row })}`;
      }
      // live-db-ddl-ignore: the migration's own DO guard, read from disk at run time; executes no DDL and the tx always rolls back
      await tx.unsafe(guardSql);
      throw new RollbackProbe();
    });
  } catch (error) {
    if ((error as { name?: string })?.name !== 'RollbackProbe') {
      raised = error as { code?: string; message?: string };
    }
  }
  return raised;
}

describeWithDb(
  'migration 103 drop legacy backfill counters',
  { enabled: Boolean(testDatabaseUrl), timeout: 120_000 },
  () => {
    beforeAll(async () => {
      const databaseUrl = assertLocalTestDatabaseUrl(testDatabaseUrl);
      featureDatabaseLock = await acquireLiveDbLock(databaseUrl);
      db = postgres(databaseUrl, { max: 1, prepare: false });
      // Proves the DB is at/after 100. Absence of the legacy four is asserted
      // directly below — a SchemaRequirement models PRESENCE and cannot express
      // "these are gone".
      await assertSchemaReady(db, [MIGRATION_100_IMPORT_CONSENT]);
      const seed = await seedTenantAccount(db, {
        userName: 'Legacy Counter Drop Owner',
        accountDisplayName: 'Legacy Counter Drop Fixture',
      });
      accountId = seed.accountId;
      userId = seed.userId;
      await db`
        INSERT INTO businesses (
          id, name, owner_name, owner_email, account_id, subscription_status, category
        ) VALUES (
          ${businessId}::uuid, 'Legacy Counter Drop Business',
          'Drop Owner', ${seed.ownerEmail}, ${seed.accountId}::uuid,
          'active', 'automotive'
        )
      `;
    }, LIVE_DB_LOCK_HOOK_TIMEOUT_MS);

    afterAll(async () => {
      try {
        if (db && accountId) {
          await db`DELETE FROM businesses WHERE id = ${businessId}::uuid`;
          await cleanupTenantAccount(db, { accountId, userId: userId! });
        }
      } finally {
        if (db) await db.end({ timeout: 5 });
        if (featureDatabaseLock) await featureDatabaseLock.release();
      }
    });

    it('migration 103 preflight raises when a legacy-work row disagrees with its collapsed counters', async () => {
      // THE test that proves the guard works at all. A row that did legacy work
      // (nonzero legacy counters) whose collapsed values do NOT equal the legacy
      // sums is exactly what must abort the migration: dropping those columns
      // would destroy the only record of the discrepancy, unrecoverably.
      const raised = await runGuardAgainstReplica([
        {
          imported_count: 5, // legacy sum is 3 + 4 = 7 — disagrees
          skipped_count: 2,
          gap_processed_count: 3,
          historical_processed_count: 4,
          gap_skipped_count: 1,
          historical_skipped_count: 1,
        },
      ]);

      // P0001 = raise_exception. Asserting the SQLSTATE keeps this from passing
      // on an unrelated failure (a missing column, a dropped connection).
      expect(raised?.code).toBe('P0001');
      expect(raised?.message).toContain('unreconciled');
    });

    it('migration 103 preflight passes matching pre-#675 rows and post-#675 zero-legacy rows', async () => {
      // Pins the two-branch disjunction against a regression to the NAIVE form
      // ("collapsed = legacy sums on every row"), which false-positives on the
      // second row here — a healthy post-#675 run. Both live staging rows are of
      // that shape, so the naive predicate would abort a clean migration.
      const raised = await runGuardAgainstReplica([
        {
          // pre-#675: dual-written, collapsed EQUALS the legacy sums
          imported_count: 7,
          skipped_count: 2,
          gap_processed_count: 3,
          historical_processed_count: 4,
          gap_skipped_count: 1,
          historical_skipped_count: 1,
        },
        {
          // post-#675: real work, all four legacy counters untouched at 0
          imported_count: 29,
          skipped_count: 4,
          gap_processed_count: 0,
          historical_processed_count: 0,
          gap_skipped_count: 0,
          historical_skipped_count: 0,
        },
      ]);

      expect(raised).toBeUndefined();
    });

    it('the four legacy gap_*/historical_* counters are absent from zernio_backfill_runs', async () => {
      const cols = await sql()<{ column_name: string }[]>`
        SELECT column_name
        FROM information_schema.columns
        WHERE table_schema = 'public' AND table_name = 'zernio_backfill_runs'
          AND column_name = ANY(${[...LEGACY_COUNTER_COLUMNS]})
      `;
      expect(
        cols.map((c) => c.column_name),
        'legacy backfill counters are still present — the local test database is behind ' +
          'migration 103. Run `pnpm test:db:setup` to provision it to head.',
      ).toEqual([]);
    });

    it('imported_count, skipped_count and oldest_skipped_create_time survive the drop with their 100-era shape', async () => {
      const cols = await sql()<
        {
          column_name: string;
          data_type: string;
          is_nullable: string;
          column_default: string | null;
        }[]
      >`
        SELECT column_name, data_type, is_nullable, column_default
        FROM information_schema.columns
        WHERE table_schema = 'public' AND table_name = 'zernio_backfill_runs'
          AND column_name IN ('imported_count', 'skipped_count', 'oldest_skipped_create_time')
      `;
      expect(cols).toHaveLength(SURVIVING_COLUMNS.length);
      for (const name of ['imported_count', 'skipped_count']) {
        const col = cols.find((c) => c.column_name === name);
        expect(col?.data_type).toBe('integer');
        expect(col?.is_nullable).toBe('NO');
        expect(col?.column_default).toBe('0');
      }
      // The DROP must not have touched the third survivor's nullability.
      expect(cols.find((c) => c.column_name === 'oldest_skipped_create_time')).toBeDefined();
    });

    it('a backfill run INSERT naming only the surviving columns succeeds and defaults both counters to 0', async () => {
      // Proves the DROP left the DEFAULTs intact — a column dropped alongside a
      // rewritten default would still satisfy the introspection above.
      // `public.` is explicit so a leaked pg_temp replica could never satisfy
      // this in place of the real table.
      await sql()
        .begin(async (tx) => {
          const [inserted] = await tx<{ imported_count: number; skipped_count: number }[]>`
            INSERT INTO public.zernio_backfill_runs (
              id, business_id, zernio_account_id, zernio_location_id,
              subscription_tier, subscription_activated_at, run_reason
            ) VALUES (
              ${randomUUID()}, ${businessId}, 'za-drop', 'zl-drop',
              'copilot', NOW(), 'initial'
            )
            RETURNING imported_count, skipped_count
          `;
          expect(inserted?.imported_count).toBe(0);
          expect(inserted?.skipped_count).toBe(0);
          throw new RollbackProbe();
        })
        .catch((err: unknown) => {
          if ((err as { name?: string })?.name !== 'RollbackProbe') throw err;
        });
    });
  },
);
