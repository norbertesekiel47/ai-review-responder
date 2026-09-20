import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

// #1108. verify-gate.sh's promised-tests row greps each tests_to_add title as
// a VERBATIM fixed string, but a JavaScript single-quoted test name spells an
// apostrophe as `\'` in source (a double-quoted name spells a quote as `\"`,
// a template literal spells a backtick as `` \` ``). The intake promises the
// title's UNESCAPED text, so the verbatim grep misses a test that exists,
// passes, and was mutation-verified — the row can only ever UNDER-report,
// and the false RED reads as unwritten work rather than a quoting mismatch.
//
// scripts/gate-promised-tests.sh exists as its own sourceable file precisely
// so this suite can exercise the matcher: sourcing verify-gate.sh would RUN
// the gate.

const ROOT = resolve(process.cwd());
const LIB = join(ROOT, 'scripts', 'gate-promised-tests.sh');
const GATE = join(ROOT, 'scripts', 'verify-gate.sh');
const STANDARD_ROOTS = ['src', 'worker', 'scripts', 'tests'];

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

/** A fixture tree with the gate's four standard search roots already made. */
function makeFixture(extraRoots: string[] = []): string {
  const dir = mkdtempSync(join(tmpdir(), 'gate-promised-tests-'));
  for (const root of [...STANDARD_ROOTS, ...extraRoots]) {
    mkdirSync(join(dir, root), { recursive: true });
  }
  return dir;
}

function writeFixtureTest(dir: string, root: string, contents: string): void {
  mkdirSync(join(dir, root), { recursive: true });
  writeFileSync(join(dir, root, 'fixture.test.ts'), contents, 'utf8');
}

/** Runs the real promised_title_found, sourced under the gate's own shell flags. */
function titleFound(dir: string, title: string, roots: string[] = STANDARD_ROOTS): boolean {
  const result = spawnSync(
    'bash',
    [
      '-euo',
      'pipefail',
      '-c',
      `. ${shellQuote(LIB)}; promised_title_found ${shellQuote(title)} ${roots.map(shellQuote).join(' ')}`,
    ],
    { cwd: dir, encoding: 'utf8' },
  );
  // A non-0/1 status (e.g. a shell syntax error) is a broken test, not a "not
  // found" — surface it rather than silently reading it as false.
  expect([0, 1], result.stderr).toContain(result.status);
  return result.status === 0;
}

/** Runs the real promised_title_spellings and returns the candidate lines it emits. */
function titleSpellings(title: string): string[] {
  const result = spawnSync(
    'bash',
    ['-euo', 'pipefail', '-c', `. ${shellQuote(LIB)}; promised_title_spellings ${shellQuote(title)}`],
    { cwd: ROOT, encoding: 'utf8' },
  );
  expect(result.status, result.stderr).toBe(0);
  return result.stdout.replace(/\n$/, '').split('\n');
}

// #1345. Asserting only the BOOLEAN match hides a version-dependent candidate:
// macOS ships bash 3.2 and CI runs bash 5.x, and bash >= 4.3 performs
// backslash processing on the replacement text of ${var//pat/rep}. A doubled
// `\\` therefore collapsed back to `\` under CI's bash only, the candidate
// became identical to the title, promised_title_spellings suppressed it as a
// duplicate, and the matcher returned a silent false — green locally, red in
// CI, with nothing in the failure naming bash. Pinning the exact emitted LIST
// makes that class visible as a MISSING CANDIDATE on whichever bash runs the
// suite, with no container and no second interpreter.
const CANDIDATE_LISTS: ReadonlyArray<{ readonly what: string; readonly title: string; readonly candidates: readonly string[] }> = [
  {
    what: 'a literal backslash, doubled the way any JS quote style spells it',
    title: 'a \\ b escape',
    candidates: ['a \\ b escape', 'a \\\\ b escape'],
  },
  {
    what: 'an apostrophe, escaped for a single-quoted name',
    title: "arms' latch",
    candidates: ["arms' latch", "arms\\' latch"],
  },
  {
    what: 'a quotation mark, escaped for a double-quoted name',
    title: 'say "yes" now',
    candidates: ['say "yes" now', 'say \\"yes\\" now'],
  },
  {
    what: 'a backtick, escaped for a template literal',
    title: 'a `tick` title',
    candidates: ['a `tick` title', 'a \\`tick\\` title'],
  },
  {
    what: 'both an apostrophe and a quotation mark, one candidate per quote style',
    title: 'both \' and " here',
    candidates: ['both \' and " here', 'both \\\' and " here', 'both \' and \\" here'],
  },
  {
    what: 'no special character at all, so the verbatim spelling is the only candidate',
    title: 'plain title no specials',
    candidates: ['plain title no specials'],
  },
];

