// Shape guard for migration 048 — `impersonation_sessions`, the admin-owned,
// time-boxed view-as session table (#1301). The suite this replaces proved
// the migration by pattern-matching its SQL TEXT, and that approach lost five
// red-team passes on #1171 against a sibling table's suite: a newline inside
// `CREATE\nPOLICY`, a block comment inside `DISABLE/**/ROW LEVEL SECURITY`,
// `--` inside a string literal, and a comment standing in as evidence. This
// suite stops parsing the checked-in file and EXECUTES it, on the shared
// `migration-guard.ts` helper (see that file's JSDoc for the contract). It is
// listed in `MIGRATION_SHAPE_FILES` (`scripts/ci/live-db-suites-audit.ts`),
// the sanctioned exemption from `ci:live-db-suites` R2 for suites where
// APPLYING the migration IS the subject.
//
// ── two oracles, both required ──────────────────────────────────────────────
//
// Oracle B — degrade `impersonation_sessions` to a pre-048 posture (its four
// indexes dropped, row security off) inside a rolled-back transaction, prove
// the degrade landed, re-apply the checked-in file VERBATIM, and diff the
// whole `public` catalogue against the before-read. This alone is circular:
// `pnpm test:db:setup` provisions the test database FROM the migration under
// test, so a weakened migration produces an already-weakened `before`, and
// `after === before` passes even though both sides are wrong.
//
// Oracle A — literals pinned IN THIS FILE, independent of the migration file,
// taken from `.feature/oracle-a-literals.txt` (machine-generated exact
// catalogue renderings, captured on a known-good container). These break the
// circle: a weakened migration still fails a DIRECT comparison against a
// hardcoded string, whatever `before` happens to read. Guarded here: all four
// `pg_get_indexdef` strings — including the partial predicate
// `WHERE (ended_at IS NULL)` on `idx_impersonation_active_actor`, the index
// that enforces "one active impersonation session per actor" at the
// database — the three `pg_get_constraintdef` foreign-key strings, the
// primary key, the `id` column's `gen_random_uuid()` default, and the whole
// column inventory with its nullability set.
//
// ── stated limit ─────────────────────────────────────────────────────────────
//
// The `CREATE TABLE` body itself — columns, types, the three FKs as a set —
// is NOT guarded by oracle B: `CREATE TABLE IF NOT EXISTS` is a no-op when the
// table already exists, so re-applying 048 at head never re-executes it and a
// degrade/reapply diff can prove nothing about it. (Migration 057 later drops
// `NOT NULL` on `account_id` and `impersonated_user_id`, so this suite must
// never drop and recreate the table either — a fresh `CREATE TABLE` would
// carry the ORIGINAL `NOT NULL` and the diff would fail for a reason that is
// not a regression.) Oracle A is what guards the table body: the column
// inventory, the non-null set, the primary key, the `id` default and the three
// FK definitions are pinned literals, read directly off the catalogue at head,
// independent of any degrade. The inventory case is the named successor to the
// deleted text guard's column assertions — `weakened-checks-reasons.md` records
// that mapping.
//
// ── the shared last title ───────────────────────────────────────────────────
//
// "head posture pins migration 048 defaults and foreign keys and migration
// 051 columns and foreign keys" is ONE title shared with the migration 051
// (`flagged_responses`) guard suite. THIS suite owns only the 048 half — the
// `id` default and the three `impersonation_sessions` foreign keys. The 051
// half (columns and foreign keys for `flagged_responses`) lives in
// `migration-051-flagged-responses.integration.test.ts`; nothing about
// `flagged_responses` is asserted here.
//
// No `assertSchemaReady` precondition: this suite proves the container is at
// head itself, through the oracle A/B assertions below — a behind-head
// container fails loudly with a message naming `pnpm test:db:setup`, the same
// idiom `migration-119-job-outbox-rls.integration.test.ts` uses.

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
} from './helpers/migration-guard';
import { auditLiveDbFile } from '../../../../scripts/ci/live-db-suites-audit';

const TABLE = 'impersonation_sessions';
const MIGRATION_FILE = '048_impersonation_sessions.sql';
const SUITE_FILE =
  'src/lib/shared/__tests__/migration-048-impersonation-sessions.integration.test.ts';
const BEHIND_HEAD =
  'impersonation_sessions posture is not at migration head — run pnpm test:db:setup';
/** For a mismatch AFTER the re-apply: the container is fine, the file is not. */
const WEAKENED_MIGRATION =
  `re-applying ${MIGRATION_FILE} did not restore this object — the container is at head, so ` +
  'the checked-in migration is what changed';

