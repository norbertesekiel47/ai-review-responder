import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import {
  analyzeRlsPosture,
  collectRlsEnabledTables,
  findDenyAllRevokeFailures,
  findRlsCoverageFailures,
  findRlsFailures,
  readMigrationsSql,
  REQUIRED_RLS_TABLES,
  stripSqlComments,
} from '../rls-audit';
import { RLS_REQUIRED_TABLES } from '../rls-tables';
import { REVIEWED_NOT_TENANT_SCOPED, TENANT_TABLES } from '../tenant-tables';

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
    ]));
  });

  it('reads its inventory from the RLS registry, not the tenant-table inventory (#1300)', () => {
    expect(REQUIRED_RLS_TABLES).toBe(RLS_REQUIRED_TABLES);
  });
});

// #1300 — the registry is its OWN list, so nothing here derives it. What is
// asserted is the one-way containment contract: a table on either
// tenant-tables list must also be registered for RLS. Drift therefore costs a
// failing test rather than silent coverage loss, and a table that leaves
// TENANT_TABLES for a tenant-scope reason keeps its RLS requirement.
describe('RLS_REQUIRED_TABLES registry', () => {
  const registry = new Set<string>(RLS_REQUIRED_TABLES);

  it('has no duplicate entries', () => {
    expect(registry.size).toBe(RLS_REQUIRED_TABLES.length);
  });

  it('covers every TENANT_TABLES member', () => {
    expect(TENANT_TABLES.filter((table) => !registry.has(table))).toEqual([]);
  });

  it('covers every REVIEWED_NOT_TENANT_SCOPED member', () => {
    expect(
      REVIEWED_NOT_TENANT_SCOPED.map((entry) => entry.table).filter((t) => !registry.has(t)),
    ).toEqual([]);
  });

  it('registers the deny-all tables #1300 names, which TENANT_TABLES never covered', () => {
    for (const table of ['job_outbox', 'admin_audit_log', 'poller_heartbeats']) {
      expect(registry.has(table)).toBe(true);
      expect(TENANT_TABLES as readonly string[]).not.toContain(table);
    }
  });

  it('gives every registered table a row in docs/security/rls-inventory.md', () => {
    const inventoryDoc = readFileSync('docs/security/rls-inventory.md', 'utf8');
    const missing = RLS_REQUIRED_TABLES.filter((t) => !inventoryDoc.includes(`| \`${t}\` |`));
    expect(missing).toEqual([]);
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

  it('every registered table enables RLS in the real migrations (the CI gate, DB-free)', () => {
    expect(
      findRlsCoverageFailures(collectRlsEnabledTables(readMigrationsSql()), RLS_REQUIRED_TABLES),
    ).toEqual([]);
  });
});

describe('stripSqlComments', () => {
  it('removes line and block comments outside strings', () => {
    expect(stripSqlComments("SELECT 1; -- REVOKE ALL ON t FROM anon, authenticated;\nSELECT 2;"))
      .not.toContain('REVOKE');
    expect(stripSqlComments('SELECT 1; /* CREATE POLICY p ON t */ SELECT 2;'))
      .not.toContain('CREATE POLICY');
  });

  it('keeps a -- sequence that lives inside a single-quoted string', () => {
    expect(stripSqlComments("SELECT 'a -- b';")).toContain("'a -- b'");
  });

  it('removes comments from inside a dollar-quoted body, as PL/pgSQL parsing does', () => {
    const sql = "DO $$ BEGIN -- REVOKE ALL ON t FROM anon, authenticated;\n END $$;";
    expect(stripSqlComments(sql)).not.toContain('REVOKE');
  });

  it('keeps a statement a dollar-quoted body EXECUTEs (migration 122 does this)', () => {
    const sql = "DO $$ BEGIN EXECUTE 'REVOKE ALL ON t FROM anon, authenticated'; END $$;";
    expect(stripSqlComments(sql)).toContain('REVOKE ALL ON t FROM anon, authenticated');
  });
});

describe('analyzeRlsPosture', () => {
  it('treats a table with RLS on and no policy as deny-all, and sees its REVOKE', () => {
    const posture = analyzeRlsPosture([
      'ALTER TABLE t ENABLE ROW LEVEL SECURITY;',
      'REVOKE ALL ON t FROM anon, authenticated;',
    ]);
    expect(posture.get('t')).toMatchObject({ rlsEnabled: true, clientRolesRevoked: true });
    expect(posture.get('t')?.policies.size).toBe(0);
  });

  it('reads a multi-table REVOKE list, including public-qualified and quoted names', () => {
    const posture = analyzeRlsPosture([
      'REVOKE ALL ON a, public.b, "c" FROM anon, authenticated;',
    ]);
    for (const table of ['a', 'b', 'c']) {
      expect(posture.get(table)?.clientRolesRevoked).toBe(true);
    }
  });

  it('ignores REVOKE ALL ON ALL TABLES IN SCHEMA public (no table named "all")', () => {
    const posture = analyzeRlsPosture([
      'REVOKE ALL ON ALL TABLES IN SCHEMA public FROM anon, authenticated;',
    ]);
    expect(posture.has('all')).toBe(false);
  });

  it('does not accept a REVOKE that names only one client role', () => {
    const posture = analyzeRlsPosture([
      'ALTER TABLE t ENABLE ROW LEVEL SECURITY;',
      'REVOKE ALL ON t FROM authenticated;',
    ]);
    expect(posture.get('t')?.clientRolesRevoked).toBe(false);
  });

  it('replays DROP POLICY IF EXISTS … ; CREATE POLICY … as policy-bearing', () => {
    const posture = analyzeRlsPosture([
      'ALTER TABLE t ENABLE ROW LEVEL SECURITY;\n'
      + 'DROP POLICY IF EXISTS t_select ON t;\n'
      + 'CREATE POLICY t_select ON t FOR SELECT TO authenticated USING (true);',
    ]);
    expect(posture.get('t')?.policies.size).toBe(1);
  });

  it('sees a later DROP POLICY that leaves a table deny-all', () => {
    const posture = analyzeRlsPosture([
      'ALTER TABLE t ENABLE ROW LEVEL SECURITY;\n'
      + 'CREATE POLICY t_select ON t FOR SELECT TO authenticated USING (true);',
      'DROP POLICY t_select ON t;',
    ]);
    expect(posture.get('t')?.policies.size).toBe(0);
  });

  it('forgets a table a later migration drops', () => {
    const posture = analyzeRlsPosture([
      'ALTER TABLE t ENABLE ROW LEVEL SECURITY;',
      'DROP TABLE IF EXISTS t;',
    ]);
    expect(posture.has('t')).toBe(false);
  });

  it('honours a DISABLE ROW LEVEL SECURITY that follows an enable', () => {
    const posture = analyzeRlsPosture([
      'ALTER TABLE t ENABLE ROW LEVEL SECURITY;',
      'ALTER TABLE t DISABLE ROW LEVEL SECURITY;',
    ]);
    expect(posture.get('t')?.rlsEnabled).toBe(false);
  });
});

describe('findDenyAllRevokeFailures', () => {
  it('flags a deny-all table with no client-role REVOKE', () => {
    expect(findDenyAllRevokeFailures(analyzeRlsPosture([
      'ALTER TABLE ledger ENABLE ROW LEVEL SECURITY;',
    ]))).toEqual([
      'ledger is deny-all (RLS on, zero policies) with no REVOKE ALL ON ledger FROM anon, authenticated in any migration',
    ]);
  });

  it('passes once the REVOKE lands, even in a later migration', () => {
    expect(findDenyAllRevokeFailures(analyzeRlsPosture([
      'ALTER TABLE ledger ENABLE ROW LEVEL SECURITY;',
      'REVOKE ALL ON ledger FROM anon, authenticated;',
    ]))).toEqual([]);
  });

  it('does not demand a REVOKE from a policy-bearing table', () => {
    expect(findDenyAllRevokeFailures(analyzeRlsPosture([
      'ALTER TABLE t ENABLE ROW LEVEL SECURITY;\n'
      + 'CREATE POLICY t_select ON t FOR SELECT TO authenticated USING (true);',
    ]))).toEqual([]);
  });

  it('does not demand a REVOKE from a table with RLS off', () => {
    expect(findDenyAllRevokeFailures(analyzeRlsPosture(['CREATE TABLE t (id uuid);']))).toEqual([]);
  });

  it('every deny-all table in the real migrations already revokes the client roles', () => {
    expect(findDenyAllRevokeFailures(analyzeRlsPosture(readMigrationsSql()))).toEqual([]);
  });
});
