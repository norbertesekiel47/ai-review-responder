import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const sql = readFileSync(
  join(process.cwd(), 'supabase/migrations/046_analytics_events.sql'),
  'utf8',
);

describe('migration 046 - analytics_events', () => {
  it('creates analytics_events as a local first-party dispatch queue', () => {
    expect(sql).toMatch(/CREATE TABLE IF NOT EXISTS analytics_events\s*\(/i);
    expect(sql).toMatch(/id UUID PRIMARY KEY DEFAULT gen_random_uuid\(\)/i);
    expect(sql).toMatch(/event_key TEXT NOT NULL UNIQUE/i);
    expect(sql).toMatch(/event_name TEXT NOT NULL/i);
    expect(sql).toMatch(/distinct_id TEXT NOT NULL/i);
    expect(sql).toMatch(/anonymous_id TEXT/i);
    expect(sql).toMatch(/account_id UUID REFERENCES accounts\(id\) ON DELETE SET NULL/i);
    expect(sql).toMatch(/user_id UUID REFERENCES users\(id\) ON DELETE SET NULL/i);
    expect(sql).toMatch(/business_id UUID REFERENCES businesses\(id\) ON DELETE SET NULL/i);
    expect(sql).toMatch(/properties JSONB NOT NULL DEFAULT '\{\}'::jsonb/i);
    expect(sql).toMatch(/occurred_at TIMESTAMPTZ NOT NULL DEFAULT NOW\(\)/i);
    expect(sql).toMatch(/available_at TIMESTAMPTZ NOT NULL DEFAULT NOW\(\)/i);
    expect(sql).toMatch(/dispatched_at TIMESTAMPTZ/i);
    expect(sql).toMatch(/locked_at TIMESTAMPTZ/i);
    expect(sql).toMatch(/attempts INTEGER NOT NULL DEFAULT 0/i);
    expect(sql).toMatch(/max_attempts INTEGER NOT NULL DEFAULT 5/i);
    expect(sql).toMatch(/status TEXT NOT NULL DEFAULT 'pending'/i);
    expect(sql).toMatch(/created_at TIMESTAMPTZ NOT NULL DEFAULT NOW\(\)/i);
  });

  it('constrains event names and queue statuses', () => {
    expect(sql).toMatch(/CHECK\s*\(\s*event_name IN\s*\(/i);
    expect(sql).toMatch(/'signup_started'/i);
    expect(sql).toMatch(/'email_verified'/i);
    expect(sql).toMatch(/'sample_demo_started'/i);
    expect(sql).toMatch(/'sample_demo_to_signup'/i);
    expect(sql).toMatch(/'gbp_connect_started'/i);
    expect(sql).toMatch(/'gbp_connect_failed'/i);
    expect(sql).toMatch(/'gbp_connected'/i);
    expect(sql).toMatch(/'first_review_ingested'/i);
    expect(sql).toMatch(/'first_response_drafted'/i);
    expect(sql).toMatch(/'activation_completed'/i);
    expect(sql).toMatch(/CHECK\s*\(\s*status IN\s*\(\s*'pending',\s*'dispatching',\s*'completed',\s*'failed'\s*\)\s*\)/i);
  });

  it('documents the queue purpose and id fallback', () => {
    expect(sql).toMatch(/COMMENT ON TABLE analytics_events IS/i);
    expect(sql).toMatch(/First-party analytics queue/i);
    expect(sql).toMatch(/COMMENT ON COLUMN analytics_events\.id IS/i);
    expect(sql).toMatch(/Application code should pass UUIDv7/i);
  });

  it('adds dispatch indexes for pending rows, account lookup, status, and locked rows', () => {
    expect(sql).toMatch(/CREATE INDEX IF NOT EXISTS idx_analytics_events_pending/i);
    expect(sql).toMatch(/WHERE status = 'pending'/i);
    expect(sql).toMatch(/CREATE INDEX IF NOT EXISTS idx_analytics_events_account/i);
    expect(sql).toMatch(/CREATE INDEX IF NOT EXISTS idx_analytics_events_status/i);
    expect(sql).toMatch(/CREATE INDEX IF NOT EXISTS idx_analytics_events_locked/i);
    expect(sql).toMatch(/WHERE status = 'dispatching'/i);
  });

  it('does not add posthog-js or a browser SDK artifact', () => {
    expect(sql).not.toMatch(/posthog-js/i);
  });
});
