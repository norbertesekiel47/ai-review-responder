// Nullability assertions for migration 057 — DROPs NOT NULL on five columns
// across three tables (#1301, plan section for the #1171 migration-guard
// sweep): account_offboardings.zernio_account_ids/zernio_profile_ids,
// approval_audit_log.response_id, impersonation_sessions.account_id/
// impersonated_user_id. The purge worker must scrub raw provider identifiers
// from a RETAINED lifecycle receipt without losing the receipt, and must
// detach approval audit rows from deleted responses without losing the audit
// history. The migration deliberately LEAVES NOT NULL on
// account_offboardings.location_ids/provider_dispositions,
// approval_audit_log.account_id/business_id and
// impersonation_sessions.actor_user_id.
//
// The predecessor suite proved all of this by pattern-matching the migration's
// SQL TEXT (`not.toMatch` regexes for both halves), and that approach lost
// five red-team passes on #1171: a newline inside `CREATE\nPOLICY`, a block
// comment inside `DISABLE/**/ROW LEVEL SECURITY`, `--` inside a string
// literal, and a comment standing in as evidence, among others. Every fix
// closed one lexical class and the next pass found another instance of it —
// the APPROACH was wrong, not the code. This suite stops parsing the file and
// starts running it, on the shared `migration-guard.ts` helper: PostgreSQL is
// the parser now.
//
// ── this suite EXECUTES DDL, deliberately ───────────────────────────────────
//
// It is listed in `MIGRATION_SHAPE_FILES` (`scripts/ci/live-db-suites-audit.ts`)
// — the sanctioned exemption from R2 for suites where APPLYING the migration
// IS the subject.
//
// ── THIS SUITE'S DEGRADE RUNS BACKWARDS — use `present`, not `absent` ────────
//
// Every sibling #1301 suite's degrade REMOVES an object its migration
// CREATES, so it uses the harness's `absent` selector. 057 does the opposite:
// it LOOSENS nullability, so there is no object to remove. The degrade here
// REINSTATES NOT NULL on the five loosened columns, and the harness's
// `present` selector is the one that fits — it asserts a name was MISSING
// from `before.notNullColumns` and is PRESENT in `degraded.notNullColumns`.
// `notNullColumns` holds BARE column names, no type string, which is exactly
// why it exists as its own catalogue property: a selector against `columns`
// would have to match `zernio_account_ids text[] NULL`, with the type sitting
// between the name and the nullability (`migration-guard.ts`'s own JSDoc on
// `CataloguedTable.columns`).
//
// ── THE DATA PRECONDITION — this degrade can fail for a real reason ─────────
//
// `SET NOT NULL` ERRORS if any existing row holds NULL in that column — the
// only one of the seven #1301 degrades with that property, because every
// other degrade removes an object rather than adding a constraint over live
// rows. `assertNoNullsBeforeDegrade` below counts NULLs in the five columns
// and throws a NAMED error identifying which column and how many rows if any
// carry one, so a container with dirty data fails loudly and specifically
// rather than either (a) silently skipping the case, or (b) surfacing as a
// bare Postgres `23502 column contains null values` with no indication which
// of the five columns was at fault.
//
// ── ORACLE A pins BOTH directions ────────────────────────────────────────────
//
// Literals from `.feature/oracle-a-literals.txt` ("057 nullability"),
// independent of the migration file: oracle B alone is circular, because
// `pnpm test:db:setup` provisions the container FROM the migration under
// test, so a weakened 057 would yield a weakened BEFORE reading and
// `AFTER == BEFORE` would pass regardless. HEAD_NULLABILITY pins all TEN
// columns — the five loosened ARE nullable, and the five deliberately
// untouched are NOT — so a hypothetical sixth `ALTER COLUMN … DROP NOT NULL`
// clause on `impersonation_sessions.actor_user_id` fails this case, not just
// a silent absence from the old suite's coverage. That second half replaces
// the predecessor suite's `not.toMatch` assertions on
// `location_ids`/`provider_dispositions`/`account_id`/`business_id`/
// `actor_user_id` with a single catalogue fact per column.
//
// ── two assertions RETIRED, deliberately ─────────────────────────────────────
//
// The predecessor suite also asserted `expect(sql).not.toMatch(/\bpurging\b/i)`
// and `expect(sql).not.toMatch(/NEXT_PUBLIC_/i)`. Both are retired here and
// have NO replacement, on purpose: they are text-vocabulary checks over a SQL
// file's prose, neither corresponds to any catalogue object this migration
// touches, and a catalogue assertion cannot — and should not — claim to
// police arbitrary text in a file. This paragraph is that explanation, for
// `ci:weakened-checks`'s REVIEW row on the deleted predecessor file.
//
// ── stated limits ────────────────────────────────────────────────────────────
//
// `approval_audit_log` carries ONE row-security policy at head (unlike the
// zero-policy tables the sibling #1301 suites guard) — noted rather than
// assumed, because `readPublicCatalogue` captures policies as part of a
// table's full state and `assertOnlyTablesMoved`'s off-target check would
// report it if 057 ever touched that policy, which is the point: this suite
// asserts nullability only and leaves the policy itself to whichever suite
// owns it.
//
// The DB-free registry case is the only one that cannot silently skip; every
// other case sits behind `describeWithDb` and needs a database.

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import postgres from 'postgres';
import type postgresType from 'postgres';
import type { TransactionSql } from 'postgres';
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
import {
  assertSchemaReady,
  MIGRATION_057_OFFBOARDING_TOMBSTONE_NULLABILITY,
} from '@/lib/shared/__tests__/helpers/schema-ready';
import { auditLiveDbFile } from '../../../../scripts/ci/live-db-suites-audit';

