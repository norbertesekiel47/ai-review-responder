import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';

const MIGRATION_PATH = resolve(
  process.cwd(),
  'supabase/migrations/056_account_offboarding.sql',
);

let sql: string;
let normalized: string;

beforeAll(() => {
  sql = readFileSync(MIGRATION_PATH, 'utf-8');
  normalized = sql.replace(/\s+/g, ' ');
});

function createTableBody(table: string): string {
  const match = normalized.match(
    new RegExp(`CREATE TABLE IF NOT EXISTS ${table} \\((.+?)\\);`, 'i'),
  );
  if (!match?.[1]) throw new Error(`missing CREATE TABLE for ${table}`);
  return match[1];
}

function partialIndexPredicate(indexName: string): string | null {
  const escaped = indexName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const match = normalized.match(new RegExp(`${escaped}[^;]+ WHERE ([^;]+);`, 'i'));
  return match?.[1] ?? null;
}

describe('migration 056 - account offboarding schema', () => {
  it('creates exactly the two approved tables', () => {
    expect(normalized).toMatch(/CREATE TABLE IF NOT EXISTS account_offboardings \(/i);
    expect(normalized).toMatch(/CREATE TABLE IF NOT EXISTS account_offboarding_tokens \(/i);
    expect(normalized).not.toMatch(/CREATE TABLE IF NOT EXISTS account_offboarding_provider/i);
  });

  it('uses app-generated UUIDv7 IDs and account-scoped identity columns', () => {
    const body = createTableBody('account_offboardings');
    expect(body).toMatch(/id UUID PRIMARY KEY,/i);
    expect(body).not.toMatch(/id UUID PRIMARY KEY DEFAULT/i);
    expect(body).toMatch(/account_id UUID NOT NULL REFERENCES accounts\(id\) ON DELETE CASCADE/i);
    expect(body).toMatch(/mode TEXT NOT NULL/i);
    expect(body).toMatch(/system_origin TEXT NOT NULL DEFAULT 'owner'/i);
  });

  it.each([
    'status',
    'failed_step',
    'requested_at',
    'access_ends_at',
    'billing_cancel_confirmed_at',
    'teardown_started_at',
    'teardown_completed_at',
    'purge_after',
    'purge_started_at',
    'purged_at',
    'purge_cancelled_at',
    'reactivated_at',
    'terminal_at',
  ])('defines lifecycle column %s', (column) => {
    expect(createTableBody('account_offboardings')).toMatch(new RegExp(`\\b${column}\\b`, 'i'));
  });

  it.each([
    'stripe_customer_id',
    'stripe_subscription_id',
    'zernio_account_ids',
    'zernio_profile_ids',
    'location_ids',
    'auth_user_id',
  ])('defines snapshot column %s', (column) => {
    expect(createTableBody('account_offboardings')).toMatch(new RegExp(`\\b${column}\\b`, 'i'));
  });

  it.each([
    'stripe_step',
    'zernio_accounts_step',
    'zernio_profiles_step',
    'location_archival_step',
    'job_terminalization_step',
    'retry_count',
    'last_error',
  ])('defines step/retry column %s', (column) => {
    expect(createTableBody('account_offboardings')).toMatch(new RegExp(`\\b${column}\\b`, 'i'));
  });

  it('defines transient fields and provider dispositions without a third table', () => {
    const body = createTableBody('account_offboardings');
    expect(body).toMatch(/recipient_email TEXT/i);
    expect(body).toMatch(/provider_dispositions JSONB NOT NULL DEFAULT '\[\]'::jsonb/i);
    expect(body).toMatch(/jsonb_typeof\(provider_dispositions\) = 'array'/i);
  });

  it('constrains mode, origin, status, failure, terminal, and step domains', () => {
    expect(normalized).toMatch(/mode IN \('cancel_only', 'delete_data'\)/i);
    expect(normalized).toMatch(/system_origin = 'owner'/i);
    expect(normalized).toMatch(
      /status IN \('pending', 'scheduled', 'tearing_down', 'purge_scheduled', 'purged', 'churned', 'reactivated', 'failed'\)/i,
    );
    expect(normalized).toMatch(
      /status = 'failed' AND failed_step IN \('billing', 'teardown', 'purge'\)/i,
    );
    expect(normalized).toMatch(/status <> 'failed' AND failed_step IS NULL/i);
    expect(normalized).toMatch(
      /status IN \('purged', 'churned', 'reactivated'\) AND terminal_at IS NOT NULL/i,
    );
    expect(normalized).toMatch(
      /status NOT IN \('purged', 'churned', 'reactivated'\) AND terminal_at IS NULL/i,
    );
    expect(normalized).toMatch(
      /mode = 'cancel_only' AND status IN \('pending', 'scheduled', 'tearing_down', 'churned', 'reactivated', 'failed'\)/i,
    );
    expect(normalized).toMatch(
      /mode = 'delete_data' AND status IN \('pending', 'tearing_down', 'purge_scheduled', 'purged', 'churned', 'failed'\)/i,
    );

    for (const column of [
      'stripe_step',
      'zernio_accounts_step',
      'zernio_profiles_step',
      'location_archival_step',
      'job_terminalization_step',
    ]) {
      expect(normalized).toMatch(
        new RegExp(`${column} IN \\('success', 'failed', 'not_applicable'\\)`, 'i'),
      );
    }
  });

  it('creates required partial and lookup indexes with exact predicates', () => {
    expect(partialIndexPredicate('account_offboardings_one_active_per_account')).toBe(
      'terminal_at IS NULL',
    );
    expect(partialIndexPredicate('idx_account_offboardings_purge_after_scheduled')).toBe(
      "status = 'purge_scheduled'",
    );
    expect(partialIndexPredicate('idx_account_offboardings_access_ends_scheduled')).toBe(
      "status = 'scheduled'",
    );
    expect(normalized).toMatch(
      /CREATE INDEX IF NOT EXISTS idx_account_offboardings_account_id ON account_offboardings\(account_id\);/i,
    );
    expect(normalized).toMatch(
      /CREATE INDEX IF NOT EXISTS idx_account_offboardings_stripe_subscription_id ON account_offboardings\(stripe_subscription_id\) WHERE stripe_subscription_id IS NOT NULL;/i,
    );
  });

  it('creates keep-my-data tokens with hashed tokens only', () => {
    const body = createTableBody('account_offboarding_tokens');
    expect(body).toMatch(/id UUID PRIMARY KEY,/i);
    expect(body).not.toMatch(/id UUID PRIMARY KEY DEFAULT/i);
    expect(body).toMatch(
      /account_offboarding_id UUID NOT NULL REFERENCES account_offboardings\(id\) ON DELETE CASCADE/i,
    );
    expect(body).toMatch(/token_hash TEXT NOT NULL/i);
    expect(body).toMatch(/token_type TEXT NOT NULL DEFAULT 'keep_my_data'/i);
    expect(body).toMatch(/expires_at TIMESTAMPTZ NOT NULL/i);
    expect(body).toMatch(/consumed_at TIMESTAMPTZ/i);
    expect(body).toMatch(/revoked_at TIMESTAMPTZ/i);
    expect(body).toMatch(/created_by_user_id UUID REFERENCES users\(id\) ON DELETE SET NULL/i);
    expect(normalized).toMatch(/token_type = 'keep_my_data'/i);
    expect(normalized).toMatch(/token_hash ~ '\^\[a-f0-9\]\{64\}\$'/i);
    expect(normalized).toMatch(/CREATE OR REPLACE FUNCTION enforce_account_offboarding_token_expiry\(\)/i);
    expect(normalized).toMatch(/IF NEW\.expires_at > offboarding_purge_after THEN/i);
    expect(normalized).toMatch(/CREATE TRIGGER account_offboarding_tokens_expiry_guard/i);
    expect(normalized).toMatch(/CREATE OR REPLACE FUNCTION enforce_account_offboarding_purge_after_token_expiry\(\)/i);
    expect(normalized).toMatch(/expires_at > NEW\.purge_after/i);
    expect(normalized).toMatch(/CREATE TRIGGER account_offboardings_purge_after_token_expiry_guard/i);
    expect(normalized).not.toMatch(/\braw_?token\b/i);
    expect(normalized).not.toMatch(/\btoken_plaintext\b/i);
  });

  it('enables deny-all RLS with no authenticated owner policies', () => {
    expect(normalized).toMatch(/ALTER TABLE account_offboardings ENABLE ROW LEVEL SECURITY;/i);
    expect(normalized).toMatch(/ALTER TABLE account_offboarding_tokens ENABLE ROW LEVEL SECURITY;/i);
    expect(normalized).toMatch(/REVOKE ALL ON account_offboardings FROM anon, authenticated;/i);
    expect(normalized).toMatch(/REVOKE ALL ON account_offboarding_tokens FROM anon, authenticated;/i);
    expect(sql).not.toMatch(/CREATE POLICY[\s\S]+account_offboarding/i);
  });
});
