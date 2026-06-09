import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';

const MIGRATION_PATH = resolve(
  process.cwd(),
  'supabase/migrations/057_account_offboarding_tombstone_nullability.sql',
);

let sql: string;
let normalized: string;

beforeAll(() => {
  sql = readFileSync(MIGRATION_PATH, 'utf-8');
  normalized = sql.replace(/\s+/g, ' ');
});

describe('migration 057 - account offboarding tombstone nullability', () => {
  it('only loosens Zernio snapshot arrays so terminal purge can null raw provider IDs', () => {
    expect(normalized).toMatch(/ALTER TABLE account_offboardings/i);
    expect(normalized).toMatch(/ALTER COLUMN zernio_account_ids DROP NOT NULL/i);
    expect(normalized).toMatch(/ALTER COLUMN zernio_profile_ids DROP NOT NULL/i);
    expect(normalized).not.toMatch(/ALTER COLUMN location_ids DROP NOT NULL/i);
    expect(normalized).not.toMatch(/ALTER COLUMN provider_dispositions DROP NOT NULL/i);
  });

  it('loosens approval audit response references so scrubbed audit rows survive response deletion', () => {
    expect(normalized).toMatch(/ALTER TABLE approval_audit_log/i);
    expect(normalized).toMatch(/ALTER COLUMN response_id DROP NOT NULL/i);
    expect(normalized).not.toMatch(
      /ALTER TABLE approval_audit_log[^;]+ALTER COLUMN account_id DROP NOT NULL/i,
    );
    expect(normalized).not.toMatch(
      /ALTER TABLE approval_audit_log[^;]+ALTER COLUMN business_id DROP NOT NULL/i,
    );
  });

  it('loosens impersonation account/user references so retained admin rows can be scrubbed', () => {
    expect(normalized).toMatch(/ALTER TABLE impersonation_sessions/i);
    expect(normalized).toMatch(/ALTER COLUMN account_id DROP NOT NULL/i);
    expect(normalized).toMatch(/ALTER COLUMN impersonated_user_id DROP NOT NULL/i);
    expect(normalized).not.toMatch(/ALTER COLUMN actor_user_id DROP NOT NULL/i);
  });

  it('does not add tables, policies, statuses, indexes, or browser-visible flags', () => {
    expect(sql).not.toMatch(/CREATE TABLE/i);
    expect(sql).not.toMatch(/CREATE POLICY/i);
    expect(sql).not.toMatch(/CREATE INDEX/i);
    expect(sql).not.toMatch(/\bpurging\b/i);
    expect(sql).not.toMatch(/NEXT_PUBLIC_/i);
  });
});
