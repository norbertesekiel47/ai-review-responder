import { describe, it, expect } from 'vitest';
import {
  extractDroppedColumns,
  findingsInFile,
  type DroppedColumn,
} from '../dropped-columns-audit';

const USERS_BUSINESS_ID: DroppedColumn = {
  table: 'users',
  column: 'business_id',
  migration: '034_multi_location_schema.sql',
};

const LEDGER: DroppedColumn[] = [
  USERS_BUSINESS_ID,
  {
    table: 'zernio_backfill_runs',
    column: 'gap_processed_count',
    migration: '103_drop_legacy_backfill_counters.sql',
  },
];

describe('dropped-columns-audit ledger (extractDroppedColumns)', () => {
  it('records a DROP COLUMN, including multi-clause ALTERs', () => {
    const ledger = extractDroppedColumns([
      {
        file: '103.sql',
        sql: 'ALTER TABLE zernio_backfill_runs\n  DROP COLUMN IF EXISTS a,\n  DROP COLUMN IF EXISTS b;',
      },
    ]);
    expect(ledger.map((d) => `${d.table}.${d.column}`).sort()).toEqual([
      'zernio_backfill_runs.a',
      'zernio_backfill_runs.b',
    ]);
    expect(ledger[0]!.migration).toBe('103.sql');
  });

  it('clears a pair when a later migration re-ADDs the column', () => {
    const ledger = extractDroppedColumns([
      { file: '010.sql', sql: 'ALTER TABLE users DROP COLUMN role;' },
      { file: '020.sql', sql: 'ALTER TABLE users ADD COLUMN IF NOT EXISTS role TEXT;' },
    ]);
    expect(ledger).toEqual([]);
  });

  it('clears a table on CREATE TABLE (schema redefined)', () => {
    const ledger = extractDroppedColumns([
      { file: '010.sql', sql: 'ALTER TABLE staging DROP COLUMN payload;' },
      { file: '020.sql', sql: 'CREATE TABLE IF NOT EXISTS staging (id UUID PRIMARY KEY, payload JSONB);' },
    ]);
    expect(ledger).toEqual([]);
  });

  it('clears a table on DROP TABLE (missing-relation is a different class)', () => {
    const ledger = extractDroppedColumns([
      { file: '010.sql', sql: 'ALTER TABLE legacy DROP COLUMN a;' },
      { file: '020.sql', sql: 'DROP TABLE IF EXISTS legacy;' },
    ]);
    expect(ledger).toEqual([]);
  });

  it('does NOT parse prose in SQL comments (103’s header mentions DROP COLUMN)', () => {
    const ledger = extractDroppedColumns([
      { file: '103.sql', sql: "-- DROP COLUMN takes ACCESS EXCLUSIVE and can collide\nSELECT 1;" },
    ]);
    expect(ledger).toEqual([]);
  });

  it('does NOT confuse ALTER COLUMN … DROP NOT NULL / DROP DEFAULT with a column drop', () => {
    const ledger = extractDroppedColumns([
      {
        file: '015.sql',
        sql: 'ALTER TABLE onboarding_drip_log ALTER COLUMN sent_at DROP NOT NULL;\n' +
          'ALTER TABLE onboarding_drip_log ALTER COLUMN sent_at DROP DEFAULT;',
      },
    ]);
    expect(ledger).toEqual([]);
  });
});

describe('dropped-columns-audit scan (findingsInFile)', () => {
  it('flags an alias-qualified reference (the #719 shape)', () => {
    const src = 'await sql`SELECT u.auth_id FROM users u WHERE u.business_id = ${businessId}`;';
    const findings = findingsInFile('f.ts', src, LEDGER);
    expect(findings).toHaveLength(1);
    expect(findings[0]!.detail).toContain('users.business_id');
    expect(findings[0]!.detail).toContain('034_multi_location_schema.sql');
  });

  it('flags a table-qualified reference', () => {
    const src = 'await tx`UPDATE users SET users.business_id = NULL WHERE users.business_id = ${id}`;';
    expect(findingsInFile('f.ts', src, LEDGER).length).toBeGreaterThan(0);
  });

  it('flags a bare column when the template touches exactly one relation', () => {
    const src = 'await db`SELECT auth_id FROM users WHERE business_id = ${businessId} LIMIT 1`;';
    expect(findingsInFile('f.ts', src, LEDGER)).toHaveLength(1);
  });

  it('does NOT attribute a bare column across relations that legitimately have it', () => {
    // business_id lives on many OTHER tables; with users joined in, only a
    // users-qualified reference may count.
    const src =
      'await sql`SELECT r.business_id FROM reviews r JOIN users u ON u.account_id = r.account_id`;';
    expect(findingsInFile('f.ts', src, LEDGER)).toEqual([]);
  });

  it('does NOT flag an output alias that merely shares the dropped name', () => {
    const src =
      'await tx`SELECT b.id AS business_id FROM businesses b JOIN accounts a ON a.id = b.account_id`;';
    expect(findingsInFile('f.ts', src, LEDGER)).toEqual([]);
  });

  it('does NOT flag a JSONB string key or commentary naming the column', () => {
    const src = [
      "await sql`SELECT 1 FROM users u -- business_id moved to businesses in 034",
      "  WHERE u.id = ${id} AND payload->>'business_id' = ${x}`;",
    ].join('\n');
    expect(findingsInFile('f.ts', src, LEDGER)).toEqual([]);
  });

  it('does NOT flag a template whose relation set omits the dropped table', () => {
    const src = 'await sql`SELECT business_id FROM reviews WHERE id = ${id}`;';
    expect(findingsInFile('f.ts', src, LEDGER)).toEqual([]);
  });

  it('ignores non-SQL tagged templates and plain strings', () => {
    const src = [
      'const gql = graphql`{ users { business_id } }`;',
      "const label = 'users.business_id';",
    ].join('\n');
    expect(findingsInFile('f.ts', src, LEDGER)).toEqual([]);
  });

  it('honors the per-line escape pragma, with a reason suffix', () => {
    const src =
      'await sql`SELECT u.business_id FROM users u -- dropped-column-ignore: forensics against pre-034 backup`;';
    expect(findingsInFile('f.ts', src, LEDGER)).toEqual([]);
  });

  it('reports the 1-based line of the reference, not the template start', () => {
    const src = [
      'await sql`',
      '  SELECT u.auth_id',
      '  FROM users u',
      '  WHERE u.business_id = ${businessId}',
      '`;',
    ].join('\n');
    const findings = findingsInFile('f.ts', src, LEDGER);
    expect(findings).toHaveLength(1);
    expect(findings[0]!.line).toBe(4);
  });

  it('scans the typed sql<Type[]> tagged-template form', () => {
    const src =
      'const rows = await sql<{ id: string }[]>`SELECT business_id FROM users`;';
    expect(findingsInFile('f.ts', src, LEDGER)).toHaveLength(1);
  });
});
