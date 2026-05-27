import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';

const MIGRATION_PATH = resolve(
  process.cwd(),
  'supabase/migrations/051_flagged_responses.sql',
);

let sql: string;
beforeAll(() => {
  sql = readFileSync(MIGRATION_PATH, 'utf-8');
});

describe('migration 051 — flagged_responses', () => {
  it('creates the table idempotently', () => {
    expect(sql).toMatch(/CREATE TABLE IF NOT EXISTS flagged_responses/i);
  });

  it.each([
    'response_id',
    'account_id',
    'business_id',
    'review_id',
    'api_cost_id',
    'source',
    'reason',
    'severity',
    'status',
    'reviewed_by_user_id',
    'reviewed_at',
    'created_at',
    'updated_at',
  ])('defines column %s', (col) => {
    expect(sql).toMatch(new RegExp(`\\b${col}\\b`));
  });

  it('references the parent rows', () => {
    expect(sql).toMatch(/response_id\s+UUID[^,]*REFERENCES\s+responses\(id\)/i);
    expect(sql).toMatch(/account_id\s+UUID[^,]*REFERENCES\s+accounts\(id\)/i);
    expect(sql).toMatch(/business_id\s+UUID[^,]*REFERENCES\s+businesses\(id\)/i);
    expect(sql).toMatch(/review_id\s+UUID[^,]*REFERENCES\s+reviews\(id\)/i);
    expect(sql).toMatch(/api_cost_id\s+UUID[^,]*REFERENCES\s+api_costs\(id\)/i);
    // api_cost_id nulls out (not RESTRICT) so the api_costs 90-day prune isn't blocked.
    expect(sql).toMatch(/api_cost_id[^,]*ON DELETE SET NULL/i);
  });

  it('constrains status and severity', () => {
    expect(sql).toMatch(/status[^,]*CHECK[^,]*open/i);
    expect(sql).toMatch(/severity[^,]*CHECK[^,]*high/i);
  });

  it('enables RLS (admin-only, deny-all)', () => {
    expect(sql).toMatch(/ALTER TABLE flagged_responses ENABLE ROW LEVEL SECURITY/i);
    expect(sql).not.toMatch(/CREATE POLICY/i);
  });

  it('indexes the admin queue read path', () => {
    expect(sql).toMatch(/CREATE INDEX IF NOT EXISTS[^;]*flagged_responses[^;]*status/i);
  });

  it('does not drop or mutate data', () => {
    expect(sql).not.toMatch(/DROP TABLE/i);
    expect(sql).not.toMatch(/^\s*UPDATE\s+/im);
    expect(sql).not.toMatch(/^\s*DELETE\s+/im);
  });
});
