import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';

const MIGRATION_PATH = resolve(
  process.cwd(),
  'supabase/migrations/054_accounts_base_price_cents.sql',
);

let sql: string;
let normalized: string;
beforeAll(() => {
  sql = readFileSync(MIGRATION_PATH, 'utf-8');
  normalized = sql.replace(/\s+/g, ' ');
});

describe('migration 054 — accounts.base_price_cents founders price-lock', () => {
  it('adds the base_price_cents column idempotently', () => {
    expect(normalized).toMatch(
      /ALTER TABLE accounts ADD COLUMN IF NOT EXISTS base_price_cents INTEGER/,
    );
  });

  it('backfills existing rows per current tier from TIER_CONFIG values', () => {
    expect(normalized).toMatch(/UPDATE accounts SET base_price_cents = CASE subscription_tier/);
    expect(normalized).toMatch(/WHEN 'basic' THEN 2900/);
    expect(normalized).toMatch(/WHEN 'standard' THEN 7900/);
    expect(normalized).toMatch(/WHEN 'premium' THEN 19900/);
    expect(normalized).toMatch(/WHEN 'founders' THEN 1900/);
    expect(normalized).toContain('WHERE base_price_cents IS NULL');
  });

  it('sets a standard default and NOT NULL after backfill', () => {
    expect(normalized).toMatch(/ALTER COLUMN base_price_cents SET DEFAULT 7900/);
    expect(normalized).toMatch(/ALTER COLUMN base_price_cents SET NOT NULL/);
  });

  it('adds a non-negative CHECK constraint guarded idempotently and scoped to accounts', () => {
    expect(normalized).toContain('accounts_base_price_cents_nonneg');
    expect(normalized).toMatch(/CHECK \(base_price_cents >= 0\)/);
    expect(normalized).toContain("conname = 'accounts_base_price_cents_nonneg'");
    expect(normalized).toContain("t.relname = 'accounts'");
  });

  it('does not drop or mutate unrelated structure', () => {
    expect(sql).not.toMatch(/DROP TABLE/i);
    expect(sql).not.toMatch(/DROP COLUMN/i);
    expect(sql).not.toMatch(/DROP CONSTRAINT/i);
  });
});
