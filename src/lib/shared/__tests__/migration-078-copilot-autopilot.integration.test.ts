import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import postgres from 'postgres';
import type postgresType from 'postgres';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { describeWithDb } from '@/__tests__/helpers/describe-with-db';

// Migration 078 is the contract step after 077 and the strict-code smoke. This
// suite keeps every fixture and schema mutation inside one rollback-only
// transaction. It can therefore emulate the exact 077 boundary even when the
// local database has already applied every checked-in migration.

const testDatabaseUrl = process.env.TEST_DATABASE_POOL_URL;
const migration077Path = resolve(
  process.cwd(),
  'supabase/migrations/077_copilot_autopilot_expand.sql',
);
const migration078Path = resolve(
  process.cwd(),
  'supabase/migrations/078_copilot_autopilot_contract.sql',
);

let db: postgresType.Sql | undefined;
let transactionOpen = false;

const fixturePrefix = `ws8-078-${randomUUID()}`;
const fixtures = {
  copilot: {
    userId: randomUUID(),
    accountId: randomUUID(),
    businessId: randomUUID(),
  },
  autopilot: {
    userId: randomUUID(),
    accountId: randomUUID(),
    businessId: randomUUID(),
  },
};

const legacyTierValues = ['basic', 'standard', 'premium', 'founders', 'founding'] as const;

function readMigration077Sql(): string {
  return readFileSync(migration077Path, 'utf-8');
}

function readMigration078Sql(): string {
  return readFileSync(migration078Path, 'utf-8');
}

function normalizeSql(value: string): string {
  return value.replace(/\s+/g, ' ').trim();
}

function stripSqlLineComments(value: string): string {
  return value.replace(/--.*$/gm, '');
}

function assertLocalMigrationDatabaseUrl(databaseUrl: string): string {
  let parsed: URL;
  try {
    parsed = new URL(databaseUrl);
  } catch {
    throw new Error('migration 078 tests require a local (localhost) test database');
  }

  const isLocalPostgres =
    (parsed.protocol === 'postgres:' || parsed.protocol === 'postgresql:') &&
    (parsed.hostname === 'localhost' || parsed.hostname === '127.0.0.1');

  if (!isLocalPostgres) {
    throw new Error('migration 078 tests require a local (localhost) test database');
  }
  return databaseUrl;
}

function afterLocalMigrationDatabaseGuard<T>(
  databaseUrl: string,
  connect: (safeDatabaseUrl: string) => T,
): T {
  return connect(assertLocalMigrationDatabaseUrl(databaseUrl));
}

function sql(): postgresType.Sql {
  if (!db) throw new Error('migration 078 integration database was not initialized');
  return db;
}

async function captureExpectedDatabaseError(operation: () => Promise<unknown>): Promise<Error> {
  await sql().unsafe('SAVEPOINT ws8_078_expected_error');
  try {
    await operation();
  } catch (error) {
    await sql().unsafe('ROLLBACK TO SAVEPOINT ws8_078_expected_error');
    await sql().unsafe('RELEASE SAVEPOINT ws8_078_expected_error');
    return error instanceof Error ? error : new Error(String(error));
  }

  await sql().unsafe('ROLLBACK TO SAVEPOINT ws8_078_expected_error');
  await sql().unsafe('RELEASE SAVEPOINT ws8_078_expected_error');
  throw new Error('expected database operation to fail');
}

async function insertFixture(
  key: keyof typeof fixtures,
  tier: 'copilot' | 'autopilot',
): Promise<void> {
  const fixture = fixtures[key];
  await sql()`
    INSERT INTO users (id, name, email, role)
    VALUES (
      ${fixture.userId}::uuid,
      ${`WS8 078 ${key} owner`},
      ${`${fixturePrefix}-${key}@test.local`},
      'owner'
    )
  `;
  await sql()`
    INSERT INTO accounts (
      id, owner_user_id, display_name, subscription_tier, subscription_status,
      price_variant, base_price_cents, locations_overage_price_cents,
      locations_included, locations_paid
    )
    VALUES (
      ${fixture.accountId}::uuid,
      ${fixture.userId}::uuid,
      ${`${fixturePrefix}:${key}`},
      ${tier},
      'active',
      ${tier === 'copilot' ? 'list' : 'founding'},
      ${tier === 'copilot' ? 2_900 : 4_900},
      ${tier === 'copilot' ? 1_500 : 2_000},
      1,
      0
    )
  `;
  await sql()`
    UPDATE users SET account_id = ${fixture.accountId}::uuid
    WHERE id = ${fixture.userId}::uuid
  `;
  await sql()`
    INSERT INTO businesses (
      id, name, owner_name, owner_email, account_id, subscription_tier,
      subscription_status
    )
    VALUES (
      ${fixture.businessId}::uuid,
      ${`${fixturePrefix}:${key}-business`},
      ${`WS8 078 ${key} owner`},
      ${`${fixturePrefix}-${key}-business@test.local`},
      ${fixture.accountId}::uuid,
      ${tier},
      'active'
    )
  `;
}

