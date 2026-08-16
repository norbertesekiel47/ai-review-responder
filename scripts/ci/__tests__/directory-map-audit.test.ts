import { describe, expect, it } from 'vitest';
import {
  collectFiles,
  collectRowExistence,
  evaluateFindings,
  expandBraces,
  isInScope,
  parseDirectoryMap,
  type MappedRow,
} from '../directory-map-audit';

// A miniature docs/directory.md exercising every resolution rule the audit
// relies on: `##` absolute roots, `###` relative children, `####` absolute
// overrides, a heading that names a file, first-cell rows (relative, absolute,
// brace-expanded), and the shapes that must NOT count (prose mentions,
// non-first-cell spans, header separators, rows under a no-token heading).
const MAP = `
# RepWorth — Directory Reference

## High-Level Architecture

Diagram mentions \`worker/index.ts\` in prose — not a row.

## \`src/lib/\`

All shared business logic.

| File | What it does |
|------|--------------|
| \`seo.ts\` | root-level module |

### \`db/\`

| File | What it does |
|------|--------------|
| \`server.ts\` | the singleton |
| \`admission.ts\` | shares a helper with \`pool-wait.ts\` (prose span in cell two) |
| \`{account-guard,transient-error}.ts\` | brace form |

### \`notifications/\`

| File | What it does |
|------|--------------|
| \`email/templates/auto-post-notice.ts\` | relative sub-path |
| \`src/lib/notifications/mask-handle.ts\` | absolute in-cell |

## \`worker/\`

### \`worker/env.ts\`

Heading names a file — that IS a row.

### \`worker/jobs/\` — BullMQ Job Handlers

| File | Queue | What it does |
|------|-------|--------------|
| \`billing/UpdateStripeOverageWorker.ts\` | \`update_stripe_overage\` | three-cell table |
| \`ingest.ts\` / \`backfill.ts\` | — | two spans in one first cell |

#### \`worker/jobs/publisher/\` — helpers

| File | What it does |
|------|--------------|
| \`post-reply.ts\` | absolute #### under ### |
| \`worker/jobs/publisher/__tests__/post-reply.test.ts\` | test path — ignored |
| \`ingress/stripe/*.ts\` | glob — ignored |
| \`handleCsvIngest\` | not a path — ignored |

### WS6 contract-test inventory

| Area | Test modules |
|------|--------------|
| \`worker/jobs/judge/failed-hook.ts\` | absolute in first cell — counted |
| \`relative-under-no-token.ts\` | ignored: no section path |
`;

function paths(rows: MappedRow[]): string[] {
  return rows.map((row) => row.path).sort();
}

describe('directory-map-audit: parseDirectoryMap', () => {
  const rows = parseDirectoryMap(MAP);

  it('resolves rows against ## roots, ### children and #### absolute overrides', () => {
    expect(paths(rows)).toEqual(
      [
        'src/lib/seo.ts',
        'src/lib/db/server.ts',
        'src/lib/db/admission.ts',
        'src/lib/db/account-guard.ts',
        'src/lib/db/transient-error.ts',
        'src/lib/notifications/email/templates/auto-post-notice.ts',
        'src/lib/notifications/mask-handle.ts',
        'worker/env.ts',
        'worker/jobs/billing/UpdateStripeOverageWorker.ts',
        'worker/jobs/ingest.ts',
        'worker/jobs/backfill.ts',
        'worker/jobs/publisher/post-reply.ts',
        // Absolute path in the first cell under a no-token heading still counts.
        'worker/jobs/judge/failed-hook.ts',
      ].sort(),
    );
  });

  it('does not count prose mentions, second-cell spans, tests, globs, or bare identifiers', () => {
    const all = paths(rows);
    expect(all).not.toContain('worker/index.ts'); // prose under a no-token heading
    expect(all).not.toContain('src/lib/db/pool-wait.ts'); // second cell
    expect(all.some((p) => p.includes('__tests__'))).toBe(false);
    expect(all.some((p) => p.includes('*'))).toBe(false);
    expect(all.some((p) => p.endsWith('handleCsvIngest'))).toBe(false);
    expect(all).not.toContain('relative-under-no-token.ts');
  });

  it('records the 1-based source line of each row', () => {
    const seo = rows.find((row) => row.path === 'src/lib/seo.ts');
    expect(seo?.line).toBe(MAP.split('\n').findIndex((line) => line.startsWith('| `seo.ts`')) + 1);
  });

  it('a heading naming a file resolves relative rows in its body to that file\'s folder', () => {
    const local = parseDirectoryMap(`## \`worker/\`\n### \`worker/config/startup-assert.ts\`\n| \`fastify-options.ts\` | x |\n`);
    expect(paths(local)).toEqual(['worker/config/fastify-options.ts', 'worker/config/startup-assert.ts']);
  });

  it('a heading with no code span opens a section where only absolute rows resolve', () => {
    const local = parseDirectoryMap(`## \`worker/\`\n### Flows\n| \`x.ts\` | relative — ignored |\n| \`worker/y.ts\` | absolute — counted |\n`);
    expect(paths(local)).toEqual(['worker/y.ts']);
  });
});

