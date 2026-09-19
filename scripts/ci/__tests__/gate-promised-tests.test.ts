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
});

describe('verify-gate.sh row wiring', () => {
  it('the verify gate reads its promised-tests verdict from the shared matcher', () => {
    const source = readFileSync(GATE, 'utf8');
    expect(source).toContain('gate-promised-tests.sh');
    expect(source).toMatch(/promised_title_found\s+"\$TITLE"\s+src\s+worker\s+scripts\s+tests/);
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