const MIGRATION_FILE = '057_account_offboarding_tombstone_nullability.sql';
const SUITE_FILE =
  'src/lib/shared/__tests__/migration-057-account-offboarding-tombstone-nullability.integration.test.ts';
const BEHIND_HEAD =
  'account_offboardings/approval_audit_log/impersonation_sessions nullability is not at ' +
  'migration head — run pnpm test:db:setup';

const TABLES = [
  'account_offboardings',
  'approval_audit_log',
  'impersonation_sessions',
] as const;

// Oracle A — `.feature/oracle-a-literals.txt` "057 nullability", verbatim.
// Both halves: the five loosened columns (nullable=YES) and the five
// deliberately untouched ones (nullable=NO).
const HEAD_NULLABILITY: readonly { table: string; column: string; nullable: boolean }[] = [
  { table: 'account_offboardings', column: 'location_ids', nullable: false },
  { table: 'account_offboardings', column: 'provider_dispositions', nullable: false },
  { table: 'account_offboardings', column: 'zernio_account_ids', nullable: true },
  { table: 'account_offboardings', column: 'zernio_profile_ids', nullable: true },
  { table: 'approval_audit_log', column: 'account_id', nullable: false },
  { table: 'approval_audit_log', column: 'business_id', nullable: false },
  { table: 'approval_audit_log', column: 'response_id', nullable: true },
  { table: 'impersonation_sessions', column: 'account_id', nullable: true },
  { table: 'impersonation_sessions', column: 'actor_user_id', nullable: false },
  { table: 'impersonation_sessions', column: 'impersonated_user_id', nullable: true },
];

// The degrade: reinstate NOT NULL on exactly the five columns 057 loosens.
const DEGRADE = `
  ALTER TABLE account_offboardings
    ALTER COLUMN zernio_account_ids SET NOT NULL,
    ALTER COLUMN zernio_profile_ids SET NOT NULL;

  ALTER TABLE approval_audit_log
    ALTER COLUMN response_id SET NOT NULL;

  ALTER TABLE impersonation_sessions
    ALTER COLUMN account_id SET NOT NULL,
    ALTER COLUMN impersonated_user_id SET NOT NULL;
`;

const testDatabaseUrl = resolveTestDatabaseUrl();

let db: postgresType.Sql | undefined;
let featureDatabaseLock: LiveDbLock | undefined;

function sql(): postgresType.Sql {
  if (!db) throw new Error('migration 057 integration database was not initialized');
  return db;
}

/**
 * `SET NOT NULL` ERRORS (23502) if any existing row already holds NULL in
 * that column — the only one of the seven #1301 degrades with that property.
 * Counting first and failing with a NAMED message, rather than letting the
 * bare Postgres error surface or (worse) silently skipping the case, is the
 * whole reason this function exists: a silent skip is exactly the failure
 * mode this entire #1301 run exists to remove.
 */
