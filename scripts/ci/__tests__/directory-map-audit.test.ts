import { describe, expect, it } from 'vitest';
import {
  MAP_INDEX,
  MAP_PAGES_DIR,
  collectFiles,
  collectMapFiles,
  collectMapSources,
  collectRowExistence,
  evaluateFindings,
  expandBraces,
  isInScope,
  parseDirectoryMap,
  parseDirectoryMapPages,
  type MappedRow,
} from '../directory-map-audit';

// A miniature one-file map exercising every resolution rule the audit
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

  it('tags every row with its map file — the index by default, the page when given', () => {
    expect(rows.every((row) => row.file === MAP_INDEX)).toBe(true);
    const page = parseDirectoryMap('## `worker/`\n| `env.ts` | x |\n', 'docs/directory/worker-root.md');
    expect(page).toEqual([{ path: 'worker/env.ts', file: 'docs/directory/worker-root.md', line: 2 }]);
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

describe('directory-map-audit: parseDirectoryMapPages (multi-file)', () => {
  // Two pages parsed back to back. The FIRST opens `## src/lib/` then `### db/`;
  // the SECOND begins with a relative `### x/` and never states an absolute
  // root. If the heading stack leaked across files, `x/` would resolve under
  // the first page's `src/lib/` (or `src/lib/db/`) and `y.ts` would count.
  const first = {
    file: 'docs/directory/lib-db-config-shared.md',
    text: '## `src/lib/`\n\n### `db/`\n\n| File | What |\n|---|---|\n| `server.ts` | the singleton |\n',
  };
  const second = {
    file: 'docs/directory/worker-jobs-b.md',
    text: '### `x/`\n\n| File | What |\n|---|---|\n| `y.ts` | relative — no root in THIS file |\n| `worker/z.ts` | absolute — counts |\n',
  };
  const rows = parseDirectoryMapPages([first, second]);

  it('heading stacks do not leak across files: an unrooted `### x/` never resolves under the previous file\'s folder', () => {
    // `x/` has no ancestor path in ITS file, so `y.ts` becomes the bare
    // `x/y.ts` — outside SCAN_DIRS, never judged, never satisfying coverage —
    // and NOT `src/lib/x/y.ts` or `src/lib/db/x/y.ts`, which a leaked stack
    // would have produced.
    expect(paths(rows)).toEqual(['src/lib/db/server.ts', 'worker/z.ts', 'x/y.ts']);
    expect(rows.some((row) => row.path.startsWith('src/lib/') && row.path.endsWith('y.ts'))).toBe(false);
    expect(rows.filter((row) => isInScope(row.path)).map((row) => row.path)).toEqual(['src/lib/db/server.ts', 'worker/z.ts']);
  });

  it('each row carries the file it came from and its line within THAT file', () => {
    expect(rows).toEqual([
      { path: 'src/lib/db/server.ts', file: first.file, line: 7 },
      { path: 'x/y.ts', file: second.file, line: 5 },
      { path: 'worker/z.ts', file: second.file, line: 6 },
    ]);
  });

  it('parsing the same pages in the other order yields the same rows (order-independent)', () => {
    expect(paths(parseDirectoryMapPages([second, first]))).toEqual(paths(rows));
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
  const page = 'docs/directory/lib-db-config-shared.md';
  const rows: MappedRow[] = [
    { path: 'worker/a.ts', file: 'docs/directory/worker-root.md', line: 10 },
    { path: 'src/lib/b.ts', file: page, line: 11 },
    { path: 'src/lib/gone.ts', file: page, line: 12 },
    { path: 'src/lib/gone.ts', file: MAP_INDEX, line: 13 }, // duplicate stale row → ONE finding
    { path: 'src/app/illustrative/route.ts', file: MAP_INDEX, line: 14 }, // out of scope — never judged
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
    // The message names the whole map (index + pages), not one fixed file.
    expect(findings[0]).toContain(`${MAP_INDEX} + ${MAP_PAGES_DIR}/*.md`);
  });

  it('flags an in-scope row whose file is absent (STALE) exactly once, naming the PAGE file:line it was read from', () => {
    const findings = evaluateFindings({ files: new Set(['worker/a.ts', 'src/lib/b.ts']), rows, exists });
    expect(findings).toHaveLength(1);
    expect(findings[0]).toContain(`${page}:12 names src/lib/gone.ts`);
    expect(findings[0]).not.toContain('docs/directory.md:');
  });

  it('never judges rows outside worker/ + src/lib/', () => {
    const findings = evaluateFindings({
      files: new Set<string>(),
      rows: [{ path: 'src/app/illustrative/route.ts', file: MAP_INDEX, line: 1 }],
      exists: () => false,
    });
    expect(findings).toEqual([]);
  });
});

describe('directory-map-audit: filesystem helpers (real repo)', () => {
  const root = process.cwd();

  it('collectRowExistence probes in-scope rows once and ignores out-of-scope rows', async () => {
    const exists = await collectRowExistence(root, [
      { path: 'worker/index.ts', file: MAP_INDEX, line: 1 },
      { path: 'worker/index.ts', file: MAP_INDEX, line: 2 }, // duplicate — one probe
      { path: 'worker/definitely-not-a-file.ts', file: MAP_INDEX, line: 3 },
      { path: 'src/app/page.tsx', file: MAP_INDEX, line: 4 }, // out of scope — never probed
      { path: 'worker/jobs', file: MAP_INDEX, line: 5 }, // a directory is not a file
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

  it('collectMapFiles lists the index first, then every docs/directory/*.md page sorted by name', async () => {
    const files = await collectMapFiles(root);
    expect(files[0]).toBe(MAP_INDEX);
    const pages = files.slice(1);
    expect(pages.length).toBeGreaterThanOrEqual(3);
    expect(pages.every((f) => f.startsWith(`${MAP_PAGES_DIR}/`) && f.endsWith('.md'))).toBe(true);
    expect(pages).toEqual([...pages].sort());
    expect(pages).toContain(`${MAP_PAGES_DIR}/components.md`);
  });

  it('collectMapFiles treats a missing pages directory as the index alone', async () => {
    const files = await collectMapFiles(`${root}/scripts/ci/__tests__`);
    expect(files).toEqual([MAP_INDEX]);
  });

  it('collectMapSources reads every map file and each page parses under its OWN root heading', async () => {
    const sources = await collectMapSources(root);
    expect(sources.map((s) => s.file)).toEqual(await collectMapFiles(root));
    const rows = parseDirectoryMapPages(sources);
    // The index carries the architecture + flows, not folder inventories: the
    // src/lib/ and worker/ rows come from pages, each tagged with that page.
    const inScope = rows.filter((row) => isInScope(row.path));
    expect(inScope.length).toBeGreaterThan(100);
    expect(inScope.every((row) => row.file.startsWith(`${MAP_PAGES_DIR}/`))).toBe(true);
  });
});
