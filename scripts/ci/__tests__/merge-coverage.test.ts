import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mergeCoverageReports } from '../../merge-coverage';

// One istanbul file-entry. Only the counter maps matter to the merge; the
// structural maps are carried through untouched.
function fileEntry(
  path: string,
  statements: Record<string, number>,
  branches: Record<string, number[]> = {},
) {
  return {
    path,
    statementMap: { '0': {} },
    fnMap: {},
    branchMap: {},
    s: statements,
    f: {},
    b: branches,
  };
}

let root: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'merge-coverage-'));
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

function writeReport(dir: string, contents: unknown): string {
  mkdirSync(dir, { recursive: true });
  const path = join(dir, 'coverage-final.json');
  writeFileSync(path, JSON.stringify(contents), 'utf8');
  return path;
}

function readBase(path: string) {
  return JSON.parse(readFileSync(path, 'utf8')) as Record<
    string,
    { s: Record<string, number>; b: Record<string, number[]> }
  >;
}

describe('mergeCoverageReports', () => {
  it('sums statement hits for a file present in both reports', () => {
    const base = writeReport(join(root, 'base'), {
      '/repo/src/ingest.ts': fileEntry('/repo/src/ingest.ts', { '0': 0, '1': 2 }),
    });
    writeReport(join(root, 'extra', 'row-a'), {
      '/repo/src/ingest.ts': fileEntry('/repo/src/ingest.ts', { '0': 5, '1': 3 }),
    });

    const merged = mergeCoverageReports(base, [join(root, 'extra')]);

    expect(merged).toBe(1);
    expect(readBase(base)['/repo/src/ingest.ts']!.s).toEqual({ '0': 5, '1': 5 });
  });

  it('is the regression guard for #563: a second row does not overwrite the first', () => {
    // The bug this script exists to prevent — each integration row writes a
    // COMPLETE report, so a shared output directory discarded every row but the
    // last. Two rows covering DIFFERENT statements must both survive.
    const base = writeReport(join(root, 'base'), {
      '/repo/src/ingest.ts': fileEntry('/repo/src/ingest.ts', { '0': 0, '1': 0 }),
    });
    writeReport(join(root, 'extra', 'row-a'), {
      '/repo/src/ingest.ts': fileEntry('/repo/src/ingest.ts', { '0': 4, '1': 0 }),
    });
    writeReport(join(root, 'extra', 'row-b'), {
      '/repo/src/ingest.ts': fileEntry('/repo/src/ingest.ts', { '0': 0, '1': 7 }),
    });

    const merged = mergeCoverageReports(base, [join(root, 'extra')]);

    expect(merged).toBe(2);
    expect(readBase(base)['/repo/src/ingest.ts']!.s).toEqual({ '0': 4, '1': 7 });
  });

  it('adds a file the base report has never seen', () => {
    const base = writeReport(join(root, 'base'), {
      '/repo/src/a.ts': fileEntry('/repo/src/a.ts', { '0': 1 }),
    });
    writeReport(join(root, 'extra', 'row-a'), {
      '/repo/src/b.ts': fileEntry('/repo/src/b.ts', { '0': 9 }),
    });

    mergeCoverageReports(base, [join(root, 'extra')]);

    expect(Object.keys(readBase(base)).sort()).toEqual(['/repo/src/a.ts', '/repo/src/b.ts']);
  });

  it('sums branch arms elementwise', () => {
    const base = writeReport(join(root, 'base'), {
      '/repo/src/a.ts': fileEntry('/repo/src/a.ts', {}, { '0': [1, 0] }),
    });
    writeReport(join(root, 'extra', 'row-a'), {
      '/repo/src/a.ts': fileEntry('/repo/src/a.ts', {}, { '0': [0, 3] }),
    });

    mergeCoverageReports(base, [join(root, 'extra')]);

    expect(readBase(base)['/repo/src/a.ts']!.b).toEqual({ '0': [1, 3] });
  });

  it('leaves the base report intact when there is nothing to merge', () => {
    const base = writeReport(join(root, 'base'), {
      '/repo/src/a.ts': fileEntry('/repo/src/a.ts', { '0': 2 }),
    });

    // A gate run with no changed integration suites must not blank the report.
    const merged = mergeCoverageReports(base, [join(root, 'does-not-exist')]);

    expect(merged).toBe(0);
    expect(readBase(base)['/repo/src/a.ts']!.s).toEqual({ '0': 2 });
  });

  it('names the offending file when a report is truncated', () => {
    const base = writeReport(join(root, 'base'), {});
    const badDir = join(root, 'extra', 'row-a');
    mkdirSync(badDir, { recursive: true });
    writeFileSync(join(badDir, 'coverage-final.json'), '{"a":', 'utf8');

    expect(() => mergeCoverageReports(base, [join(root, 'extra')])).toThrow(
      /coverage-final\.json is not valid JSON/,
    );
  });

  it('throws when the base report is missing', () => {
    expect(() => mergeCoverageReports(join(root, 'nope.json'), [])).toThrow(
      /base report .* not found/,
    );
  });
});
