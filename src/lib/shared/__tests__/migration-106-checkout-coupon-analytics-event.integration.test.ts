// Shape suite for migration 106 (admin-invite-funnel T3) — the Beta comp
// coupon decision analytics event.
//
// Text-shape PLUS one live rejection, following the 089 → 094 → 097 → 102
// precedent verbatim: the subject of the text assertions is the constraint list
// in the migration FILE, immutable once applied, so no live DB is needed and no
// run-time DDL ever executes. The live assertion exists because superset-plus-
// subset does NOT prove rejection — a CHECK carrying extra DB-only names
// satisfies both text assertions while admitting a name nothing registered.
//
// 106 HELD the live ANALYTICS_EVENT_NAMES drift guard while it was the latest
// migration replacing analytics_events_event_name_check. 115 is now the latest,
// so 115's suite owns that guard and this file keeps only the historical pin —
// the same handoff 097 made to 102 and 102 made to 106.
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

const MIGRATION_106 = 'supabase/migrations/106_checkout_coupon_analytics_event.sql';
const MIGRATION_102 = 'supabase/migrations/102_import_consent_analytics_events.sql';

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

const NEW_EVENT_NAMES = ['checkout_coupon_decision'] as const;

describe('migration 106 - checkout coupon analytics event', () => {
  it('migration 106 replaces the analytics event_name CHECK constraint idempotently', () => {
    const sql = migrationText(MIGRATION_106);
    expect(sql).toMatch(
      /ALTER TABLE analytics_events\s+DROP CONSTRAINT IF EXISTS analytics_events_event_name_check/i,
    );
    expect(sql).toMatch(
      /ALTER TABLE analytics_events\s+ADD CONSTRAINT analytics_events_event_name_check/i,
    );
  });

  it('migration 106 sets a lock_timeout for the ACCESS EXCLUSIVE constraint swap', () => {
    // DROP + re-ADD takes a brief ACCESS EXCLUSIVE lock on analytics_events and
    // re-validates every existing row. Without a bound, a swap that queues
    // behind a long reader blocks every emitting transaction in the system.
    expect(executableSql(MIGRATION_106)).toMatch(/SET (LOCAL )?lock_timeout/i);
  });

  it('migration 106 admits checkout_coupon_decision in analytics_events', () => {
    // The DB CHECK is the REAL registration. Registering the name only in
    // ANALYTICS_EVENT_NAMES would roll back the emitting statement — which for
    // this event is the post-commit coupon-decision record that exists to make
    // a silently-skipped comp visible before a beta tester is charged.
    const text = executableSql(MIGRATION_106);
    for (const name of NEW_EVENT_NAMES) {
      expect(text).toContain(`'${name}'`);
    }
  });

  it('migration 106 keeps every event name from migration 102 in the CHECK', () => {
    // The failure this catches is RETYPING the list instead of copying it: a
    // dropped member re-validates every existing analytics_events row against a
    // narrower CHECK, the ALTER fails in production, and `ci:analytics-events`
    // stays green because it never reads the database.
    const previous = eventNamesInCheck(executableSql(MIGRATION_102));
    const current = eventNamesInCheck(executableSql(MIGRATION_106));
    expect(current.slice(0, previous.length)).toEqual(previous);
    expect(current.slice(previous.length)).toEqual([...NEW_EVENT_NAMES]);
  });

  it('migration 106 pins its own historical event-name list', () => {
    // RE-PINNED for feat-qr-review-request. 106 held the live
    // ANALYTICS_EVENT_NAMES drift guard while it was the LATEST
    // constraint-replacing migration; 115 is now, so 115's suite owns it — the
    // same handoff 097 made to 102 and 102 made to 106, and stated in 106's own
    // migrations-log entry.
    //
    // Left behind is the assertion only THIS file can make: 106's list is
    // history, immutable, and equal to these 26 names in this order. Keeping the
    // live guard here instead would fail the moment 115 registers a 27th name —
    // for a constraint that has been in the database since the day it shipped.
    // That is exactly what happened: registering `qr_scan_redirected` turned
    // this suite red until the handoff was made.
    expect(eventNamesInCheck(executableSql(MIGRATION_106))).toEqual([
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
      'checkout_coupon_decision',
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

describeWithDb('migration 106 against live Postgres', { timeout: 30_000 }, () => {
  beforeAll(() => {
    db = postgres(testDatabaseUrl!, { max: 1, prepare: false });
  });

  afterAll(async () => {
    if (db) await db.end({ timeout: 5 });
  });

  it('migration 106 still rejects an unregistered event name', async () => {
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
            ${`migration-106-probe-${Date.now()}`},
            'checkout_coupon_decision_typo_not_registered',
            'migration-106-probe'
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