async function assertContractObjectsAbsent(): Promise<void> {
  const [shape] = await sql()<
    {
      account_nullable: 'YES' | 'NO';
      business_nullable: 'YES' | 'NO';
      tier_constraint_count: string;
    }[]
  >`
    SELECT
      (SELECT is_nullable FROM information_schema.columns
        WHERE table_schema = 'public' AND table_name = 'accounts'
          AND column_name = 'subscription_tier') AS account_nullable,
      (SELECT is_nullable FROM information_schema.columns
        WHERE table_schema = 'public' AND table_name = 'businesses'
          AND column_name = 'subscription_tier') AS business_nullable,
      (SELECT count(*)::text FROM pg_constraint
        WHERE (conrelid = 'public.accounts'::regclass
            AND conname = 'accounts_subscription_tier_check')
          OR (conrelid = 'public.businesses'::regclass
            AND conname = 'businesses_subscription_tier_check')) AS tier_constraint_count
  `;

  expect(shape).toEqual({
    account_nullable: 'NO',
    business_nullable: 'YES',
    tier_constraint_count: '0',
  });
}

async function tierConstraintCatalog(): Promise<
  { table_name: string; constraint_name: string; constraint_def: string }[]
> {
  return sql()<{ table_name: string; constraint_name: string; constraint_def: string }[]>`
    SELECT
      conrelid::regclass::text AS table_name,
      conname AS constraint_name,
      pg_get_constraintdef(oid) AS constraint_def
    FROM pg_constraint
    WHERE conname IN (
      'accounts_subscription_tier_check',
      'businesses_subscription_tier_check'
    )
    ORDER BY table_name, constraint_name
  `;
}

async function accountAndBusinessBytes(): Promise<{ table_name: string; id: string; bytes: string }[]> {
  return sql()<{ table_name: string; id: string; bytes: string }[]>`
    SELECT 'accounts' AS table_name, id::text, row_to_json(accounts)::text AS bytes
    FROM accounts
    WHERE display_name LIKE ${`${fixturePrefix}:%`}
    UNION ALL
    SELECT 'businesses' AS table_name, id::text, row_to_json(businesses)::text AS bytes
    FROM businesses
    WHERE name LIKE ${`${fixturePrefix}:%`}
    ORDER BY table_name, id
  `;
}

