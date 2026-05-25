import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { findRlsFailures, REQUIRED_RLS_TABLES } from '../rls-audit';
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
