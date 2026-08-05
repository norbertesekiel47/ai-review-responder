import { afterAll, beforeAll, expect, it } from 'vitest';
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

// Shape suite for migration 100 — the Consented Review Import state on
// `businesses` plus the ADD half of the backfill-counter collapse on
// `zernio_backfill_runs` (#673, epic #667; ADR 0015 + spec
// docs/superpowers/specs/2026-08-05-consented-review-import-design.md §4,
// §8a R3/R4). Written red by T1 (the eval task) and turned green by T2, once
// 100 exists and `pnpm test:db:setup` has provisioned it.
//
// The subject is three contracts:
//
//  1. `import_decision` — the import offer's state — is NOT NULL DEFAULT
//     'pending' under the named four-value CHECK, with the DEFAULT exact
//     (#668 / §8a R3): no backfill clause, no backdating — writing 'accepted'
//     for rows that never answered records a consent that was never given.
//
//  2. The two timestamps are nullable timestamptz with deliberately NO
//     cross-column constraint tying them to the decision — the #677 decision
//     API and #679 expiry sweep own those semantics (locked decision 2).
//
//  3. The collapse ships its ADD half only: `imported_count`/`skipped_count`
//     are NOT NULL DEFAULT 0 while the four legacy gap_*/historical_*
//     counters remain PRESENT — their DROP is #680 (§8a R4), so `git revert`
//     of any epic PR never leaves the worker writing to a dropped column.
//
// No migration SQL is applied here (#573): `pnpm test:db:setup` provisions to
// head and this suite ASSERTS with assertSchemaReady, then introspects shape.
// Every behavioural write either runs inside a transaction that is always
// rolled back or is a single statement expected to be rejected, so the
// fixture rows never change.

const testDatabaseUrl = resolveTestDatabaseUrl();

const ENUM_VALUES = ['pending', 'accepted', 'declined', 'expired'] as const;
const INVALID_VALUES = ['', 'PENDING', 'yes', 'dismissed'] as const;
const migrationPath = resolve(
  process.cwd(),
  'supabase/migrations/100_import_consent_and_backfill_counters.sql',
);
// Executable SQL only — header comments DISCUSS the operations this migration
// must not contain, so absence assertions must not read them (099 precedent).
const rawSql = existsSync(migrationPath) ? readFileSync(migrationPath, 'utf-8') : '';
const executableSql = rawSql
  .split('\n')
  .filter((line) => !line.trimStart().startsWith('--'))
  .join('\n');

let db: postgresType.Sql | undefined;
let featureDatabaseLock: LiveDbLock | undefined;
let accountId: string | undefined;
let userId: string | undefined;
const businessId = randomUUID();

/**
 * Accessor for the suite's client — assigned in `beforeAll`, so probes reach
 * it through a call rather than capturing the still-undefined binding.
 */
function sql(): postgresType.Sql {
  return db!;
}

