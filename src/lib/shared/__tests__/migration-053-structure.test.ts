import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';

const MIGRATION_PATH = resolve(
  process.cwd(),
  'supabase/migrations/053_users_role_constraint.sql',
);

let sql: string;
let normalized: string;
beforeAll(() => {
  sql = readFileSync(MIGRATION_PATH, 'utf-8');
  normalized = sql.replace(/\s+/g, ' ');
});

describe('migration 053 — retire legacy sales_partner role', () => {
  it('defensively converts any stray sales_partner row to admin', () => {
    expect(normalized).toMatch(
      /UPDATE users SET role = 'admin' WHERE role = 'sales_partner'/,
    );
  });

  it('runs the conversion exactly once so re-running is a no-op', () => {
    const updates = sql.match(/UPDATE\s+users/gi) ?? [];
    expect(updates).toHaveLength(1);
  });

  it('adds a CHECK constraint restricting role to the owner/admin allowlist', () => {
    expect(normalized).toContain('users_role_check');
    expect(normalized).toMatch(
      /CHECK \(role IN \('owner',\s*'admin'\)\)/,
    );
  });

  it('adds the constraint idempotently (guarded by pg_constraint)', () => {
    expect(normalized).toContain("conname = 'users_role_check'");
  });

  it('scopes the constraint-existence guard to the users relation (conname is not globally unique)', () => {
    expect(normalized).toContain("t.relname = 'users'");
    expect(normalized).toContain('JOIN pg_class t ON t.oid = c.conrelid');
  });

  it('does not drop or mutate unrelated structure', () => {
    expect(sql).not.toMatch(/DROP TABLE/i);
    expect(sql).not.toMatch(/DROP COLUMN/i);
    expect(sql).not.toMatch(/DROP CONSTRAINT/i);
  });
});
