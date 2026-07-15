import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import postgres from 'postgres';
import type postgresType from 'postgres';
import { describeWithDb } from '@/__tests__/helpers/describe-with-db';
import { resolveTierSnapshot } from '@/lib/accounts/tier-config';

// Migration 077 is a one-time normalization whose first-apply marker is the
// absence of accounts.price_variant. This suite therefore runs inside one
// rollback-only transaction: it transactionally removes any committed 077/078
// objects to emulate the required schema-through-076 boundary, seeds legacy
// fixtures, applies the checked-in migration twice, and rolls everything back.
// Parallel sessions continue to see the committed schema/data; this file leaves
// no fixture or migration residue behind.

const testDatabaseUrl = process.env.TEST_DATABASE_POOL_URL;
const migrationPath = resolve(
  process.cwd(),
  'supabase/migrations/077_copilot_autopilot_expand.sql',
);

let db: postgresType.Sql | undefined;
let transactionOpen = false;
let outboxCountBeforeFirstApply = '';
let outboxCountAfterFirstApply = '';

const fixturePrefix = `ws8-077-${randomUUID()}`;

interface LegacyAccountFixture {
  key: string;
  accountId: string;
  userId: string;
  businessId: string;
  tier: string | null;
  mirrorTier: string | null;
  basePriceCents: number;
  overagePriceCents: number;
  locationsIncluded: number;
  locationsPaid: number;
}

const legacyFixtures: LegacyAccountFixture[] = [
  {
    key: 'premium',
    accountId: randomUUID(),
    userId: randomUUID(),
    businessId: randomUUID(),
    tier: 'premium',
    mirrorTier: 'premium',
    basePriceCents: 19_900,
    overagePriceCents: 2_500,
    locationsIncluded: 5,
    locationsPaid: 4,
  },
  {
    key: 'basic',
    accountId: randomUUID(),
    userId: randomUUID(),
    businessId: randomUUID(),
    tier: 'basic',
    mirrorTier: 'basic',
    basePriceCents: 2_900,
    overagePriceCents: 2_500,
    locationsIncluded: 1,
    locationsPaid: 1,
  },
  {
    key: 'standard',
    accountId: randomUUID(),
    userId: randomUUID(),
    businessId: randomUUID(),
    tier: 'standard',
    mirrorTier: null,
    basePriceCents: 7_900,
    overagePriceCents: 2_500,
    locationsIncluded: 2,
    locationsPaid: 1,
  },
  {
    key: 'founders',
    accountId: randomUUID(),
    userId: randomUUID(),
    businessId: randomUUID(),
    tier: 'founders',
    mirrorTier: 'founders',
    basePriceCents: 1_900,
    overagePriceCents: 1_500,
    locationsIncluded: 1,
    locationsPaid: 0,
  },
  {
    key: 'null-tier-invalid-mirror',
    accountId: randomUUID(),
    userId: randomUUID(),
    businessId: randomUUID(),
    tier: null,
    mirrorTier: 'invalid-mirror',
    basePriceCents: 12_345,
    overagePriceCents: 9_999,
    locationsIncluded: 8,
    locationsPaid: 7,
  },
  {
    key: 'stray-founding-copilot-shape',
    accountId: randomUUID(),
    userId: randomUUID(),
    businessId: randomUUID(),
    tier: 'copilot',
    mirrorTier: 'copilot',
    basePriceCents: 1_900,
    overagePriceCents: 1_500,
    locationsIncluded: 3,
    locationsPaid: 2,
  },
  {
    key: 'stray-founding-autopilot-shape',
    accountId: randomUUID(),
    userId: randomUUID(),
    businessId: randomUUID(),
    tier: 'autopilot',
    mirrorTier: 'autopilot',
    basePriceCents: 4_900,
    overagePriceCents: 2_000,
    locationsIncluded: 4,
    locationsPaid: 3,
  },
];

const premiumExtraLocations = [
  { id: randomUUID(), archived: false },
  { id: randomUUID(), archived: false },
  { id: randomUUID(), archived: true },
];

function readMigration077Sql(): string {
  return readFileSync(migrationPath, 'utf-8');
}

function stripSqlLineComments(value: string): string {
  return value.replace(/--.*$/gm, '');
}

