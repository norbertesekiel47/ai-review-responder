import { describe, expect, it } from 'vitest';
import {
  blankSqlComments,
  jobOutboxAliases,
  scanMigration,
  scanSource,
  statusGroups,
} from '../outbox-status-audit';
import { OUTBOX_IN_FLIGHT_STATUSES } from '../../../src/lib/shared/job-outbox-status';

const CANONICAL_SQL = OUTBOX_IN_FLIGHT_STATUSES.map((s) => `'${s}'`).join(', ');

describe('outbox-status-audit — canonical set', () => {
  it('derives its expected set from the constant, not a re-typed literal', () => {
    // If the constant changed, the canonical spelling below changes with it and
    // this template stays passing — that is the property being asserted.
    const template = `const q = sql\`SELECT 1 FROM job_outbox WHERE status IN (${CANONICAL_SQL})\`;`;
    expect(scanSource('worker/probe.ts', template)).toEqual([]);
  });

  it('accepts the unspaced spelling migration 080 uses', () => {
    const migration = `CREATE INDEX i ON job_outbox (topic)\n  WHERE status IN ('pending','dispatching','dispatched');`;
    expect(scanMigration('supabase/migrations/900_probe.sql', migration)).toEqual([]);
  });
});

describe('outbox-status-audit — drift detection', () => {
  it("flags a group missing 'dispatching' (the migration-004 drift)", () => {
    const template = `const q = sql\`SELECT 1 FROM job_outbox jo WHERE jo.status IN ('pending', 'dispatched')\`;`;
    const findings = scanSource('worker/probe.ts', template);
    expect(findings).toHaveLength(1);
    expect(findings[0]!.rule).toBe('outbox-status-group');
    expect(findings[0]!.detail).toContain("'pending', 'dispatching', 'dispatched'");
  });

  it('flags a reordered group — member order is significant', () => {
    const template = `const q = sql\`SELECT 1 FROM job_outbox WHERE status IN ('dispatched', 'dispatching', 'pending')\`;`;
    expect(scanSource('worker/probe.ts', template)).toHaveLength(1);
  });

  it('flags an extra member', () => {
    const template = `const q = sql\`SELECT 1 FROM job_outbox WHERE status IN ('pending', 'dispatching', 'dispatched', 'completed')\`;`;
    expect(scanSource('worker/probe.ts', template)).toHaveLength(1);
  });

  it('flags drift in a migration', () => {
    const migration = `CREATE INDEX i ON job_outbox (topic)\n  WHERE status IN ('pending', 'dispatched');`;
    const findings = scanMigration('supabase/migrations/900_probe.sql', migration);
    expect(findings).toHaveLength(1);
    expect(findings[0]!.line).toBe(2);
  });
});

describe('outbox-status-audit — binding to job_outbox', () => {
  // The risk this guards: a template that queries job_outbox AND filters a
  // joined table's status. There are 32 such response-status groups repo-wide.
  it('ignores a co-located responses status group in a job_outbox template', () => {
    const template = [
      'const q = sql`',
      '  SELECT 1 FROM responses resp',
      "  WHERE resp.status IN ('approved', 'edited', 'awaiting_owner_connect')",
      '    AND NOT EXISTS (',
      '      SELECT 1 FROM job_outbox jo WHERE jo.aggregate_id = resp.id',
      `        AND jo.status IN (${CANONICAL_SQL})`,
      '    )`;',
    ].join('\n');
    expect(scanSource('worker/probe.ts', template)).toEqual([]);
  });

  it('ignores a non-job_outbox alias even when its group names an outbox status', () => {
    const template = [
      'const q = sql`',
      '  SELECT 1 FROM responses resp JOIN job_outbox jo ON jo.aggregate_id = resp.id',
      "  WHERE resp.status IN ('pending', 'dispatched')`;",
    ].join('\n');
    expect(scanSource('worker/probe.ts', template)).toEqual([]);
  });

  it('checks an unqualified group in an ON CONFLICT predicate (no alias available)', () => {
    const template = [
      'const q = sql`',
      '  INSERT INTO job_outbox (topic) VALUES (1)',
      "  ON CONFLICT (topic, aggregate_id) WHERE topic = 'x'",
      "    AND status IN ('pending', 'dispatched') DO NOTHING`;",
    ].join('\n');
    expect(scanSource('worker/probe.ts', template)).toHaveLength(1);
  });

  it('ignores a status group in a template that never mentions job_outbox', () => {
    const template = `const q = sql\`SELECT 1 FROM some_queue WHERE status IN ('pending', 'dispatched')\`;`;
    expect(scanSource('worker/probe.ts', template)).toEqual([]);
  });

  it('ignores a plain (non-sql-tagged) template that merely mentions the columns', () => {
    const template = `const copy = \`job_outbox rows where status IN ('pending', 'dispatched')\`;`;
    expect(scanSource('worker/probe.ts', template)).toEqual([]);
  });

  it('resolves aliases without treating a reserved word as one', () => {
    expect([...jobOutboxAliases('FROM job_outbox WHERE x')].sort()).toEqual(['job_outbox']);
    expect([...jobOutboxAliases('FROM job_outbox jo WHERE x')].sort()).toEqual(['jo', 'job_outbox']);
    expect([...jobOutboxAliases('FROM job_outbox AS q WHERE x')].sort()).toEqual(['job_outbox', 'q']);
  });
});

