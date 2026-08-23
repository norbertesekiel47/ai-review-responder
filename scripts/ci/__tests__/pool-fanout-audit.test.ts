import { describe, it, expect } from 'vitest';
import {
  PRAGMA,
  collectSqlBindings,
  evaluateFindings,
  findFanoutSites,
  pragmaReason,
  type FileSites,
} from '../pool-fanout-audit';
import ts from 'typescript';

/**
 * These fixtures carry the SHAPES, not the subjects. #893's whole point is that
 * naming subjects is what failed three times — so the four real sites appear
 * here only in the regression block at the bottom, as proof the rule covers what
 * the enumeration missed, never as the rule's definition.
 */

/** A backtick, so fixtures can contain tagged templates without escaping wars. */
const BT = '`';
const tag = (name: string, body = 'SELECT 1'): string => `${name}${BT}${body}${BT}`;

function wrap(body: string, sqlParam = 'sql: Sql'): string {
  return `import type { Sql } from 'postgres';
export async function probe(${sqlParam}, id: string) {
${body}
}
`;
}

function sitesOf(body: string, sqlParam?: string) {
  return findFanoutSites(wrap(body, sqlParam));
}

function fileOf(text: string, file = 'src/lib/admin/probe.ts'): FileSites {
  return { file, text, sites: findFanoutSites(text, file) };
}

describe('pool-fanout-audit / collectSqlBindings', () => {
  it('takes the convention names even with no annotation in the file', () => {
    const source = ts.createSourceFile('x.ts', 'const a = 1;', ts.ScriptTarget.Latest, true);
    const names = collectSqlBindings(source);
    expect([...names].sort()).toEqual(['db', 'exec', 'sql', 'tx']);
  });

  it('adds a parameter named anything, when its TYPE says Postgres client', () => {
    const source = ts.createSourceFile(
      'x.ts',
      'export async function f(client: Sql, other: string) { return other; }',
      ts.ScriptTarget.Latest,
      true,
    );
    expect(collectSqlBindings(source).has('client')).toBe(true);
    expect(collectSqlBindings(source).has('other')).toBe(false);
  });

  it('adds a `begin` callback parameter, whose type is inferred rather than written', () => {
    const source = ts.createSourceFile(
      'x.ts',
      'export async function f(sql: Sql) { return sql.begin((scope) => scope`SELECT 1`); }',
      ts.ScriptTarget.Latest,
      true,
    );
    expect(collectSqlBindings(source).has('scope')).toBe(true);
  });
});

describe('pool-fanout-audit / findFanoutSites — the three element forms', () => {
  it('(a) counts tagged templates on a sql binding', () => {
    const [site] = sitesOf(`  return Promise.all([${tag('sql')}, ${tag('sql', 'SELECT 2')}]);`);
    expect(site).toMatchObject({ combinator: 'all', dbElements: 2 });
  });

  it('(b) counts sql.unsafe(...) — the form a tagged-template-only rule misses', () => {
    const [site] = sitesOf("  return Promise.all([sql.unsafe('SELECT 1', []), sql.unsafe('SELECT 2', [])]);");
    expect(site?.dbElements).toBe(2);
  });

  it('(c) counts a call that PASSES the binding — indirection does not shrink a wave', () => {
    const [site] = sitesOf('  return Promise.all([getA(sql, id), getB(sql, id), getC(sql, id)]);');
    expect(site?.dbElements).toBe(3);
  });

  it('counts a conditional element once, whichever branch issues the query', () => {
    const [site] = sitesOf(
      `  return Promise.all([${tag('sql')}, id ? ${tag('sql', 'A')} : ${tag('sql', 'B')}]);`,
    );
    expect(site?.dbElements).toBe(2);
  });

  it('recognises a custom-named client through its type annotation', () => {
    const [site] = sitesOf(
      `  return Promise.all([${tag('client')}, ${tag('client', 'SELECT 2')}]);`,
      'client: Sql',
    );
    expect(site?.dbElements).toBe(2);
  });
});

