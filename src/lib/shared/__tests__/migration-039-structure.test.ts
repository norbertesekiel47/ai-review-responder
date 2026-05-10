/**
 * Structural validation test for migration 039_revert_problematic_not_null_constraints.sql
 *
 * This test validates that the migration SQL file contains all required DDL
 * statements per the corrective-migration-039 feature expected behavior.
 * It reads the SQL file and checks for the presence of key statements.
 *
 * This is NOT a database integration test — it cannot verify that the migration
 * actually runs successfully against a real database. That must be done manually
 * in the Supabase SQL editor.
 *
 * Run: pnpm test -- migration-039
 */

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { beforeAll, describe, it, expect } from 'vitest';

const MIGRATION_PATH = resolve(
  process.cwd(),
  'supabase/migrations/039_revert_problematic_not_null_constraints.sql',
);

let sql: string;
beforeAll(() => {
  sql = readFileSync(MIGRATION_PATH, 'utf-8');
});

// ── users.account_id nullable ───────────────────────────────────────────────

describe('migration 039 — users.account_id is nullable', () => {
  it('drops NOT NULL constraint on users.account_id', () => {
    expect(sql).toMatch(
      /ALTER TABLE users ALTER COLUMN account_id DROP NOT NULL/i,
    );
  });

  it('checks attnotnull before dropping (idempotent)', () => {
    // Should use a DO block with attnotnull check so re-running is safe
    expect(sql).toMatch(/attnotnull/i);
    expect(sql).toMatch(/attrelid\s*=\s*'users'::regclass/i);
    expect(sql).toMatch(/attname\s*=\s*'account_id'/i);
  });
});

// ── api_costs.account_id nullable ───────────────────────────────────────────

describe('migration 039 — api_costs.account_id is nullable', () => {
  it('drops NOT NULL constraint on api_costs.account_id', () => {
    expect(sql).toMatch(
      /ALTER TABLE api_costs ALTER COLUMN account_id DROP NOT NULL/i,
    );
  });

  it('checks attnotnull before dropping (idempotent)', () => {
    expect(sql).toMatch(/attrelid\s*=\s*'api_costs'::regclass/i);
  });
});

// ── notification_deliveries.account_id nullable ─────────────────────────────

describe('migration 039 — notification_deliveries.account_id is nullable', () => {
  it('drops NOT NULL constraint on notification_deliveries.account_id', () => {
    expect(sql).toMatch(
      /ALTER TABLE notification_deliveries ALTER COLUMN account_id DROP NOT NULL/i,
    );
  });

  it('checks attnotnull before dropping (idempotent)', () => {
    expect(sql).toMatch(/attrelid\s*=\s*'notification_deliveries'::regclass/i);
  });
});

// ── Partial index on api_costs ──────────────────────────────────────────────

describe('migration 039 — partial index idx_api_costs_account_partial', () => {
  it('creates partial index on api_costs(account_id) WHERE account_id IS NOT NULL', () => {
    expect(sql).toMatch(
      /CREATE INDEX IF NOT EXISTS idx_api_costs_account_partial\s+ON api_costs\s*\(\s*account_id\s*\)\s+WHERE\s+account_id\s+IS\s+NOT\s+NULL/i,
    );
  });

  it('uses IF NOT EXISTS for idempotency', () => {
    expect(sql).toMatch(
      /CREATE INDEX IF NOT EXISTS idx_api_costs_account_partial/i,
    );
  });
});

// ── Idempotency ─────────────────────────────────────────────────────────────

describe('migration 039 — idempotency', () => {
  it('uses DO blocks with attnotnull checks for all DROP NOT NULL operations', () => {
    // Three tables: users, api_costs, notification_deliveries
    const doBlocks = sql.match(/DO\s+\$\$\s*BEGIN/gi) || [];
    expect(doBlocks.length).toBeGreaterThanOrEqual(3);
  });

  it('uses IF NOT EXISTS for index creation', () => {
    expect(sql).toMatch(/CREATE INDEX IF NOT EXISTS/i);
  });
});

// ── Safety: no data mutation ────────────────────────────────────────────────

describe('migration 039 — no data mutation', () => {
  it('does not contain UPDATE statements that modify data', () => {
    // Only attnotnull = TRUE checks in the DO blocks, no data UPDATEs
    expect(sql).not.toMatch(/^\s*UPDATE\s+(?!pg_attribute)/im);
  });

  it('does not contain DELETE statements', () => {
    expect(sql).not.toMatch(/DELETE FROM/i);
  });

  it('does not contain INSERT statements that add data rows', () => {
    // No INSERT INTO for data tables (only pg_attribute lookups)
    expect(sql).not.toMatch(/INSERT INTO (?!pg_attribute)(?!\w+\.\w+\s*RETURNING)/i);
  });

  it('does not drop any columns or tables', () => {
    expect(sql).not.toMatch(/DROP TABLE/i);
    expect(sql).not.toMatch(/DROP COLUMN/i);
  });
});

// ── Does NOT affect other account_id NOT NULL constraints ───────────────────

describe('migration 039 — does not touch other NOT NULL constraints', () => {
  it('does NOT drop NOT NULL on businesses.account_id', () => {
    expect(sql).not.toMatch(
      /ALTER TABLE businesses ALTER COLUMN account_id DROP NOT NULL/i,
    );
  });

  it('does NOT drop NOT NULL on channel_enrollments.account_id', () => {
    expect(sql).not.toMatch(
      /ALTER TABLE channel_enrollments ALTER COLUMN account_id DROP NOT NULL/i,
    );
  });

  it('does NOT drop NOT NULL on approval_audit_log.account_id', () => {
    expect(sql).not.toMatch(
      /ALTER TABLE approval_audit_log ALTER COLUMN account_id DROP NOT NULL/i,
    );
  });
});

// ── Only three tables have account_id NOT NULL dropped ─────────────────────

describe('migration 039 — exactly three tables affected', () => {
  it('drops NOT NULL on exactly 3 tables (users, api_costs, notification_deliveries)', () => {
    const dropNotNulls = sql.match(/ALTER COLUMN account_id DROP NOT NULL/gi) || [];
    expect(dropNotNulls.length).toBe(3);
  });
});