function normalizeSql(value: string): string {
  return value.replace(/\s+/g, ' ').trim();
}

function assertLocalMigrationDatabaseUrl(databaseUrl: string): string {
  let parsed: URL;
  try {
    parsed = new URL(databaseUrl);
  } catch {
    throw new Error('migration 077 tests require a local (localhost) test database');
  }

  const isLocalPostgres =
    (parsed.protocol === 'postgres:' || parsed.protocol === 'postgresql:') &&
    (parsed.hostname === 'localhost' || parsed.hostname === '127.0.0.1');

  if (!isLocalPostgres) {
    throw new Error('migration 077 tests require a local (localhost) test database');
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
  if (!db) throw new Error('migration 077 integration database was not initialized');
  return db;
}

async function insertLegacyFixture(fixture: LegacyAccountFixture): Promise<void> {
  const ownerEmail = `${fixturePrefix}-${fixture.key}@test.local`;

  await sql()`
    INSERT INTO users (id, name, email, role, account_id)
    VALUES (
      ${fixture.userId}::uuid,
      ${`WS8 077 ${fixture.key} owner`},
      ${ownerEmail},
      'owner',
      ${fixture.accountId}::uuid
    )
  `;
  await sql()`
    INSERT INTO accounts (
      id, owner_user_id, display_name, subscription_tier, subscription_status,
      base_price_cents, locations_overage_price_cents, locations_included,
      locations_paid
    )
    VALUES (
      ${fixture.accountId}::uuid,
      ${fixture.userId}::uuid,
      ${`${fixturePrefix}:${fixture.key}`},
      ${fixture.tier},
      'active',
      ${fixture.basePriceCents},
      ${fixture.overagePriceCents},
      ${fixture.locationsIncluded},
      ${fixture.locationsPaid}
    )
  `;
  await insertFixtureBusiness(
    fixture.accountId,
    fixture.businessId,
    `${fixture.key}-primary`,
    fixture.mirrorTier,
    false,
  );
}

async function insertFixtureBusiness(
  accountId: string,
  businessId: string,
  suffix: string,
  mirrorTier: string | null,
  archived: boolean,
): Promise<void> {
  await sql()`
    INSERT INTO businesses (
      id, name, owner_name, owner_email, account_id, subscription_tier,
      subscription_status, archived_at
    )
    VALUES (
      ${businessId}::uuid,
      ${`${fixturePrefix}:${suffix}`},
      'WS8 077 Owner',
      ${`${fixturePrefix}-${suffix}@test.local`},
      ${accountId}::uuid,
      ${mirrorTier},
      'active',
      CASE WHEN ${archived} THEN NOW() ELSE NULL END
    )
  `;
}

async function captureExpectedDatabaseError(operation: () => Promise<unknown>): Promise<Error> {
  await sql().unsafe('SAVEPOINT ws8_077_expected_error');
  try {
    await operation();
  } catch (error) {
    await sql().unsafe('ROLLBACK TO SAVEPOINT ws8_077_expected_error');
    await sql().unsafe('RELEASE SAVEPOINT ws8_077_expected_error');
    return error instanceof Error ? error : new Error(String(error));
  }

  await sql().unsafe('ROLLBACK TO SAVEPOINT ws8_077_expected_error');
  await sql().unsafe('RELEASE SAVEPOINT ws8_077_expected_error');
  throw new Error('expected database operation to fail');
}

async function accountBytesForLegacyFixtures(): Promise<{ id: string; bytes: string }[]> {
  return sql()<{ id: string; bytes: string }[]>`
    SELECT id::text, row_to_json(accounts)::text AS bytes
    FROM accounts
    WHERE display_name LIKE ${`${fixturePrefix}:%`}
    ORDER BY id
  `;
}

async function businessBytesForLegacyFixtures(): Promise<{ id: string; bytes: string }[]> {
  return sql()<{ id: string; bytes: string }[]>`
    SELECT id::text, row_to_json(businesses)::text AS bytes
    FROM businesses
    WHERE name LIKE ${`${fixturePrefix}:%`}
    ORDER BY id
  `;
}

describe('migration 077 checked-in SQL safety', () => {
  it('accepts local-host test databases and rejects remote or non-Postgres URLs', () => {
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
        'migration 077 tests require a local (localhost) test database',
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
    ).toThrow('migration 077 tests require a local (localhost) test database');
    expect(connect).not.toHaveBeenCalled();
  });

  it('is one atomic, direct-SQL statement with no async side effects', () => {
    const executableSql = stripSqlLineComments(readMigration077Sql()).trim();

    expect(executableSql).toMatch(/^DO \$migration\$[\s\S]*\$migration\$;$/);
    expect(executableSql).not.toMatch(/\bCONCURRENTLY\b/i);
    expect(executableSql).not.toMatch(
      /(?:INSERT\s+INTO|UPDATE|DELETE\s+FROM)\s+(?:public\.)?job_outbox\b/i,
    );
    expect(executableSql).not.toMatch(/\b(?:stripe|redis|typescript)\b/i);
  });

  it('captures the marker-column sentinel before expansion and pins the complete first-apply snapshot', () => {
    const migrationSql = normalizeSql(readMigration077Sql());
    const sentinelIndex = migrationSql.indexOf("attname = 'price_variant'");
    const expansionIndex = migrationSql.indexOf('ADD COLUMN IF NOT EXISTS price_variant');

    expect(sentinelIndex).toBeGreaterThan(-1);
    expect(expansionIndex).toBeGreaterThan(sentinelIndex);
    expect(migrationSql).toContain(
      normalizeSql(`
        IF first_apply THEN
          UPDATE public.accounts
          SET
            subscription_tier = 'copilot',
            price_variant = 'list',
            base_price_cents = 2900,
            locations_overage_price_cents = 1500,
            locations_included = 1,
            locations_paid = 0;
      `),
    );
    expect(migrationSql).toContain(
      normalizeSql(`UPDATE public.businesses SET subscription_tier = 'copilot';`),
    );
  });
});

