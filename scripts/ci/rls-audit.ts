import postgres from 'postgres';
import { createHash } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { LIVE_DB_LOCK_KEY } from '../../src/lib/shared/__tests__/helpers/live-db-lock';
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
 *
 * Presence-only: a table enabled then later `DISABLE`d would still be counted.
 * The realistic regression (forgetting to enable) is caught here; a later
 * DISABLE is only caught by the live relrowsecurity check.
 */
export function collectRlsEnabledTables(migrationsSql: readonly string[]): Set<string> {
  const enabled = new Set<string>();
  for (const sql of migrationsSql) {
    for (const match of sql.matchAll(ENABLE_RLS_RE)) {
      const table = match[1];
      if (table) enabled.add(table);
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

export function readMigrationsSql(dir: string = MIGRATIONS_DIR): string[] {
  return readdirSync(dir)
    .filter((file) => file.endsWith('.sql'))
    .map((file) => readFileSync(join(dir, file), 'utf8'));
}

function reportFailures(label: string, failures: readonly string[]): void {
  console.error(`rls-audit: ${label} failed`);
  for (const failure of failures) {
    console.error(failure);
  }
}

// ---------------------------------------------------------------------------
// Provisioning coordination (#877). The live check joins the same advisory
// protocol as scripts/test-db-setup.sh (exclusive) and the DDL suites
// (exclusive, via live-db-lock.ts): a SHARED acquisition on the same key, so
// this read can never observe a half-dropped schema — the class of failure
// that produced 20+ bogus "missing from pg_class" lines on #865.

/** Bounds both the shared-lock wait and the queries on the audit session. */
const LIVE_AUDIT_STATEMENT_TIMEOUT_MS = 240_000;

// Re-exported for the DB-free provisioning tests: importing the live-db-lock
// helper directly would mark them as live-DB suites (`ci:live-db-suites`
// counts that import as suite-shaped), and this audit is the key's
// shared-lock consumer anyway.
export { LIVE_DB_LOCK_KEY };

/** A minimal tagged-template query surface — what the helpers below need. */
export type LiveSql = (
  strings: TemplateStringsArray,
  ...params: unknown[]
) => Promise<Record<string, unknown>[]>;

export const PROVISION_MARKER_MISSING = 'provision_marker_missing';

/**
 * Hash of the ordered bootstrap + migration file contents — byte-for-byte the
 * value scripts/test-db-setup.sh records in `test_meta.provision`
 * (`cat bootstrap migrations… | shasum -a 256`). Hashing CONTENT rather than
 * the head filename means an edit to an existing migration or to the
 * bootstrap also reads as not-at-head.
 */
export function computeProvisionHash(orderedSqlContents: readonly string[]): string {
  const hash = createHash('sha256');
  for (const content of orderedSqlContents) hash.update(content);
  return hash.digest('hex');
}

export function expectedProvisionHash(): string {
  const bootstrap = readFileSync(
    resolve(process.cwd(), 'scripts/ci/test-db-bootstrap.sql'),
    'utf8',
  );
  const migrations = readdirSync(MIGRATIONS_DIR)
    .filter((file) => file.endsWith('.sql'))
    .sort()
    .map((file) => readFileSync(join(MIGRATIONS_DIR, file), 'utf8'));
  return computeProvisionHash([bootstrap, ...migrations]);
}

/**
 * Reads the provisioning marker. An absent `test_meta` schema (3F000), absent
 * table (42P01), or empty table all mean the same thing: no completed
 * provision — an interrupted run clears the marker before touching `public`
 * and rewrites it only as its final statement.
 */
export async function readProvisionMarker(
  sql: LiveSql,
): Promise<{ contentHash: string } | typeof PROVISION_MARKER_MISSING> {
  let rows: Record<string, unknown>[];
  try {
    rows = await sql`SELECT content_hash FROM test_meta.provision`;
  } catch (error) {
    const code = (error as { code?: string }).code;
    if (code === '3F000' || code === '42P01') return PROVISION_MARKER_MISSING;
    throw error;
  }
  const contentHash = rows[0]?.content_hash;
  return typeof contentHash === 'string' ? { contentHash } : PROVISION_MARKER_MISSING;
}

export function findProvisionFailure(
  marker: { contentHash: string } | typeof PROVISION_MARKER_MISSING,
  expectedHash: string,
): string | undefined {
  if (marker === PROVISION_MARKER_MISSING || marker.contentHash !== expectedHash) {
    return 'test DB provisioning incomplete or behind head — run pnpm test:db:setup';
  }
  return undefined;
}

/**
 * Runs `fn` holding the SHARED live-DB advisory lock, releasing it on every
 * path — an audit crash must never leave a shared hold that blocks the next
 * provisioning run for the session's lifetime.
 */
export async function withSharedLiveDbLock<T>(sql: LiveSql, fn: () => Promise<T>): Promise<T> {
  await sql`SELECT pg_advisory_lock_shared(hashtext(${LIVE_DB_LOCK_KEY}))`;
  try {
    return await fn();
  } finally {
    await sql`SELECT pg_advisory_unlock_shared(hashtext(${LIVE_DB_LOCK_KEY}))`;
  }
}

/**
 * Live relrowsecurity check against a real database. Owns the connection
 * lifecycle and returns the tables whose RLS is actually disabled or missing.
 * A missing or stale provisioning marker short-circuits to ONE actionable
 * line instead of a per-table failure flood.
 */
async function auditLiveRls(databaseUrl: string): Promise<string[]> {
  const sql = postgres(databaseUrl, {
    max: 1,
    prepare: false,
    connection: { statement_timeout: LIVE_AUDIT_STATEMENT_TIMEOUT_MS },
  });
  // postgres.js's Sql is structurally a LiveSql at runtime (tagged template →
  // thenable rows); its declared parameter types are narrower, hence the cast.
  const liveSql = sql as unknown as LiveSql;
  try {
    return await withSharedLiveDbLock(liveSql, async () => {
      const provisionFailure = findProvisionFailure(
        await readProvisionMarker(liveSql),
        expectedProvisionHash(),
      );
      if (provisionFailure) return [provisionFailure];

      const rows = await sql<RlsRow[]>`
        SELECT c.relname, c.relrowsecurity
        FROM pg_class c
        JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname = 'public'
          AND c.relkind IN ('r', 'p')
      `;
      return findRlsFailures(rows);
    });
  } finally {
    await sql.end({ timeout: 5 });
  }
}

async function main(): Promise<void> {
  // 1. Static coverage gate — DB-free and the authoritative CI check. Every
  //    TENANT_TABLES entry must enable RLS in some migration.
  const coverageFailures = findRlsCoverageFailures(
    collectRlsEnabledTables(readMigrationsSql()),
  );
  if (coverageFailures.length > 0) {
    reportFailures('static RLS coverage', coverageFailures);
    process.exitCode = 1;
    return;
  }
  console.log(
    `rls-audit: static coverage passed (${REQUIRED_RLS_TABLES.length} tenant tables enable RLS in migrations)`,
  );

  // 2. Live relrowsecurity check — only when an explicit test database is set.
  //    We require TEST_DATABASE_POOL_URL (not the always-present DATABASE_POOL_URL
  //    placeholder) so CI runs the static gate without attempting a connection.
  //    The gate above already fails closed, so this path can never silently pass.
  const databaseUrl = process.env.TEST_DATABASE_POOL_URL;
  if (!databaseUrl) {
    console.log(
      'rls-audit: live DB check skipped (TEST_DATABASE_POOL_URL unset); static coverage gate enforced above',
    );
    return;
  }

  const liveFailures = await auditLiveRls(databaseUrl);
  if (liveFailures.length > 0) {
    reportFailures('live DB check', liveFailures);
    process.exitCode = 1;
    return;
  }
  console.log('rls-audit: live DB check passed');
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  main().catch((err) => {
    console.error('rls-audit: fatal error');
    console.error(err);
    process.exit(1);
  });
}
