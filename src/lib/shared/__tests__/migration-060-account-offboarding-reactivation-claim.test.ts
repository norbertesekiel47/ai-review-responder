import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';

const MIGRATION_PATH = resolve(
  process.cwd(),
  'supabase/migrations/060_account_offboarding_reactivation_claim.sql',
);

let sql: string;
let normalized: string;

beforeAll(() => {
  sql = readFileSync(MIGRATION_PATH, 'utf-8');
  normalized = sql.replace(/\s+/g, ' ');
});

describe('migration 060 - account offboarding reactivation claim columns', () => {
  it('adds dedicated, nullable reactivation-claim columns', () => {
    expect(normalized).toMatch(/ALTER TABLE account_offboardings/i);
    expect(normalized).toMatch(/ADD COLUMN IF NOT EXISTS reactivation_claimed_at TIMESTAMPTZ/i);
    expect(normalized).toMatch(/ADD COLUMN IF NOT EXISTS reactivation_claim_token TEXT/i);
    // Additive + nullable: no NOT NULL, no backfill, no default that would rewrite the table.
    expect(normalized).not.toMatch(/reactivation_claimed_at TIMESTAMPTZ NOT NULL/i);
    expect(normalized).not.toMatch(/reactivation_claim_token TEXT NOT NULL/i);
  });

  it('indexes only active (non-terminal) claims for the reset poller', () => {
    expect(normalized).toMatch(
      /CREATE INDEX IF NOT EXISTS idx_account_offboardings_reactivation_claim/i,
    );
    expect(normalized).toMatch(/ON account_offboardings \(reactivation_claimed_at\)/i);
    expect(normalized).toMatch(
      /WHERE reactivation_claimed_at IS NOT NULL AND terminal_at IS NULL/i,
    );
  });
});
