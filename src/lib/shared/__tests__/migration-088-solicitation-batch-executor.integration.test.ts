import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import postgres from 'postgres';
import type postgresType from 'postgres';
import { describeWithDb } from '@/__tests__/helpers/describe-with-db';
import {
  acquireLiveDbLock,
  assertLocalTestDatabaseUrl,
  LIVE_DB_LOCK_HOOK_TIMEOUT_MS,
  resolveTestDatabaseUrl,
  type LiveDbLock,
} from '@/lib/shared/__tests__/helpers/live-db-lock';
import {
  cleanupTenantAccount,
  seedTenantAccount,
} from '@/lib/shared/__tests__/live-db-tenant';

const testDatabaseUrl = resolveTestDatabaseUrl();
const migrationPath = resolve(
  process.cwd(),
  'supabase/migrations/088_solicitation_batch_executor.sql',
);

let db: postgresType.Sql | undefined;
let featureDatabaseLock: LiveDbLock | undefined;

function normalizeSql(value: string): string {
  return value.replace(/\s+/g, ' ').trim();
}

function readMigration088Sql(): string {
  return readFileSync(migrationPath, 'utf-8');
}

/** Rolls the 088 re-apply back without swallowing genuine failures. */
class RollbackAfterReapply extends Error {
  constructor() {
    super('088 re-apply probe complete — rolling back');
    this.name = 'RollbackAfterReapply';
  }
}

/**
 * The run-spine constraints 088 replaces (plus the one it deliberately leaves
 * alone), each of which a later migration may legitimately have widened on the
 * shared database.
 */
const SPINE_CONSTRAINTS = [
  ['agent_runs', 'agent_runs_kind_check'],
  ['agent_runs', 'agent_runs_kind_subject_type_pairing'],
  ['agent_runs', 'agent_runs_status_check'],
  ['agent_outcomes', 'agent_outcomes_outcome_kind_check'],
] as const;

type SqlExecutor = postgresType.Sql | postgresType.TransactionSql;

async function constraintDefinition(
  exec: SqlExecutor,
  table: string,
  name: string,
): Promise<string | undefined> {
  const [row] = await exec<{ definition: string }[]>`
    SELECT pg_get_constraintdef(oid) AS definition
    FROM pg_constraint
    WHERE conrelid = to_regclass(${`public.${table}`}) AND conname = ${name}
  `;
  return row === undefined ? undefined : normalizeSql(row.definition);
}

