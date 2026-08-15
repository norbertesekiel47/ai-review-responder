// Shape suite for migration 102 (#679 T1) — the Import offer analytics events.
//
// Text-shape PLUS one live rejection. The five text assertions follow the
// 089 → 094 → 097 precedent (the subject is the constraint list in the
// migration FILE, immutable once applied, so no live DB is needed and no
// run-time DDL ever executes). The sixth is live because superset-plus-subset
// does NOT prove rejection: a CHECK carrying extra DB-only names satisfies both
// text assertions while admitting a name nothing registered.
//
// 102 HELD the live ANALYTICS_EVENT_NAMES drift guard while it was the latest
// migration replacing analytics_events_event_name_check. 106 is now the latest,
// so 106's suite owns that guard and this file keeps only the historical pin —
// the same handoff 094 made to 097 and 097 made to 102.
//
// Live-DB conventions (`ci:live-db-suites`): named `*.integration.test.ts`,
// gated by describeWithDb, and it NEVER applies migration SQL — the one write it
// makes is an ordinary INSERT inside a transaction that always rolls back.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import postgres from 'postgres';
import type postgresType from 'postgres';
import { describeWithDb } from '@/__tests__/helpers/describe-with-db';

const MIGRATION_102 = 'supabase/migrations/102_import_consent_analytics_events.sql';
const MIGRATION_097 = 'supabase/migrations/097_suppression_analytics_events.sql';

/**
 * Read lazily, not at module scope. Before T1 the file does not exist, and a
 * top-level read would fail COLLECTION — reporting one suite error instead of
 * the six named titles this eval commit is supposed to fail on.
 */
function migrationText(path: string): string {
  return readFileSync(join(process.cwd(), path), 'utf8');
}

/** Executable SQL only — `-- …` line comments discuss SQL they do not run. */
function executableSql(path: string): string {
  return migrationText(path).replace(/--.*$/gm, '');
}

function eventNamesInCheck(text: string): string[] {
  const checkMatch = text.match(/event_name IN\s*\(([^)]*)\)/i);
  expect(checkMatch).not.toBeNull();
  return [...checkMatch![1]!.matchAll(/'([^']+)'/g)].map((m) => m[1]!);
}

const NEW_EVENT_NAMES = ['import_offer_created', 'import_decision_recorded'] as const;

describe('migration 102 - import consent analytics events', () => {
  it('migration 102 replaces the analytics event_name CHECK constraint idempotently', () => {
    const sql = migrationText(MIGRATION_102);
    expect(sql).toMatch(
      /ALTER TABLE analytics_events\s+DROP CONSTRAINT IF EXISTS analytics_events_event_name_check/i,
    );
    expect(sql).toMatch(
      /ALTER TABLE analytics_events\s+ADD CONSTRAINT analytics_events_event_name_check/i,
    );
  });

  it('migration 102 sets a lock_timeout for the ACCESS EXCLUSIVE constraint swap', () => {
    // DROP + re-ADD takes a brief ACCESS EXCLUSIVE lock on analytics_events and
    // re-validates every existing row. Without a bound, a swap that queues
    // behind a long reader blocks every emitting transaction in the system.
    expect(executableSql(MIGRATION_102)).toMatch(/SET (LOCAL )?lock_timeout/i);
  });

  it('migration 102 admits import_offer_created and import_decision_recorded in analytics_events', () => {
    // The DB CHECK is the REAL registration (#643's lesson, restated by #677
    // D7). Registering the names only in ANALYTICS_EVENT_NAMES rolls back every
    // emitting transaction on the constraint — and for `import_decision_
    // recorded` that transaction is a legitimate owner consent decision.
    const text = executableSql(MIGRATION_102);
    for (const name of NEW_EVENT_NAMES) {
      expect(text).toContain(`'${name}'`);
    }
  });

  it('migration 102 keeps every event name from migration 097 in the CHECK', () => {
    // The failure this catches is RETYPING the list instead of copying it: a
    // dropped member re-validates every existing analytics_events row against a
    // narrower CHECK, the ALTER fails in production, and `ci:analytics-events`
    // stays green because it never reads the database.
    const previous = eventNamesInCheck(executableSql(MIGRATION_097));
    const current = eventNamesInCheck(executableSql(MIGRATION_102));
    expect(current.slice(0, previous.length)).toEqual(previous);
    expect(current.slice(previous.length)).toEqual([...NEW_EVENT_NAMES]);
  });

  it('migration 102 pins its own historical event-name list', () => {
    // RE-PINNED for admin-invite-funnel T3. 102 held the live
    // ANALYTICS_EVENT_NAMES drift guard while it was the LATEST
    // constraint-replacing migration; 106 is now, so 106's suite owns it — the
    // same handoff 094 made to 097 and 097 made to 102, and stated in 102's own
    // migrations-log entry.
    //
    // Left behind is the assertion only THIS file can make: 102's list is
    // history, immutable, and equal to these 25 names in this order. Keeping the
    // live guard here instead would fail the moment 106 registers a 26th name —
    // for a constraint that has been in the database since the day it shipped.
    // That is exactly what happened: registering `checkout_coupon_decision`
    // turned this suite red until the handoff was made.
    expect(eventNamesInCheck(executableSql(MIGRATION_102))).toEqual([
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
      'import_offer_created',
      'import_decision_recorded',
    ]);
  });
});

// ── The one live assertion ──────────────────────────────────────────────────

const testDatabaseUrl = process.env.TEST_DATABASE_POOL_URL;

let db: postgresType.Sql | undefined;

/** Thrown to roll a probe transaction back; never escapes this file. */
class RollbackProbe extends Error {
  override readonly name = 'RollbackProbe';
}

describeWithDb('migration 102 against live Postgres', { timeout: 30_000 }, () => {
  beforeAll(() => {
    db = postgres(testDatabaseUrl!, { max: 1, prepare: false });
  });

  afterAll(async () => {
    if (db) await db.end({ timeout: 5 });
  });

  it('migration 102 still rejects an unregistered event name', async () => {
    // Superset-plus-subset permits a CHECK carrying extra DB-only names, so the
    // text assertions above cannot prove the constraint still REJECTS. Only the
    // database can. The write is made inside a transaction that always rolls
    // back, so no analytics row survives either outcome.
    let rejection: { code?: string } | undefined;
    try {
      await db!.begin(async (tx) => {
        await tx`
          INSERT INTO analytics_events (event_key, event_name, distinct_id)
          VALUES (
            ${`migration-102-probe-${Date.now()}`},
            'import_offer_created_typo_not_registered',
            'migration-102-probe'
          )
        `;
        throw new RollbackProbe();
      });
    } catch (error) {
      if ((error as { name?: string })?.name === 'RollbackProbe') {
        throw new Error(
          'analytics_events ACCEPTED an unregistered event_name — the CHECK constraint is missing or too wide',
        );
      }
      rejection = error as { code?: string };
    }

    // 23514 = check_violation. Asserting the SQLSTATE rather than the message
    // keeps this from passing on an unrelated failure (a missing column, a
    // rolled-back connection).
    expect(rejection?.code).toBe('23514');
  });
});
