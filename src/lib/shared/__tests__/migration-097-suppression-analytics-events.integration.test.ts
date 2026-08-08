// Shape suite for migration 097 (#643 spec §9.4). Deliberately a pure
// SQL-text suite, like migration-094's and migration-089's: the subject is the
// constraint list in the migration FILE (immutable once applied), so no live DB
// is needed and no run-time DDL ever executes. The `.integration.test.ts` name
// only places it in vitest's serialized project — harmless for a text-only
// suite.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const sql = readFileSync(
  join(process.cwd(), 'supabase/migrations/097_suppression_analytics_events.sql'),
  'utf8',
);
const previousSql = readFileSync(
  join(process.cwd(), 'supabase/migrations/094_consent_analytics_events.sql'),
  'utf8',
);

// Executable SQL only — strip `-- …` line comments so SQL discussed in the
// migration header is not mistaken for a statement the migration runs.
const executableSql = sql.replace(/--.*$/gm, '');
const previousExecutableSql = previousSql.replace(/--.*$/gm, '');

function eventNamesInCheck(text: string): string[] {
  const checkMatch = text.match(/event_name IN\s*\(([^)]*)\)/i);
  expect(checkMatch).not.toBeNull();
  return [...checkMatch![1]!.matchAll(/'([^']+)'/g)].map((m) => m[1]!);
}

describe('migration 097 - suppression ledger analytics events', () => {
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

  it('migration 097 admits solicitation_suppressed and solicitation_suppressed_at_dispatch into the analytics_events CHECK', () => {
    // Registering the names only in ANALYTICS_EVENT_NAMES is not enough:
    // without the CHECK entries every emitting transaction ROLLS BACK, and
    // `ci:analytics-events` never inspects the database. `solicitation_
    // suppressed` is emitted by this ticket's writer; `solicitation_suppressed_
    // at_dispatch` is emitted by #630 and is registered here so #644 and #630
    // both stay migration-free.
    expect(executableSql).toMatch(/'solicitation_suppressed'/);
    expect(executableSql).toMatch(/'solicitation_suppressed_at_dispatch'/);
  });

  it('is a strict superset of 094 in the SAME order — existing rows always pass', () => {
    // The failure this catches is retyping the list instead of copying it: a
    // dropped member re-validates every existing analytics_events row against
    // a narrower CHECK and the ALTER fails in production, while
    // `ci:analytics-events` stays green because it never reads the database.
    const previous = eventNamesInCheck(previousExecutableSql);
    const current = eventNamesInCheck(executableSql);
    expect(current.slice(0, previous.length)).toEqual(previous);
    expect(current.slice(previous.length)).toEqual([
      'solicitation_suppressed',
      'solicitation_suppressed_at_dispatch',
    ]);
  });

  it('migration 097 pins its own historical event-name list', () => {
    // RE-PINNED for #679 T1. 097 held the live ANALYTICS_EVENT_NAMES drift guard
    // while it was the LATEST constraint-replacing migration; 102 is now, so 102's
    // suite owns it — the same handoff 094 made to 097, and stated in 097's own
    // migrations-log entry.
    //
    // Left behind is the assertion only THIS file can make: 097's list is
    // history, immutable, and equal to these 23 names in this order. Keeping the
    // live guard here instead would fail the moment 102 registers a 24th name —
    // for a constraint that has been in the database since the day it shipped.
    expect(eventNamesInCheck(executableSql)).toEqual([
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
      'solicitation_suppressed',
      'solicitation_suppressed_at_dispatch',
    ]);
  });
});