describe('pool-fanout-audit / findFanoutSites — what it must NOT count', () => {
  it('does not count sql.json(x) — it builds a value, not a round trip', () => {
    const [site] = sitesOf(`  return Promise.all([${tag('sql')}, sql.json({ a: 1 })]);`);
    expect(site?.dbElements).toBe(1);
  });

  it('does not count a non-DB element, so one query plus one Redis call is legal', () => {
    const [site] = sitesOf(`  return Promise.all([${tag('sql')}, redis.get(id)]);`);
    expect(site?.dbElements).toBe(1);
  });

  it('does not recurse into thunks — settledInOrder takes thunks by design', () => {
    const [site] = sitesOf(`  return Promise.all([() => ${tag('sql')}, () => ${tag('sql', 'B')}]);`);
    expect(site?.dbElements).toBe(0);
  });

  it('sees no site at all in the sanctioned sequential analog', () => {
    expect(sitesOf(`  return settledInOrder([() => ${tag('sql')}, () => ${tag('sql', 'B')}]);`)).toEqual([]);
  });
});

describe('pool-fanout-audit / findFanoutSites — fail-closed on unreadable shapes', () => {
  it('reports -1 for an identifier argument it cannot read', () => {
    const [site] = sitesOf('  const work = [];\n  return Promise.all(work);');
    expect(site?.dbElements).toBe(-1);
  });

  it('reports -1 for a mapped argument', () => {
    const [site] = sitesOf(`  return Promise.all(ids.map((one) => ${tag('sql')}));`);
    expect(site?.dbElements).toBe(-1);
  });

  it('reports -1 for a spread element, whose width is unknown', () => {
    const [site] = sitesOf(`  return Promise.all([${tag('sql')}, ...rest]);`);
    expect(site?.dbElements).toBe(-1);
  });
});

describe('pool-fanout-audit / findFanoutSites — every concurrent combinator', () => {
  it.each(['all', 'allSettled', 'race', 'any'])('detects Promise.%s', (combinator) => {
    const [site] = sitesOf(`  return Promise.${combinator}([${tag('sql')}, ${tag('sql', 'B')}]);`);
    expect(site).toMatchObject({ combinator, dbElements: 2 });
  });
});

describe('pool-fanout-audit / pragmaReason', () => {
  const lines = [
    `// ${PRAGMA}: one DB call and one Redis call`,
    'await Promise.all([a, b]);',
    `await Promise.all([c, d]); // ${PRAGMA}: trailing form`,
    `// ${PRAGMA}`,
    'await Promise.all([e, f]);',
    `const x = 1; // ${PRAGMA}: on a CODE line`,
    'await Promise.all([g, h]);',
  ];

  it('reads a reason from a comment-only line directly above', () => {
    expect(pragmaReason(lines, 1)).toBe('one DB call and one Redis call');
  });

  it('reads a reason from the site line itself', () => {
    expect(pragmaReason(lines, 2)).toBe('trailing form');
  });

  it('returns the empty string for a pragma with no reason', () => {
    expect(pragmaReason(lines, 4)).toBe('');
  });

  it('does NOT let a CODE line above blanket the line below', () => {
    expect(pragmaReason(lines, 6)).toBeNull();
  });

  it('returns null where there is no pragma', () => {
    expect(pragmaReason(['await Promise.all([a, b]);'], 0)).toBeNull();
  });
});

describe('pool-fanout-audit / evaluateFindings', () => {
  it('reports a two-element fan-out — two is already enough to wedge a backend', () => {
    const { findings } = evaluateFindings([fileOf(wrap(`  return Promise.all([${tag('sql')}, ${tag('sql', 'B')}]);`))]);
    expect(findings).toHaveLength(1);
    expect(findings[0]).toContain('fans out 2 DB-issuing elements');
  });

  it('passes a single-element fan-out', () => {
    const { findings } = evaluateFindings([fileOf(wrap(`  return Promise.all([${tag('sql')}, redis.get(id)]);`))]);
    expect(findings).toEqual([]);
  });

  it('reports an unreadable shape rather than passing it', () => {
    const { findings } = evaluateFindings([fileOf(wrap('  return Promise.all(work);'))]);
    expect(findings).toHaveLength(1);
    expect(findings[0]).toContain('not a readable array literal');
  });

  it('allows a site whose pragma carries a reason, and says so out loud', () => {
    const text = wrap(
      `  // ${PRAGMA}: both reads are on the worker pool, not the Vercel singleton\n` +
        `  return Promise.all([${tag('sql')}, ${tag('sql', 'B')}]);`,
    );
    const { findings, allowed } = evaluateFindings([fileOf(text)]);
    expect(findings).toEqual([]);
    expect(allowed).toHaveLength(1);
    expect(allowed[0]).toContain('both reads are on the worker pool');
  });

  it('reports a pragma with NO reason — an unexplained exemption is the old problem', () => {
    const text = wrap(`  // ${PRAGMA}\n  return Promise.all([${tag('sql')}, ${tag('sql', 'B')}]);`);
    const { findings, allowed } = evaluateFindings([fileOf(text)]);
    expect(allowed).toEqual([]);
    expect(findings).toHaveLength(1);
    expect(findings[0]).toContain('with no reason');
  });

  it('names the file and line so the finding is navigable', () => {
    const { findings } = evaluateFindings([
      fileOf(wrap(`  return Promise.all([${tag('sql')}, ${tag('sql', 'B')}]);`), 'src/lib/admin/x.ts'),
    ]);
    expect(findings[0]).toMatch(/^src\/lib\/admin\/x\.ts:\d+ —/);
  });
});

