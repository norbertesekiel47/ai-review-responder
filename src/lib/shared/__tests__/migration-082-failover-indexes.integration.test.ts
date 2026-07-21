import postgres from 'postgres';
import type postgresType from 'postgres';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { describeWithDb } from '@/__tests__/helpers/describe-with-db';

// Migration 082 adds two CREATE INDEX CONCURRENTLY partial indexes for the
// NotificationFailoverPoller lookups (correlation recovery + the two global
// pending_approval sweeps). Because the indexes are created CONCURRENTLY they
// cannot be reproduced inside a rollback-only transaction; this suite therefore
// asserts against the already-migrated test database — the objects must exist,
// carry the exact partial predicates the queries filter on, AND be valid/ready
// (an interrupted CONCURRENTLY build leaves an INVALID index that
// `IF NOT EXISTS` silently skips on re-run — the 062 lesson).

const testDatabaseUrl = process.env.TEST_DATABASE_POOL_URL;

let db: postgresType.Sql | undefined;

function assertLocalMigrationDatabaseUrl(databaseUrl: string): string {
  let parsed: URL;
  try {
    parsed = new URL(databaseUrl);
  } catch {
    throw new Error('migration 082 tests require a local (localhost) test database');
  }

  const isLocalPostgres =
    (parsed.protocol === 'postgres:' || parsed.protocol === 'postgresql:') &&
    (parsed.hostname === 'localhost' || parsed.hostname === '127.0.0.1');

  if (!isLocalPostgres) {
    throw new Error('migration 082 tests require a local (localhost) test database');
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
  if (!db) throw new Error('migration 082 integration database was not initialized');
  return db;
}

interface IndexCatalogRow {
  indexname: string;
  indexdef: string;
  predicate: string | null;
  indisvalid: boolean;
  indisready: boolean;
}

async function fetchIndexCatalogRow(indexName: string): Promise<IndexCatalogRow | undefined> {
  const [row] = await sql()<IndexCatalogRow[]>`
    SELECT
      idx.relname AS indexname,
      pg_get_indexdef(i.indexrelid) AS indexdef,
      pg_get_expr(i.indpred, i.indrelid) AS predicate,
      i.indisvalid,
      i.indisready
    FROM pg_index i
    JOIN pg_class idx ON idx.oid = i.indexrelid
    JOIN pg_class tbl ON tbl.oid = i.indrelid
    JOIN pg_namespace ns ON ns.oid = tbl.relnamespace
    WHERE ns.nspname = 'public'
      AND idx.relname = ${indexName}
  `;
  return row;
}

describeWithDb('migration 082 failover lookup indexes', { timeout: 60_000 }, () => {
  beforeAll(() => {
    db = afterLocalMigrationDatabaseGuard(testDatabaseUrl!, (safeDatabaseUrl) =>
      postgres(safeDatabaseUrl, { max: 1, prepare: false }),
    );
  });

  afterAll(async () => {
    if (!db) return;
    await db.end({ timeout: 5 });
    db = undefined;
  });

  it('creates idx_jo_send_notification_by_aggregate valid+ready with the exact send_notification predicate', async () => {
    const index = await fetchIndexCatalogRow('idx_jo_send_notification_by_aggregate');

    expect(index).toBeDefined();
    expect(index?.indisvalid).toBe(true);
    expect(index?.indisready).toBe(true);
    expect(index?.predicate).toContain("topic = 'send_notification'");
    expect(index?.indexdef).toContain('(aggregate_id, created_at DESC)');
    expect(index?.indexdef).toContain('ON public.job_outbox');
  });

  it('creates idx_responses_pending_approval_created valid+ready with the exact pending_approval predicate', async () => {
    const index = await fetchIndexCatalogRow('idx_responses_pending_approval_created');

    expect(index).toBeDefined();
    expect(index?.indisvalid).toBe(true);
    expect(index?.indisready).toBe(true);
    expect(index?.predicate).toContain("status = 'pending_approval'");
    expect(index?.indexdef).toContain('(created_at)');
    expect(index?.indexdef).toContain('ON public.responses');
  });
});
