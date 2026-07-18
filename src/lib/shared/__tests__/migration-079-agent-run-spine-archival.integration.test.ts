import postgres from 'postgres';
import type postgresType from 'postgres';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { describeWithDb } from '@/__tests__/helpers/describe-with-db';

// Migration 079 adds two CREATE INDEX CONCURRENTLY archival-scan indexes for
// the ArchivalPoller agent-run-spine retention arms (migration 071 spine).
// Because the indexes are created CONCURRENTLY they cannot be reproduced inside
// a rollback-only transaction; this suite therefore asserts against the
// already-migrated test database — the objects must exist and carry the exact
// shape the retention scans depend on (leading column, partial predicate, and
// the ON DELETE CASCADE that lets agent_run_steps prune with their parent run).

const testDatabaseUrl = process.env.TEST_DATABASE_POOL_URL;

let db: postgresType.Sql | undefined;

function assertLocalMigrationDatabaseUrl(databaseUrl: string): string {
  let parsed: URL;
  try {
    parsed = new URL(databaseUrl);
  } catch {
    throw new Error('migration 079 tests require a local (localhost) test database');
  }

  const isLocalPostgres =
    (parsed.protocol === 'postgres:' || parsed.protocol === 'postgresql:') &&
    (parsed.hostname === 'localhost' || parsed.hostname === '127.0.0.1');

  if (!isLocalPostgres) {
    throw new Error('migration 079 tests require a local (localhost) test database');
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
  if (!db) throw new Error('migration 079 integration database was not initialized');
  return db;
}

describeWithDb('migration 079 agent-run-spine archival indexes', { timeout: 60_000 }, () => {
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

  it('creates idx_agent_outcomes_archival leading with occurred_at on agent_outcomes', async () => {
    const [index] = await sql()<{ indexdef: string }[]>`
      SELECT indexdef
      FROM pg_indexes
      WHERE schemaname = 'public'
        AND tablename = 'agent_outcomes'
        AND indexname = 'idx_agent_outcomes_archival'
    `;

    expect(index).toBeDefined();
    expect(index?.indexdef).toContain('occurred_at');
  });

  it('creates idx_agent_runs_archival as a partial index on ended_at WHERE ended_at IS NOT NULL', async () => {
    const [index] = await sql()<{ indexdef: string }[]>`
      SELECT indexdef
      FROM pg_indexes
      WHERE schemaname = 'public'
        AND tablename = 'agent_runs'
        AND indexname = 'idx_agent_runs_archival'
    `;

    expect(index).toBeDefined();
    expect(index?.indexdef).toContain('ended_at');
    expect(index?.indexdef).toContain('WHERE (ended_at IS NOT NULL)');
  });

  it('cascades agent_run_steps deletes from their parent agent_runs row', async () => {
    // Regression guard for the "no separate steps arm — steps prune via
    // cascade" decision: the agent_runs retention DELETE must transitively
    // remove agent_run_steps, so the FK confdeltype MUST be 'c' (CASCADE).
    const [constraint] = await sql()<{ confdeltype: string }[]>`
      SELECT c.confdeltype
      FROM pg_constraint c
      JOIN pg_class child ON child.oid = c.conrelid
      JOIN pg_class parent ON parent.oid = c.confrelid
      WHERE c.contype = 'f'
        AND child.relname = 'agent_run_steps'
        AND parent.relname = 'agent_runs'
    `;

    expect(constraint).toBeDefined();
    expect(constraint?.confdeltype).toBe('c');
  });
});
