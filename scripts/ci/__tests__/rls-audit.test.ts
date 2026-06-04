import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import {
  collectRlsEnabledTables,
  findRlsCoverageFailures,
  findRlsFailures,
  readMigrationsSql,
  REQUIRED_RLS_TABLES,
} from '../rls-audit';
import { TENANT_TABLES } from '../tenant-tables';

describe('rls-audit', () => {
  it('returns no failures when all required tables have RLS', () => {
    expect(findRlsFailures([
      { relname: 'reviews', relrowsecurity: true },
      { relname: 'responses', relrowsecurity: true },
    ], ['reviews', 'responses'])).toEqual([]);
  });

  it('returns missing tables and disabled RLS tables', () => {
    expect(findRlsFailures([
      { relname: 'reviews', relrowsecurity: false },
    ], ['reviews', 'responses'])).toEqual([
      'reviews has RLS disabled',
      'responses missing from pg_class result',
    ]);
  });

  it('includes direct, inherited, and handle-bridged tenant tables in the default inventory', () => {
    expect(REQUIRED_RLS_TABLES).toEqual(expect.arrayContaining([
      'accounts',
      'businesses',
      'channel_enrollments',
      'weekly_summaries',
      'monthly_impact_emails',
      'api_costs_daily_rollups',
      'zernio_finalize_incidents',
      'zernio_backfill_runs',
      'sms_sender_opt_outs',
      'sms_sender_opt_out_events',
    ]));
  });

  it('uses the shared tenant table inventory for RLS and docs', () => {
    expect(REQUIRED_RLS_TABLES).toBe(TENANT_TABLES);

    const inventoryDoc = readFileSync('docs/security/rls-inventory.md', 'utf8');
    for (const table of TENANT_TABLES) {
      expect(inventoryDoc).toContain(`| \`${table}\` |`);
    }
  });
});

describe('collectRlsEnabledTables', () => {
  it('extracts table names from ALTER TABLE … ENABLE ROW LEVEL SECURITY across casing/quoting', () => {
    const enabled = collectRlsEnabledTables([
      'ALTER TABLE foo ENABLE ROW LEVEL SECURITY;',
      'alter table public."bar" enable row level security;',
      'ALTER TABLE baz ADD COLUMN qux int;', // not an RLS enable — ignored
    ]);
    expect([...enabled].sort()).toEqual(['bar', 'foo']);
  });
});

describe('findRlsCoverageFailures', () => {
  it('passes when every required table enables RLS', () => {
    expect(
      findRlsCoverageFailures(new Set(['reviews', 'responses']), ['reviews', 'responses']),
    ).toEqual([]);
  });

  it('flags a required table with no ENABLE RLS in any migration', () => {
    expect(findRlsCoverageFailures(new Set(['reviews']), ['reviews', 'responses'])).toEqual([
      'responses has no ENABLE ROW LEVEL SECURITY in any migration',
    ]);
  });

  it('every TENANT_TABLES entry enables RLS in the real migrations (the CI gate, DB-free)', () => {
    expect(
      findRlsCoverageFailures(collectRlsEnabledTables(readMigrationsSql()), TENANT_TABLES),
    ).toEqual([]);
  });
});
