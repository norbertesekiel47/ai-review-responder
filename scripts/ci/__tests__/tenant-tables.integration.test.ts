import { afterAll, beforeAll, expect, it } from 'vitest';
import postgres from 'postgres';
import type postgresType from 'postgres';
import { describeWithDb } from '@/__tests__/helpers/describe-with-db';
import {
  assertLocalTestDatabaseUrl,
  resolveTestDatabaseUrl,
} from '@/lib/shared/__tests__/helpers/live-db-lock';
import {
  assertSchemaReady,
  MIGRATION_108_OUTREACH_OWNER_EXCLUDED,
} from '@/lib/shared/__tests__/helpers/schema-ready';
import {
  REVIEWED_NOT_TENANT_SCOPED,
  TENANT_SCOPE_COLUMNS,
  TENANT_TABLES,
  type TenantScopeColumn,
  type TenantTable,
} from '../tenant-tables';

// Live-DB conformance for TENANT_SCOPE_COLUMNS (#859). The map tells
// `ci:tenant-scope` which tenant-identity columns each table PHYSICALLY has,
// so a scope predicate on a column the table lacks is never accepted as proof
// (inside a subquery PostgreSQL resolves it to the OUTER row). A row that
// drifts from the schema is unsafe in exactly one direction — a column dropped
// by a migration but still listed here lets the audit accept a predicate that
// restricts nothing — so the map is asserted against information_schema at
// migration head rather than trusted. Read-only: no lock, no seed, no cleanup.
// Applies NO migration SQL: `pnpm test:db:setup` provisions the schema and this
// file asserts it with assertSchemaReady (#573).

const testDatabaseUrl = resolveTestDatabaseUrl();
const SCOPE_COLUMNS: readonly TenantScopeColumn[] = ['id', 'account_id', 'business_id'];

let db: postgresType.Sql | undefined;

describeWithDb(
  'TENANT_SCOPE_COLUMNS against live local Postgres',
  { enabled: Boolean(testDatabaseUrl), timeout: 60_000 },
  () => {
    beforeAll(async () => {
      const databaseUrl = assertLocalTestDatabaseUrl(testDatabaseUrl);
      db = postgres(databaseUrl, { max: 1, prepare: false });
      await assertSchemaReady(db, [MIGRATION_108_OUTREACH_OWNER_EXCLUDED]);
    }, 60_000);

    afterAll(async () => {
      if (db) await db.end({ timeout: 5 });
    }, 30_000);

    // #894 Step 3 — the INVERTED completeness contract. The old direction
    // ("do the listed tables have these columns") could never see a table the
    // list omitted; this direction makes every CREATE TABLE a forced,
    // reviewed decision.
    it('every live public table is in EXACTLY ONE of TENANT_TABLES or REVIEWED_NOT_TENANT_SCOPED', async () => {
      if (!db) throw new Error('tenant-tables integration database was not initialized');
      const rows = await db<{ tablename: string }[]>`
        SELECT tablename FROM pg_tables WHERE schemaname = 'public'
      `;
      const live = new Set(rows.map((row) => row.tablename));
      const tenant = new Set<string>(TENANT_TABLES);
      const reviewed = new Set(REVIEWED_NOT_TENANT_SCOPED.map((entry) => entry.table));

      const problems: string[] = [];
      for (const table of [...live].sort()) {
        const inTenant = tenant.has(table);
        const inReviewed = reviewed.has(table);
        if (inTenant && inReviewed) {
          problems.push(`${table}: on BOTH lists — pick one`);
        } else if (!inTenant && !inReviewed) {
          problems.push(
            `${table}: on NEITHER list — add it to TENANT_TABLES (audited) or to REVIEWED_NOT_TENANT_SCOPED with a reviewed reason`,
          );
        }
      }
      // No stale rows: a listed table that no longer exists is a lie waiting
      // to reassure someone.
      for (const table of [...tenant].sort()) {
        if (!live.has(table)) problems.push(`${table}: in TENANT_TABLES but absent from the live schema`);
      }
      for (const table of [...reviewed].sort()) {
        if (!live.has(table)) {
          problems.push(`${table}: in REVIEWED_NOT_TENANT_SCOPED but absent from the live schema`);
        }
      }
      expect(problems).toEqual([]);
    });

    it('every REVIEWED_NOT_TENANT_SCOPED entry carries a substantive reason', () => {
      for (const entry of REVIEWED_NOT_TENANT_SCOPED) {
        expect(entry.reason.length, entry.table).toBeGreaterThan(40);
      }
    });

    it('lists exactly the tenant-identity columns each tenant table carries', async () => {
      if (!db) throw new Error('tenant-tables integration database was not initialized');
      const rows = await db<{ table_name: string; column_name: string }[]>`
        SELECT table_name, column_name
        FROM information_schema.columns
        WHERE table_schema = 'public'
          AND table_name = ANY(${[...TENANT_TABLES]}::text[])
          AND column_name = ANY(${[...SCOPE_COLUMNS]}::text[])
      `;
      const actual = new Map<string, Set<string>>();
      for (const row of rows) {
        const columns = actual.get(row.table_name) ?? new Set<string>();
        columns.add(row.column_name);
        actual.set(row.table_name, columns);
      }

      const mismatches: string[] = [];
      for (const table of TENANT_TABLES) {
        const present = actual.get(table);
        if (!present) {
          mismatches.push(`${table}: table missing from the schema`);
          continue;
        }
        // `id` identifies only accounts/businesses; every other table is
        // identified by account_id/business_id, so `id` is compared only there.
        const expected = expectedColumns(table, present);
        const listed = [...TENANT_SCOPE_COLUMNS[table]].sort().join(',');
        const found = expected.sort().join(',');
        if (listed !== found) {
          mismatches.push(`${table}: TENANT_SCOPE_COLUMNS lists [${listed}] but the schema has [${found}]`);
        }
      }
      expect(mismatches).toEqual([]);
    });
  },
);

function expectedColumns(table: TenantTable, present: ReadonlySet<string>): TenantScopeColumn[] {
  const identityColumns: TenantScopeColumn[] = table === 'accounts'
    ? ['id']
    : table === 'businesses'
      ? ['id', 'account_id']
      : ['account_id', 'business_id'];
  return identityColumns.filter((column) => present.has(column));
}
