/**
 * Structural validation test for migration 061_remove_sms_schema.sql
 *
 * SMS channel removal: validates the migration archives stale sms
 * enrollments, replaces the sms+whatsapp handle index with a whatsapp-only
 * one, rebuilds one_mobile_per_scope without 'sms', and drops both
 * sms_sender_opt_out tables (events first — no FK links the two tables;
 * conventional child-before-parent order. Events' only FK points at
 * inbound_events).
 *
 * NOT a database integration test — catches accidental edits to the
 * archive predicate, index predicates, or drop order.
 *
 * Run: pnpm test -- migration-061
 */

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { beforeAll, describe, it, expect } from 'vitest';

const MIGRATION_PATH = resolve(
  process.cwd(),
  'supabase/migrations/061_remove_sms_schema.sql',
);

let sql: string;
/** SQL with comment lines stripped (avoids false positive matches on commented-out code). */
let sqlNoComments: string;

beforeAll(() => {
  sql = readFileSync(MIGRATION_PATH, 'utf-8');
  sqlNoComments = sql.replace(/--.*$/gm, '');
});

describe('migration 061 — stale enrollment archive', () => {
  it('archives active sms enrollments defensively', () => {
    expect(sqlNoComments).toMatch(
      /UPDATE channel_enrollments\s+SET archived_at = NOW\(\)[\s\S]*?WHERE channel = 'sms'\s+AND archived_at IS NULL/i,
    );
  });
});

describe('migration 061 — handle index replacement', () => {
  it('drops the sms+whatsapp handle index', () => {
    expect(sqlNoComments).toMatch(/DROP INDEX IF EXISTS idx_channel_enrollments_sms_handle/i);
  });

  it('creates a whatsapp-only handle index with the same shape', () => {
    expect(sqlNoComments).toMatch(
      /CREATE INDEX IF NOT EXISTS idx_channel_enrollments_whatsapp_handle\s+ON channel_enrollments\(handle\)\s+WHERE channel = 'whatsapp' AND handle IS NOT NULL AND archived_at IS NULL/i,
    );
  });
});

describe('migration 061 — one_mobile_per_scope rebuild', () => {
  it('drops the old index', () => {
    expect(sqlNoComments).toMatch(/DROP INDEX IF EXISTS channel_enrollments_one_mobile_per_scope/i);
  });

  it('recreates it without sms, preserving scope key and status exclusions', () => {
    expect(sqlNoComments).toMatch(
      /CREATE UNIQUE INDEX IF NOT EXISTS channel_enrollments_one_mobile_per_scope[\s\S]*?COALESCE\(location_id, '00000000-0000-0000-0000-000000000000'\)[\s\S]*?WHERE channel IN \('telegram','whatsapp'\)\s+AND status IN \('pending_verification','verified'\)\s+AND archived_at IS NULL/i,
    );
  });

  it('does not reference sms in the rebuilt predicate', () => {
    const rebuilt = sqlNoComments.split('one_mobile_per_scope')[2] ?? '';
    expect(rebuilt).not.toMatch(/'sms'/);
  });
});

describe('migration 061 — table drops', () => {
  it('drops events before parent (FK direction)', () => {
    const eventsIdx = sqlNoComments.indexOf('DROP TABLE IF EXISTS sms_sender_opt_out_events');
    const parentIdx = sqlNoComments.indexOf('DROP TABLE IF EXISTS sms_sender_opt_outs');
    expect(eventsIdx).toBeGreaterThan(-1);
    expect(parentIdx).toBeGreaterThan(-1);
    expect(eventsIdx).toBeLessThan(parentIdx);
  });

  it('is wrapped in a transaction', () => {
    expect(sqlNoComments).toMatch(/BEGIN;/i);
    expect(sqlNoComments).toMatch(/COMMIT;/i);
  });
});
