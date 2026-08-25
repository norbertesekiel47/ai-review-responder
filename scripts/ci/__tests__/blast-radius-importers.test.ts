// Unit tests for scripts/blast-radius-importers.ts (#888): the AST-based
// importer matcher must resolve real import edges — and ONLY real import
// edges — where the old substring grep reported phantom importers for any
// common basename. Every test runs against a throwaway fixture tree so the
// matcher's directory walk and tsconfig alias reading are exercised for real.
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  computeImporters,
  extractSpecifiers,
  readAliasMappings,
  renderReport,
  specifierCandidates,
} from '../../blast-radius-importers';

let root: string;

function write(repoPath: string, content: string): void {
  const full = join(root, repoPath);
  mkdirSync(dirname(full), { recursive: true });
  writeFileSync(full, content);
}

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), 'blast-radius-'));
  write(
    'tsconfig.json',
    JSON.stringify({
      compilerOptions: {
        paths: { '@/*': ['./src/*'], '@/lib/*': ['./src/lib/*'] },
      },
    }),
  );

  write('src/lib/target.ts', 'export const x = 1;\n');
  write('src/lib/consumer-alias.ts', "import { x } from '@/lib/target';\nexport const y = x;\n");
  write('src/lib/consumer-relative.ts', "import { x } from './target';\nexport const y = x;\n");
  write('src/lib/deep/consumer-updir.ts', "import { x } from '../target';\nexport const y = x;\n");
  write('src/consumer-js-suffix.ts', "import { x } from './lib/target.js';\nexport const y = x;\n");
  write('src/lib/reexport.ts', "export { x } from '@/lib/target';\n");
  write(
    'src/lib/consumer-dynamic.ts',
    "export async function load() { return import('./target'); }\n",
  );
  write('src/lib/consumer-require.ts', "const m = require('./target');\nexport const y = m;\n");
  write(
    'src/lib/consumer-comment.ts',
    "// import { x } from './target'\nconst mention = '@/lib/target';\nexport const y = mention;\n",
  );

  // Folder import resolving to index.ts.
  write('src/pkg/index.ts', 'export const pkg = 1;\n');
  write('src/consumer-folder.ts', "import { pkg } from './pkg';\nexport const y = pkg;\n");

  // The #888 phantom class: a changed route.ts must not attract importers of
  // OTHER files named route.ts.
  write('src/app/a/route.ts', 'export const GET = () => null;\n');
  write('src/app/b/route.ts', 'export const GET = () => null;\n');
  write('src/app/b/page.ts', "import { GET } from './route';\nexport const y = GET;\n");

  // Deleted target: nothing on disk, importer still present.
  write('src/lib/consumer-of-deleted.ts', "import { gone } from './deleted';\nexport const y = gone;\n");

  // Self-import must never count as an importer.
  write('src/lib/selfy.ts', "export * from './selfy';\n");
});

afterAll(() => {
  rmSync(root, { recursive: true, force: true });
});

describe('readAliasMappings', () => {
  it('orders longer prefixes first so @/lib/* wins over @/*', () => {
    const mappings = readAliasMappings(root);
    expect(mappings[0]).toEqual({ prefix: '@/lib/', target: 'src/lib/' });
    expect(mappings[1]).toEqual({ prefix: '@/', target: 'src/' });
  });
});

describe('extractSpecifiers', () => {
  it('reads only real specifier nodes, never comments or string literals', () => {
    const specifiers = extractSpecifiers(
      "// import { a } from './commented'\nconst s = './stringy';\nimport { b } from './real';\n",
      'x.ts',
    );
    expect(specifiers).toEqual(['./real']);
  });
});

describe('specifierCandidates', () => {
  it('returns no candidates for bare package specifiers', () => {
    expect(specifierCandidates('src/a.ts', 'postgres', readAliasMappings(root))).toEqual([]);
  });

  it('returns no candidates for a relative path escaping the repo', () => {
    expect(specifierCandidates('src/a.ts', '../../outside', [])).toEqual([]);
  });
});

describe('computeImporters', () => {
  it('finds alias, relative, updir, .js-suffix, re-export, dynamic and require importers', () => {
    const importers = computeImporters(root, ['src/lib/target.ts']);
    expect(importers.get('src/lib/target.ts')).toEqual([
      'src/consumer-js-suffix.ts',
      'src/lib/consumer-alias.ts',
      'src/lib/consumer-dynamic.ts',
      'src/lib/consumer-relative.ts',
      'src/lib/consumer-require.ts',
      'src/lib/deep/consumer-updir.ts',
      'src/lib/reexport.ts',
    ]);
  });

  it('resolves folder imports to index.ts', () => {
    const importers = computeImporters(root, ['src/pkg/index.ts']);
    expect(importers.get('src/pkg/index.ts')).toEqual(['src/consumer-folder.ts']);
  });

  it('does NOT attract importers of other files sharing a common basename', () => {
    const importers = computeImporters(root, ['src/app/a/route.ts']);
    expect(importers.get('src/app/a/route.ts')).toEqual([]);
  });

  it('still reports importers of a DELETED changed file', () => {
    const importers = computeImporters(root, ['src/lib/deleted.ts']);
    expect(importers.get('src/lib/deleted.ts')).toEqual(['src/lib/consumer-of-deleted.ts']);
  });

  it('reports importers of the OLD path of a rename exactly like a deletion', () => {
    // A rename feeds both paths; the old path behaves as a deleted target.
    const importers = computeImporters(root, ['src/lib/deleted.ts', 'src/lib/target.ts']);
    expect(importers.get('src/lib/deleted.ts')).toEqual(['src/lib/consumer-of-deleted.ts']);
    expect(importers.get('src/lib/target.ts')).toContain('src/lib/consumer-alias.ts');
  });

  it('excludes self-imports', () => {
    const importers = computeImporters(root, ['src/lib/selfy.ts']);
    expect(importers.get('src/lib/selfy.ts')).toEqual([]);
  });
});

describe('renderReport', () => {
  it('renders the empty-changed-set report', () => {
    expect(renderReport('feat-x', new Map())).toContain('_No changed production source files._');
  });

  it('renders counts, importer bullets, and the none-found note', () => {
    const report = renderReport(
      'feat-x',
      new Map([
        ['src/a.ts', ['src/b.ts']],
        ['src/c.ts', []],
      ]),
    );
    expect(report).toContain('# Blast radius — importers of changed files (`feat-x`)');
    expect(report).toContain('## `src/a.ts` — 1 importer(s)');
    expect(report).toContain('- src/b.ts');
    expect(report).toContain('## `src/c.ts` — 0 importer(s)');
    expect(report).toContain('_none found');
  });
});
