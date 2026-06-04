import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';

const MIGRATION_PATH = resolve(
  process.cwd(),
  'supabase/migrations/055_auto_approval_policy.sql',
);

let sql: string;
let normalized: string;

beforeAll(() => {
  sql = readFileSync(MIGRATION_PATH, 'utf-8');
  normalized = sql.replace(/\s+/g, ' ');
});

function partialIndexPredicate(indexName: string): string | null {
  const escaped = indexName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const match = normalized.match(new RegExp(`${escaped}[^;]+ WHERE ([^;]+);`, 'i'));
  return match?.[1] ?? null;
}

describe('migration 055 — auto approval policy schema', () => {
  it('creates auto_approval_policies with app-side UUIDv7 IDs and threshold check', () => {
    expect(normalized).toMatch(/CREATE TABLE IF NOT EXISTS auto_approval_policies \(/i);
    expect(normalized).toMatch(/id UUID PRIMARY KEY,/i);
    expect(normalized).not.toMatch(/id UUID PRIMARY KEY DEFAULT/i);
    expect(normalized).toMatch(
      /account_id UUID NOT NULL REFERENCES accounts\(id\) ON DELETE CASCADE/i,
    );
    expect(normalized).toMatch(/location_id UUID NULL/i);
    expect(normalized).toMatch(/auto_approve_min_star SMALLINT NULL/i);
    expect(normalized).toMatch(
      /CHECK \(auto_approve_min_star IS NULL OR auto_approve_min_star BETWEEN 1 AND 5\)/i,
    );
    expect(normalized).toMatch(/created_at TIMESTAMPTZ NOT NULL DEFAULT NOW\(\)/i);
    expect(normalized).toMatch(/updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW\(\)/i);
  });

  it('adds the business/account composite guard without MATCH FULL', () => {
    expect(normalized).toMatch(
      /ADD CONSTRAINT businesses_id_account_id_key UNIQUE \(id, account_id\)/i,
    );
    expect(normalized).toMatch(
      /ADD CONSTRAINT auto_approval_policies_location_account_fk FOREIGN KEY \(location_id, account_id\) REFERENCES businesses\(id, account_id\) ON DELETE CASCADE/i,
    );
    expect(normalized).not.toMatch(/MATCH FULL/i);
  });

  it('creates byte-for-byte partial unique indexes for conflict targets', () => {
    expect(partialIndexPredicate('auto_approval_policies_one_account_default')).toBe(
      'location_id IS NULL',
    );
    expect(partialIndexPredicate('auto_approval_policies_one_location_override')).toBe(
      'location_id IS NOT NULL',
    );
    expect(normalized).toMatch(
      /CREATE UNIQUE INDEX IF NOT EXISTS auto_approval_policies_one_account_default ON auto_approval_policies\(account_id\) WHERE location_id IS NULL;/i,
    );
    expect(normalized).toMatch(
      /CREATE UNIQUE INDEX IF NOT EXISTS auto_approval_policies_one_location_override ON auto_approval_policies\(account_id, location_id\) WHERE location_id IS NOT NULL;/i,
    );
  });

  it('enables RLS without authenticated owner DML policies', () => {
    expect(normalized).toMatch(
      /ALTER TABLE auto_approval_policies ENABLE ROW LEVEL SECURITY;/i,
    );
    expect(normalized).toMatch(
      /REVOKE INSERT, UPDATE, DELETE ON auto_approval_policies FROM authenticated;/i,
    );
    expect(sql).not.toMatch(/CREATE POLICY[\s\S]+auto_approval_policies/i);
  });

  it('adds nullable responses.approval_method with conservative backfill', () => {
    expect(normalized).toMatch(
      /ALTER TABLE responses ADD COLUMN IF NOT EXISTS approval_method TEXT NULL;/i,
    );
    expect(normalized).toMatch(/ADD CONSTRAINT responses_approval_method_check/i);
    expect(normalized).toMatch(
      /CHECK \(approval_method IS NULL OR approval_method IN \('owner', 'auto_policy'\)\)/i,
    );
    expect(normalized).not.toMatch(/approval_method TEXT NOT NULL/i);
    expect(normalized).not.toMatch(/approval_method TEXT .*DEFAULT 'owner'/i);

    expect(normalized).toMatch(
      /UPDATE responses SET approval_method = 'owner' WHERE approval_method IS NULL AND status IN \('approved', 'edited', 'awaiting_owner_connect'\);/i,
    );
    expect(normalized).toMatch(
      /UPDATE responses SET approval_method = 'owner' WHERE approval_method IS NULL AND status = 'posted' AND EXISTS \( SELECT 1 FROM approval_audit_log aal WHERE aal.response_id = responses.id \);/i,
    );
  });

  it('extends approval_audit_log.auth_method for auto policy audit rows', () => {
    expect(normalized).toMatch(
      /ALTER TABLE approval_audit_log DROP CONSTRAINT IF EXISTS approval_audit_log_auth_method_check;/i,
    );
    expect(normalized).toMatch(/ADD CONSTRAINT approval_audit_log_auth_method_check/i);
    expect(normalized).toMatch(
      /CHECK \(auth_method IN \('token', 'owner_session', 'auto_policy'\)\)/i,
    );
  });
});
