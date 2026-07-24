import { describe, expect, it } from 'vitest';
import {
  auditedBranch,
  auditSurface,
  extractSurface,
  globToRegExp,
  intakePathFor,
} from '../feature-surface-audit';

describe('globToRegExp', () => {
  it('matches the edit-surface-guard bash [[ == ]] semantics: * crosses /', () => {
    expect(globToRegExp('src/worker/*').test('src/worker/jobs/deep/file.ts')).toBe(true);
    expect(globToRegExp('src/lib/foo/*').test('src/lib/foo/bar.ts')).toBe(true);
    expect(globToRegExp('src/lib/foo/*').test('src/lib/other/bar.ts')).toBe(false);
  });

  it('treats ? as exactly one character', () => {
    expect(globToRegExp('src/?.ts').test('src/a.ts')).toBe(true);
    expect(globToRegExp('src/?.ts').test('src/ab.ts')).toBe(false);
  });

  it('escapes regex metacharacters as literals', () => {
    expect(globToRegExp('package.json').test('package.json')).toBe(true);
    expect(globToRegExp('package.json').test('packageXjson')).toBe(false);
    expect(globToRegExp('a+b.ts').test('a+b.ts')).toBe(true);
  });

  it('anchors the whole path', () => {
    expect(globToRegExp('src/a.ts').test('other/src/a.ts')).toBe(false);
    expect(globToRegExp('src/a.ts').test('src/a.ts.bak')).toBe(false);
  });
});

describe('auditSurface', () => {
  const surface = ['src/lib/foo/*', 'worker/jobs/thing.ts'];

  it('allows surface matches and flags everything else', () => {
    expect(
      auditSurface(
        ['src/lib/foo/a.ts', 'worker/jobs/thing.ts', 'src/lib/other/b.ts'],
        surface,
      ),
    ).toEqual(['src/lib/other/b.ts']);
  });

  it('always allows the process surfaces (docs, CONTEXT.md, .feature)', () => {
    expect(
      auditSurface(
        ['docs/superpowers/plans/x-intake.json', 'docs/reviews/x/spec.md', 'CONTEXT.md'],
        [],
      ),
    ).toEqual([]);
  });

  it('with an empty surface, flags every non-process change', () => {
    expect(auditSurface(['src/app/page.tsx'], [])).toEqual(['src/app/page.tsx']);
  });
});

describe('auditedBranch / intakePathFor', () => {
  it('prefers the CI head ref and skips long-lived refs', () => {
    expect(auditedBranch('feat/x', 'main')).toBe('feat/x');
    expect(auditedBranch(undefined, 'feat/y')).toBe('feat/y');
    expect(auditedBranch(undefined, 'main')).toBeNull();
    expect(auditedBranch(undefined, 'staging')).toBeNull();
    expect(auditedBranch(undefined, '')).toBeNull();
  });

  it('slugs branch separators into the committed intake path', () => {
    expect(intakePathFor('feat/ci-feature-surface')).toBe(
      'docs/superpowers/plans/feat-ci-feature-surface-intake.json',
    );
  });
});

describe('extractSurface', () => {
  it('narrows only string entries from a valid intake', () => {
    expect(
      extractSurface({ allowed_edit_surface: ['src/*', 42, 'worker/*'] }),
    ).toEqual(['src/*', 'worker/*']);
  });

  it('returns empty for malformed shapes', () => {
    expect(extractSurface(null)).toEqual([]);
    expect(extractSurface({ allowed_edit_surface: 'src/*' })).toEqual([]);
    expect(extractSurface('not an object')).toEqual([]);
  });
});