describe('promised_title_spellings candidate list', () => {
  for (const { what, title, candidates } of CANDIDATE_LISTS) {
    it(`emits the same candidates on every bash version for ${what}`, () => {
      expect(titleSpellings(title)).toEqual([...candidates]);
    });
  }

  it('builds the doubled-backslash candidate without bash pattern substitution', () => {
    // The assertions above can only observe the ONE bash that runs them, so on
    // macOS's bash 3.2 they stay green against the construct that breaks under
    // CI's bash 5 — they turn the CI failure into a readable missing-candidate
    // diff, they do not catch it locally. This one does, on every version: a
    // source assertion is the only thing a single interpreter can check about
    // a difference between interpreters. It is deliberately narrow — it pins
    // the ONE construct whose behaviour is unobservable here, not the search
    // roots or anything else a regex would pin badly.
    const source = readFileSync(LIB, 'utf8');
    expect(source).toContain(`bslash=$(printf '%s' "$title" | sed 's/\\\\/\\\\\\\\/g')`);
    // ${var//pat/rep} is version-dependent for a backslash REPLACEMENT in both
    // its unquoted and its quoted form, so neither may come back.
    expect(source).not.toMatch(/\$\{title\/\/[^}]*backslash/);
  });

  it('emits each candidate exactly once, so a suppressed one reads as absent not as a duplicate', () => {
    for (const { title, candidates } of CANDIDATE_LISTS) {
      const emitted = titleSpellings(title);
      expect(new Set(emitted).size, title).toBe(emitted.length);
      // The verbatim title is always first, and every extra candidate differs
      // from it — that is exactly the property a collapsed replacement breaks.
      expect(emitted[0]).toBe(title);
      for (const candidate of candidates.slice(1)) {
        expect(candidate).not.toBe(title);
      }
    }
  });
});