describeWithDb(
  'migration 100 import consent',
  { enabled: Boolean(testDatabaseUrl), timeout: 120_000 },
  () => {
    beforeAll(async () => {
      const databaseUrl = assertLocalTestDatabaseUrl(testDatabaseUrl);
      featureDatabaseLock = await acquireLiveDbLock(databaseUrl);
      db = postgres(databaseUrl, { max: 1, prepare: false });
      await assertSchemaReady(db, [MIGRATION_100_IMPORT_CONSENT]);
      const seed = await seedTenantAccount(db, {
        userName: 'Import Consent Shape Owner',
        accountDisplayName: 'Import Consent Shape Fixture',
      });
      accountId = seed.accountId;
      userId = seed.userId;
      // The fixture row deliberately does NOT name import_decision — the
      // DEFAULT is the subject of the first test's behavioural probe.
      await db`
        INSERT INTO businesses (
          id, name, owner_name, owner_email, account_id, subscription_status, category
        ) VALUES (
          ${businessId}::uuid, 'Import Consent Shape Business',
          'Shape Owner', ${seed.ownerEmail}, ${seed.accountId}::uuid,
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
        try {
          if (db) await db.end({ timeout: 5 });
        } finally {
          await featureDatabaseLock?.release();
          featureDatabaseLock = undefined;
        }
      }
    }, LIVE_DB_LOCK_HOOK_TIMEOUT_MS);

    it("businesses.import_decision defaults to 'pending' and rejects values outside the four-state enum", async () => {
      // Catalog-level pin — the DEFAULT and type live in the catalog, not in a
      // fixture's luck: a trigger or seeded value could also read back 'pending'.
      const [decisionCol] = await sql()<
        { data_type: string; is_nullable: string; column_default: string | null }[]
      >`
        SELECT data_type, is_nullable, column_default
        FROM information_schema.columns
        WHERE table_schema = 'public' AND table_name = 'businesses'
          AND column_name = 'import_decision'
      `;
      expect(decisionCol?.data_type).toBe('text');
      expect(decisionCol?.is_nullable).toBe('NO');
      expect(decisionCol?.column_default).toBe("'pending'::text");

      // The predicate itself, not just the constraint's existence: a broader
      // CHECK (e.g. `IN (…) OR length(x) = 1`) admits unseen values while
      // containing all four literals and passing every sampled probe below. Pin
      // the pg-normalized rendering: `= ANY (ARRAY[exactly these four])`, in
      // order, with no other branch.
      const [check] = await sql()<{ def: string }[]>`
        SELECT pg_get_constraintdef(oid) AS def
        FROM pg_constraint
        WHERE conrelid = 'public.businesses'::regclass
          AND conname = 'businesses_import_decision_check'
      `;
      const def = check?.def.replace(/\s+/g, ' ');
      // FULL-definition equality — start-anchored prefixes admit a pathological
      // trailing branch (round-3 finding 4). PG16-pinned rendering: if this
      // equality ever fails on parenthesization/cast variance, print the actual
      // def, eyeball that it is the four-value ANY with no extra branch, and pin
      // THAT literal — the contract is whole-definition equality, not this guess.
      expect(def).toBe(
        "CHECK ((import_decision = ANY (ARRAY['pending'::text, 'accepted'::text, 'declined'::text, 'expired'::text])))",
      );

      // Behavioural probes (all rolled back): fixture row took the default…
      const [row] = await sql()<
        {
          import_decision: string;
          import_decision_at: Date | null;
          import_offer_expires_at: Date | null;
        }[]
      >`
        SELECT import_decision, import_decision_at, import_offer_expires_at
        FROM businesses WHERE id = ${businessId}
      `;
      expect(row?.import_decision).toBe('pending');
      expect(row?.import_decision_at).toBeNull();
      expect(row?.import_offer_expires_at).toBeNull();
      // …every legal value UPDATEs fine…
      for (const value of ENUM_VALUES) {
        await sql().begin(async (tx) => {
          await tx`UPDATE businesses SET import_decision = ${value} WHERE id = ${businessId}`;
          throw new Error('rollback');
        }).catch((err) => { if (err.message !== 'rollback') throw err; });
      }
      // …every illegal value hits the CHECK (23514), and NULL hits NOT NULL
      // (23502) — the CHECK-passes-NULL trap from the new-migration checklist.
      for (const value of INVALID_VALUES) {
        await expect(
          sql()`UPDATE businesses SET import_decision = ${value} WHERE id = ${businessId}`,
        ).rejects.toMatchObject({ code: '23514' });
      }
      await expect(
        sql()`UPDATE businesses SET import_decision = NULL WHERE id = ${businessId}`,
      ).rejects.toMatchObject({ code: '23502' });
    });

    it('import_decision_at and import_offer_expires_at are nullable timestamptz with no cross-column constraint', async () => {
      const cols = await sql()<{ column_name: string; data_type: string; is_nullable: string }[]>`
        SELECT column_name, data_type, is_nullable
        FROM information_schema.columns
        WHERE table_schema = 'public' AND table_name = 'businesses'
          AND column_name IN ('import_decision_at', 'import_offer_expires_at')
        ORDER BY column_name
      `;
      expect(cols).toHaveLength(2);
      for (const col of cols) {
        expect(col.data_type).toBe('timestamp with time zone');
        expect(col.is_nullable).toBe('YES');
      }
      // Absence proof by introspection, not by one lucky accepted combination:
      // NO CHECK on businesses references either timestamp column. #677/#679 own
      // any tightening (owner decision 2026-08-05).
      const coupled = await sql()<{ conname: string; def: string }[]>`
        SELECT conname, pg_get_constraintdef(oid) AS def
        FROM pg_constraint
        WHERE conrelid = 'public.businesses'::regclass AND contype = 'c'
          AND (pg_get_constraintdef(oid) LIKE '%import_decision_at%'
            OR pg_get_constraintdef(oid) LIKE '%import_offer_expires_at%')
      `;
      expect(coupled).toHaveLength(0);
      // Behavioural corroboration (rolled back): non-pending decision with both
      // timestamps NULL is accepted.
      await sql().begin(async (tx) => {
        await tx`
          UPDATE businesses
          SET import_decision = 'expired', import_decision_at = NULL, import_offer_expires_at = NULL
          WHERE id = ${businessId}
        `;
        throw new Error('rollback');
      }).catch((err) => { if (err.message !== 'rollback') throw err; });
    });

    it('zernio_backfill_runs.imported_count and skipped_count are NOT NULL DEFAULT 0 alongside the four legacy counters', async () => {
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
          AND column_name IN (
            'imported_count', 'skipped_count',
            'gap_processed_count', 'historical_processed_count',
            'gap_skipped_count', 'historical_skipped_count',
            'oldest_skipped_create_time'
          )
      `;
      // 2 new + 4 legacy + the untouched oldest_skipped_create_time = 7. The
      // legacy four being PRESENT is the §8a R4 assertion — their DROP is #680.
      expect(cols).toHaveLength(7);
      for (const name of ['imported_count', 'skipped_count']) {
        const col = cols.find((c) => c.column_name === name);
        expect(col?.data_type).toBe('integer');
        expect(col?.is_nullable).toBe('NO');
        expect(col?.column_default).toBe('0');
      }
      // Behavioural default probe (rolled back): INSERT without naming the new
      // counters → both read back 0.
      await sql().begin(async (tx) => {
        const [inserted] = await tx<{ imported_count: number; skipped_count: number }[]>`
          INSERT INTO zernio_backfill_runs (
            id, business_id, zernio_account_id, zernio_location_id,
            subscription_tier, subscription_activated_at, run_reason
          ) VALUES (
            ${randomUUID()}, ${businessId}, 'za-shape', 'zl-shape',
            'copilot', NOW(), 'initial'
          )
          RETURNING imported_count, skipped_count
        `;
        expect(inserted?.imported_count).toBe(0);
        expect(inserted?.skipped_count).toBe(0);
        throw new Error('rollback');
      }).catch((err) => { if (err.message !== 'rollback') throw err; });
    });
  },
);

