import { describe, it, expect } from 'vitest';
import { scanSource } from '../response-status-audit';

describe('response-status-audit scanSource', () => {
  it('flags a 2+ array literal of canonical statuses', () => {
    const findings = scanSource('src/x.ts', `const g = ['approved', 'edited'];`);
    expect(findings).toHaveLength(1);
    expect(findings[0]?.rule).toBe('response-status-group');
  });

  it('flags a 4-value array literal of canonical statuses', () => {
    const findings = scanSource(
      'src/x.ts',
      `const g = ['pending_approval', 'approved', 'edited', 'awaiting_owner_connect'];`,
    );
    expect(findings.length).toBeGreaterThanOrEqual(1);
  });

  it('flags a SQL IN (...) list of 3 canonical statuses inside a template literal', () => {
    const src = "const q = sql`SELECT 1 FROM t WHERE status IN ('approved','edited','posted')`;";
    expect(scanSource('src/x.ts', src).length).toBeGreaterThanOrEqual(1);
  });

  it('flags a SQL ANY(ARRAY[...]) of canonical statuses', () => {
    const src = "const q = sql`WHERE status = ANY(ARRAY['approved','posted']::text[])`;";
    expect(scanSource('src/x.ts', src).length).toBeGreaterThanOrEqual(1);
  });

  it('does NOT flag a single-status equality', () => {
    expect(scanSource('src/x.ts', `if (status === 'approved') { doThing(); }`)).toEqual([]);
  });

  it('does NOT flag a single-status array literal', () => {
    expect(scanSource('src/x.ts', `const g = ['approved'];`)).toEqual([]);
  });

  it('does NOT flag a single-status SQL equality predicate', () => {
    const src = "const q = sql`WHERE status = 'approved'`;";
    expect(scanSource('src/x.ts', src)).toEqual([]);
  });

  it('does NOT flag const-interpolated group usage (zero canonical string literals)', () => {
    const src =
      'const q = sql`WHERE status = ANY(${[...HANDLED_STATUSES] as string[]}::text[])`;';
    expect(scanSource('src/lib/dashboard/service.ts', src)).toEqual([]);
  });

  it('does NOT flag the migrated statusArraySql usage', () => {
    const src = 'const q = sql`WHERE status = ANY(${statusArraySql(NON_TERMINAL_STATUSES)})`;';
    expect(scanSource('src/app/api/dashboard/past-replies/draft/route.ts', src)).toEqual([]);
  });

  it('honors // status-audit-ignore on the same line (array literal)', () => {
    const src = "const g = ['approved', 'edited']; // status-audit-ignore: reason";
    expect(scanSource('src/x.ts', src)).toEqual([]);
  });

  it('honors // status-audit-ignore on the preceding line (array literal)', () => {
    const src = "// status-audit-ignore: reason\nconst g = ['approved', 'edited'];";
    expect(scanSource('src/x.ts', src)).toEqual([]);
  });

  it('honors a trailing SQL -- status-audit-ignore on the same line (IN list)', () => {
    const src =
      "const q = sql`WHERE status IN ('approved','edited') -- status-audit-ignore: write guard\n`;";
    expect(scanSource('src/x.ts', src)).toEqual([]);
  });

  it('does not scan the exempt response-status.ts module', () => {
    const src = `export const X = ['approved', 'edited', 'posted'];`;
    expect(scanSource('src/lib/shared/response-status.ts', src)).toEqual([]);
  });

  it('does not scan the exempt response-status-sql.ts module', () => {
    const src = `export const X = ['approved', 'edited', 'posted'];`;
    expect(scanSource('src/lib/shared/response-status-sql.ts', src)).toEqual([]);
  });

  it('reports the 1-based line number of the offending literal', () => {
    const src = "const a = 1;\nconst g = ['approved', 'edited'];";
    const findings = scanSource('src/x.ts', src);
    expect(findings[0]?.line).toBe(2);
  });
});