async function assertNoNullsBeforeDegrade(tx: TransactionSql): Promise<void> {
  const nullCounts = await tx<{ label: string; null_count: string }[]>`
    SELECT 'account_offboardings.zernio_account_ids' AS label, count(*)::text AS null_count
      FROM account_offboardings WHERE zernio_account_ids IS NULL
    UNION ALL
    SELECT 'account_offboardings.zernio_profile_ids', count(*)::text
      FROM account_offboardings WHERE zernio_profile_ids IS NULL
    UNION ALL
    SELECT 'approval_audit_log.response_id', count(*)::text
      FROM approval_audit_log WHERE response_id IS NULL
    UNION ALL
    SELECT 'impersonation_sessions.account_id', count(*)::text
      FROM impersonation_sessions WHERE account_id IS NULL
    UNION ALL
    SELECT 'impersonation_sessions.impersonated_user_id', count(*)::text
      FROM impersonation_sessions WHERE impersonated_user_id IS NULL
  `;
  const withNulls = nullCounts.filter((row) => Number(row.null_count) > 0);
  if (withNulls.length === 0) return;

  throw new Error(
    'migration 057 degrade cannot reinstate NOT NULL: this container carries NULL values ' +
      'in a column migration 057 loosens, which makes `SET NOT NULL` fail for a real data ' +
      'reason rather than a harness bug — ' +
      withNulls.map((row) => `${row.label} (${row.null_count} row(s))`).join(', ') +
      '. Re-provision with `pnpm test:db:setup`, or find and fix the fixture/seed path ' +
      'that left these columns NULL.',
  );
}

// ── registry: no database needed, so this one can never silently skip ───────

describe('migration 057 registries', () => {
  it('migration 057 suite is registered in MIGRATION_SHAPE_FILES', () => {
    // `MIGRATION_SHAPE_FILES` itself is a module-private `const` inside
    // `scripts/ci/live-db-suites-audit.ts` — not exported, so this case reads
    // its EFFECT through the audit's own exported entry point rather than the
    // set. This suite's own checked-in text executes DDL (multiple
    // `.unsafe()` calls below) and holds the cross-process lock; running the
    // real audit against that real text produces zero findings ONLY because
    // this file's exact path is a member of the allowlist AND names the lock
    // marker. A typo'd or dropped entry — or a lock call renamed away —
    // would surface a `runtime-ddl` or `unlocked-ddl` finding here, which is
    // a stronger, live check than reading membership off a hardcoded copy of
    // the set.
    const ownSourceText = readFileSync(join(process.cwd(), SUITE_FILE), 'utf8');
    expect(auditLiveDbFile(SUITE_FILE, ownSourceText)).toEqual([]);
  });
});