describe('promised_title_found', () => {
  it('finds a promised title spelled verbatim in the test source', () => {
    const dir = makeFixture();
    try {
      writeFixtureTest(dir, 'src', `it("a verbatim promised title", () => {});\n`);
      expect(titleFound(dir, 'a verbatim promised title')).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("finds a promised title whose apostrophe the source escapes inside a single-quoted name", () => {
    const dir = makeFixture();
    try {
      // Written exactly as a real single-quoted JS test name would spell it:
      // the source literally contains the substring `arms\' once`.
      writeFixtureTest(
        dir,
        'worker',
        `it('noteRefusalLedgerDark shares the write arms\\' once-per-episode latch', () => {});\n`,
      );
      const raw = readFileSync(join(dir, 'worker', 'fixture.test.ts'), 'utf8');
      expect(raw).toContain(`arms\\' once`);
      expect(
        titleFound(
          dir,
          "noteRefusalLedgerDark shares the write arms' once-per-episode latch",
        ),
      ).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('finds a promised title whose quotation mark the source escapes inside a double-quoted name', () => {
    const dir = makeFixture();
    try {
      // Written exactly as a real double-quoted JS test name would spell it:
      // the source literally contains the substring `say \"yes\" now`.
      writeFixtureTest(dir, 'scripts', `it("say \\"yes\\" now", () => {});\n`);
      const raw = readFileSync(join(dir, 'scripts', 'fixture.test.ts'), 'utf8');
      expect(raw).toContain(`say \\"yes\\" now`);
      expect(titleFound(dir, 'say "yes" now')).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('finds a promised title whose literal backslash the source doubles', () => {
    // #1108 review finding 3: the intake's edge_cases claims the VERBATIM
    // spelling still matches a title containing a literal backslash. Verified
    // false — a real JS test name always escapes a literal backslash the
    // same way regardless of quote style, so the source doubles it. Written
    // exactly as a real single-quoted JS test name would spell it: the
    // source literally contains the substring `a \\ b escape` (two
    // backslash characters).
    const dir = makeFixture();
    try {
      writeFixtureTest(dir, 'src', `it('a \\\\ b escape', () => {});\n`);
      const raw = readFileSync(join(dir, 'src', 'fixture.test.ts'), 'utf8');
      expect(raw).toContain(`a \\\\ b escape`);
      expect(titleFound(dir, 'a \\ b escape')).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('keeps the gate honest about a title that carries an author\'s apostrophe', () => {
    // This test's own name, above, is written single-quoted in THIS file's
    // source, so it literally spells `author\'s apostrophe`. That title is
    // also in this run's intake tests_to_add list, so the gate's own
    // promised-tests row — scanning this very file under `scripts` — goes
    // green only if promised_title_found's single-quote candidate actually
    // works. That is the end-to-end proof; the body below exercises the same
    // escape path against a disposable fixture.
    const dir = makeFixture();
    try {
      writeFixtureTest(
        dir,
        'tests',
        `it('records an author\\'s apostrophe correctly', () => {});\n`,
      );
      expect(titleFound(dir, "records an author's apostrophe correctly")).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('reports a title no test file spells, so the row goes red only on real absence', () => {
    const dir = makeFixture();
    try {
      writeFixtureTest(dir, 'src', `it('a title that was written', () => {});\n`);
      expect(titleFound(dir, 'a title nobody wrote')).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('searches src, worker, scripts and tests, and no other root', () => {
    const dir = makeFixture(['e2e']);
    try {
      writeFixtureTest(dir, 'e2e', `it('a title only e2e spells', () => {});\n`);
      expect(titleFound(dir, 'a title only e2e spells', STANDARD_ROOTS)).toBe(false);
      // Prove the fixture itself is valid: the same title IS found once e2e
      // is included, so the failure above is the root filter, not a typo.
      expect(titleFound(dir, 'a title only e2e spells', [...STANDARD_ROOTS, 'e2e'])).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('does not match a promised title that appears only in a non-test file', () => {
    // The --include='*.test.ts' --include='*.test.tsx' filters are pinned by
    // nothing else: every fixture above only ever writes fixture.test.ts, so
    // a mutant that drops both --include flags survives the whole suite. That
    // mutant widens the search into every file under the root, which is the
    // dangerous direction — the gate would report a promised test exists
    // because its title merely appears in a markdown note or a source
    // comment. This fixture writes the title into a sibling non-test file so
    // dropping the flags is the one change that flips this test to true.
    const dir = makeFixture();
    try {
      writeFileSync(
        join(dir, 'src', 'notes.md'),
        'a title that only a markdown file spells\n',
        'utf8',
      );
      expect(titleFound(dir, 'a title that only a markdown file spells')).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('verify-gate.sh row wiring', () => {
  it('the verify gate reads its promised-tests verdict from the shared matcher', () => {
    // This pins WIRING only — that verify-gate.sh sources this file and
    // routes its verdict through promised_title_found — not the search
    // roots. A source-text regex naming the roots (`src worker scripts
    // tests`) passes against a mutant that names them in a comment and
    // drops them from the real command it calls; gate-rows.test.ts's
    // "promised-tests title discovery" suite covers the roots properly, by
    // extracting that exact line and EXECUTING it against a fixture.
    const source = readFileSync(GATE, 'utf8');
    expect(source).toContain('gate-promised-tests.sh');
    expect(source).toMatch(/promised_title_found\s+"\$TITLE"/);
  });
});

describe('promised_title_found security contract', () => {
  it('a title containing $(touch pwned) is searched for literally and creates no such file', () => {
    const dir = makeFixture();
    try {
      const maliciousTitle = "runs nothing: $(touch pwned) and `touch pwned2`";
      writeFixtureTest(dir, 'src', `it('an unrelated fixture title', () => {});\n`);
      expect(titleFound(dir, maliciousTitle)).toBe(false);
      expect(existsSync(join(dir, 'pwned'))).toBe(false);
      expect(existsSync(join(dir, 'pwned2'))).toBe(false);
      expect(existsSync(join(ROOT, 'pwned'))).toBe(false);
      expect(existsSync(join(ROOT, 'pwned2'))).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