// Deliberately OUTSIDE the DB gate: this test only READS the migration file as
// text — it never touches the database, so it must run (and fail red while the
// file is absent) even when the DB is unreachable or behind head, exactly the
// state Task 1 commits.
it('migration 100 executable SQL is additive-only — no data rewrite, no DROP COLUMN, no ALTER COLUMN, no CREATE INDEX', () => {
  // Shape introspection cannot see what the file DID on the way to the final
  // shape (a backdating UPDATE, TRUNCATE, drop-and-recreate, a trigger, a
  // stray index). Deny-listing verbs is leaky, so this is an ALLOWLIST over
  // every executable statement: anything not in the exact permitted set —
  // lock_timeout, additive ADD COLUMN on the two named tables, the named
  // CHECK's idempotent drop/add pair, COMMENT ON COLUMN — fails with the
  // offending statement in the message. Splitting on ';' is safe because the
  // migration's COMMENT literals deliberately contain no semicolons (a Task 2
  // authoring constraint, noted in the migration header).
  expect(executableSql.length).toBeGreaterThan(0);
  const statements = executableSql
    .split(';')
    .map((s) => s.replace(/\s+/g, ' ').trim())
    .filter(Boolean);
  expect(statements.length).toBeGreaterThanOrEqual(5);

  // Exact table→column pinning (round-3 finding 2): a stray column, a
  // counter on the wrong table, or a foreign lock_timeout all fail.
  const BUSINESSES_ADDS = [
    "ADD COLUMN IF NOT EXISTS import_decision TEXT NOT NULL DEFAULT 'pending'",
    'ADD COLUMN IF NOT EXISTS import_decision_at TIMESTAMPTZ',
    'ADD COLUMN IF NOT EXISTS import_offer_expires_at TIMESTAMPTZ',
  ];
  const RUNS_ADDS = [
    'ADD COLUMN IF NOT EXISTS imported_count INTEGER NOT NULL DEFAULT 0',
    'ADD COLUMN IF NOT EXISTS skipped_count INTEGER NOT NULL DEFAULT 0',
  ];
  const COMMENTABLE =
    /^COMMENT ON COLUMN (businesses\.(import_decision|import_decision_at|import_offer_expires_at)|zernio_backfill_runs\.(imported_count|skipped_count)) IS '/;
  const isAllowed = (stmt: string): boolean => {
    if (stmt === "SET lock_timeout = '5s'") return true;
    if (COMMENTABLE.test(stmt)) return true;
    const alter = stmt.match(/^ALTER TABLE (businesses|zernio_backfill_runs) (.+)$/);
    if (!alter) return false;
    const allowedAdds = alter[1] === 'businesses' ? BUSINESSES_ADDS : RUNS_ADDS;
    const actions = (alter[2] ?? '')
      .split(/,(?= ?(?:ADD COLUMN|DROP CONSTRAINT|ADD CONSTRAINT))/)
      .map((a) => a.trim());
    return actions.every(
      (action) =>
        allowedAdds.includes(action) ||
        (alter[1] === 'businesses' &&
          (action === 'DROP CONSTRAINT IF EXISTS businesses_import_decision_check' ||
            action ===
              "ADD CONSTRAINT businesses_import_decision_check CHECK (import_decision IN ('pending', 'accepted', 'declined', 'expired'))")),
    );
  };
  for (const stmt of statements) {
    expect(isAllowed(stmt), `statement outside the additive-only allowlist: ${stmt}`).toBe(true);
  }
});