describe('migration 078 checked-in SQL safety', () => {
  it('accepts only local Postgres test databases', () => {
    for (const localUrl of [
      'postgresql://test:test@localhost:5499/test_ws4',
      'postgres://test:test@127.0.0.1:5432/test',
      'postgresql://test:test@localhost:5499/test_ws4?sslmode=disable',
    ]) {
      expect(assertLocalMigrationDatabaseUrl(localUrl)).toBe(localUrl);
    }

    for (const unsafeUrl of [
      'postgresql://test:test@db.example.supabase.co:5432/postgres',
      'postgresql://test:test@aws-0-us-west-1.pooler.supabase.com:6543/postgres',
      'postgresql://test:test@db.internal:5499/test_ws4',
      'mysql://test:test@localhost:5499/test_ws4',
      'not-a-database-url',
    ]) {
      expect(() => assertLocalMigrationDatabaseUrl(unsafeUrl)).toThrow(
        'migration 078 tests require a local (localhost) test database',
      );
    }
  });

  it('rejects an unsafe URL before invoking the database connector', () => {
    const connect = vi.fn();

    expect(() =>
      afterLocalMigrationDatabaseGuard(
        'postgresql://test:test@db.example.supabase.co:5432/postgres',
        connect,
      ),
    ).toThrow('migration 078 tests require a local (localhost) test database');
    expect(connect).not.toHaveBeenCalled();
  });

  it('runs both NULL-safe preflights before any schema contraction in one atomic statement', () => {
    const executableSql = stripSqlLineComments(readMigration078Sql()).trim();
    const migrationSql = normalizeSql(executableSql);
    const accountsPreflight = migrationSql.indexOf(
      "FROM public.accounts WHERE subscription_tier IS NULL OR subscription_tier NOT IN ('copilot', 'autopilot')",
    );
    const businessesPreflight = migrationSql.indexOf(
      "FROM public.businesses WHERE subscription_tier IS NULL OR subscription_tier NOT IN ('copilot', 'autopilot')",
    );
    const schemaChangeIndexes = [
      ...migrationSql.matchAll(/ALTER TABLE public\.(?:accounts|businesses)/g),
    ].map((match) => match.index);
    const firstSchemaChange = Math.min(...schemaChangeIndexes);

    expect(executableSql).toMatch(/^DO \$migration\$[\s\S]*\$migration\$;$/);
    expect(executableSql).not.toMatch(/\bCONCURRENTLY\b/i);
    expect(accountsPreflight).toBeGreaterThan(-1);
    expect(businessesPreflight).toBeGreaterThan(accountsPreflight);
    expect(schemaChangeIndexes).not.toHaveLength(0);
    expect(firstSchemaChange).toBeGreaterThan(businessesPreflight);
  });

  it('replaces only the exact named constraints scoped by conrelid', () => {
    const migrationSql = normalizeSql(readMigration078Sql());

    for (const [table, constraint] of [
      ['accounts', 'accounts_subscription_tier_check'],
      ['businesses', 'businesses_subscription_tier_check'],
    ] as const) {
      expect(migrationSql).toContain(
        normalizeSql(`
          WHERE conname = '${constraint}'
            AND conrelid = 'public.${table}'::regclass
        `),
      );
      expect(migrationSql).toContain(
        `ALTER TABLE public.${table} DROP CONSTRAINT ${constraint}`,
      );
      expect(migrationSql).toContain(
        normalizeSql(`
          ALTER TABLE public.${table}
            ADD CONSTRAINT ${constraint}
            CHECK (subscription_tier IN ('copilot', 'autopilot'));
        `),
      );
    }
  });
});