describeWithDb(
  'migration 057 account offboarding tombstone nullability',
  { enabled: Boolean(testDatabaseUrl), timeout: 180_000 },
  () => {
    beforeAll(async () => {
      const databaseUrl = assertLocalTestDatabaseUrl(testDatabaseUrl);
      featureDatabaseLock = await acquireLiveDbLock(databaseUrl);
      db = postgres(databaseUrl, {
        // max: 1, not 2 — every case here runs the checked-in migration
        // verbatim through `unsafe` inside a transaction it also owns
        // (`withRolledBackTransaction`), and postgres.js refuses a
        // transaction-bearing `unsafe` on a pooled client
        // (`UNSAFE_TRANSACTION: Only use sql.begin, sql.reserved or max: 1`)
        // because it cannot guarantee the statements land on one backend.
        // Every case here is sequential, so a single connection costs
        // nothing.
        max: 1,
        prepare: false,
        connection: { statement_timeout: 30_000 },
      });
      // Actionable behind-head message instead of an undefined-column error
      // mid-degrade — `schema-ready.ts`'s own comment on
      // MIGRATION_057_OFFBOARDING_TOMBSTONE_NULLABILITY states this bound: the
      // requirement proves the columns EXIST (what 048/056 already guarantee)
      // and no more, since a `SchemaRequirement` structurally cannot carry
      // nullability. The catalogue-executing cases below prove nullability
      // itself.
      await assertSchemaReady(db, [MIGRATION_057_OFFBOARDING_TOMBSTONE_NULLABILITY]);
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

    it('the five tombstone columns are nullable at head', async () => {
      const rows = await sql()<{ table_name: string; column_name: string; is_nullable: string }[]>`
        SELECT table_name, column_name, is_nullable
          FROM information_schema.columns
         WHERE table_schema = 'public'
           AND table_name IN ('account_offboardings', 'approval_audit_log', 'impersonation_sessions')
      `;
      const byKey = new Map(
        rows.map((row) => [`${row.table_name}.${row.column_name}`, row.is_nullable]),
      );

      // Both halves of oracle A, pinned in one loop: the five loosened
      // columns must read `nullable=YES` and the five deliberately untouched
      // ones must read `nullable=NO`. A hypothetical sixth `DROP NOT NULL`
      // clause on `impersonation_sessions.actor_user_id` flips its expected
      // 'NO' to an actual 'YES' and fails this case.
      for (const entry of HEAD_NULLABILITY) {
        const key = `${entry.table}.${entry.column}`;
        expect(byKey.get(key), `${key} — ${BEHIND_HEAD}`).toBe(entry.nullable ? 'YES' : 'NO');
      }
    });

    // ── ORACLE B: degrade, prove it landed, apply verbatim, diff ─────────────

    it('re-applying 057 restores nullability after NOT NULL is reinstated', async () => {
      // `withRolledBackTransaction` ALWAYS rolls back, which is what makes
      // running the degrade/apply cycle once per title safe for the shared
      // container: later migrations layer on `public`, so a persistent
      // degrade would corrupt it for every other suite.
      await withRolledBackTransaction(sql(), async (tx) => {
        const before = await readPublicCatalogue(tx);

        // Precondition: SET NOT NULL errors on an existing NULL. Fail loudly
        // and by name if the container's data makes the degrade impossible —
        // never skip silently.
        await assertNoNullsBeforeDegrade(tx);

        await tx.unsafe(DEGRADE);
        const degraded = await readPublicCatalogue(tx);

        // Three `present` calls, one per table — this suite's degrade ADDS
        // notNullColumns entries rather than removing them, so `present` is
        // the selector that fits (see header). Each call also proves the
        // degrade LANDED, which is what keeps this case from passing
        // vacuously against a no-op migration.
        assertDegradeLanded(before, degraded, {
          table: 'account_offboardings',
          property: 'notNullColumns',
          present: ['zernio_account_ids', 'zernio_profile_ids'],
        });
        assertDegradeLanded(before, degraded, {
          table: 'approval_audit_log',
          property: 'notNullColumns',
          present: ['response_id'],
        });
        assertDegradeLanded(before, degraded, {
          table: 'impersonation_sessions',
          property: 'notNullColumns',
          present: ['account_id', 'impersonated_user_id'],
        });

        await tx.unsafe(readMigrationSql(MIGRATION_FILE));
        const after = await readPublicCatalogue(tx);

        // All THREE tables' full state — not nullability alone — must match
        // the original BEFORE reading once 057 re-runs.
        for (const table of TABLES) {
          expect(after.tables[table]).toEqual(before.tables[table]);
        }
      });
    });

    it('re-applying 057 moves no other table in public', async () => {
      await withRolledBackTransaction(sql(), async (tx) => {
        const before = await readPublicCatalogue(tx);
        await assertNoNullsBeforeDegrade(tx);
        await tx.unsafe(DEGRADE);
        const degraded = await readPublicCatalogue(tx);

        // The degrade must LAND before the re-apply gets credit for undoing it.
        // Four of the seven "moves no other table" cases ran this cycle
        // without proving it, while three proved it — one plan, three shapes
        // (#1301 S-1/F-F/RT-15). A reader could not tell a deliberate omission
        // from an oversight, so every one of the seven now proves it, with the
        // same targets its sibling case uses.
        assertDegradeLanded(before, degraded, {
          table: 'account_offboardings',
          property: 'notNullColumns',
          present: ['zernio_account_ids', 'zernio_profile_ids'],
        });
        assertDegradeLanded(before, degraded, {
          table: 'approval_audit_log',
          property: 'notNullColumns',
          present: ['response_id'],
        });
        assertDegradeLanded(before, degraded, {
          table: 'impersonation_sessions',
          property: 'notNullColumns',
          present: ['account_id', 'impersonated_user_id'],
        });

        await tx.unsafe(readMigrationSql(MIGRATION_FILE));
        const after = await readPublicCatalogue(tx);

        // A migration may harden the tables it names while doing arbitrary
        // damage elsewhere (migration 119's off-target `GRANT ALL ON
        // admin_audit_log TO anon;` red-team round). THREE tables move here,
        // not one — every table outside them must come out byte-identical.
        assertOnlyTablesMoved(before, after, [...TABLES]);
      });
    });
  },
);
