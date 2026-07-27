// The contract for every live-DB suite: the shared test database is migrated
// to head ONCE, out of band (`pnpm test:db:setup`), and suites ASSERT the
// schema they depend on instead of re-applying migration SQL at run time.
//
// Why assert rather than apply (#573): a migration re-apply takes
// ACCESS EXCLUSIVE locks on the tables it touches. Another suite holding
// ordinary row locks on those same tables in the opposite order deadlocks
// against it (40P01), and the victim is whichever transaction Postgres picks —
// so the failure lands in an unrelated suite and looks like flake. vitest's
// `integration` project serializes suites WITHIN one process, but nothing in
// vitest spans processes, and `scripts/verify-gate.sh` runs the intake's
// verification_commands as separate concurrent vitest processes. Removing the
// run-time DDL removes the ACCESS EXCLUSIVE lock, which is the only ingredient
// of that deadlock a test suite actually controls.
//
// Test-helper only — never imported by production code.

import type postgres from 'postgres';

const SETUP_COMMAND = 'pnpm test:db:setup';

export interface SchemaRequirement {
  /** Migration that introduces these objects. Named in the failure message. */
  migration: string;
  /** Relations that must exist in the `public` schema. */
  tables?: readonly string[];
  /** `table.column` pairs that must exist. */
  columns?: readonly string[];
  /** Index names that must exist in the `public` schema. */
  indexes?: readonly string[];
  /**
   * `table.column` pairs whose `information_schema` data_type must match —
   * for migrations that only WIDEN an existing column (085 → NUMERIC), where
   * presence alone proves nothing.
   */
  columnTypes?: readonly { column: string; dataType: string }[];
}

interface MissingObject {
  migration: string;
  description: string;
}

async function findMissingTables(
  db: postgres.Sql,
  requirement: SchemaRequirement,
): Promise<MissingObject[]> {
  const tables = requirement.tables ?? [];
  if (tables.length === 0) return [];

  const present = await db<{ table_name: string }[]>`
    SELECT table_name FROM information_schema.tables
    WHERE table_schema = 'public' AND table_name IN ${db(tables)}
  `;
  const found = new Set(present.map((row) => row.table_name));
  return tables
    .filter((table) => !found.has(table))
    .map((table) => ({ migration: requirement.migration, description: `table ${table}` }));
}

async function findMissingColumns(
  db: postgres.Sql,
  requirement: SchemaRequirement,
): Promise<MissingObject[]> {
  const columns = requirement.columns ?? [];
  if (columns.length === 0) return [];

  const pairs = columns.map((qualified) => {
    const [table, column] = qualified.split('.');
    if (!table || !column) {
      throw new Error(`schema requirement column must be "table.column", got "${qualified}"`);
    }
    return { qualified, table, column };
  });

  const present = await db<{ table_name: string; column_name: string }[]>`
    SELECT table_name, column_name FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name IN ${db(pairs.map((pair) => pair.table))}
      AND column_name IN ${db(pairs.map((pair) => pair.column))}
  `;
  const found = new Set(present.map((row) => `${row.table_name}.${row.column_name}`));
  return pairs
    .filter((pair) => !found.has(pair.qualified))
    .map((pair) => ({
      migration: requirement.migration,
      description: `column ${pair.qualified}`,
    }));
}

async function findMissingIndexes(
  db: postgres.Sql,
  requirement: SchemaRequirement,
): Promise<MissingObject[]> {
  const indexes = requirement.indexes ?? [];
  if (indexes.length === 0) return [];

  const present = await db<{ indexname: string }[]>`
    SELECT indexname FROM pg_indexes
    WHERE schemaname = 'public' AND indexname IN ${db(indexes)}
  `;
  const found = new Set(present.map((row) => row.indexname));
  return indexes
    .filter((index) => !found.has(index))
    .map((index) => ({ migration: requirement.migration, description: `index ${index}` }));
}

