import postgres from 'postgres';
import { readdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { TENANT_TABLES } from './tenant-tables';

export interface RlsRow {
  relname: string;
  relrowsecurity: boolean;
}

export const REQUIRED_RLS_TABLES = TENANT_TABLES;

export function findRlsFailures(
  rows: RlsRow[],
  requiredTables: readonly string[] = REQUIRED_RLS_TABLES,
): string[] {
  const rowByTable = new Map(rows.map((row) => [row.relname, row]));

  return requiredTables.flatMap((table) => {
    const row = rowByTable.get(table);
    if (!row) return [`${table} missing from pg_class result`];
    if (!row.relrowsecurity) return [`${table} has RLS disabled`];
    return [];
  });
}

const MIGRATIONS_DIR = resolve(process.cwd(), 'supabase/migrations');

const ENABLE_RLS_RE =
  /ALTER\s+TABLE\s+(?:public\.)?"?([a-z_][a-z0-9_]*)"?\s+ENABLE\s+ROW\s+LEVEL\s+SECURITY/gi;

/**
 * Tables that receive `ENABLE ROW LEVEL SECURITY` anywhere in the given
 * migration SQL. Pure over its input, so the coverage gate is unit-testable
 * without a database.
 */
export function collectRlsEnabledTables(migrationsSql: readonly string[]): Set<string> {
  const enabled = new Set<string>();
  for (const sql of migrationsSql) {
    for (const match of sql.matchAll(ENABLE_RLS_RE)) {
      enabled.add(match[1]);
    }
  }
  return enabled;
}

/**
 * Required tenant tables that have no `ENABLE ROW LEVEL SECURITY` in any
 * migration. This is the DB-free gate: it catches a new TENANT_TABLES entry (or
 * a migration) that forgets to enable RLS — a regression a live-DB check would
 * miss entirely whenever no database is reachable.
 */
export function findRlsCoverageFailures(
  enabledTables: ReadonlySet<string>,
  requiredTables: readonly string[] = REQUIRED_RLS_TABLES,
): string[] {
  return requiredTables.flatMap((table) =>
    enabledTables.has(table)
      ? []
      : [`${table} has no ENABLE ROW LEVEL SECURITY in any migration`],
  );
}

function readMigrationsSql(dir: string = MIGRATIONS_DIR): string[] {
  return readdirSync(dir)
    .filter((file) => file.endsWith('.sql'))
    .map((file) => readFileSync(join(dir, file), 'utf8'));
}

async function main(): Promise<void> {
  // 1. Static coverage gate — runs with no database and is the authoritative CI
  //    check. Every TENANT_TABLES entry must enable RLS in some migration.
  const coverageFailures = findRlsCoverageFailures(
    collectRlsEnabledTables(readMigrationsSql()),
  );
  if (coverageFailures.length > 0) {
    console.error('rls-audit: static RLS coverage failed');
    for (const failure of coverageFailures) {
      console.error(failure);
    }
    process.exitCode = 1;
    return;
  }
  console.log(
    `rls-audit: static coverage passed (${REQUIRED_RLS_TABLES.length} tenant tables enable RLS in migrations)`,
  );

  // 2. Live relrowsecurity check — only when an explicit test database is
  //    provided. We require TEST_DATABASE_POOL_URL (not the always-present
  //    DATABASE_POOL_URL placeholder) so CI runs the static gate without
  //    attempting a connection. The gate above already fails closed when no DB
  //    is available, so this path can never silently pass.
  const databaseUrl = process.env.TEST_DATABASE_POOL_URL;
  if (!databaseUrl) {
    console.log(
      'rls-audit: live DB check skipped (TEST_DATABASE_POOL_URL unset); static coverage gate enforced above',
    );
    return;
  }

  const sql = postgres(databaseUrl, { max: 1, prepare: false });
  try {
    const rows = await sql<RlsRow[]>`
      SELECT c.relname, c.relrowsecurity
      FROM pg_class c
      JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = 'public'
        AND c.relkind IN ('r', 'p')
    `;
    const failures = findRlsFailures(rows);
    if (failures.length > 0) {
      console.error('rls-audit: live DB check failed');
      for (const failure of failures) {
        console.error(failure);
      }
      process.exitCode = 1;
      return;
    }

    console.log('rls-audit: live DB check passed');
  } finally {
    await sql.end({ timeout: 5 });
  }
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  main().catch((err) => {
    console.error('rls-audit: fatal error');
    console.error(err);
    process.exit(1);
  });
}
