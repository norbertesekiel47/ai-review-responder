import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const sql = readFileSync(
  join(process.cwd(), 'supabase/migrations/048_impersonation_sessions.sql'),
  'utf8',
);

describe('migration 048 - impersonation_sessions', () => {
  it('creates impersonation_sessions with UUID fallback and audit fields', () => {
    expect(sql).toMatch(/CREATE TABLE IF NOT EXISTS impersonation_sessions/i);
    expect(sql).toMatch(/id UUID PRIMARY KEY DEFAULT gen_random_uuid\(\)/i);
    expect(sql).toMatch(/actor_user_id UUID NOT NULL REFERENCES users\(id\)/i);
    expect(sql).toMatch(/impersonated_user_id UUID NOT NULL REFERENCES users\(id\)/i);
    expect(sql).toMatch(/account_id UUID NOT NULL REFERENCES accounts\(id\)/i);
    expect(sql).toMatch(/ticket_id TEXT NOT NULL/i);
    expect(sql).toMatch(/reason TEXT NOT NULL/i);
    expect(sql).toMatch(/expires_at TIMESTAMPTZ NOT NULL/i);
  });

  it('enforces one active session per actor via a partial UNIQUE index', () => {
    expect(sql).toMatch(/CREATE UNIQUE INDEX IF NOT EXISTS idx_impersonation_active_actor/i);
    expect(sql).toMatch(/ON impersonation_sessions \(actor_user_id\)\s*\n?\s*WHERE ended_at IS NULL/i);
    expect(sql).toMatch(/CREATE INDEX IF NOT EXISTS idx_impersonation_account_started/i);
  });

  it('enables RLS so browser Supabase clients cannot read sessions directly', () => {
    expect(sql).toMatch(/ALTER TABLE impersonation_sessions ENABLE ROW LEVEL SECURITY/i);
    expect(sql).not.toMatch(/CREATE POLICY/i);
  });
});
