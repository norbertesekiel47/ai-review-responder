import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const sql = readFileSync(
  join(process.cwd(), 'supabase/migrations/069_trial_subscription.sql'),
  'utf8',
);

// Executable SQL only — strip `-- …` line comments so example SQL written in the
// migration header (e.g. a verification `INSERT INTO …;`) is not mistaken for an
// actual statement the migration runs.
const executableSql = sql.replace(/--.*$/gm, '');

describe('migration 069 - card-up-front trial', () => {
  it('comments accounts.subscription_activated_at as the service-start anchor', () => {
    expect(sql).toMatch(/COMMENT ON COLUMN accounts\.subscription_activated_at IS/i);
    expect(sql).toMatch(/service-start/i);
  });

  it('adds NO new column and NO data backfill', () => {
    expect(executableSql).not.toMatch(/ADD COLUMN/i);
    expect(executableSql).not.toMatch(/UPDATE accounts SET/i);
    expect(executableSql).not.toMatch(/INSERT INTO/i);
  });

  it('replaces the analytics event_name CHECK constraint idempotently', () => {
    expect(sql).toMatch(/ALTER TABLE analytics_events\s+DROP CONSTRAINT IF EXISTS analytics_events_event_name_check/i);
    expect(sql).toMatch(/ALTER TABLE analytics_events\s+ADD CONSTRAINT analytics_events_event_name_check/i);
  });

  it('adds the four trial lifecycle events', () => {
    for (const eventName of [
      'trial_started',
      'trial_converted',
      'trial_payment_failed',
      'trial_cancelled',
    ]) {
      expect(sql).toMatch(new RegExp(`'${eventName}'`, 'i'));
    }
  });

  // The live "effective CHECK list ⟺ ANALYTICS_EVENT_NAMES" drift-guard moved to
  // migration-089 (the LATEST migration that replaces the constraint, adding
  // competitor_rival_picked). 069 is no longer the head of this constraint, and
  // its SQL is immutable — so its list can never grow again. What remains here is
  // 069's own historical list, pinned as a literal.
  it('pins 069 own historical event_name CHECK list', () => {
    const checkMatch = sql.match(/event_name IN\s*\(([^)]*)\)/i);
    expect(checkMatch).not.toBeNull();
    const namesInCheck = [...checkMatch![1]!.matchAll(/'([^']+)'/g)].map((m) => m[1]);
    expect(namesInCheck).toEqual([
      'signup_started',
      'email_verified',
      'sample_demo_started',
      'sample_demo_to_signup',
      'gbp_connect_started',
      'gbp_connect_failed',
      'gbp_connected',
      'first_review_ingested',
      'first_response_drafted',
      'activation_completed',
      'offboarding_started',
      'offboarding_reactivated',
      'offboarding_teardown_completed',
      'offboarding_purged',
      'trial_started',
      'trial_converted',
      'trial_payment_failed',
      'trial_cancelled',
    ]);
  });

  it('does not introduce a NEXT_PUBLIC_ companion or a subscription_status CHECK constraint', () => {
    expect(sql).not.toMatch(/NEXT_PUBLIC_/i);
    // No CHECK constraint is ever added on accounts.subscription_status (the
    // 'trialing' value is a plain new VARCHAR value). Guard the executable SQL.
    expect(executableSql).not.toMatch(/subscription_status.*CHECK/i);
  });
});