// ── Oracle A: pinned literals, from .feature/oracle-a-literals.txt ─────────

/** The four indexes 048 creates, keyed by name. Never the pkey index — that
 * one comes from the PRIMARY KEY constraint, not from one of 048's own
 * `CREATE INDEX` statements, and is outside what this suite degrades. */
const GUARDED_INDEX_DEFINITIONS: Readonly<Record<string, string>> = {
  idx_impersonation_actor_started:
    'CREATE INDEX idx_impersonation_actor_started ON public.impersonation_sessions USING btree (actor_user_id, started_at DESC)',
  idx_impersonation_impersonated_started:
    'CREATE INDEX idx_impersonation_impersonated_started ON public.impersonation_sessions USING btree (impersonated_user_id, started_at DESC)',
  idx_impersonation_account_started:
    'CREATE INDEX idx_impersonation_account_started ON public.impersonation_sessions USING btree (account_id, started_at DESC)',
  // The partial predicate is the one thing pattern-matching kept losing to
  // red-team passes on #1171's sibling suite. Pinned verbatim.
  idx_impersonation_active_actor:
    'CREATE UNIQUE INDEX idx_impersonation_active_actor ON public.impersonation_sessions USING btree (actor_user_id) WHERE (ended_at IS NULL)',
};
/**
 * The same four names as a literal tuple, so the selector list is non-empty BY
 * TYPE. It was `Object.keys(GUARDED_INDEX_DEFINITIONS)`, whose type is
 * `string[]`, which forced a runtime `nonEmptyNames` narrowing six lines below
 * the literal it was derived from — a runtime check for something the compiler
 * could see (#1301 S-7). `satisfies` keeps the two in step: drop a name here
 * and the definitions map no longer covers it.
 */
const GUARDED_INDEXES = [
  'idx_impersonation_actor_started',
  'idx_impersonation_impersonated_started',
  'idx_impersonation_account_started',
  'idx_impersonation_active_actor',
] as const satisfies readonly (keyof typeof GUARDED_INDEX_DEFINITIONS)[];

const GUARDED_FOREIGN_KEYS: Readonly<Record<string, string>> = {
  impersonation_sessions_account_id_fkey: 'FOREIGN KEY (account_id) REFERENCES accounts(id)',
  impersonation_sessions_actor_user_id_fkey:
    'FOREIGN KEY (actor_user_id) REFERENCES users(id)',
  impersonation_sessions_impersonated_user_id_fkey:
    'FOREIGN KEY (impersonated_user_id) REFERENCES users(id)',
};

const ID_DEFAULT = 'gen_random_uuid()';

/**
 * The head-posture column inventory, rendered exactly as `readPublicCatalogue`
 * renders `columns`. The deleted text guard asserted `id UUID PRIMARY KEY`,
 * `ticket_id TEXT NOT NULL`, `reason TEXT NOT NULL` and
 * `expires_at TIMESTAMPTZ NOT NULL` against the migration FILE. Oracle B
 * cannot carry those: `CREATE TABLE IF NOT EXISTS` is a no-op at head, so the
 * degrade/reapply diff never re-executes the table body (the stated limit
 * above). Pinning the inventory here is what replaces them.
 *
 * These are HEAD literals, not 048's original text. Migration 057 dropped
 * `NOT NULL` from `account_id` and `impersonated_user_id`, so both render
 * `NULL` — which is precisely why a regex over 048's file could never have
 * guarded the live table.
 */
const GUARDED_COLUMNS: Readonly<Record<string, string>> = {
  account_id: 'uuid NULL identity=none generated=none',
  actor_user_id: 'uuid NOT NULL identity=none generated=none',
  created_at: 'timestamp with time zone NOT NULL identity=none generated=none',
  ended_at: 'timestamp with time zone NULL identity=none generated=none',
  expires_at: 'timestamp with time zone NOT NULL identity=none generated=none',
  id: 'uuid NOT NULL identity=none generated=none',
  impersonated_user_id: 'uuid NULL identity=none generated=none',
  reason: 'text NOT NULL identity=none generated=none',
  started_at: 'timestamp with time zone NOT NULL identity=none generated=none',
  ticket_id: 'text NOT NULL identity=none generated=none',
};

/**
 * `notNullColumns` as a SET, asserted exhaustively. A per-column check would
 * pass while an eleventh column arrived NOT NULL; the whole-list comparison
 * fails on any addition, removal or nullability flip.
 */