async function spineConstraintDefinitions(
  exec: SqlExecutor,
): Promise<Record<string, string | undefined>> {
  const definitions: Record<string, string | undefined> = {};
  for (const [table, name] of SPINE_CONSTRAINTS) {
    definitions[name] = await constraintDefinition(exec, table, name);
  }
  return definitions;
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
    expect(migrationSql).toContain(normalizeSql(`
      ADD CONSTRAINT agent_runs_account_business_id_uniq
      UNIQUE (account_id, business_id, id)
    `));
    expect(migrationSql).toContain(normalizeSql(`
      ADD CONSTRAINT agent_runs_parent_business_required
      CHECK (parent_run_id IS NULL OR business_id IS NOT NULL)
    `));
    expect(migrationSql).toContain(normalizeSql(`
      ADD CONSTRAINT agent_runs_parent_run_tenant_fkey
      FOREIGN KEY (account_id, business_id, parent_run_id)
      REFERENCES agent_runs (account_id, business_id, id)
      ON DELETE SET NULL (parent_run_id)
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
    expect(migrationSql).toContain(normalizeSql(`
      ADD CONSTRAINT solicitation_asks_agent_run_tenant_fkey
      FOREIGN KEY (account_id, business_id, agent_run_id)
      REFERENCES agent_runs (account_id, business_id, id)
      ON DELETE SET NULL (agent_run_id)
    `));
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
      assertLocalTestDatabaseUrl(
        'postgresql://test:test@db.example.supabase.co:5432/postgres',
      ),
    ).toThrow('live-DB integration requires a local (localhost) test database');
  });
});

describeWithDb(
  'migration 088 live catalog contract',
  { enabled: Boolean(testDatabaseUrl), timeout: 30_000 },
  () => {
  beforeAll(async () => {
    const databaseUrl = assertLocalTestDatabaseUrl(testDatabaseUrl);
    featureDatabaseLock = await acquireLiveDbLock(databaseUrl);
    // No migration SQL here on purpose. `pnpm test:db:setup` provisions the
    // shared database to head; 088's re-apply lives in its own test below,
    // inside a transaction that always rolls back, because 088 re-adds three
    // run-spine constraints at its own narrower text and committing that
    // silently reverts every later migration's widening (CLAUDE.md live-DB
    // rule: migration-shape suites "must roll back any unconditional re-apply").
    db = postgres(databaseUrl, {
      max: 1,
      prepare: false,
    });
  }, LIVE_DB_LOCK_HOOK_TIMEOUT_MS);

  afterAll(async () => {
    try {
      if (db) await db.end({ timeout: 5 });
    } finally {
      await featureDatabaseLock?.release();
      featureDatabaseLock = undefined;
    }
  }, 120_000);

  it('keeps the active-run predicate exact and never narrows the run-status enum', async () => {
    const [activeIndex] = await db!<{ predicate: string | null }[]>`
      SELECT pg_get_expr(i.indpred, i.indrelid) AS predicate
      FROM pg_index i
      JOIN pg_class idx ON idx.oid = i.indexrelid
      WHERE idx.relname = 'agent_runs_one_active_per_subject'
    `;
    expect(activeIndex?.predicate).toBe("(status = 'running'::text)");

    // 088 deliberately does not touch agent_runs_status_check — the SQL-text
    // assertion in the contract block above (no ADD/DROP of it anywhere in
    // 088) is what owns that claim, and the re-apply test below proves it
    // against the live catalog. The status DOMAIN therefore belongs to
    // whichever migration last widened it (091 added 'cancelled' and pins the
    // exact four-state array in its own suite), so the honest thing for this
    // file to assert is only that 088's three states are still members.
    const statusDefinition = await constraintDefinition(
      db!,
      'agent_runs',
      'agent_runs_status_check',
    );
    for (const status of ['running', 'completed', 'failed']) {
      expect(statusDefinition).toContain(`'${status}'::text`);
    }
  });

  it('re-applies migration 088 idempotently and leaves the shared database untouched', async () => {
    const beforeReapply = await spineConstraintDefinitions(db!);

    let duringReapply: Record<string, string | undefined> = {};
    try {
      await db!.begin(async (tx) => {
        // Applying 088 twice is the idempotency proof: the second run must be
        // a clean no-op rather than an error. Both runs and every assertion
        // that depends on them stay inside this transaction, because 088
        // re-adds agent_runs_kind_check, the kind/subject_type pairing and
        // agent_outcomes_outcome_kind_check at its own narrower definitions.
        await tx.unsafe(readMigration088Sql());
        await tx.unsafe(readMigration088Sql());
        duringReapply = await spineConstraintDefinitions(tx);
        throw new RollbackAfterReapply();
      });
    } catch (error) {
      if (!(error instanceof RollbackAfterReapply)) throw error;
    }

    // 088's own shape, as re-applied.
    expect(duringReapply.agent_runs_kind_check).toBe(
      "CHECK ((kind = ANY (ARRAY['review_handler'::text, 'weekly_insights'::text, " +
        "'solicitation_batch'::text, 'solicitation_ask'::text])))",
    );
    expect(duringReapply.agent_runs_kind_subject_type_pairing).not.toContain(
      'solicitation_send_batch',
    );
    expect(duringReapply.agent_outcomes_outcome_kind_check).not.toContain('solicitation_sent');
    // The one 088 leaves alone: a re-apply must not move it in either direction.
    expect(duringReapply.agent_runs_status_check).toBe(beforeReapply.agent_runs_status_check);

    // And the point of the rollback: every widening a later migration made to
    // these constraints is still there.
    expect(await spineConstraintDefinitions(db!)).toEqual(beforeReapply);
  });

  it('migration 088 rejects cross-account and cross-business parent and ask run links', async () => {
    const primaryTenant = await seedTenantAccount(db!, {
      accountDisplayName: 'Migration 088 Primary Tenant',
    });
    const otherTenant = await seedTenantAccount(db!, {
      accountDisplayName: 'Migration 088 Other Tenant',
    });
    const primaryBusinessId = randomUUID();
    const siblingBusinessId = randomUUID();
    const otherBusinessId = randomUUID();
    const uploadId = randomUUID();
    const contactId = randomUUID();
    const batchId = randomUUID();
    const otherAccountRunId = randomUUID();
    const siblingBusinessRunId = randomUUID();
    const validParentRunId = randomUUID();
    const validChildRunId = randomUUID();
    const validAskId = randomUUID();

    const insertRun = async (input: {
      id: string;
      accountId: string;
      businessId: string | null;
      subjectId: string;
      parentRunId?: string;
    }): Promise<void> => {
      await db!`
        INSERT INTO agent_runs (
          id, account_id, business_id, kind, subject_type, subject_id,
          correlation_id, parent_run_id
        ) VALUES (
          ${input.id}::uuid, ${input.accountId}::uuid, ${input.businessId}::uuid,
          'solicitation_ask', 'solicitation_ask', ${input.subjectId},
          'migration-088-tenant-integrity', ${input.parentRunId ?? null}::uuid
        )
      `;
    };

    const expectParentRunRejection = async (parentRunId: string): Promise<void> => {
      const childRunId = randomUUID();
      try {
        await expect(insertRun({
          id: childRunId,
          accountId: primaryTenant.accountId,
          businessId: primaryBusinessId,
          subjectId: childRunId,
          parentRunId,
        })).rejects.toMatchObject({
          code: '23503',
          constraint_name: 'agent_runs_parent_run_tenant_fkey',
        });
      } finally {
        await db!`DELETE FROM agent_runs WHERE id = ${childRunId}::uuid`;
      }
    };

    const expectAskRunRejection = async (agentRunId: string): Promise<void> => {
      const askId = randomUUID();
      try {
        await expect(db!`
          INSERT INTO solicitation_asks (
            id, account_id, business_id, batch_id, contact_id, status,
            withheld_reason, evidence, agent_run_id, decided_at
          ) VALUES (
            ${askId}::uuid, ${primaryTenant.accountId}::uuid,
            ${primaryBusinessId}::uuid, ${batchId}::uuid, ${contactId}::uuid,
            'send', NULL, ${db!.json({ decision: 'send' })},
            ${agentRunId}::uuid, NOW()
          )
        `).rejects.toMatchObject({
          code: '23503',
          constraint_name: 'solicitation_asks_agent_run_tenant_fkey',
        });
      } finally {
        await db!`DELETE FROM solicitation_asks WHERE id = ${askId}::uuid`;
      }
    };

    try {
      await db!`
        INSERT INTO businesses (
          id, name, owner_name, owner_email, account_id, subscription_status
        ) VALUES
          (
            ${primaryBusinessId}::uuid, 'Migration 088 Primary Business',
            'Primary Owner', ${primaryTenant.ownerEmail},
            ${primaryTenant.accountId}::uuid, 'active'
          ),
          (
            ${siblingBusinessId}::uuid, 'Migration 088 Sibling Business',
            'Primary Owner', ${primaryTenant.ownerEmail},
            ${primaryTenant.accountId}::uuid, 'active'
          ),
          (
            ${otherBusinessId}::uuid, 'Migration 088 Other Business',
            'Other Owner', ${otherTenant.ownerEmail},
            ${otherTenant.accountId}::uuid, 'active'
          )
      `;
      await db!`
        INSERT INTO contact_csv_uploads (
          id, account_id, business_id, filename, byte_size, content_sha256,
          raw_csv, status, report, attested_by_user_id, attested_at,
          attestation_version, completed_at
        ) VALUES (
          ${uploadId}::uuid, ${primaryTenant.accountId}::uuid,
          ${primaryBusinessId}::uuid, 'migration-088.csv', 1,
          ${uploadId.replaceAll('-', '').padEnd(64, '0').slice(0, 64)},
          NULL, 'completed', ${db!.json({ accepted: 1 })},
          ${primaryTenant.userId}::uuid, NOW(), 'migration-088-test', NOW()
        )
      `;
      await db!`
        INSERT INTO solicitation_contacts (
          id, business_id, name, email, created_by_upload_id
        ) VALUES (
          ${contactId}::uuid, ${primaryBusinessId}::uuid,
          'Migration 088 Contact', ${`${contactId}@example.test`}, ${uploadId}::uuid
        )
      `;
      await db!`
        INSERT INTO solicitation_batches (
          id, account_id, business_id, source_upload_id
        ) VALUES (
          ${batchId}::uuid, ${primaryTenant.accountId}::uuid,
          ${primaryBusinessId}::uuid, ${uploadId}::uuid
        )
      `;
      await insertRun({
        id: otherAccountRunId,
        accountId: otherTenant.accountId,
        businessId: otherBusinessId,
        subjectId: otherAccountRunId,
      });
      await insertRun({
        id: siblingBusinessRunId,
        accountId: primaryTenant.accountId,
        businessId: siblingBusinessId,
        subjectId: siblingBusinessRunId,
      });
      await insertRun({
        id: validParentRunId,
        accountId: primaryTenant.accountId,
        businessId: primaryBusinessId,
        subjectId: validParentRunId,
      });

      await expectParentRunRejection(otherAccountRunId);
      await expectParentRunRejection(siblingBusinessRunId);
      const unscopedChildRunId = randomUUID();
      try {
        await expect(insertRun({
          id: unscopedChildRunId,
          accountId: primaryTenant.accountId,
          businessId: null,
          subjectId: unscopedChildRunId,
          parentRunId: otherAccountRunId,
        })).rejects.toMatchObject({
          code: '23514',
          constraint_name: 'agent_runs_parent_business_required',
        });
      } finally {
        await db!`DELETE FROM agent_runs WHERE id = ${unscopedChildRunId}::uuid`;
      }
      await expectAskRunRejection(otherAccountRunId);
      await expectAskRunRejection(siblingBusinessRunId);

      await insertRun({
        id: validChildRunId,
        accountId: primaryTenant.accountId,
        businessId: primaryBusinessId,
        subjectId: validChildRunId,
        parentRunId: validParentRunId,
      });
      await db!`
        INSERT INTO solicitation_asks (
          id, account_id, business_id, batch_id, contact_id, status,
          withheld_reason, evidence, agent_run_id, decided_at
        ) VALUES (
          ${validAskId}::uuid, ${primaryTenant.accountId}::uuid,
          ${primaryBusinessId}::uuid, ${batchId}::uuid, ${contactId}::uuid,
          'send', NULL, ${db!.json({ decision: 'send' })},
          ${validParentRunId}::uuid, NOW()
        )
      `;

      await db!`DELETE FROM agent_runs WHERE id = ${validParentRunId}::uuid`;

      const [childAfterDelete] = await db!<{
        account_id: string;
        business_id: string;
        parent_run_id: string | null;
      }[]>`
        SELECT account_id, business_id, parent_run_id
        FROM agent_runs
        WHERE id = ${validChildRunId}::uuid
      `;
      expect(childAfterDelete).toEqual({
        account_id: primaryTenant.accountId,
        business_id: primaryBusinessId,
        parent_run_id: null,
      });

      const [askAfterDelete] = await db!<{
        account_id: string;
        business_id: string;
        agent_run_id: string | null;
      }[]>`
        SELECT account_id, business_id, agent_run_id
        FROM solicitation_asks
        WHERE id = ${validAskId}::uuid
      `;
      expect(askAfterDelete).toEqual({
        account_id: primaryTenant.accountId,
        business_id: primaryBusinessId,
        agent_run_id: null,
      });
    } finally {
      await db!`
        DELETE FROM businesses
        WHERE id IN (
          ${primaryBusinessId}::uuid,
          ${siblingBusinessId}::uuid,
          ${otherBusinessId}::uuid
        )
      `;
      await cleanupTenantAccount(db!, primaryTenant);
      await cleanupTenantAccount(db!, otherTenant);
    }
  });

  it('pins tenant-composite, idempotency, archival, history, and zero-unit catalog facts', async () => {
    const constraints = await db!<{ constraint_name: string; definition: string }[]>`
      SELECT conname AS constraint_name, pg_get_constraintdef(oid) AS definition
      FROM pg_constraint
      WHERE conname IN (
        'agent_runs_account_business_id_uniq',
        'agent_runs_parent_business_required',
        'agent_runs_parent_run_tenant_fkey',
        'agent_outcomes_unit_count_check',
        'solicitation_batches_source_upload_uniq',
        'solicitation_batches_business_account_fk',
        'solicitation_batches_source_upload_tenant_fk',
        'solicitation_asks_batch_contact_uniq',
        'solicitation_asks_business_account_fk',
        'solicitation_asks_batch_tenant_fk',
        'solicitation_asks_contact_business_fk',
        'solicitation_asks_agent_run_tenant_fkey'
      )
      ORDER BY conname
    `;
    const definition = new Map(
      constraints.map((constraint) => [
        constraint.constraint_name,
        normalizeSql(constraint.definition),
      ]),
    );

    expect(definition.get('agent_runs_account_business_id_uniq')).toBe(
      'UNIQUE (account_id, business_id, id)',
    );
    expect(definition.get('agent_runs_parent_business_required')).toContain(
      'CHECK (((parent_run_id IS NULL) OR (business_id IS NOT NULL)))',
    );
    expect(definition.get('agent_runs_parent_run_tenant_fkey')).toContain(
      'FOREIGN KEY (account_id, business_id, parent_run_id) REFERENCES agent_runs(account_id, business_id, id) ON DELETE SET NULL (parent_run_id)',
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
    expect(definition.get('solicitation_asks_agent_run_tenant_fkey')).toContain(
      'FOREIGN KEY (account_id, business_id, agent_run_id) REFERENCES agent_runs(account_id, business_id, id) ON DELETE SET NULL (agent_run_id)',
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