describe('directory-map-audit: expandBraces / isInScope', () => {
  it('expands one brace group and leaves plain tokens alone', () => {
    expect(expandBraces('{a,b}.ts')).toEqual(['a.ts', 'b.ts']);
    expect(expandBraces('sub/{a, b}.ts')).toEqual(['sub/a.ts', 'sub/b.ts']);
    expect(expandBraces('plain.ts')).toEqual(['plain.ts']);
  });

  it('scopes to worker/ and src/lib/ only', () => {
    expect(isInScope('worker/x.ts')).toBe(true);
    expect(isInScope('src/lib/x.ts')).toBe(true);
    expect(isInScope('src/app/page.tsx')).toBe(false);
    expect(isInScope('src/components/x.tsx')).toBe(false);
    expect(isInScope('src/library/x.ts')).toBe(false); // prefix, not folder
  });
});

describe('directory-map-audit: evaluateFindings', () => {
  const rows: MappedRow[] = [
    { path: 'worker/a.ts', line: 10 },
    { path: 'src/lib/b.ts', line: 11 },
    { path: 'src/lib/gone.ts', line: 12 },
    { path: 'src/lib/gone.ts', line: 13 }, // duplicate stale row → ONE finding
    { path: 'src/app/illustrative/route.ts', line: 14 }, // out of scope — never judged
  ];
  const exists = (path: string): boolean => path !== 'src/lib/gone.ts' && path !== 'src/app/illustrative/route.ts';

  it('passes when every file has a row and every in-scope row exists', () => {
    expect(
      evaluateFindings({
        files: new Set(['worker/a.ts', 'src/lib/b.ts']),
        rows: rows.filter((row) => !row.path.endsWith('gone.ts')),
        exists,
      }),
    ).toEqual([]);
  });

  it('flags a production file with no row (UNMAPPED), sorted, naming the target folder', () => {
    const findings = evaluateFindings({
      files: new Set(['worker/a.ts', 'worker/jobs/publisher/z.ts', 'src/lib/b.ts']),
      rows: rows.filter((row) => !row.path.endsWith('gone.ts')),
      exists,
    });
    expect(findings).toHaveLength(1);
    expect(findings[0]).toContain('worker/jobs/publisher/z.ts has no row');
    expect(findings[0]).toContain('worker/jobs/publisher/');
  });

  it('flags an in-scope row whose file is absent (STALE) exactly once, with its line', () => {
    const findings = evaluateFindings({ files: new Set(['worker/a.ts', 'src/lib/b.ts']), rows, exists });
    expect(findings).toHaveLength(1);
    expect(findings[0]).toContain('docs/directory.md:12 names src/lib/gone.ts');
  });

  it('never judges rows outside worker/ + src/lib/', () => {
    const findings = evaluateFindings({
      files: new Set<string>(),
      rows: [{ path: 'src/app/illustrative/route.ts', line: 1 }],
      exists: () => false,
    });
    expect(findings).toEqual([]);
  });
});

describe('directory-map-audit: filesystem helpers (real repo)', () => {
  const root = process.cwd();

  it('collectRowExistence probes in-scope rows once and ignores out-of-scope rows', async () => {
    const exists = await collectRowExistence(root, [
      { path: 'worker/index.ts', line: 1 },
      { path: 'worker/index.ts', line: 2 }, // duplicate — one probe
      { path: 'worker/definitely-not-a-file.ts', line: 3 },
      { path: 'src/app/page.tsx', line: 4 }, // out of scope — never probed
      { path: 'worker/jobs', line: 5 }, // a directory is not a file
    ]);
    expect(exists('worker/index.ts')).toBe(true);
    expect(exists('worker/definitely-not-a-file.ts')).toBe(false);
    expect(exists('src/app/page.tsx')).toBe(false); // not probed → unknown → false
    expect(exists('worker/jobs')).toBe(false);
    expect(exists('never-asked.ts')).toBe(false);
  });

  it('collectFiles walks worker/ + src/lib/ and skips the test lane', async () => {
    const files = await collectFiles(root);
    expect(files.has('worker/index.ts')).toBe(true);
    expect(files.has('src/lib/db/server.ts')).toBe(true);
    expect([...files].some((f) => f.includes('__tests__') || /\.test\.tsx?$/.test(f))).toBe(false);
    expect([...files].some((f) => f.startsWith('src/app/'))).toBe(false);
  });
});
