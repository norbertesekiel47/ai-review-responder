import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  DEFAULT_SKIP_DIRS,
  evaluateAgainstBaseline,
  normalize,
  walk,
} from '../lib/ratchet-harness';

describe('ratchet-harness: normalize', () => {
  it('is identity for forward-slash paths (POSIX)', () => {
    expect(normalize('src/lib/db/server.ts')).toBe('src/lib/db/server.ts');
  });
});

describe('ratchet-harness: evaluateAgainstBaseline', () => {
  const messages = {
    onNew: (file: string) => `NEW ${file}`,
    onStale: (file: string) => `STALE ${file}`,
  };

  it('flags a live offender that is not skip-exempt and not baselined (NEW)', () => {
    const findings = evaluateAgainstBaseline(new Set(['a.ts']), {
      baseline: new Set<string>(),
      skip: () => false,
      ...messages,
    });
    expect(findings).toEqual(['NEW a.ts']);
  });

  it('flags a baseline entry absent from the live set (STALE)', () => {
    const findings = evaluateAgainstBaseline(new Set<string>(), {
      baseline: new Set(['gone.ts']),
      skip: () => false,
      ...messages,
    });
    expect(findings).toEqual(['STALE gone.ts']);
  });

  it('emits both a NEW and a STALE finding at once', () => {
    const findings = evaluateAgainstBaseline(new Set(['new.ts']), {
      baseline: new Set(['gone.ts']),
      skip: () => false,
      ...messages,
    });
    expect(findings).toHaveLength(2);
  });

  it('does not flag a skip-exempt live offender', () => {
    const findings = evaluateAgainstBaseline(new Set(['root.ts']), {
      baseline: new Set<string>(),
      skip: (file) => file === 'root.ts',
      ...messages,
    });
    expect(findings).toEqual([]);
  });

  it('is quiet when the live set equals the baseline', () => {
    const findings = evaluateAgainstBaseline(new Set(['kept.ts']), {
      baseline: new Set(['kept.ts']),
      skip: () => false,
      ...messages,
    });
    expect(findings).toEqual([]);
  });
});

describe('ratchet-harness: walk', () => {
  let root: string;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'ratchet-walk-'));
    await mkdir(join(root, 'src', 'nested'), { recursive: true });
    await mkdir(join(root, 'src', 'node_modules'), { recursive: true });
    await writeFile(join(root, 'src', 'a.ts'), '');
    await writeFile(join(root, 'src', 'b.tsx'), '');
    await writeFile(join(root, 'src', 'c.js'), ''); // excluded by default ext
    await writeFile(join(root, 'src', 'd.test.ts'), ''); // excluded by default skipFile
    await writeFile(join(root, 'src', 'nested', 'e.ts'), '');
    await writeFile(join(root, 'src', 'node_modules', 'skip.ts'), ''); // skipped dir
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it('collects normalized .ts/.tsx paths, honoring default ext + skip filters', async () => {
    const files = (await walk(root, { scanDirs: ['src'] })).sort();
    expect(files).toEqual(['src/a.ts', 'src/b.tsx', 'src/nested/e.ts']);
  });

  it('honors a scanExt override (adds .js)', async () => {
    const files = await walk(root, { scanDirs: ['src'], scanExt: /\.(?:ts|tsx|js)$/ });
    expect(files).toContain('src/c.js');
  });

  it('honors a skipDirs override (descends into node_modules when dropped)', async () => {
    const files = await walk(root, { scanDirs: ['src'], skipDirs: new Set<string>() });
    expect(files).toContain('src/node_modules/skip.ts');
  });

  it('silently skips a missing scan directory', async () => {
    const files = await walk(root, { scanDirs: ['does-not-exist'] });
    expect(files).toEqual([]);
  });

  it('exposes the shared default skip-dir set', () => {
    expect(DEFAULT_SKIP_DIRS.has('__fixtures__')).toBe(true);
  });
});