const GUARDED_NOT_NULL_COLUMNS: readonly string[] = [
  'actor_user_id',
  'created_at',
  'expires_at',
  'id',
  'reason',
  'started_at',
  'ticket_id',
];

/** The other half of the deleted `id UUID PRIMARY KEY` assertion. */
const PRIMARY_KEY_NAME = 'impersonation_sessions_pkey';
const PRIMARY_KEY_DEFINITION = 'PRIMARY KEY (id)';

// The degrade: the four guarded indexes, plus the one thing 048 turns on.
// Never DROP TABLE — see the header's stated-limit note.
const DEGRADE = `
  DROP INDEX idx_impersonation_actor_started;
  DROP INDEX idx_impersonation_impersonated_started;
  DROP INDEX idx_impersonation_account_started;
  DROP INDEX idx_impersonation_active_actor;
  ALTER TABLE impersonation_sessions DISABLE ROW LEVEL SECURITY;
`;

const TABLE_COMMENT =
  'Admin-owned, time-boxed view-as sessions. Application code should pass UUIDv7 ids.';

const testDatabaseUrl = resolveTestDatabaseUrl();

let db: postgresType.Sql | undefined;
let featureDatabaseLock: LiveDbLock | undefined;

function sql(): postgresType.Sql {
  if (!db) throw new Error('migration 048 integration database was not initialized');
  return db;
}

/**
 * Degrades `impersonation_sessions`, proves the degrade landed (both the
 * indexes and row security — DEGRADE always does both, so both are proven
 * regardless of which one the caller's assertion focuses on), re-applies 048
 * verbatim, then hands `before`/`after` to the caller. Always inside a rolled
 * back transaction — nothing here outlives the case.
 */
async function degradeAndApply(
  assertion: (before: PublicCatalogue, after: PublicCatalogue) => void,
): Promise<void> {
  await withRolledBackTransaction(sql(), async (tx) => {
    const before = await readPublicCatalogue(tx);
    await tx.unsafe(DEGRADE);
    const degraded = await readPublicCatalogue(tx);

    assertDegradeLanded(before, degraded, {
      table: TABLE,
      property: 'indexes',
      // A literal tuple, so it satisfies the selector's non-empty type
      // directly — no runtime narrowing. `nonEmptyNames` still exists for the
      // 117 suite, whose list is a live `acldefault` read and is therefore
      // genuinely only knowable at run time.
      absent: GUARDED_INDEXES,
    });
    // `rowSecurity` is a BOOLEAN property with no named objects, so it has its
    // own selector-free variant — the value flip IS the proof.
    assertDegradeLanded(before, degraded, { table: TABLE, property: 'rowSecurity' });

    await tx.unsafe(readMigrationSql(MIGRATION_FILE));
    const after = await readPublicCatalogue(tx);
    assertion(before, after);
  });
}

// ── registry: no database needed, so this case can never silently skip ─────

describe('migration 048 registry', () => {
  it('migration 048 suite is registered in MIGRATION_SHAPE_FILES', () => {
    // MIGRATION_SHAPE_FILES itself is a module-private `const` in
    // scripts/ci/live-db-suites-audit.ts — not exported, and that file is
    // outside this lease, so membership cannot be read directly. Asserting
    // through the audit's exported entry point, `auditLiveDbFile`, instead
    // proves the EFFECT rather than reading the Set: running it against this
    // suite's own real source text returns zero findings only because this
    // exact path is an allowlist member AND the file names the shared lock
    // marker (`acquireLiveDbLock`, imported above). Drop the entry, typo the
    // path, or rename the lock call away, and this reports a `runtime-ddl` or
    // `unlocked-ddl` finding — a strictly stronger check than a membership
    // read, because it also catches a lock-lifecycle regression.
    const ownSourceText = readFileSync(join(process.cwd(), SUITE_FILE), 'utf8');
    expect(auditLiveDbFile(SUITE_FILE, ownSourceText)).toEqual([]);
  });
});

