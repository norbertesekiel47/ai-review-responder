import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const sql = readFileSync(
  join(process.cwd(), 'supabase/migrations/089_competitor_rival_pick.sql'),
  'utf8',
);

// Executable SQL only — strip `-- …` line comments so SQL discussed in the
// migration header is not mistaken for a statement the migration runs.
const executableSql = sql.replace(/--.*$/gm, '');

describe('migration 089 - owner-picked Named rival columns', () => {
  // The single `ALTER TABLE businesses …;` statement, so the nullability and
  // no-default assertions below cannot be satisfied or defeated by prose in a
  // COMMENT string literal elsewhere in the file.
  const alterBusinesses = executableSql.match(/ALTER TABLE businesses[^;]*;/i)?.[0];

  it('adds the three pick columns idempotently and nullably', () => {
    expect(alterBusinesses).toBeDefined();
    for (const column of [
      'rival_place_id TEXT',
      'rival_title_snapshot TEXT',
      'rival_picked_at TIMESTAMPTZ',
    ]) {
      expect(alterBusinesses).toMatch(
        new RegExp(`ADD COLUMN IF NOT EXISTS ${column}`, 'i'),
      );
    }
    // Nullable, no default, no backfill: existing rows keep behaving exactly as
    // today (they fall back to the Auto-default rival).
    expect(alterBusinesses).not.toMatch(/NOT NULL/i);
    expect(alterBusinesses).not.toMatch(/DEFAULT/i);
    expect(executableSql).not.toMatch(/UPDATE businesses SET/i);
  });

  it('does NOT foreign-key the pick to competitor_snapshots', () => {
    // Packs are replaced wholesale on every ranking run (084's replace-pack
    // idempotency), so an FK would cascade-delete a pick the owner made.
    expect(executableSql).not.toMatch(/REFERENCES competitor_snapshots/i);
  });

  it('sets a lock_timeout for the ACCESS EXCLUSIVE constraint swap', () => {
    expect(executableSql).toMatch(/SET (LOCAL )?lock_timeout/i);
  });

  it('replaces the analytics event_name CHECK constraint idempotently', () => {
    expect(sql).toMatch(
      /ALTER TABLE analytics_events\s+DROP CONSTRAINT IF EXISTS analytics_events_event_name_check/i,
    );
    expect(sql).toMatch(
      /ALTER TABLE analytics_events\s+ADD CONSTRAINT analytics_events_event_name_check/i,
    );
  });

  it('registers competitor_rival_picked at the DB CHECK level', () => {
    // Registering the name only in ANALYTICS_EVENT_NAMES is not enough: without
    // the CHECK entry every pick transaction ROLLS BACK, and
    // `ci:analytics-events` never inspects the database.
    expect(executableSql).toMatch(/'competitor_rival_picked'/);
  });

  // The live "effective CHECK list ⟺ ANALYTICS_EVENT_NAMES" drift-guard moved
  // to migration-094 (the LATEST migration that replaces the constraint,
  // adding the consent-ledger events). 089 is no longer the head of this
  // constraint, and its SQL is immutable — so its list can never grow again.
  // What remains here is 089's own historical list, pinned as a literal.
  it('pins 089 own historical event_name CHECK list', () => {
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
    ]);
  });

  it('does not drop any name that 069 had already allowed', () => {
    // Dropping a name silently breaks an existing event lane; the DROP/ADD makes
    // that a one-character mistake.
    const previousSql = readFileSync(
      join(process.cwd(), 'supabase/migrations/069_trial_subscription.sql'),
      'utf8',
    ).replace(/--.*$/gm, '');
    const previousNames = [
      ...previousSql
        .match(/event_name IN\s*\(([^)]*)\)/i)![1]!
        .matchAll(/'([^']+)'/g),
    ].map((m) => m[1]);
    const namesInCheck = new Set(
      [
        ...executableSql
          .match(/event_name IN\s*\(([^)]*)\)/i)![1]!
          .matchAll(/'([^']+)'/g),
      ].map((m) => m[1]),
    );
    expect(previousNames.filter((name) => !namesInCheck.has(name))).toEqual([]);
  });
});
