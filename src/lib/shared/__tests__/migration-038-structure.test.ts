/**
 * Structural validation test for migration 038_owner_user_id_unique_index.sql
 *
 * Validates that the migration SQL file:
 *   1. Drops the old non-unique idx_accounts_owner index
 *   2. Creates a partial unique index idx_accounts_owner_unique on accounts(owner_user_id)
 *      with a WHERE owner_user_id IS NOT NULL predicate
 *   3. Is idempotent (uses IF EXISTS / IF NOT EXISTS)
 *
 * This is NOT a database integration test — it cannot verify that the unique
 * index actually rejects duplicate owner_user_id INSERTs against a real database.
 * That must be done manually in the Supabase SQL editor. Instead, it catches
 * accidental deletions, mis-ordering, or missing statements.
 *
 * Validation contract: VAL-LOC-055
 *
 * Run: pnpm test -- migration-038
 */

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { beforeAll, describe, it, expect } from 'vitest';

const MIGRATION_PATH = resolve(
  process.cwd(),
  'supabase/migrations/038_owner_user_id_unique_index.sql',
);

let sql: string;
beforeAll(() => {
  sql = readFileSync(MIGRATION_PATH, 'utf-8');
});

// ── VAL-LOC-055: accounts.owner_user_id is unique ───────────────────────────

describe('migration 038 — VAL-LOC-055: unique index on owner_user_id', () => {
  it('drops the old non-unique idx_accounts_owner index', () => {
    expect(sql).toMatch(/DROP INDEX IF EXISTS idx_accounts_owner/i);
  });

  it('creates idx_accounts_owner_unique as a UNIQUE index', () => {
    expect(sql).toMatch(
      /CREATE UNIQUE INDEX IF NOT EXISTS idx_accounts_owner_unique/i,
    );
  });

  it('indexes accounts(owner_user_id)', () => {
    expect(sql).toMatch(
      /ON accounts\s*\(\s*owner_user_id\s*\)/i,
    );
  });

  it('has partial predicate WHERE owner_user_id IS NOT NULL', () => {
    expect(sql).toMatch(
      /WHERE\s+owner_user_id\s+IS\s+NOT\s+NULL/i,
    );
  });

  it('drops old index BEFORE creating the new unique index', () => {
    const dropIdx = sql.indexOf('DROP INDEX IF EXISTS idx_accounts_owner');
    const createIdx = sql.indexOf('CREATE UNIQUE INDEX IF NOT EXISTS idx_accounts_owner_unique');
    expect(dropIdx).toBeGreaterThan(-1);
    expect(createIdx).toBeGreaterThan(-1);
    expect(dropIdx).toBeLessThan(createIdx);
  });
});

// ── Idempotency ──────────────────────────────────────────────────────────────

describe('migration 038 — idempotency', () => {
  it('uses IF EXISTS for index drop', () => {
    expect(sql).toMatch(/DROP INDEX IF EXISTS/i);
  });

  it('uses IF NOT EXISTS for unique index creation', () => {
    expect(sql).toMatch(/CREATE UNIQUE INDEX IF NOT EXISTS/i);
  });
});
