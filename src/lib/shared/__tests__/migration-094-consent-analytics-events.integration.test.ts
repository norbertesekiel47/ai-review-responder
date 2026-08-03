// Shape suite for migration 094 (#625 spec §8.1). Deliberately a pure
// SQL-text suite, like migration-089's: the subject is the constraint list in
// the migration FILE (immutable once applied), so no live DB is needed and no
// run-time DDL ever executes. The `.integration.test.ts` name only places it
// in vitest's serialized project — harmless for a text-only suite.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const sql = readFileSync(
  join(process.cwd(), 'supabase/migrations/094_consent_analytics_events.sql'),
  'utf8',
);

// Executable SQL only — strip `-- …` line comments so SQL discussed in the
// migration header is not mistaken for a statement the migration runs.
const executableSql = sql.replace(/--.*$/gm, '');

describe('migration 094 - consent ledger analytics events', () => {
  it('replaces the analytics event_name CHECK constraint idempotently', () => {
    expect(sql).toMatch(
      /ALTER TABLE analytics_events\s+DROP CONSTRAINT IF EXISTS analytics_events_event_name_check/i,
    );
    expect(sql).toMatch(
      /ALTER TABLE analytics_events\s+ADD CONSTRAINT analytics_events_event_name_check/i,
    );
  });

  it('sets a lock_timeout for the ACCESS EXCLUSIVE constraint swap', () => {
    expect(executableSql).toMatch(/SET (LOCAL )?lock_timeout/i);
  });

  it('registers both consent events at the DB CHECK level', () => {
    // Registering the names only in ANALYTICS_EVENT_NAMES is not enough:
    // without the CHECK entries every consent-recording csv_ingest
    // transaction ROLLS BACK, and `ci:analytics-events` never inspects the
    // database.
    expect(executableSql).toMatch(/'solicitation_consent_recorded'/);
    expect(executableSql).toMatch(/'solicitation_consent_upgraded'/);
  });

  // The live "effective CHECK list ⟺ ANALYTICS_EVENT_NAMES" drift-guard moved
  // to migration-097 (the LATEST migration that replaces the constraint,
  // adding the Suppression ledger events). 094 is no longer the head of this
  // constraint, and its SQL is immutable — so its list can never grow again.
  // What remains here is 094's own historical list, pinned as a literal.
  it('pins 094 own historical event_name CHECK list', () => {
    const checkMatch = executableSql.match(/event_name IN\s*\(([^)]*)\)/i);
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
      'competitor_rival_picked',
      'solicitation_consent_recorded',
      'solicitation_consent_upgraded',
    ]);
  });
});
