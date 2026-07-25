import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import postgres from 'postgres';
import type postgresType from 'postgres';
import { describeWithDb } from '@/__tests__/helpers/describe-with-db';

function localTestDatabaseUrl(): string | undefined {
  if (process.env.TEST_DATABASE_POOL_URL) return process.env.TEST_DATABASE_POOL_URL;
  try {
    const raw = readFileSync(resolve(process.cwd(), '.env.local'), 'utf8');
    const line = raw.split('\n').find((candidate) =>
      /^\s*TEST_DATABASE_POOL_URL\s*=/.test(candidate),
    );
    return line
      ?.replace(/^\s*TEST_DATABASE_POOL_URL\s*=\s*/, '')
      .trim()
      .replace(/^["']|["']$/g, '');
  } catch {
    return undefined;
  }
}

const testDatabaseUrl = localTestDatabaseUrl();
// verify-gate runs changed integration files in separate processes against one DB.
// Keep this feature's schema setup and large fixture lifecycles from overlapping.
const FEATURE_543_DATABASE_LOCK_KEY = 'repworth_feature_543_integration';
const migrationPath = resolve(
  process.cwd(),
  'supabase/migrations/088_solicitation_batch_executor.sql',
);

let db: postgresType.Sql | undefined;
let featureDatabaseLock: postgresType.Sql | undefined;

function normalizeSql(value: string): string {
  return value.replace(/\s+/g, ' ').trim();
}

function readMigration088Sql(): string {
  return readFileSync(migrationPath, 'utf-8');
}

function assertLocalMigrationDatabaseUrl(databaseUrl: string): string {
  let parsed: URL;
  try {
    parsed = new URL(databaseUrl);
  } catch {
    throw new Error('migration 088 tests require a local (localhost) test database');
  }

  const isLocalPostgres =
    (parsed.protocol === 'postgres:' || parsed.protocol === 'postgresql:') &&
    (parsed.hostname === 'localhost' || parsed.hostname === '127.0.0.1');
  if (!isLocalPostgres) {
    throw new Error('migration 088 tests require a local (localhost) test database');
  }
  return databaseUrl;
}

async function releaseFeatureDatabaseLock(): Promise<void> {
  if (!featureDatabaseLock) return;
  const lock = featureDatabaseLock;
  featureDatabaseLock = undefined;
  try {
    await lock`
      SELECT pg_advisory_unlock(hashtext(${FEATURE_543_DATABASE_LOCK_KEY}))
    `;
  } finally {
    await lock.end({ timeout: 5 });
  }
}

describe('migration 088 checked-in SQL contract', () => {
  it('migration 088 widens the run spine and creates tenant-safe Solicitation batch tables', () => {
    expect(existsSync(migrationPath)).toBe(true);
    if (!existsSync(migrationPath)) return;

    const migrationSql = normalizeSql(readMigration088Sql());
    expect(migrationSql).toContain(normalizeSql(`
      ALTER TABLE agent_runs
        ADD COLUMN IF NOT EXISTS parent_run_id UUID
    `));
    expect(migrationSql).toContain(normalizeSql(`
      CREATE INDEX IF NOT EXISTS idx_agent_runs_parent_run
        ON agent_runs (parent_run_id)
        WHERE parent_run_id IS NOT NULL
    `));
    expect(migrationSql).toContain(
      "CHECK (kind IN ('review_handler', 'weekly_insights', 'solicitation_batch', 'solicitation_ask'))",
    );
    expect(migrationSql).toContain(
      "CHECK (subject_type IN ('review', 'account_week', 'solicitation_batch', 'solicitation_ask'))",
    );
    expect(migrationSql).toContain(
      "(kind = 'solicitation_batch' AND subject_type = 'solicitation_batch')",
    );
    expect(migrationSql).toContain(
      "(kind = 'solicitation_ask' AND subject_type = 'solicitation_ask')",
    );
    expect(migrationSql).toContain(
      "CHECK (attributed_agent IN ('reply', 'guardian', 'insights', 'solicitation', 'system'))",
    );
    expect(migrationSql).toContain("'solicitation_batch_built'");
    expect(migrationSql).toContain(
      "CHECK (unit_count > 0 OR (outcome_kind = 'solicitation_batch_built' AND unit_count = 0))",
    );
    expect(migrationSql).toContain('CREATE TABLE IF NOT EXISTS solicitation_batches');
    expect(migrationSql).toContain('CREATE TABLE IF NOT EXISTS solicitation_asks');
    expect(migrationSql).toContain(
      'CONSTRAINT solicitation_batches_source_upload_uniq UNIQUE (source_upload_id)',
    );
    expect(migrationSql).toContain(
      'CONSTRAINT solicitation_asks_batch_contact_uniq UNIQUE (batch_id, contact_id)',
    );
    expect(migrationSql).toContain(
      'agent_run_id UUID REFERENCES agent_runs(id) ON DELETE SET NULL',
    );
    expect(migrationSql).toContain(
      'CREATE POLICY solicitation_batches_owner_select ON solicitation_batches FOR SELECT TO authenticated USING (account_id = owner_account_id() AND built_at IS NOT NULL)',
    );
    expect(migrationSql).not.toMatch(
      /DROP\s+INDEX(?:\s+IF\s+EXISTS)?\s+agent_runs_one_active_per_subject/i,
    );
    expect(migrationSql).not.toMatch(
      /(?:DROP|ADD)\s+CONSTRAINT(?:\s+IF\s+EXISTS)?\s+agent_runs_status_check/i,
    );
  });

  it('refuses to connect migration tests to a remote Postgres host', () => {
    expect(() =>
      assertLocalMigrationDatabaseUrl(
        'postgresql://test:test@db.example.supabase.co:5432/postgres',
      ),
    ).toThrow('migration 088 tests require a local (localhost) test database');
  });
});

describeWithDb(
  'migration 088 live catalog contract',
  { enabled: Boolean(testDatabaseUrl), timeout: 30_000 },
  () => {
  beforeAll(async () => {
    const databaseUrl = assertLocalMigrationDatabaseUrl(testDatabaseUrl!);
    featureDatabaseLock = postgres(databaseUrl, { max: 1, prepare: false });
    await featureDatabaseLock`
      SELECT pg_advisory_lock(hashtext(${FEATURE_543_DATABASE_LOCK_KEY}))
    `;
    db = postgres(databaseUrl, {
      max: 1,
      prepare: false,
    });
    await db.unsafe(readMigration088Sql());
    await db.unsafe(readMigration088Sql());
  }, 120_000);

  afterAll(async () => {
    try {
      if (db) await db.end({ timeout: 5 });
    } finally {
      await releaseFeatureDatabaseLock();
    }
  }, 120_000);

  it('keeps the active-run predicate and three-state status enum exact', async () => {
    const [activeIndex] = await db!<{ predicate: string | null }[]>`
      SELECT pg_get_expr(i.indpred, i.indrelid) AS predicate
      FROM pg_index i
      JOIN pg_class idx ON idx.oid = i.indexrelid
      WHERE idx.relname = 'agent_runs_one_active_per_subject'
    `;
    expect(activeIndex?.predicate).toBe("(status = 'running'::text)");

    const [statusConstraint] = await db!<{ definition: string }[]>`
      SELECT pg_get_constraintdef(oid) AS definition
      FROM pg_constraint
      WHERE conrelid = 'agent_runs'::regclass
        AND conname = 'agent_runs_status_check'
    `;
    expect(statusConstraint?.definition).toContain(
      "ARRAY['running'::text, 'completed'::text, 'failed'::text]",
    );
  });

  it('pins tenant-composite, idempotency, archival, history, and zero-unit catalog facts', async () => {
    const constraints = await db!<{ constraint_name: string; definition: string }[]>`
      SELECT conname AS constraint_name, pg_get_constraintdef(oid) AS definition
      FROM pg_constraint
      WHERE conname IN (
        'agent_runs_parent_run_id_fkey',
        'agent_outcomes_unit_count_check',
        'solicitation_batches_source_upload_uniq',
        'solicitation_batches_business_account_fk',
        'solicitation_batches_source_upload_tenant_fk',
        'solicitation_asks_batch_contact_uniq',
        'solicitation_asks_business_account_fk',
        'solicitation_asks_batch_tenant_fk',
        'solicitation_asks_contact_business_fk',
        'solicitation_asks_agent_run_id_fkey'
      )
      ORDER BY conname
    `;
    const definition = new Map(
      constraints.map((constraint) => [
        constraint.constraint_name,
        normalizeSql(constraint.definition),
      ]),
    );

    expect(definition.get('agent_runs_parent_run_id_fkey')).toContain(
      'FOREIGN KEY (parent_run_id) REFERENCES agent_runs(id) ON DELETE SET NULL',
    );
    expect(definition.get('agent_outcomes_unit_count_check')).toContain(
      "outcome_kind = 'solicitation_batch_built'::text",
    );
    expect(definition.get('solicitation_batches_source_upload_uniq')).toBe(
      'UNIQUE (source_upload_id)',
    );
    expect(definition.get('solicitation_batches_business_account_fk')).toContain(
      'FOREIGN KEY (business_id, account_id) REFERENCES businesses(id, account_id) ON DELETE CASCADE',
    );
    expect(definition.get('solicitation_batches_source_upload_tenant_fk')).toContain(
      'FOREIGN KEY (source_upload_id, account_id, business_id) REFERENCES contact_csv_uploads(id, account_id, business_id) ON DELETE CASCADE',
    );
    expect(definition.get('solicitation_asks_batch_contact_uniq')).toBe(
      'UNIQUE (batch_id, contact_id)',
    );
    expect(definition.get('solicitation_asks_business_account_fk')).toContain(
      'FOREIGN KEY (business_id, account_id) REFERENCES businesses(id, account_id) ON DELETE CASCADE',
    );
    expect(definition.get('solicitation_asks_batch_tenant_fk')).toContain(
      'FOREIGN KEY (batch_id, account_id, business_id) REFERENCES solicitation_batches(id, account_id, business_id) ON DELETE CASCADE',
    );
    expect(definition.get('solicitation_asks_contact_business_fk')).toContain(
      'FOREIGN KEY (contact_id, business_id) REFERENCES solicitation_contacts(id, business_id) ON DELETE CASCADE',
    );
    expect(definition.get('solicitation_asks_agent_run_id_fkey')).toContain(
      'FOREIGN KEY (agent_run_id) REFERENCES agent_runs(id) ON DELETE SET NULL',
    );

    const indexes = await db!<{ indexname: string; indexdef: string }[]>`
      SELECT indexname, indexdef
      FROM pg_indexes
      WHERE schemaname = 'public'
        AND indexname IN (
          'idx_agent_runs_parent_run',
          'idx_solicitation_contacts_business_candidate',
          'idx_solicitation_visits_business_contact_latest',
          'idx_solicitation_asks_business_contact_decided',
          'idx_solicitation_asks_business_contact_send',
          'idx_solicitation_asks_agent_run'
        )
      ORDER BY indexname
    `;
    const indexDefinitions = new Map(
      indexes.map((index) => [index.indexname, index.indexdef]),
    );
    expect(indexDefinitions.get('idx_agent_runs_parent_run')).toContain(
      'WHERE (parent_run_id IS NOT NULL)',
    );
    expect(indexDefinitions.get('idx_solicitation_contacts_business_candidate')).toContain(
      '(business_id, id)',
    );
    expect(indexDefinitions.get('idx_solicitation_visits_business_contact_latest')).toContain(
      '(business_id, contact_id, visit_date DESC, upload_id)',
    );
    expect(indexDefinitions.get('idx_solicitation_asks_business_contact_decided')).toContain(
      '(business_id, contact_id, decided_at DESC)',
    );
    expect(indexDefinitions.get('idx_solicitation_asks_business_contact_send')).toContain(
      "WHERE (status = 'send'::text)",
    );
    expect(indexDefinitions.get('idx_solicitation_asks_agent_run')).toContain(
      'WHERE (agent_run_id IS NOT NULL)',
    );

    const idColumns = await db!<{ table_name: string; column_default: string | null }[]>`
      SELECT table_name, column_default
      FROM information_schema.columns
      WHERE table_schema = 'public'
        AND table_name IN ('solicitation_batches', 'solicitation_asks')
        AND column_name = 'id'
      ORDER BY table_name
    `;
    expect(idColumns).toEqual([
      { table_name: 'solicitation_asks', column_default: null },
      { table_name: 'solicitation_batches', column_default: null },
    ]);
  });

  it('creates owner-readable batch policies with partial batches hidden at the policy', async () => {
    const policies = await db!<
      { tablename: string; policyname: string; cmd: string; qual: string | null }[]
    >`
      SELECT tablename, policyname, cmd, qual
      FROM pg_policies
      WHERE schemaname = 'public'
        AND tablename IN ('solicitation_batches', 'solicitation_asks')
      ORDER BY tablename, policyname
    `;

    expect(policies).toEqual([
      expect.objectContaining({
        tablename: 'solicitation_asks',
        policyname: 'solicitation_asks_owner_select',
        cmd: 'SELECT',
      }),
      expect.objectContaining({
        tablename: 'solicitation_batches',
        policyname: 'solicitation_batches_owner_select',
        cmd: 'SELECT',
        qual: expect.stringContaining('(built_at IS NOT NULL)'),
      }),
    ]);
  });
  },
);