describe('pool-fanout-audit / regression — the four subjects the pins missed', () => {
  // Each fixture is the ORIGINAL shape, reduced to its fan-out. If any of these
  // stops producing a finding, the rule has drifted back toward the enumeration.

  it('subject A — lookupSuppressions: two tagged templates (2026-08-18 pass)', () => {
    const { findings } = evaluateFindings([
      fileOf(wrap(`  const [rows, corrections] = await Promise.all([${tag('sql')}, ${tag('sql', 'B')}]);\n  return [rows, corrections];`)),
    ]);
    expect(findings).toHaveLength(1);
  });

  it('subject B — getAdminNotifications: two sql.unsafe plus a conditional template (2026-08-22 pass)', () => {
    const { findings } = evaluateFindings([
      fileOf(
        wrap(
          "  const [a, b, c] = await Promise.all([\n" +
            "    sql.unsafe('SELECT 1', []),\n" +
            "    sql.unsafe('SELECT 2', []),\n" +
            `    id ? ${tag('sql', 'A')} : ${tag('sql', 'B')},\n` +
            '  ]);\n  return [a, b, c];',
        ),
      ),
    ]);
    expect(findings).toHaveLength(1);
    expect(findings[0]).toContain('fans out 3 DB-issuing elements');
  });

  it('subject C — the cost-report rollup branch: two templates behind an if (2026-08-23)', () => {
    const { findings } = evaluateFindings([
      fileOf(wrap(`  if (id) {\n    return Promise.all([${tag('sql')}, ${tag('sql', 'B')}]);\n  }\n  return [];`)),
    ]);
    expect(findings).toHaveLength(1);
  });

  it('subject D — processRow: three helper calls, and nothing mentions sql twice (2026-08-23)', () => {
    const { findings } = evaluateFindings([
      fileOf(
        wrap(
          '  const [n, account, owner] = await Promise.all([\n' +
            '    getActiveLocationCount(sql, id),\n' +
            '    getAccountById(sql, id),\n' +
            '    getAccountOwnerUser(sql, id),\n' +
            '  ]);\n  return [n, account, owner];',
        ),
      ),
    ]);
    expect(findings).toHaveLength(1);
    expect(findings[0]).toContain('fans out 3 DB-issuing elements');
  });
});

describe('pool-fanout-audit / guards the guard', () => {
  // Without this, a classifier that silently stopped classifying would let every
  // assertion above pass by returning nothing, and the audit would report
  // success on a tree full of fan-outs — the #592 blind-detector failure.
  it('a file with no combinator yields no sites, and a bad one yields a finding', () => {
    expect(findFanoutSites(wrap(`  return ${tag('sql')};`))).toEqual([]);

    const { findings } = evaluateFindings([fileOf(wrap(`  return Promise.all([${tag('sql')}, ${tag('sql', 'B')}]);`))]);
    expect(findings).toHaveLength(1);
  });

  it('parses .tsx without mistaking a type argument for JSX', () => {
    const text = `import type { Sql } from 'postgres';
export async function probe(sql: Sql) {
  return Promise.all([sql<Row[]>${BT}SELECT 1${BT}, sql<Row[]>${BT}SELECT 2${BT}]);
}
`;
    const sites = findFanoutSites(text, 'src/lib/admin/probe.tsx');
    expect(sites[0]?.dbElements).toBe(2);
  });
});