describe('outbox-status-audit — escapes', () => {
  it('honours a trailing TS pragma', () => {
    const template = [
      'const q = sql`',
      '  SELECT 1 FROM job_outbox',
      "  WHERE status IN ('pending', 'dispatched')`; // outbox-status-audit-ignore",
    ].join('\n');
    expect(scanSource('worker/probe.ts', template)).toEqual([]);
  });

  it('honours a standalone SQL pragma comment above the line', () => {
    const migration = [
      'CREATE INDEX i ON job_outbox (topic)',
      '  -- outbox-status-audit-ignore: post-dispatch scan, pending excluded on purpose',
      "  WHERE status IN ('dispatched', 'dispatching');",
    ].join('\n');
    expect(scanMigration('supabase/migrations/900_probe.sql', migration)).toEqual([]);
  });

  it.each([
    ['004 — superseded by 018', 'supabase/migrations/004_sync_reviews_dedup_constraint.sql'],
    ['065 — post-dispatch by design', 'supabase/migrations/065_archival_watchdog_indexes.sql'],
  ])('allowlists immutable migration %s', (_label, file) => {
    const migration = `CREATE INDEX i ON job_outbox (topic) WHERE status IN ('pending', 'dispatched');`;
    expect(scanMigration(file, migration)).toEqual([]);
  });
});

describe('outbox-status-audit — SQL comment handling', () => {
  it('does not flag a drifted group quoted inside a SQL comment', () => {
    const migration = [
      "-- historical note: 004 shipped status IN ('pending', 'dispatched')",
      `CREATE INDEX i ON job_outbox (topic) WHERE status IN (${CANONICAL_SQL});`,
    ].join('\n');
    expect(scanMigration('supabase/migrations/900_probe.sql', migration)).toEqual([]);
  });

  it('preserves byte offsets so line numbers survive comment blanking', () => {
    const text = "-- comment\nSELECT 1;\n";
    expect(blankSqlComments(text)).toHaveLength(text.length);
    expect(blankSqlComments(text).split('\n')[1]).toBe('SELECT 1;');
  });

  it('does not let a -- inside a string literal eat the rest of the line', () => {
    const text = "SELECT 'a--b', status;";
    expect(blankSqlComments(text)).toBe(text);
  });
});

describe('outbox-status-audit — predicate parsing', () => {
  it('captures members in source order with the qualifier', () => {
    const groups = statusGroups("WHERE jo.status IN ('pending', 'dispatching')");
    expect(groups).toHaveLength(1);
    expect(groups[0]!.members).toBe('pending,dispatching');
    expect(groups[0]!.qualifier).toBe('jo');
  });

  it('reads the = ANY (...) spelling', () => {
    const groups = statusGroups("WHERE status = ANY ('pending', 'dispatched')");
    expect(groups[0]!.members).toBe('pending,dispatched');
  });

  it('is not truncated by a nested subquery inside the predicate', () => {
    const groups = statusGroups("WHERE status IN ('pending', (SELECT x FROM t), 'dispatched')");
    expect(groups[0]!.members).toBe('pending,dispatched');
  });
});
