// Shape suite for migration 094 (#625 spec §8.1). Deliberately a pure
// SQL-text suite, like migration-089's: the subject is the constraint list in
// the migration FILE (immutable once applied), so no live DB is needed and no
// run-time DDL ever executes. The `.integration.test.ts` name only places it
// in vitest's serialized project — harmless for a text-only suite.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { ANALYTICS_EVENT_NAMES } from '@/lib/analytics/events';

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

  it('keeps every ANALYTICS_EVENT_NAMES entry in the re-added CHECK list (drift-guard)', () => {
    // 094 is the LATEST migration that replaces the constraint, so it owns
    // this guard (handed off from migration-089's suite). Subset (not
    // toEqual) in this direction: the CHECK list may lead the TS allowlist
    // while a name is being introduced, but a name that the app can emit and
    // the DB would reject is a production rollback — that is what fails here.
    const checkMatch = executableSql.match(/event_name IN\s*\(([^)]*)\)/i);
    expect(checkMatch).not.toBeNull();
    const namesInCheck = new Set(
      [...checkMatch![1]!.matchAll(/'([^']+)'/g)].map((m) => m[1]),
    );
    const missingFromCheck = ANALYTICS_EVENT_NAMES.filter(
      (name) => !namesInCheck.has(name),
    );
    expect(missingFromCheck).toEqual([]);
  });
});
