import postgres from 'postgres';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

export interface RlsRow {
  relname: string;
  relrowsecurity: boolean;
}

export const REQUIRED_RLS_TABLES = [
  'businesses',
  'reviews',
  'responses',
  'approval_links',
  'notification_deliveries',
  'api_costs',
  'review_exceptions',
  'ranking_snapshots',
  'approval_audit_log',
  'account_audit_log',
  'zernio_connections',
] as const;

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

async function main(): Promise<void> {
  const databaseUrl = process.env.TEST_DATABASE_POOL_URL ?? process.env.DATABASE_POOL_URL;
  if (!databaseUrl) {
    console.log('rls-audit: skipped because TEST_DATABASE_POOL_URL and DATABASE_POOL_URL are unset');
    return;
  }

  const sql = postgres(databaseUrl, { max: 1 });
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
      console.error('rls-audit: failed');
      for (const failure of failures) {
        console.error(failure);
      }
      process.exitCode = 1;
      return;
    }

    console.log('rls-audit: passed');
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