async function findMismatchedColumnTypes(
  db: postgres.Sql,
  requirement: SchemaRequirement,
): Promise<MissingObject[]> {
  const expectations = requirement.columnTypes ?? [];
  if (expectations.length === 0) return [];

  const mismatched: MissingObject[] = [];
  for (const expectation of expectations) {
    const [table, column] = expectation.column.split('.');
    if (!table || !column) {
      throw new Error(
        `schema requirement columnType must be "table.column", got "${expectation.column}"`,
      );
    }
    const [actual] = await db<{ data_type: string }[]>`
      SELECT data_type FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = ${table} AND column_name = ${column}
    `;
    if (actual?.data_type !== expectation.dataType) {
      mismatched.push({
        migration: requirement.migration,
        description: `column ${expectation.column} is ${actual?.data_type ?? 'absent'}, expected ${expectation.dataType}`,
      });
    }
  }
  return mismatched;
}

/**
 * The migration → objects mapping, owned in ONE place so a suite declares the
 * migration it depends on rather than re-deriving which objects prove it.
 */
export const MIGRATION_071_RUN_SPINE: SchemaRequirement = {
  migration: '071_agent_run_spine',
  tables: ['agent_runs', 'agent_run_steps', 'agent_outcomes'],
};

export const MIGRATION_072_REVIEW_TRIAGE: SchemaRequirement = {
  migration: '072_review_triage',
  columns: ['reviews.triage_severity', 'reviews.triaged_at', 'reviews.triage_content_hash'],
};

export const MIGRATION_073_REVIEW_ESCALATIONS: SchemaRequirement = {
  migration: '073_review_escalations',
  tables: ['review_escalations'],
  columns: ['notification_deliveries.escalation_id'],
};

export const MIGRATION_074_TRUST_DIAL_VETO_WINDOW: SchemaRequirement = {
  migration: '074_trust_dial_veto_window',
  // The migration's LAST statement, so its presence implies the whole file.
  indexes: ['notification_deliveries_pending_post_notice_claim'],
};

export const MIGRATION_085_COMPETITOR_RATING_NUMERIC: SchemaRequirement = {
  migration: '085_competitor_rating_numeric',
  columnTypes: [{ column: 'competitor_snapshots.rating', dataType: 'numeric' }],
};

export const MIGRATION_088_SOLICITATION_BATCH_EXECUTOR: SchemaRequirement = {
  migration: '088_solicitation_batch_executor',
  tables: ['solicitation_batches', 'solicitation_asks'],
  columns: ['agent_runs.parent_run_id'],
};

export const MIGRATION_089_COMPETITOR_RIVAL_PICK: SchemaRequirement = {
  migration: '089_competitor_rival_pick',
  columns: [
    'businesses.rival_picked_at',
    'businesses.rival_place_id',
    'businesses.rival_title_snapshot',
  ],
};

/**
 * Throws unless every requirement is already present on the connected
 * database. Read-only: it takes no lock stronger than ACCESS SHARE, so it can
 * never be the blocking side of a deadlock.
 *
 * The failure is deliberately loud and actionable — a missing object means the
 * test DB is behind head, which is a setup problem, not a test problem.
 */
export async function assertSchemaReady(
  db: postgres.Sql,
  requirements: readonly SchemaRequirement[],
): Promise<void> {
  const missing: MissingObject[] = [];
  for (const requirement of requirements) {
    missing.push(
      ...(await findMissingTables(db, requirement)),
      ...(await findMissingColumns(db, requirement)),
      ...(await findMissingIndexes(db, requirement)),
      ...(await findMismatchedColumnTypes(db, requirement)),
    );
  }

  if (missing.length === 0) return;

  const byMigration = new Map<string, string[]>();
  for (const item of missing) {
    const bucket = byMigration.get(item.migration) ?? [];
    bucket.push(item.description);
    byMigration.set(item.migration, bucket);
  }
  const detail = [...byMigration.entries()]
    .map(([migration, descriptions]) => `  ${migration}: ${descriptions.join(', ')}`)
    .join('\n');

  throw new Error(
    `test database is behind head — missing schema objects:\n${detail}\n` +
      `Re-provision it with \`${SETUP_COMMAND}\`. Suites assert schema; they no ` +
      `longer apply migrations at run time (#573).`,
  );
}