describeWithDb(
  'migration 077 Copilot / Autopilot expansion — first apply and repair reapply',
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

      // Emulate the exact schema-through-076 boundary even when the containing
      // test database was bootstrapped through every checked-in migration.
      // All changes are invisible outside and rolled back in afterAll.
      await sql().unsafe(`
        DROP TRIGGER IF EXISTS accounts_price_variant_immutable ON public.accounts;
        DROP FUNCTION IF EXISTS public.reject_accounts_price_variant_mutation();

        DO $reset$
        DECLARE
          tier_constraint RECORD;
        BEGIN
          FOR tier_constraint IN
            SELECT conrelid::regclass AS relation_name, conname
            FROM pg_constraint
            WHERE conrelid IN ('public.accounts'::regclass, 'public.businesses'::regclass)
              AND contype = 'c'
              AND pg_get_constraintdef(oid) ILIKE '%subscription_tier%'
          LOOP
            EXECUTE format(
              'ALTER TABLE %s DROP CONSTRAINT %I',
              tier_constraint.relation_name,
              tier_constraint.conname
            );
          END LOOP;
        END
        $reset$;

        ALTER TABLE public.accounts DROP COLUMN IF EXISTS price_variant;
        ALTER TABLE public.accounts ALTER COLUMN subscription_tier DROP NOT NULL;
        ALTER TABLE public.accounts
          ALTER COLUMN subscription_tier SET DEFAULT 'standard',
          ALTER COLUMN base_price_cents SET DEFAULT 7900,
          ALTER COLUMN locations_overage_price_cents SET DEFAULT 2500,
          ALTER COLUMN locations_included SET DEFAULT 1;
        ALTER TABLE public.businesses ALTER COLUMN subscription_tier DROP NOT NULL;
        ALTER TABLE public.businesses ALTER COLUMN subscription_tier SET DEFAULT 'standard';
        SET CONSTRAINTS ALL DEFERRED;
      `);

      for (const fixture of legacyFixtures) {
        await insertLegacyFixture(fixture);
      }

      const premium = legacyFixtures[0]!;
      for (const [index, location] of premiumExtraLocations.entries()) {
        await insertFixtureBusiness(
          premium.accountId,
          location.id,
          `premium-extra-${index + 1}`,
          index === 1 ? null : index === 2 ? 'invalid-mirror' : 'premium',
          location.archived,
        );
      }

      // The fixture parents now exist on both sides of the circular deferred
      // users/accounts FKs. Drain those pending trigger events before 077 takes
      // ALTER TABLE locks; otherwise PostgreSQL correctly rejects the DDL.
      await sql().unsafe('SET CONSTRAINTS ALL IMMEDIATE');

      const [outboxBefore] = await sql()<{ count: string }[]>`
        SELECT count(*)::text AS count FROM job_outbox
      `;
      outboxCountBeforeFirstApply = outboxBefore!.count;

      await sql().unsafe(readMigration077Sql());

      const [outboxAfter] = await sql()<{ count: string }[]>`
        SELECT count(*)::text AS count FROM job_outbox
      `;
      outboxCountAfterFirstApply = outboxAfter!.count;
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

    it('unconditionally normalizes every legacy/null/new-shaped account to the complete Copilot/list snapshot', async () => {
      const rows = await accountBytesForLegacyFixtures();
      expect(rows).toHaveLength(legacyFixtures.length);

      const snapshots = await sql()<
        {
          id: string;
          subscription_tier: string;
          price_variant: string;
          base_price_cents: number;
          locations_overage_price_cents: number;
          locations_included: number;
          locations_paid: number;
        }[]
      >`
        SELECT
          id::text, subscription_tier, price_variant, base_price_cents,
          locations_overage_price_cents, locations_included, locations_paid
        FROM accounts
        WHERE display_name LIKE ${`${fixturePrefix}:%`}
        ORDER BY id
      `;

      expect(snapshots).toHaveLength(legacyFixtures.length);
      for (const snapshot of snapshots) {
        expect(snapshot).toEqual({
          id: snapshot.id,
          subscription_tier: 'copilot',
          price_variant: 'list',
          base_price_cents: 2_900,
          locations_overage_price_cents: 1_500,
          locations_included: 1,
          locations_paid: 0,
        });
      }
    });

    it('pins migration 077 direct-SQL constants to the canonical Copilot/list registry snapshot', async () => {
      const target = legacyFixtures[0]!;
      const [snapshot] = await sql()<
        {
          subscription_tier: string;
          price_variant: string;
          base_price_cents: number;
          locations_overage_price_cents: number;
          locations_included: number;
          locations_paid: number;
        }[]
      >`
        SELECT
          subscription_tier, price_variant, base_price_cents,
          locations_overage_price_cents, locations_included, locations_paid
        FROM accounts
        WHERE id = ${target.accountId}::uuid
      `;
      const registry = resolveTierSnapshot('copilot', 'list');

      expect(snapshot).toEqual({
        subscription_tier: registry.tier,
        price_variant: registry.variant,
        base_price_cents: registry.baseCents,
        locations_overage_price_cents: registry.overageCents,
        locations_included: registry.included,
        // Deliberate migration-only exception after the provider preflight:
        // no live subscription quantity exists to preserve.
        locations_paid: 0,
      });
    });

    it('normalizes every NULL/invalid business mirror without inferring paid quantity from active locations', async () => {
      const businesses = await sql()<
        { account_id: string; archived: boolean; subscription_tier: string }[]
      >`
        SELECT
          account_id::text,
          archived_at IS NOT NULL AS archived,
          subscription_tier
        FROM businesses
        WHERE name LIKE ${`${fixturePrefix}:%`}
        ORDER BY id
      `;
      expect(businesses).toHaveLength(legacyFixtures.length + premiumExtraLocations.length);
      expect(businesses.every((business) => business.subscription_tier === 'copilot')).toBe(true);

      const premium = legacyFixtures[0]!;
      const [locationCounts] = await sql()<
        { active_count: string; archived_count: string; locations_paid: number }[]
      >`
        SELECT
          count(*) FILTER (WHERE b.archived_at IS NULL)::text AS active_count,
          count(*) FILTER (WHERE b.archived_at IS NOT NULL)::text AS archived_count,
          a.locations_paid
        FROM accounts a
        JOIN businesses b ON b.account_id = a.id
        WHERE a.id = ${premium.accountId}::uuid
        GROUP BY a.locations_paid
      `;
      expect(locationCounts).toEqual({
        active_count: '3',
        archived_count: '1',
        locations_paid: 0,
      });
    });

    it('creates no outbox or reconciliation work', async () => {
      expect(outboxCountAfterFirstApply).toBe(outboxCountBeforeFirstApply);

      const accountIds = legacyFixtures.map((fixture) => fixture.accountId);
      const [fixtureOutbox] = await sql()<{ count: string }[]>`
        SELECT count(*)::text AS count
        FROM job_outbox
        WHERE aggregate_id = ANY(${accountIds}::uuid[])
      `;
      expect(fixtureOutbox?.count).toBe('0');
    });

    it('creates the exact column, defaults, CHECK, function, and column-scoped trigger catalog shape', async () => {
      const columns = await sql()<
        {
          table_name: string;
          column_name: string;
          data_type: string;
          is_nullable: 'YES' | 'NO';
          column_default: string | null;
        }[]
      >`
        SELECT table_name, column_name, data_type, is_nullable, column_default
        FROM information_schema.columns
        WHERE table_schema = 'public'
          AND (
            (table_name = 'accounts' AND column_name IN (
              'subscription_tier', 'price_variant', 'base_price_cents',
              'locations_overage_price_cents', 'locations_included', 'locations_paid'
            ))
            OR (table_name = 'businesses' AND column_name = 'subscription_tier')
          )
        ORDER BY table_name, column_name
      `;
      const byColumn = new Map(
        columns.map((column) => [`${column.table_name}.${column.column_name}`, column]),
      );

      expect(byColumn.get('accounts.price_variant')).toEqual({
        table_name: 'accounts',
        column_name: 'price_variant',
        data_type: 'text',
        is_nullable: 'NO',
        column_default: "'list'::text",
      });
      expect(byColumn.get('accounts.subscription_tier')?.column_default).toMatch(
        /^'copilot'::/,
      );
      expect(byColumn.get('accounts.base_price_cents')?.column_default).toBe('2900');
      expect(byColumn.get('accounts.locations_overage_price_cents')?.column_default).toBe(
        '1500',
      );
      expect(byColumn.get('accounts.locations_included')?.column_default).toBe('1');
      expect(byColumn.get('accounts.locations_paid')?.column_default).toBe('0');
      expect(byColumn.get('businesses.subscription_tier')?.column_default).toMatch(
        /^'copilot'::/,
      );

      const [constraint] = await sql()<
        { constraint_name: string; constraint_def: string; validated: boolean }[]
      >`
        SELECT
          conname AS constraint_name,
          pg_get_constraintdef(oid) AS constraint_def,
          convalidated AS validated
        FROM pg_constraint
        WHERE conrelid = 'public.accounts'::regclass
          AND conname = 'accounts_price_variant_check'
      `;
      expect(constraint).toEqual({
        constraint_name: 'accounts_price_variant_check',
        constraint_def:
          "CHECK ((price_variant = ANY (ARRAY['list'::text, 'founding'::text])))",
        validated: true,
      });

      const [trigger] = await sql()<
        { trigger_name: string; trigger_def: string; function_def: string }[]
      >`
        SELECT
          trigger.tgname AS trigger_name,
          pg_get_triggerdef(trigger.oid) AS trigger_def,
          pg_get_functiondef(function.oid) AS function_def
        FROM pg_trigger trigger
        JOIN pg_proc function ON function.oid = trigger.tgfoid
        WHERE trigger.tgrelid = 'public.accounts'::regclass
          AND trigger.tgname = 'accounts_price_variant_immutable'
          AND NOT trigger.tgisinternal
      `;
      expect(trigger?.trigger_name).toBe('accounts_price_variant_immutable');
      expect(trigger?.trigger_def).toContain(
        'BEFORE UPDATE OF price_variant ON public.accounts',
      );
      expect(trigger?.trigger_def).toContain(
        'EXECUTE FUNCTION reject_accounts_price_variant_mutation()',
      );
      expect(trigger?.function_def).toContain(
        'IF NEW.price_variant IS DISTINCT FROM OLD.price_variant THEN',
      );
      expect(trigger?.function_def).toContain('SET search_path TO \'pg_catalog\'');
    });

    it('rejects invalid variants and mutations while permitting unrelated account updates', async () => {
      const invalidUserId = randomUUID();
      const invalidAccountId = randomUUID();
      await sql()`
        INSERT INTO users (id, name, email, role)
        VALUES (
          ${invalidUserId}::uuid,
          'WS8 invalid variant owner',
          ${`${fixturePrefix}-invalid-variant@test.local`},
          'owner'
        )
      `;

      const invalidInsertError = await captureExpectedDatabaseError(() =>
        sql()`
          INSERT INTO accounts (
            id, owner_user_id, display_name, subscription_tier, price_variant
          )
          VALUES (
            ${invalidAccountId}::uuid,
            ${invalidUserId}::uuid,
            ${`${fixturePrefix}:invalid-variant`},
            'copilot',
            'invalid'
          )
        `,
      );
      expect(invalidInsertError.message).toMatch(/accounts_price_variant_check/);

      const target = legacyFixtures[1]!;
      const mutationError = await captureExpectedDatabaseError(() =>
        sql()`
          UPDATE accounts SET price_variant = 'founding'
          WHERE id = ${target.accountId}::uuid
        `,
      );
      expect(mutationError.message).toMatch(/accounts_price_variant_immutable/);

      await expect(
        sql()`
          UPDATE accounts
          SET display_name = display_name || ':unrelated-update-ok'
          WHERE id = ${target.accountId}::uuid
        `,
      ).resolves.not.toThrow();
      const [updated] = await sql()<{ price_variant: string; display_name: string }[]>`
        SELECT price_variant, display_name FROM accounts
        WHERE id = ${target.accountId}::uuid
      `;
      expect(updated?.price_variant).toBe('list');
      expect(updated?.display_name).toContain(':unrelated-update-ok');

      await sql()`DELETE FROM users WHERE id = ${invalidUserId}::uuid`;
    });

    it('uses all launch defaults for omitted account snapshots and the business mirror', async () => {
      const userId = randomUUID();
      const accountId = randomUUID();
      const businessId = randomUUID();
      await sql()`
        INSERT INTO users (id, name, email, role)
        VALUES (
          ${userId}::uuid,
          'WS8 defaults owner',
          ${`${fixturePrefix}-defaults@test.local`},
          'owner'
        )
      `;
      await sql()`
        INSERT INTO accounts (id, owner_user_id, display_name)
        VALUES (${accountId}::uuid, ${userId}::uuid, ${`${fixturePrefix}:defaults`})
      `;
      await sql()`UPDATE users SET account_id = ${accountId}::uuid WHERE id = ${userId}::uuid`;
      await sql()`
        INSERT INTO businesses (id, name, owner_name, owner_email, account_id)
        VALUES (
          ${businessId}::uuid,
          ${`${fixturePrefix}:defaults-business`},
          'WS8 Defaults Owner',
          ${`${fixturePrefix}-defaults-business@test.local`},
          ${accountId}::uuid
        )
      `;

      const [account] = await sql()<
        {
          subscription_tier: string;
          price_variant: string;
          base_price_cents: number;
          locations_overage_price_cents: number;
          locations_included: number;
          locations_paid: number;
        }[]
      >`
        SELECT
          subscription_tier, price_variant, base_price_cents,
          locations_overage_price_cents, locations_included, locations_paid
        FROM accounts WHERE id = ${accountId}::uuid
      `;
      expect(account).toEqual({
        subscription_tier: 'copilot',
        price_variant: 'list',
        base_price_cents: 2_900,
        locations_overage_price_cents: 1_500,
        locations_included: 1,
        locations_paid: 0,
      });
      const [business] = await sql()<{ subscription_tier: string }[]>`
        SELECT subscription_tier FROM businesses WHERE id = ${businessId}::uuid
      `;
      expect(business?.subscription_tier).toBe('copilot');
    });

    it('repairs damaged schema objects on second apply without changing normalized or founding Autopilot rows', async () => {
      const founding = {
        userId: randomUUID(),
        accountId: randomUUID(),
        businessId: randomUUID(),
      };
      await sql()`
        INSERT INTO users (id, name, email, role)
        VALUES (
          ${founding.userId}::uuid,
          'WS8 founding Autopilot owner',
          ${`${fixturePrefix}-founding-autopilot@test.local`},
          'owner'
        )
      `;
      await sql()`
        INSERT INTO accounts (
          id, owner_user_id, display_name, subscription_tier, subscription_status,
          price_variant, base_price_cents, locations_overage_price_cents,
          locations_included, locations_paid, stripe_customer_id,
          stripe_subscription_id, flags
        )
        VALUES (
          ${founding.accountId}::uuid,
          ${founding.userId}::uuid,
          ${`${fixturePrefix}:post-first-founding-autopilot`},
          'autopilot',
          'trialing',
          'founding',
          4900,
          2000,
          1,
          2,
          'cus_ws8_077_preserve',
          'sub_ws8_077_preserve',
          '{"preserve":"byte-for-byte"}'::jsonb
        )
      `;
      await sql()`
        UPDATE users SET account_id = ${founding.accountId}::uuid
        WHERE id = ${founding.userId}::uuid
      `;
      await sql()`
        INSERT INTO businesses (
          id, name, owner_name, owner_email, account_id, subscription_tier,
          subscription_status, display_label
        )
        VALUES (
          ${founding.businessId}::uuid,
          ${`${fixturePrefix}:post-first-founding-autopilot-business`},
          'WS8 Founding Owner',
          ${`${fixturePrefix}-founding-business@test.local`},
          ${founding.accountId}::uuid,
          'autopilot',
          'trialing',
          'Preserve this business byte-for-byte'
        )
      `;

      const normalizedAccountsBefore = await accountBytesForLegacyFixtures();
      const normalizedBusinessesBefore = await businessBytesForLegacyFixtures();
      const [foundingAccountBefore] = await sql()<{ bytes: string }[]>`
        SELECT row_to_json(accounts)::text AS bytes
        FROM accounts WHERE id = ${founding.accountId}::uuid
      `;
      const [foundingBusinessBefore] = await sql()<{ bytes: string }[]>`
        SELECT row_to_json(businesses)::text AS bytes
        FROM businesses WHERE id = ${founding.businessId}::uuid
      `;
      const [outboxBefore] = await sql()<{ count: string }[]>`
        SELECT count(*)::text AS count FROM job_outbox
      `;

      // Deliberately damage every repairable object without touching row data.
      await sql().unsafe(`
        DROP TRIGGER accounts_price_variant_immutable ON public.accounts;
        CREATE OR REPLACE FUNCTION public.reject_accounts_price_variant_mutation()
        RETURNS TRIGGER LANGUAGE plpgsql AS $$
        BEGIN
          RETURN NEW;
        END
        $$;
        CREATE TRIGGER accounts_price_variant_immutable
          BEFORE UPDATE ON public.accounts
          FOR EACH ROW
          EXECUTE FUNCTION public.reject_accounts_price_variant_mutation();

        ALTER TABLE public.accounts DROP CONSTRAINT accounts_price_variant_check;
        ALTER TABLE public.accounts ADD CONSTRAINT accounts_price_variant_check
          CHECK (price_variant IN ('list', 'founding', 'bogus'));
        ALTER TABLE public.accounts
          ALTER COLUMN subscription_tier SET DEFAULT 'standard',
          ALTER COLUMN price_variant DROP NOT NULL,
          ALTER COLUMN price_variant SET DEFAULT 'founding',
          ALTER COLUMN base_price_cents SET DEFAULT 7900,
          ALTER COLUMN locations_overage_price_cents SET DEFAULT 2500,
          ALTER COLUMN locations_included SET DEFAULT 9;
        ALTER TABLE public.businesses
          ALTER COLUMN subscription_tier SET DEFAULT 'premium';
      `);

      await expect(sql().unsafe(readMigration077Sql())).resolves.not.toThrow();

      expect(await accountBytesForLegacyFixtures()).toEqual(normalizedAccountsBefore);
      expect(await businessBytesForLegacyFixtures()).toEqual(normalizedBusinessesBefore);

      const [foundingAccountAfter] = await sql()<{ bytes: string }[]>`
        SELECT row_to_json(accounts)::text AS bytes
        FROM accounts WHERE id = ${founding.accountId}::uuid
      `;
      const [foundingBusinessAfter] = await sql()<{ bytes: string }[]>`
        SELECT row_to_json(businesses)::text AS bytes
        FROM businesses WHERE id = ${founding.businessId}::uuid
      `;
      expect(foundingAccountAfter?.bytes).toBe(foundingAccountBefore?.bytes);
      expect(foundingBusinessAfter?.bytes).toBe(foundingBusinessBefore?.bytes);

      const [repaired] = await sql()<
        {
          account_tier_default: string | null;
          variant_default: string | null;
          variant_nullable: 'YES' | 'NO';
          base_default: string | null;
          overage_default: string | null;
          included_default: string | null;
          business_tier_default: string | null;
          constraint_def: string;
          trigger_def: string;
          function_def: string;
        }[]
      >`
        SELECT
          (SELECT column_default FROM information_schema.columns
            WHERE table_schema = 'public' AND table_name = 'accounts'
              AND column_name = 'subscription_tier') AS account_tier_default,
          (SELECT column_default FROM information_schema.columns
            WHERE table_schema = 'public' AND table_name = 'accounts'
              AND column_name = 'price_variant') AS variant_default,
          (SELECT is_nullable FROM information_schema.columns
            WHERE table_schema = 'public' AND table_name = 'accounts'
              AND column_name = 'price_variant') AS variant_nullable,
          (SELECT column_default FROM information_schema.columns
            WHERE table_schema = 'public' AND table_name = 'accounts'
              AND column_name = 'base_price_cents') AS base_default,
          (SELECT column_default FROM information_schema.columns
            WHERE table_schema = 'public' AND table_name = 'accounts'
              AND column_name = 'locations_overage_price_cents') AS overage_default,
          (SELECT column_default FROM information_schema.columns
            WHERE table_schema = 'public' AND table_name = 'accounts'
              AND column_name = 'locations_included') AS included_default,
          (SELECT column_default FROM information_schema.columns
            WHERE table_schema = 'public' AND table_name = 'businesses'
              AND column_name = 'subscription_tier') AS business_tier_default,
          (SELECT pg_get_constraintdef(oid) FROM pg_constraint
            WHERE conrelid = 'public.accounts'::regclass
              AND conname = 'accounts_price_variant_check') AS constraint_def,
          (SELECT pg_get_triggerdef(oid) FROM pg_trigger
            WHERE tgrelid = 'public.accounts'::regclass
              AND tgname = 'accounts_price_variant_immutable'
              AND NOT tgisinternal) AS trigger_def,
          (SELECT pg_get_functiondef(oid) FROM pg_proc
            WHERE oid = 'public.reject_accounts_price_variant_mutation()'::regprocedure)
            AS function_def
      `;
      expect(repaired?.account_tier_default).toMatch(/^'copilot'::/);
      expect(repaired?.variant_default).toBe("'list'::text");
      expect(repaired?.variant_nullable).toBe('NO');
      expect(repaired?.base_default).toBe('2900');
      expect(repaired?.overage_default).toBe('1500');
      expect(repaired?.included_default).toBe('1');
      expect(repaired?.business_tier_default).toMatch(/^'copilot'::/);
      expect(repaired?.constraint_def).toBe(
        "CHECK ((price_variant = ANY (ARRAY['list'::text, 'founding'::text])))",
      );
      expect(repaired?.constraint_def).not.toContain('bogus');
      expect(repaired?.trigger_def).toContain(
        'BEFORE UPDATE OF price_variant ON public.accounts',
      );
      expect(repaired?.function_def).toContain(
        'IF NEW.price_variant IS DISTINCT FROM OLD.price_variant THEN',
      );

      const [outboxAfter] = await sql()<{ count: string }[]>`
        SELECT count(*)::text AS count FROM job_outbox
      `;
      expect(outboxAfter?.count).toBe(outboxBefore?.count);

      const repairedMutationError = await captureExpectedDatabaseError(() =>
        sql()`
          UPDATE accounts SET price_variant = 'list'
          WHERE id = ${founding.accountId}::uuid
        `,
      );
      expect(repairedMutationError.message).toMatch(/accounts_price_variant_immutable/);
    });
  },
);