describeWithDb(
  'migration 078 Copilot / Autopilot strict contract',
  { timeout: 60_000 },
  () => {
    beforeAll(async () => {
      db = afterLocalMigrationDatabaseGuard(testDatabaseUrl!, (safeDatabaseUrl) =>
        postgres(safeDatabaseUrl, { max: 1, prepare: false }),
      );
      await sql().unsafe('BEGIN');
      transactionOpen = true;

      const [migrationBoundary] = await sql()<
        { judge_verdicts: boolean; subject_index: boolean; final_076_index: boolean }[]
      >`
        SELECT
          to_regclass('public.judge_verdicts') IS NOT NULL AS judge_verdicts,
          to_regclass('public.idx_agent_runs_subject') IS NOT NULL AS subject_index,
          to_regclass('public.idx_jo_autonomy_admin_alert_inflight') IS NOT NULL AS final_076_index
      `;
      expect(migrationBoundary).toEqual({
        judge_verdicts: true,
        subject_index: true,
        final_076_index: true,
      });

      // Apply/repair 077 first, then remove only 078's objects to reproduce the
      // strict-code smoke boundary. All reset DDL remains private to this tx.
      await sql().unsafe(readMigration077Sql());
      await sql().unsafe(`
        ALTER TABLE public.accounts
          DROP CONSTRAINT IF EXISTS accounts_subscription_tier_check;
        ALTER TABLE public.businesses
          DROP CONSTRAINT IF EXISTS businesses_subscription_tier_check;
        ALTER TABLE public.accounts ALTER COLUMN subscription_tier SET NOT NULL;
        ALTER TABLE public.businesses ALTER COLUMN subscription_tier DROP NOT NULL;
      `);

      const [invalidRows] = await sql()<{ accounts: string; businesses: string }[]>`
        SELECT
          (SELECT count(*)::text FROM accounts
            WHERE subscription_tier IS NULL
              OR subscription_tier NOT IN ('copilot', 'autopilot')) AS accounts,
          (SELECT count(*)::text FROM businesses
            WHERE subscription_tier IS NULL
              OR subscription_tier NOT IN ('copilot', 'autopilot')) AS businesses
      `;
      expect(invalidRows).toEqual({ accounts: '0', businesses: '0' });

      await insertFixture('copilot', 'copilot');
      await insertFixture('autopilot', 'autopilot');

      // The fixture parents now exist on both sides of the circular deferred
      // users/accounts FKs. Drain those pending trigger events before 078 takes
      // ALTER TABLE locks, matching the migration-077 live-suite discipline.
      await sql().unsafe('SET CONSTRAINTS ALL IMMEDIATE');

      // A same-name constraint on the wrong table proves 078 scopes catalog
      // lookups by conrelid. It must survive both aborted and successful runs.
      await sql().unsafe(`
        ALTER TABLE public.accounts
          ADD CONSTRAINT businesses_subscription_tier_check
          CHECK (id IS NOT NULL);
        ALTER TABLE public.businesses
          ADD CONSTRAINT accounts_subscription_tier_check
          CHECK (id IS NOT NULL);
      `);
    });

    afterAll(async () => {
      if (!db) return;
      if (transactionOpen) {
        await db.unsafe('ROLLBACK');
        transactionOpen = false;
      }
      await db.end({ timeout: 5 });
      db = undefined;
    });

    it('aborts before every constraint change for NULL, every removed tier, and an unknown tier in either table', async () => {
      const invalidValues: readonly (string | null)[] = [
        null,
        ...legacyTierValues,
        'enterprise',
      ];

      for (const table of ['accounts', 'businesses'] as const) {
        for (const invalidValue of invalidValues) {
          const error = await captureExpectedDatabaseError(async () => {
            if (table === 'accounts' && invalidValue === null) {
              await sql().unsafe(
                'ALTER TABLE public.accounts ALTER COLUMN subscription_tier DROP NOT NULL',
              );
            }

            if (table === 'accounts') {
              await sql()`
                UPDATE accounts SET subscription_tier = ${invalidValue}
                WHERE id = ${fixtures.copilot.accountId}::uuid
              `;
            } else {
              await sql()`
                UPDATE businesses SET subscription_tier = ${invalidValue}
                WHERE id = ${fixtures.copilot.businessId}::uuid
              `;
            }

            await sql().unsafe(readMigration078Sql());
          });

          expect(error.message).toContain('migration 078 preflight failed');
          expect(error.message).toContain(
            table === 'accounts'
              ? 'accounts_invalid=t, businesses_invalid=f'
              : 'accounts_invalid=f, businesses_invalid=t',
          );
          await assertContractObjectsAbsent();
        }
      }
    });

    it('reports simultaneous account and business blockers without changing rows or catalog', async () => {
      const rowsBefore = await accountAndBusinessBytes();
      const catalogBefore = await tierConstraintCatalog();
      expect(catalogBefore).toEqual([
        {
          table_name: 'accounts',
          constraint_name: 'businesses_subscription_tier_check',
          constraint_def: 'CHECK ((id IS NOT NULL))',
        },
        {
          table_name: 'businesses',
          constraint_name: 'accounts_subscription_tier_check',
          constraint_def: 'CHECK ((id IS NOT NULL))',
        },
      ]);

      const error = await captureExpectedDatabaseError(async () => {
        await sql()`
          UPDATE accounts SET subscription_tier = 'standard'
          WHERE id = ${fixtures.copilot.accountId}::uuid
        `;
        await sql()`
          UPDATE businesses SET subscription_tier = 'premium'
          WHERE id = ${fixtures.copilot.businessId}::uuid
        `;
        await sql().unsafe(readMigration078Sql());
      });

      expect(error.message).toContain('migration 078 preflight failed');
      expect(error.message).toContain('accounts_invalid=t, businesses_invalid=t');
      expect(await accountAndBusinessBytes()).toEqual(rowsBefore);
      expect(await tierConstraintCatalog()).toEqual(catalogBefore);
      await assertContractObjectsAbsent();
    });

    it('accepts valid Copilot/Autopilot rows and contracts both table shapes', async () => {
      const before = await accountAndBusinessBytes();

      await expect(sql().unsafe(readMigration078Sql())).resolves.not.toThrow();
      expect(await accountAndBusinessBytes()).toEqual(before);

      const columns = await sql()<
        { table_name: 'accounts' | 'businesses'; is_nullable: 'YES' | 'NO' }[]
      >`
        SELECT table_name, is_nullable
        FROM information_schema.columns
        WHERE table_schema = 'public'
          AND table_name IN ('accounts', 'businesses')
          AND column_name = 'subscription_tier'
        ORDER BY table_name
      `;
      expect(columns).toEqual([
        { table_name: 'accounts', is_nullable: 'NO' },
        { table_name: 'businesses', is_nullable: 'NO' },
      ]);

      const constraints = await sql()<
        {
          table_name: string;
          constraint_name: string;
          constraint_def: string;
          validated: boolean;
        }[]
      >`
        SELECT
          conrelid::regclass::text AS table_name,
          conname AS constraint_name,
          pg_get_constraintdef(oid) AS constraint_def,
          convalidated AS validated
        FROM pg_constraint
        WHERE (conrelid = 'public.accounts'::regclass
            AND conname = 'accounts_subscription_tier_check')
          OR (conrelid = 'public.businesses'::regclass
            AND conname = 'businesses_subscription_tier_check')
        ORDER BY table_name
      `;
      expect(constraints).toHaveLength(2);
      expect(constraints.map((constraint) => constraint.constraint_name)).toEqual([
        'accounts_subscription_tier_check',
        'businesses_subscription_tier_check',
      ]);
      for (const constraint of constraints) {
        expect(constraint.validated).toBe(true);
        expect(constraint.constraint_def).toContain("'copilot'");
        expect(constraint.constraint_def).toContain("'autopilot'");
      }

      const decoys = (await tierConstraintCatalog()).filter(
        (constraint) =>
          (constraint.table_name === 'accounts' &&
            constraint.constraint_name === 'businesses_subscription_tier_check') ||
          (constraint.table_name === 'businesses' &&
            constraint.constraint_name === 'accounts_subscription_tier_check'),
      );
      expect(decoys).toEqual([
        {
          table_name: 'accounts',
          constraint_name: 'businesses_subscription_tier_check',
          constraint_def: 'CHECK ((id IS NOT NULL))',
        },
        {
          table_name: 'businesses',
          constraint_name: 'accounts_subscription_tier_check',
          constraint_def: 'CHECK ((id IS NOT NULL))',
        },
      ]);
    });

    it('rejects NULL, removed, and unknown tiers after contraction', async () => {
      for (const [table, id] of [
        ['accounts', fixtures.copilot.accountId],
        ['businesses', fixtures.copilot.businessId],
      ] as const) {
        for (const invalidValue of [null, 'premium', 'enterprise'] as const) {
          const error = await captureExpectedDatabaseError(() =>
            table === 'accounts'
              ? sql()`
                  UPDATE accounts SET subscription_tier = ${invalidValue}
                  WHERE id = ${id}::uuid
                `
              : sql()`
                  UPDATE businesses SET subscription_tier = ${invalidValue}
                  WHERE id = ${id}::uuid
                `,
          );
          expect(error.message).toMatch(
            invalidValue === null
              ? /null value in column "subscription_tier".*violates not-null constraint/
              : /subscription_tier_check/,
          );
        }
      }
    });

    it('repairs widened named CHECKs and remains data-idempotent on second apply', async () => {
      const rowsBefore = await accountAndBusinessBytes();

      await sql().unsafe(`
        ALTER TABLE public.accounts DROP CONSTRAINT accounts_subscription_tier_check;
        ALTER TABLE public.accounts ADD CONSTRAINT accounts_subscription_tier_check
          CHECK (subscription_tier IN ('copilot', 'autopilot', 'enterprise'));
        ALTER TABLE public.businesses DROP CONSTRAINT businesses_subscription_tier_check;
        ALTER TABLE public.businesses ADD CONSTRAINT businesses_subscription_tier_check
          CHECK (subscription_tier IN ('copilot', 'autopilot', 'enterprise'));
      `);

      await expect(sql().unsafe(readMigration078Sql())).resolves.not.toThrow();
      expect(await accountAndBusinessBytes()).toEqual(rowsBefore);

      const constraints = await sql()<
        { constraint_name: string; constraint_def: string }[]
      >`
        SELECT conname AS constraint_name, pg_get_constraintdef(oid) AS constraint_def
        FROM pg_constraint
        WHERE (conrelid = 'public.accounts'::regclass
            AND conname = 'accounts_subscription_tier_check')
          OR (conrelid = 'public.businesses'::regclass
            AND conname = 'businesses_subscription_tier_check')
        ORDER BY constraint_name
      `;
      expect(constraints).toHaveLength(2);
      for (const constraint of constraints) {
        expect(constraint.constraint_def).not.toContain('enterprise');
      }

      // A clean third execution proves ordinary re-runnability after repair.
      await expect(sql().unsafe(readMigration078Sql())).resolves.not.toThrow();
      expect(await accountAndBusinessBytes()).toEqual(rowsBefore);
    });
  },
);
