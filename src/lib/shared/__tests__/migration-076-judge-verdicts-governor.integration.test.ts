import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import postgres from 'postgres';
import type postgresType from 'postgres';
import { describeWithDb } from '@/__tests__/helpers/describe-with-db';
import {
  acquireLiveDbLock,
  assertLocalTestDatabaseUrl,
  LIVE_DB_LOCK_HOOK_TIMEOUT_MS,
  type LiveDbLock,
} from '@/lib/shared/__tests__/helpers/live-db-lock';

// Live-DB shape suite for migration 076 (WS6 judge + governor, spec
// 2026-07-13-ws6-judge-governor-design.md §2.3). The suite applies the
// additive migration before inspecting the catalog, then applies it again to
// prove the checked-in SQL is re-runnable. Gated on TEST_DATABASE_POOL_URL;
// skips cleanly without one.
const testDatabaseUrl = process.env.TEST_DATABASE_POOL_URL;
const migrationPath = resolve(
  process.cwd(),
  'supabase/migrations/076_judge_verdicts_governor.sql',
);

let db: postgresType.Sql | undefined;
let liveDbLock: LiveDbLock | undefined;

// Local-host refusal guard: any localhost/127.0.0.1 Postgres is accepted (the
// dev container on 5499 AND the CI service container on 5432), everything
// else — notably any Supabase/pooler host — is refused. Never widen this to
// remote hosts.
function assertLocalMigrationDatabaseUrl(databaseUrl: string): string {
  let parsed: URL;
  try {
    parsed = new URL(databaseUrl);
  } catch {
    throw new Error('migration 076 tests require a local (localhost) test database');
  }

  const isLocalPostgres =
    (parsed.protocol === 'postgres:' || parsed.protocol === 'postgresql:') &&
    (parsed.hostname === 'localhost' || parsed.hostname === '127.0.0.1');

  if (!isLocalPostgres) {
    throw new Error('migration 076 tests require a local (localhost) test database');
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
  if (!db) throw new Error('migration 076 integration database was not initialized');
  return db;
}

function readMigration076Sql(): string {
  return readFileSync(migrationPath, 'utf-8');
}

function normalizeSql(value: string): string {
  return value.replace(/\s+/g, ' ').trim();
}

function stripSqlLineComments(value: string): string {
  return value.replace(/--.*$/gm, '');
}

describe('migration 076 checked-in SQL safety', () => {
  it('accepts local-host test containers and rejects remote/pooler variants', () => {
    for (const localUrl of [
      'postgresql://test:test@localhost:5499/test_ws4',
      'postgres://test:test@127.0.0.1:5499/test_ws4',
      // The CI service container (different port/db/user — still localhost).
      'postgres://test:test@localhost:5432/test',
      'postgresql://test:test@localhost:5499/test_ws4?sslmode=disable',
    ]) {
      expect(assertLocalMigrationDatabaseUrl(localUrl)).toBe(localUrl);
    }

    for (const unsafeUrl of [
      'postgresql://test:test@db.example.supabase.co:5432/test_ws4',
      'postgresql://test:test@aws-0-us-west-1.pooler.supabase.com:6543/postgres',
      'postgresql://test:test@db.internal:5499/test_ws4',
      'mysql://test:test@localhost:5499/test_ws4',
      'not-a-database-url',
    ]) {
      expect(() => assertLocalMigrationDatabaseUrl(unsafeUrl)).toThrow(
        'migration 076 tests require a local (localhost) test database',
      );
    }
  });

  it('rejects an unsafe URL before invoking the database connector', () => {
    const connect = vi.fn();

    expect(() =>
      afterLocalMigrationDatabaseGuard(
        'postgresql://test:test@db.example.supabase.co:5432/test_ws4',
        connect,
      ),
    ).toThrow('migration 076 tests require a local (localhost) test database');
    expect(connect).not.toHaveBeenCalled();
  });

  it('pins every critical table, security, and index statement in the migration source', () => {
    const migrationSql = normalizeSql(readMigration076Sql());
    const requiredStatements = [
      `
        CREATE TABLE IF NOT EXISTS judge_verdicts (
          id UUID PRIMARY KEY,
          account_id UUID NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
          business_id UUID NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
          review_id UUID NOT NULL REFERENCES reviews(id) ON DELETE CASCADE,
          response_id UUID NOT NULL REFERENCES responses(id) ON DELETE CASCADE,
          agent_run_id UUID NULL REFERENCES agent_runs(id) ON DELETE SET NULL,
          verdict TEXT NOT NULL CHECK (verdict IN ('pass', 'warn', 'flag', 'error')),
          reasons JSONB NULL,
          rationale TEXT NULL,
          model TEXT NOT NULL,
          prompt_version TEXT NOT NULL,
          created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          UNIQUE (response_id)
        );
      `,
      `CREATE INDEX IF NOT EXISTS idx_judge_verdicts_account_created ON judge_verdicts (account_id, created_at DESC);`,
      `CREATE INDEX IF NOT EXISTS idx_judge_verdicts_created ON judge_verdicts (created_at DESC);`,
      `CREATE INDEX IF NOT EXISTS idx_judge_verdicts_business ON judge_verdicts (business_id);`,
      `CREATE INDEX IF NOT EXISTS idx_judge_verdicts_review ON judge_verdicts (review_id);`,
      `CREATE INDEX IF NOT EXISTS idx_judge_verdicts_agent_run ON judge_verdicts (agent_run_id) WHERE agent_run_id IS NOT NULL;`,
      `ALTER TABLE judge_verdicts ENABLE ROW LEVEL SECURITY;`,
      `REVOKE INSERT, UPDATE, DELETE ON judge_verdicts FROM authenticated;`,
      `CREATE INDEX IF NOT EXISTS idx_responses_auto_policy_posted ON responses (posted_at DESC) WHERE status = 'posted' AND approval_method = 'auto_policy';`,
      `CREATE UNIQUE INDEX IF NOT EXISTS idx_jo_judge_verdict_inflight ON job_outbox (topic, aggregate_id) WHERE topic = 'judge_verdict' AND status IN ('pending', 'dispatching', 'dispatched');`,
      `ALTER TABLE notification_deliveries ADD COLUMN IF NOT EXISTS entity_id UUID;`,
      `CREATE UNIQUE INDEX IF NOT EXISTS notification_deliveries_autonomy_suspended_claim ON notification_deliveries (entity_id, channel, recipient) WHERE entity_id IS NOT NULL AND template = 'autonomy_suspended_notice';`,
      `CREATE UNIQUE INDEX IF NOT EXISTS idx_jo_autonomy_suspended_notice_inflight ON job_outbox (topic, aggregate_id) WHERE topic = 'autonomy_suspended_notice' AND status IN ('pending', 'dispatching', 'dispatched');`,
      `CREATE UNIQUE INDEX IF NOT EXISTS idx_jo_autonomy_admin_alert_inflight ON job_outbox (topic, aggregate_id) WHERE topic = 'autonomy_admin_alert' AND status IN ('pending', 'dispatching', 'dispatched');`,
    ];

    for (const statement of requiredStatements) {
      expect(migrationSql).toContain(normalizeSql(statement));
    }
    expect(normalizeSql(stripSqlLineComments(readMigration076Sql()))).not.toMatch(
      /\bCONCURRENTLY\b/,
    );
  });
});

describeWithDb('migration 076 judge verdicts + governor — shape', { timeout: 30_000 }, () => {
  beforeAll(async () => {
    // Enrolled in the cross-process live-DB lock: this suite applies real DDL
    // (ACCESS EXCLUSIVE), which deadlocks against a sibling suite's row locks
    // when the two run in concurrent vitest processes (#573).
    liveDbLock = await acquireLiveDbLock(assertLocalTestDatabaseUrl(testDatabaseUrl));
    db = afterLocalMigrationDatabaseGuard(testDatabaseUrl!, (safeDatabaseUrl) =>
      postgres(safeDatabaseUrl, { max: 1, prepare: false }),
    );
    await sql().unsafe(readMigration076Sql());
  }, LIVE_DB_LOCK_HOOK_TIMEOUT_MS);

  afterAll(async () => {
    try {
      if (db) await db.end({ timeout: 5 });
    } finally {
      await liveDbLock?.release();
      liveDbLock = undefined;
    }
  });

  it('creates judge_verdicts with the exact column contract', async () => {
    const columns = await sql()<
      {
        column_name: string;
        data_type: string;
        is_nullable: 'YES' | 'NO';
        column_default: string | null;
      }[]
    >`
      SELECT column_name, data_type, is_nullable, column_default
      FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = 'judge_verdicts'
      ORDER BY ordinal_position
    `;

    expect(columns).toEqual([
      { column_name: 'id', data_type: 'uuid', is_nullable: 'NO', column_default: null },
      {
        column_name: 'account_id',
        data_type: 'uuid',
        is_nullable: 'NO',
        column_default: null,
      },
      {
        column_name: 'business_id',
        data_type: 'uuid',
        is_nullable: 'NO',
        column_default: null,
      },
      {
        column_name: 'review_id',
        data_type: 'uuid',
        is_nullable: 'NO',
        column_default: null,
      },
      {
        column_name: 'response_id',
        data_type: 'uuid',
        is_nullable: 'NO',
        column_default: null,
      },
      {
        column_name: 'agent_run_id',
        data_type: 'uuid',
        is_nullable: 'YES',
        column_default: null,
      },
      {
        column_name: 'verdict',
        data_type: 'text',
        is_nullable: 'NO',
        column_default: null,
      },
      {
        column_name: 'reasons',
        data_type: 'jsonb',
        is_nullable: 'YES',
        column_default: null,
      },
      {
        column_name: 'rationale',
        data_type: 'text',
        is_nullable: 'YES',
        column_default: null,
      },
      {
        column_name: 'model',
        data_type: 'text',
        is_nullable: 'NO',
        column_default: null,
      },
      {
        column_name: 'prompt_version',
        data_type: 'text',
        is_nullable: 'NO',
        column_default: null,
      },
      {
        column_name: 'created_at',
        data_type: 'timestamp with time zone',
        is_nullable: 'NO',
        column_default: 'now()',
      },
    ]);
  });

  it('pins the verdict domain, one-verdict uniqueness, and FK delete actions', async () => {
    const constraints = await sql()<
      { constraint_name: string; constraint_type: string; constraint_def: string }[]
    >`
      SELECT
        con.conname AS constraint_name,
        CASE con.contype
          WHEN 'p' THEN 'primary'
          WHEN 'u' THEN 'unique'
          WHEN 'c' THEN 'check'
          ELSE con.contype::text
        END AS constraint_type,
        pg_get_constraintdef(con.oid) AS constraint_def
      FROM pg_constraint con
      WHERE con.conrelid = 'public.judge_verdicts'::regclass
        AND con.contype IN ('p', 'u', 'c')
      ORDER BY con.conname
    `;

    expect(constraints).toEqual([
      {
        constraint_name: 'judge_verdicts_pkey',
        constraint_type: 'primary',
        constraint_def: 'PRIMARY KEY (id)',
      },
      {
        constraint_name: 'judge_verdicts_response_id_key',
        constraint_type: 'unique',
        constraint_def: 'UNIQUE (response_id)',
      },
      {
        constraint_name: 'judge_verdicts_verdict_check',
        constraint_type: 'check',
        constraint_def:
          "CHECK ((verdict = ANY (ARRAY['pass'::text, 'warn'::text, 'flag'::text, 'error'::text])))",
      },
    ]);

    const foreignKeys = await sql()<
      { column_name: string; referenced_table: string; delete_action: string }[]
    >`
      SELECT
        att.attname AS column_name,
        target.relname AS referenced_table,
        CASE con.confdeltype
          WHEN 'c' THEN 'cascade'
          WHEN 'n' THEN 'set null'
          ELSE con.confdeltype::text
        END AS delete_action
      FROM pg_constraint con
      JOIN pg_class target ON target.oid = con.confrelid
      JOIN pg_attribute att
        ON att.attrelid = con.conrelid AND att.attnum = con.conkey[1]
      WHERE con.conrelid = 'public.judge_verdicts'::regclass
        AND con.contype = 'f'
      ORDER BY att.attname
    `;

    expect(foreignKeys).toEqual([
      { column_name: 'account_id', referenced_table: 'accounts', delete_action: 'cascade' },
      {
        column_name: 'agent_run_id',
        referenced_table: 'agent_runs',
        delete_action: 'set null',
      },
      {
        column_name: 'business_id',
        referenced_table: 'businesses',
        delete_action: 'cascade',
      },
      { column_name: 'response_id', referenced_table: 'responses', delete_action: 'cascade' },
      { column_name: 'review_id', referenced_table: 'reviews', delete_action: 'cascade' },
    ]);
  });

  it('creates the two verdict lookup indexes in query order', async () => {
    const indexes = await sql()<{ indexname: string; indexdef: string }[]>`
      SELECT indexname, indexdef
      FROM pg_indexes
      WHERE schemaname = 'public'
        AND tablename = 'judge_verdicts'
        AND indexname IN (
          'idx_judge_verdicts_account_created',
          'idx_judge_verdicts_created'
        )
      ORDER BY indexname
    `;

    expect(indexes).toHaveLength(2);
    expect(indexes[0]!.indexdef).toContain('(account_id, created_at DESC)');
    expect(indexes[1]!.indexdef).toContain('(created_at DESC)');
  });

  it('creates RI-support indexes for every FK not covered by another leading key', async () => {
    const indexes = await sql()<
      { indexname: string; indexdef: string; predicate: string | null }[]
    >`
      SELECT
        idx.relname AS indexname,
        pg_get_indexdef(i.indexrelid) AS indexdef,
        pg_get_expr(i.indpred, i.indrelid) AS predicate
      FROM pg_index i
      JOIN pg_class idx ON idx.oid = i.indexrelid
      WHERE i.indrelid = 'public.judge_verdicts'::regclass
        AND idx.relname IN (
          'idx_judge_verdicts_business',
          'idx_judge_verdicts_review',
          'idx_judge_verdicts_agent_run'
        )
      ORDER BY idx.relname
    `;
    const byName = new Map(indexes.map((index) => [index.indexname, index]));

    expect(indexes).toHaveLength(3);
    expect(byName.get('idx_judge_verdicts_business')).toMatchObject({
      predicate: null,
    });
    expect(byName.get('idx_judge_verdicts_business')!.indexdef).toContain('(business_id)');
    expect(byName.get('idx_judge_verdicts_review')).toMatchObject({ predicate: null });
    expect(byName.get('idx_judge_verdicts_review')!.indexdef).toContain('(review_id)');
    expect(byName.get('idx_judge_verdicts_agent_run')).toMatchObject({
      predicate: '(agent_run_id IS NOT NULL)',
    });
    expect(byName.get('idx_judge_verdicts_agent_run')!.indexdef).toContain('(agent_run_id)');
  });

  it('creates all five partial indexes with exact predicates', async () => {
    const indexes = await sql()<
      { indexname: string; indexdef: string; predicate: string }[]
    >`
      SELECT
        idx.relname AS indexname,
        pg_get_indexdef(i.indexrelid) AS indexdef,
        pg_get_expr(i.indpred, i.indrelid) AS predicate
      FROM pg_index i
      JOIN pg_class idx ON idx.oid = i.indexrelid
      JOIN pg_class tbl ON tbl.oid = i.indrelid
      JOIN pg_namespace ns ON ns.oid = tbl.relnamespace
      WHERE ns.nspname = 'public'
        AND idx.relname IN (
          'idx_responses_auto_policy_posted',
          'idx_jo_judge_verdict_inflight',
          'notification_deliveries_autonomy_suspended_claim',
          'idx_jo_autonomy_suspended_notice_inflight',
          'idx_jo_autonomy_admin_alert_inflight'
        )
      ORDER BY idx.relname
    `;
    const byName = new Map(indexes.map((index) => [index.indexname, index]));

    expect(indexes).toHaveLength(5);
    expect(byName.get('idx_responses_auto_policy_posted')).toMatchObject({
      predicate:
        "((status = 'posted'::text) AND (approval_method = 'auto_policy'::text))",
    });
    expect(byName.get('idx_responses_auto_policy_posted')!.indexdef).toContain(
      '(posted_at DESC)',
    );

    for (const [indexName, topic] of [
      ['idx_jo_judge_verdict_inflight', 'judge_verdict'],
      ['idx_jo_autonomy_suspended_notice_inflight', 'autonomy_suspended_notice'],
      ['idx_jo_autonomy_admin_alert_inflight', 'autonomy_admin_alert'],
    ] as const) {
      expect(byName.get(indexName)).toMatchObject({
        predicate: `((topic = '${topic}'::text) AND (status = ANY (ARRAY['pending'::text, 'dispatching'::text, 'dispatched'::text])))`,
      });
      expect(byName.get(indexName)!.indexdef).toContain('UNIQUE');
      expect(byName.get(indexName)!.indexdef).toContain('(topic, aggregate_id)');
    }

    expect(byName.get('notification_deliveries_autonomy_suspended_claim')).toMatchObject({
      predicate:
        "((entity_id IS NOT NULL) AND (template = 'autonomy_suspended_notice'::text))",
    });
    expect(
      byName.get('notification_deliveries_autonomy_suspended_claim')!.indexdef,
    ).toContain('UNIQUE');
    expect(
      byName.get('notification_deliveries_autonomy_suspended_claim')!.indexdef,
    ).toContain('(entity_id, channel, recipient)');
  });

  it('enables deny-all RLS and revokes authenticated writes', async () => {
    const [security] = await sql()<
      {
        rls_enabled: boolean;
        policy_count: string;
        can_insert: boolean;
        can_update: boolean;
        can_delete: boolean;
      }[]
    >`
      SELECT
        cls.relrowsecurity AS rls_enabled,
        (
          SELECT count(*)::text
          FROM pg_policies
          WHERE schemaname = 'public' AND tablename = 'judge_verdicts'
        ) AS policy_count,
        has_table_privilege('authenticated', 'public.judge_verdicts', 'INSERT') AS can_insert,
        has_table_privilege('authenticated', 'public.judge_verdicts', 'UPDATE') AS can_update,
        has_table_privilege('authenticated', 'public.judge_verdicts', 'DELETE') AS can_delete
      FROM pg_class cls
      WHERE cls.oid = 'public.judge_verdicts'::regclass
    `;

    expect(security).toEqual({
      rls_enabled: true,
      policy_count: '0',
      can_insert: false,
      can_update: false,
      can_delete: false,
    });
  });

  it('adds nullable notification_deliveries.entity_id', async () => {
    const [column] = await sql()<
      { data_type: string; is_nullable: 'YES' | 'NO'; column_default: string | null }[]
    >`
      SELECT data_type, is_nullable, column_default
      FROM information_schema.columns
      WHERE table_schema = 'public'
        AND table_name = 'notification_deliveries'
        AND column_name = 'entity_id'
    `;

    expect(column).toEqual({ data_type: 'uuid', is_nullable: 'YES', column_default: null });
  });

  it('applies cleanly a second time without duplicating schema objects', async () => {
    await expect(sql().unsafe(readMigration076Sql())).resolves.not.toThrow();

    const [indexCount] = await sql()<{ count: string }[]>`
      SELECT count(*)::text AS count
      FROM pg_indexes
      WHERE schemaname = 'public'
        AND indexname IN (
          'idx_judge_verdicts_account_created',
          'idx_judge_verdicts_created',
          'idx_judge_verdicts_business',
          'idx_judge_verdicts_review',
          'idx_judge_verdicts_agent_run',
          'idx_responses_auto_policy_posted',
          'idx_jo_judge_verdict_inflight',
          'notification_deliveries_autonomy_suspended_claim',
          'idx_jo_autonomy_suspended_notice_inflight',
          'idx_jo_autonomy_admin_alert_inflight'
        )
    `;
    expect(indexCount?.count).toBe('10');

    const [tableCount] = await sql()<{ count: string }[]>`
      SELECT count(*)::text AS count
      FROM information_schema.tables
      WHERE table_schema = 'public' AND table_name = 'judge_verdicts'
    `;
    expect(tableCount?.count).toBe('1');
  });
});
