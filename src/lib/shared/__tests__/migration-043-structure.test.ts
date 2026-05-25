import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';

const MIGRATION_PATH = resolve(
  process.cwd(),
  'supabase/migrations/043_step_1_keystones.sql',
);

let sql: string;
beforeAll(() => {
  sql = readFileSync(MIGRATION_PATH, 'utf-8');
});

describe('migration 043 — accounts.past_due_at', () => {
  it('adds nullable accounts.past_due_at', () => {
    expect(sql).toMatch(
      /ALTER TABLE accounts\s+ADD COLUMN IF NOT EXISTS past_due_at TIMESTAMPTZ/i,
    );
  });

  it('documents past_due_at semantics', () => {
    expect(sql).toMatch(/COMMENT ON COLUMN accounts\.past_due_at/i);
    expect(sql).toMatch(/current past_due interval/i);
  });
});

describe('migration 043 — account_audit_log metadata', () => {
  it.each([
    'entity_type TEXT',
    'entity_id TEXT',
    'ip TEXT',
    'user_agent TEXT',
    'request_id TEXT',
  ])('adds nullable %s', (column) => {
    const [name, type] = column.split(' ');
    // `name`/`type` come from the hardcoded array above — never user input.
    // Assert against whitespace-normalized SQL with a plain substring check so
    // there is no dynamically-built RegExp for static scanners to flag (ReDoS).
    const normalized = sql.replace(/\s+/g, ' ');
    expect(normalized).toContain(
      `ALTER TABLE account_audit_log ADD COLUMN IF NOT EXISTS ${name} ${type}`,
    );
  });

  it('does not create account_memberships in this slice', () => {
    expect(sql).not.toMatch(/CREATE\s+TABLE\b[^;]*\baccount_memberships\b[^;]*;/i);
  });

  it('does not create new audit indexes without a matching query', () => {
    expect(sql).not.toMatch(
      /CREATE\s+INDEX\b[^;]*\baccount_audit\b[^;]*\bentity\b[^;]*;/i,
    );
    expect(sql).not.toMatch(
      /CREATE\s+INDEX\b[^;]*\baccount_audit\b[^;]*\brequest\b[^;]*;/i,
    );
  });
});

describe('migration 043 — additive and idempotent', () => {
  it('uses IF NOT EXISTS for every added column', () => {
    const additions = sql.match(/ADD\s+COLUMN\b/gi) ?? [];
    const idempotentAdditions =
      sql.match(/ADD\s+COLUMN\s+IF\s+NOT\s+EXISTS\b/gi) ?? [];

    expect(additions.length).toBeGreaterThanOrEqual(6);
    expect(idempotentAdditions).toHaveLength(additions.length);
  });

  it('does not drop tables, columns, or mutate data', () => {
    expect(sql).not.toMatch(/DROP TABLE/i);
    expect(sql).not.toMatch(/DROP COLUMN/i);
    expect(sql).not.toMatch(/^\s*UPDATE\s+/im);
    expect(sql).not.toMatch(/^\s*DELETE\s+/im);
    expect(sql).not.toMatch(/^\s*INSERT\s+/im);
  });
});