describeWithDb(
  'migration 048 impersonation_sessions guarded indexes and row security',
  { enabled: Boolean(testDatabaseUrl), timeout: 180_000 },
  () => {
    beforeAll(async () => {
      const databaseUrl = assertLocalTestDatabaseUrl(testDatabaseUrl);
      featureDatabaseLock = await acquireLiveDbLock(databaseUrl);
      db = postgres(databaseUrl, {
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

    it('impersonation_sessions carries row security enabled at head', async () => {
      await withRolledBackTransaction(sql(), async (tx) => {
        const catalogue = await readPublicCatalogue(tx);
        const table = catalogue.tables[TABLE];
        expect(table?.rowSecurity, BEHIND_HEAD).toBe(true);
        expect(table?.forceRowSecurity, BEHIND_HEAD).toBe(false);
        expect(table?.policies, BEHIND_HEAD).toEqual([]);
      });
    });

    it('re-applying 048 restores the guarded indexes after they are dropped', async () => {
      await degradeAndApply((before, after) => {
        const table = after.tables[TABLE];
        if (!table) {
          throw new Error(`readPublicCatalogue did not return ${TABLE} after reapply`);
        }

        // Oracle A — direct comparison against the pinned literals, not
        // against `before`. This is what a weakened migration cannot survive
        // even on a container that was itself provisioned from that same
        // weakened file (see header).
        //
        // NOT `BEHIND_HEAD`. The re-apply has already happened here, so a
        // mismatch means the MIGRATION did not restore the index — telling the
        // reader to run `pnpm test:db:setup` sends them to re-provision a
        // container that is already at head, while the real fault is in the
        // file (#1301 RT-11). The two messages are kept apart on purpose:
        // `BEHIND_HEAD` belongs to the head-posture cases, which read the
        // container and nothing else.
        for (const [name, definition] of Object.entries(GUARDED_INDEX_DEFINITIONS)) {
          expect(
            table.indexes.find((entry) => entry.name === name)?.definition,
            WEAKENED_MIGRATION,
          ).toBe(definition);
        }

        // Oracle B — the whole table restored to exactly what it was before
        // the degrade: indexes, row security and every other dimension
        // `readPublicCatalogue` renders, in one comparison.
        expect(after.tables[TABLE]).toEqual(before.tables[TABLE]);
      });
    });

    it('re-applying 048 moves no other table in public', async () => {
      await degradeAndApply((before, after) => {
        assertOnlyTablesMoved(before, after, [TABLE]);
      });
    });

    it('head posture pins migration 048 defaults and foreign keys and migration 051 columns and foreign keys', async () => {
      // THIS suite's half only — see the header's "shared last title" note.
      // flagged_responses is asserted nowhere in this file.
      await withRolledBackTransaction(sql(), async (tx) => {
        const catalogue = await readPublicCatalogue(tx);
        const table = catalogue.tables[TABLE];
        if (!table) {
          throw new Error(`readPublicCatalogue did not return ${TABLE} — ${BEHIND_HEAD}`);
        }

        expect(
          table.columnDefaults.find((entry) => entry.name === 'id')?.definition,
          BEHIND_HEAD,
        ).toBe(ID_DEFAULT);

        for (const [name, definition] of Object.entries(GUARDED_FOREIGN_KEYS)) {
          expect(
            table.constraints.find((entry) => entry.name === name)?.definition,
            BEHIND_HEAD,
          ).toBe(definition);
        }
      });
    });

    it('head posture pins the impersonation_sessions column inventory, primary key and table comment', async () => {
      // Oracle A for the table BODY. The stated limit above explains why
      // oracle B cannot reach it, and `weakened-checks-reasons.md` records
      // this case as the successor to the deleted text guard's column
      // assertions. Exhaustive on purpose: an ADDED column is a schema change
      // 048's suite should report, not tolerate.
      await withRolledBackTransaction(sql(), async (tx) => {
        const catalogue = await readPublicCatalogue(tx);
        const table = catalogue.tables[TABLE];
        if (!table) {
          throw new Error(`readPublicCatalogue did not return ${TABLE} — ${BEHIND_HEAD}`);
        }

        expect(
          Object.fromEntries(table.columns.map((entry) => [entry.name, entry.definition])),
          BEHIND_HEAD,
        ).toEqual(GUARDED_COLUMNS);

        expect([...table.notNullColumns], BEHIND_HEAD).toEqual(GUARDED_NOT_NULL_COLUMNS);

        expect(
          table.constraints.find((entry) => entry.name === PRIMARY_KEY_NAME)?.definition,
          BEHIND_HEAD,
        ).toBe(PRIMARY_KEY_DEFINITION);

        // #1301 RT-12. No suite in this family pinned its table comment, and
        // deleting 117's `COMMENT ON TABLE` survived 13 of 13 red-team runs.
        // Oracle B cannot carry it either: the comment is re-applied by the
        // migration, so a weakened file yields a weakened `before` and
        // `after === before` still passes. Only a literal pinned HERE breaks
        // that circle. Migration 118 already pinned its own, with a written
        // rationale; this is the missed sibling case.
        expect(table.comment, BEHIND_HEAD).toBe(TABLE_COMMENT);
      });
    });
  },
);
