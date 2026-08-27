// Shape suite for migration 115 (feat-qr-review-request) — the QR scan
// redirect analytics event (CONTEXT.md "QR redirect").
//
// Text-shape PLUS two live assertions, following the 089 → 094 → 097 → 102 →
// 106 precedent: the subject of the text assertions is the constraint list in
// the migration FILE, immutable once applied, so no live DB is needed and no
// run-time DDL ever executes. The live REJECTION exists because superset-plus-
// subset does NOT prove rejection — a CHECK carrying extra DB-only names
// satisfies both text assertions while admitting a name nothing registered.
// The live ADMIT (codex R2 on M3) exists because rejection alone proves only
// that SOME constraint is live — together they prove the constraint is live
// AND admits the name the /q/[businessId] route will insert.
//
// 115 is now the LATEST migration that replaces analytics_events_event_name_
// check, so it TAKES OVER the live ANALYTICS_EVENT_NAMES drift guard from
// 106's suite — the same handoff 097 made to 102 and 102 made to 106. That
// handoff is not optional bookkeeping: leaving the live guard in the previous
// suite is precisely what went red when each successor migration registered
// its new name.
//
// Why the guard matters at all: a name the app can emit and the DB would reject
// rolls back the emitting transaction in production, and `ci:analytics-events`
// cannot catch it because it only compares the TS allowlist against
// docs/analytics/events.md — it never reads the database.
//
// Live-DB conventions (`ci:live-db-suites`): named `*.integration.test.ts`,
// gated by describeWithDb, and it NEVER applies migration SQL — the writes it
// makes are ordinary INSERTs: the rejection probe inside a transaction that
// always rolls back, and the admit probe deleted by the same test.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import postgres from 'postgres';
import type postgresType from 'postgres';
import { describeWithDb } from '@/__tests__/helpers/describe-with-db';
import { ANALYTICS_EVENT_NAMES } from '@/lib/analytics/events';

const MIGRATION_115 = 'supabase/migrations/115_qr_scan_analytics_event.sql';
const MIGRATION_106 = 'supabase/migrations/106_checkout_coupon_analytics_event.sql';

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

const NEW_EVENT_NAMES = ['qr_scan_redirected'] as const;

describe('migration 115 - qr scan analytics event', () => {
  it('migration 115 replaces the analytics event_name CHECK constraint idempotently', () => {
    const sql = migrationText(MIGRATION_115);
    expect(sql).toMatch(
      /ALTER TABLE analytics_events\s+DROP CONSTRAINT IF EXISTS analytics_events_event_name_check/i,
    );
    expect(sql).toMatch(
      /ALTER TABLE analytics_events\s+ADD CONSTRAINT analytics_events_event_name_check/i,
    );
  });

  it('migration 115 sets a lock_timeout for the ACCESS EXCLUSIVE constraint swap', () => {
    // DROP + re-ADD takes a brief ACCESS EXCLUSIVE lock on analytics_events and
    // re-validates every existing row. Without a bound, a swap that queues
    // behind a long reader blocks every emitting transaction in the system.
    expect(executableSql(MIGRATION_115)).toMatch(/SET (LOCAL )?lock_timeout/i);
  });

  it('migration 115 admits qr_scan_redirected in analytics_events', () => {
    // The DB CHECK is the REAL registration. Registering the name only in
    // ANALYTICS_EVENT_NAMES would reject the emitting statement — which for
    // this event is the best-effort scan-count insert in the public QR
    // redirect route: the scan would still reach Google, but every scan
    // metric would silently become a Sentry-reported handled error.
    const text = executableSql(MIGRATION_115);
    for (const name of NEW_EVENT_NAMES) {
      expect(text).toContain(`'${name}'`);
    }
  });

  it('migration 115 keeps every event name from migration 106 in the CHECK', () => {
    // The failure this catches is RETYPING the list instead of copying it: a
    // dropped member re-validates every existing analytics_events row against a
    // narrower CHECK, the ALTER fails in production, and `ci:analytics-events`
    // stays green because it never reads the database.
    const previous = eventNamesInCheck(executableSql(MIGRATION_106));
    const current = eventNamesInCheck(executableSql(MIGRATION_115));
    expect(current.slice(0, previous.length)).toEqual(previous);
    expect(current.slice(previous.length)).toEqual([...NEW_EVENT_NAMES]);
  });

  it('migration 115 keeps every ANALYTICS_EVENT_NAMES entry in the re-added CHECK list (drift-guard)', () => {
    // Handed off from 106's suite: the LATEST constraint-replacing migration
    // owns this guard. Subset (not toEqual) in this direction — the CHECK may
    // lead the TS allowlist while a name is being introduced, but a name the
    // app can emit and the DB would reject is what fails here.
    const namesInCheck = new Set(eventNamesInCheck(executableSql(MIGRATION_115)));
    const missingFromCheck = ANALYTICS_EVENT_NAMES.filter((name) => !namesInCheck.has(name));
    expect(missingFromCheck).toEqual([]);
  });
});

// ── The live assertions ─────────────────────────────────────────────────────

const testDatabaseUrl = process.env.TEST_DATABASE_POOL_URL;

let db: postgresType.Sql | undefined;

/** Thrown to roll a probe transaction back; never escapes this file. */
class RollbackProbe extends Error {
  override readonly name = 'RollbackProbe';
}

describeWithDb('migration 115 against live Postgres', { timeout: 30_000 }, () => {
  beforeAll(() => {
    db = postgres(testDatabaseUrl!, { max: 1, prepare: false });
  });

  afterAll(async () => {
    if (db) await db.end({ timeout: 5 });
  });

  it('migration 115 still rejects an unregistered event name', async () => {
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
            ${`migration-115-probe-${Date.now()}`},
            'qr_scan_redirected_typo_not_registered',
            'migration-115-probe'
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

  it('migration 115 admits qr_scan_redirected in the live CHECK', async () => {
    // The rejection above proves only that SOME constraint is live; a stale
    // CHECK (105-shaped) would reject the typo AND the real name alike. This
    // insert proves the live constraint admits the exact name the
    // /q/[businessId] route will insert — then deletes the probe row so
    // nothing survives the suite (codex R2 on M3).
    const eventKey = `migration-115-admit-probe-${Date.now()}`;
    try {
      await db!`
        INSERT INTO analytics_events (event_key, event_name, distinct_id)
        VALUES (${eventKey}, 'qr_scan_redirected', 'migration-115-probe')
      `;
    } finally {
      await db!`DELETE FROM analytics_events WHERE event_key = ${eventKey}`;
    }
  });
});
