import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  auditedBranch,
  auditSurface,
  extractSurface,
  findPreEscapedEntries,
  findUnmatchedEntries,
  globToRegExp,
  intakePathFor,
  plainSpellingOf,
  preEscapedEntriesByIntake,
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

  // Lockstep with BOTH bash hooks — see scripts/ci/__tests__/edit-surface-guard.test.ts,
  // which pins the same table against .claude/hooks/edit-surface-guard.sh and
  // its Codex port. This side was already correct; the Claude hook read '[id]'
  // as a character class until #828 and the Codex port until #867.
  it('treats a Next.js dynamic route segment literally, not as a character class', () => {
    const glob = 'src/app/admin/businesses/[id]/page.tsx';
    expect(globToRegExp(glob).test('src/app/admin/businesses/[id]/page.tsx')).toBe(true);
    expect(globToRegExp(glob).test('src/app/admin/businesses/i/page.tsx')).toBe(false);
    expect(globToRegExp(glob).test('src/app/admin/businesses/d/page.tsx')).toBe(false);
    expect(
      globToRegExp('src/app/admin/businesses/[id]/**').test(
        'src/app/admin/businesses/[id]/__tests__/page-source.test.ts',
      ),
    ).toBe(true);
  });

  it('a pre-escaped bracket spelling matches nothing real (#867)', () => {
    const real = 'src/app/api/u/[token]/route.ts';
    expect(globToRegExp('src/app/api/u/\\[token\\]/route.ts').test(real)).toBe(false);
    expect(globToRegExp('src/app/api/u/[[]token[]]/route.ts').test(real)).toBe(false);
    expect(globToRegExp('src/app/api/u/[token]/route.ts').test(real)).toBe(true);
  });
});

describe('findPreEscapedEntries / plainSpellingOf', () => {
  it('flags every pre-escaped bracket form and nothing else', () => {
    expect(
      findPreEscapedEntries([
        'src/app/api/u/[token]/route.ts',
        'src/app/api/u/\\[token\\]/route.ts',
        'src/app/api/u/[[]token[]]/route.ts',
        'src/app/api/dashboard/reviews/\\[reviewId\\]/generate/**',
        'src/lib/foo/*',
        'package.json',
      ]),
    ).toEqual([
      'src/app/api/u/\\[token\\]/route.ts',
      'src/app/api/u/[[]token[]]/route.ts',
      'src/app/api/dashboard/reviews/\\[reviewId\\]/generate/**',
    ]);
  });

  it('names the plain literal the intake should carry instead', () => {
    expect(plainSpellingOf('src/app/api/u/\\[token\\]/route.ts')).toBe('src/app/api/u/[token]/route.ts');
    expect(plainSpellingOf('src/app/api/u/[[]token[]]/route.ts')).toBe('src/app/api/u/[token]/route.ts');
    expect(plainSpellingOf('src/app/api/dashboard/reviews/\\[reviewId\\]/generate/**')).toBe(
      'src/app/api/dashboard/reviews/[reviewId]/generate/**',
    );
  });

  it('sweeps every committed intake in a directory, keyed by path', () => {
    const dir = mkdtempSync(join(tmpdir(), 'intakes-'));
    try {
      mkdirSync(dir, { recursive: true });
      writeFileSync(
        join(dir, 'a-intake.json'),
        JSON.stringify({ allowed_edit_surface: ['src/app/x/[id]/page.tsx'] }),
      );
      writeFileSync(
        join(dir, 'b-intake.json'),
        JSON.stringify({
          allowed_edit_surface: ['src/app/x/[id]/page.tsx', 'src/app/x/\\[id\\]/page.tsx'],
        }),
      );
      // Not an intake (wrong suffix) — must be ignored even though it is dirty.
      writeFileSync(join(dir, 'notes.json'), JSON.stringify({ allowed_edit_surface: ['\\[x\\]'] }));
      writeFileSync(join(dir, 'c-intake.json'), JSON.stringify({ size: 'epic' }));
      const found = preEscapedEntriesByIntake(dir);
      expect([...found.entries()]).toEqual([[`${dir}/b-intake.json`, ['src/app/x/\\[id\\]/page.tsx']]]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('returns empty for a missing directory', () => {
    expect(preEscapedEntriesByIntake('/nonexistent/intakes').size).toBe(0);
  });
});

describe('findUnmatchedEntries', () => {
  const tracked = [
    'src/app/api/u/[token]/route.ts',
    'src/lib/foo/a.ts',
    'src/lib/foo/__tests__/a.test.ts',
    'package.json',
  ];

  it('flags a non-process entry that matches neither a tracked nor a changed file', () => {
    expect(
      findUnmatchedEntries(
        [
          'src/app/api/u/[token]/route.ts',
          'src/app/api/u/[[]token[]]/route.ts',
          'src/lib/foo/*',
          'src/lib/typo/**',
        ],
        tracked,
        [],
      ),
    ).toEqual(['src/app/api/u/[[]token[]]/route.ts', 'src/lib/typo/**']);
  });

  it('counts a file the branch deleted or renamed away as matched', () => {
    expect(
      findUnmatchedEntries(['src/lib/old-module.ts'], tracked, ['src/lib/old-module.ts']),
    ).toEqual([]);
  });

  it('never flags always-allowed process surfaces, matched or not', () => {
    expect(
      findUnmatchedEntries(
        ['docs/superpowers/plans/never-written.md', 'docs/reviews/x/**', 'CONTEXT.md', '.feature/**'],
        tracked,
        [],
      ),
    ).toEqual([]);
  });

  it('with an empty surface, flags nothing', () => {
    expect(findUnmatchedEntries([], tracked, [])).toEqual([]);
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
