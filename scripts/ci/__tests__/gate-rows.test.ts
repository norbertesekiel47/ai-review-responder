import { spawnSync } from 'node:child_process';
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

// #696. A verify-gate row's name is also its `.feature/logs/<name>.log` and,
// for integration rows, its coverage directory — so two rows sharing a name
// share a status slot, and a FAILED suite can be recorded as PASS. The gate is
// the mechanical backstop for an entire /feature run, so a silent green there
// invalidates every downstream claim.
//
// `scripts/gate-rows.sh` exists as its own sourceable file precisely so this
// suite can exercise the derivation: sourcing `verify-gate.sh` would run the
// gate. The two colliding paths below are the real ones from the ticket.

const ROOT = resolve(process.cwd());
const LIB = join(ROOT, 'scripts', 'gate-rows.sh');
const GATE = join(ROOT, 'scripts', 'verify-gate.sh');

/** The exact pair that collided: the first path is 40 slug characters long. */
const CONSENT_SUITE = 'src/lib/reviews/__tests__/import-consent.integration.test.ts';
const CONSENT_SIBLING =
  'src/lib/reviews/__tests__/import-consent-analytics.integration.test.ts';

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

/** Run a snippet with gate-rows.sh sourced, under the gate's own shell flags. */
function runWithLib(snippet: string) {
  return spawnSync('bash', ['-euo', 'pipefail', '-c', `. ${shellQuote(LIB)}; ${snippet}`], {
    cwd: ROOT,
    encoding: 'utf8',
  });
}

function rowSlug(input: string): string {
  const result = runWithLib(`row_slug ${shellQuote(input)}`);
  expect(result.status, result.stderr).toBe(0);
  return result.stdout;
}

describe('row_slug', () => {
  it('derives distinct slugs for integration suites sharing a 40-character path prefix', () => {
    const suite = rowSlug(CONSENT_SUITE);
    const sibling = rowSlug(CONSENT_SIBLING);

    // The precondition the old truncation threw away: these two DO share the
    // first 40 characters. Without this assertion the test could pass against
    // a pair that never collided in the first place.
    expect(suite.slice(0, 40)).toBe(sibling.slice(0, 40));
    expect(suite).not.toBe(sibling);
  });

  it('keeps the truncated path prefix readable in the derived slug', () => {
    // Readability is the reason the prefix survives at all — a bare hash would
    // be collision-free and useless in the printed table.
    expect(rowSlug(CONSENT_SUITE)).toMatch(
      /^src-lib-reviews---tests---import-consent-[0-9a-f]{6}$/,
    );
  });
});

describe('gate-rows.sh as a sourced library', () => {
  it('never exits, so its caller can always record a RED gate-status.json', () => {
    // `exit` in a sourced file terminates the CALLER. The hash-tool check used
    // to do exactly that, taking the gate down before it could overwrite the
    // previous run's {"passed":true} — which .claude/hooks/stop-gate.sh then
    // reads as this run's success. Text is the right medium here: the property
    // is "this token does not appear at any depth in this file".
    const lines = readFileSync(LIB, 'utf8')
      .split('\n')
      .filter((line) => !line.trim().startsWith('#'));
    expect(lines.filter((line) => /\bexit\b/.test(line))).toEqual([]);
  });
});

describe('assert_unique_row_name', () => {
  it('accepts a row name that is not already registered', () => {
    const result = runWithLib('assert_unique_row_name build lint typecheck test');
    expect(result.status, result.stderr).toBe(0);
  });

  it('exits non-zero when a row name is already registered', () => {
    const result = runWithLib('assert_unique_row_name lint lint typecheck');
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("duplicate row name 'lint'");
  });

  it('accepts the first row name when no rows are registered yet', () => {
    // `${NAMES[@]+…}` under `set -u` with an empty array is the bash 3.2 trap
    // this call site has to survive on macOS.
    const result = runWithLib('NAMES=(); assert_unique_row_name lint ${NAMES[@]+"${NAMES[@]}"}');
    expect(result.status, result.stderr).toBe(0);
  });
});

describe('verify-gate.sh row wiring', () => {
  const source = readFileSync(GATE, 'utf8');

  it('routes every dynamic row name in verify-gate.sh through row_slug', () => {
    const assignments = source.match(/^\s*SAFE=.*$/gm) ?? [];
    expect(assignments.length).toBeGreaterThan(0);
    for (const assignment of assignments) {
      expect(assignment).toContain('row_slug');
    }
    // Any truncation at all now lives only in gate-rows.sh, where the hash
    // suffix is applied in the same expression. Matched as a pattern, not the
    // literal `cut -c1-40`: `cut -c1-41` or `head -c 40` is the same bug.
    expect(source).not.toMatch(/\b(cut\s+-c\s*1-\d+|head\s+-c\s*\d+)/);
  });

  // The two tests below run the REAL `launch` and `gate_abort` bodies rather
  // than asserting that verify-gate.sh mentions them. A source-text assertion
  // passed against a mutant whose launch() asserted uniqueness over ${PIDS[@]}
  // instead of ${NAMES[@]} — correct-looking, completely disarmed.
  function runLaunchHarness(snippet: string) {
    const extract = (fn: string) =>
      `eval "$(sed -n '/^${fn}() {/,/^}/p' ${shellQuote(GATE)})"`;
    return spawnSync(
      'bash',
      [
        '-uo',
        'pipefail',
        '-c',
        [
          'cd "$(mktemp -d)" || exit 9',
          'mkdir -p .feature/logs',
          `. ${shellQuote(LIB)}`,
          extract('gate_abort'),
          extract('launch'),
          'MAX_PARALLEL=4',
          snippet,
        ].join('\n'),
      ],
      { encoding: 'utf8' },
    );
  }

  it('launches the first row when no rows are registered yet', () => {
    // `set -u` + bash 3.2 (what /usr/bin/env bash is on macOS): expanding an
    // EMPTY array as "${NAMES[@]}" is an unbound-variable error, so the very
    // first `launch lint` would kill the gate before it wrote any status.
    const result = runLaunchHarness('NAMES=(); PIDS=(); launch alpha true; echo "rc=$?"');
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain('rc=0');
  });

  it('aborts with a RED gate-status.json when a launched row name is already taken', () => {
    const result = runLaunchHarness(
      'NAMES=(); PIDS=(); launch alpha true; launch alpha true; echo "NO ABORT"; ' +
        'cat .feature/gate-status.json',
    );
    expect(result.status).toBe(1);
    expect(result.stdout).not.toContain('NO ABORT');
    expect(result.stdout).toContain('GATE: RED');
    expect(result.stderr).toContain("duplicate row name 'alpha'");
  });

  it('aborts with a RED gate-status.json when the row library fails to load', () => {
    // A missing/unloadable gate-rows.sh used to surface as a bogus duplicate:
    // `launch` read the exit 127 from an undefined assert_unique_row_name as a
    // collision. Copy the gate WITHOUT its library to reproduce; the guard
    // fires before any expensive row starts, so this stays a fast test.
    const dir = mkdtempSync(join(tmpdir(), 'gate-rows-'));
    try {
      copyFileSync(GATE, join(dir, 'verify-gate.sh'));
      const result = spawnSync('bash', [join(dir, 'verify-gate.sh')], {
        cwd: dir,
        encoding: 'utf8',
      });

      expect(result.status).toBe(1);
      expect(result.stdout).toContain('GATE: RED');
      expect(result.stdout).toContain('gate-rows.sh did not load');
      const status = JSON.parse(readFileSync(join(dir, '.feature/gate-status.json'), 'utf8'));
      expect(status.passed).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('promised-tests title discovery', () => {
  const source = readFileSync(GATE, 'utf8');

  // Extract and RUN the real grep line rather than asserting that the script
  // mentions a root. A source-text assertion ("expect(source).toContain('tests')")
  // passes against a mutant that names the root in a comment and drops it from
  // the command — the same disarmed-mutant trap the launch tests above exist
  // for. Whatever roots that one line names are the roots this test exercises.
  // `&& continue` is stripped: it belongs to the enclosing read-loop and is a
  // syntax error on its own. Everything that decides WHAT is searched — the
  // flags, the --include filters, the roots — is kept verbatim.
  const GREP_LINE = source
    .match(/^\s*grep -rqF "\$TITLE".*$/m)?.[0]
    ?.replace(/\s*&&\s*continue\s*$/, '');

  /** A tree with one promised title, under `where`, and empty sibling roots. */
  function corpusFixture(where: string, title: string): string {
    const dir = mkdtempSync(join(tmpdir(), 'promised-tests-'));
    for (const root of ['src', 'worker', 'scripts', 'tests']) {
      mkdirSync(join(dir, root), { recursive: true });
    }
    mkdirSync(join(dir, where), { recursive: true });
    writeFileSync(
      join(dir, where, 'fixture.test.ts'),
      `it('${title}', () => {});\n`,
      'utf8',
    );
    return dir;
  }

  function discovers(where: string, title: string): boolean {
    const dir = corpusFixture(where, title);
    try {
      const result = spawnSync(
        'bash',
        ['-uo', 'pipefail', '-c', `TITLE=${shellQuote(title)}; ${GREP_LINE} && echo FOUND`],
        { cwd: dir, encoding: 'utf8' },
      );
      return result.stdout.includes('FOUND');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }

  it('promised-tests discovers promised corpus titles under tests/llm-eval', () => {
    // The LLM-eval suites have nowhere else to live, and feat/safety-review-
    // auto-approval promises 13 titles there. Without `tests` in the roots the
    // gate reports all 13 missing while they exist and pass — a false RED that
    // cannot be told apart from an unwritten test (plan round-1 finding 13).
    expect(GREP_LINE, 'the promised-tests grep line moved or was renamed').toBeDefined();
    expect(discovers('tests/llm-eval/__tests__', 'scores unsafe-threat-02 as true_positive')).toBe(
      true,
    );
  });

  it('keeps discovering titles under the roots it already searched', () => {
    // Adding a root must not reorder or drop the others. #611 added `scripts`
    // for exactly this class of false RED; this pins all four at once.
    for (const where of ['src/lib/__tests__', 'worker/__tests__', 'scripts/ci/__tests__']) {
      expect(discovers(where, `promised title under ${where}`), where).toBe(true);
    }
  });

  it('still reports a genuinely unwritten title as missing', () => {
    // The roots are wide, not unconditional. A gate that finds everything is
    // the same false green as a gate that finds nothing is a false red.
    const dir = corpusFixture('tests/llm-eval/__tests__', 'a title that was written');
    try {
      const result = spawnSync(
        'bash',
        [
          '-uo',
          'pipefail',
          '-c',
          `TITLE=${shellQuote('a title nobody wrote')}; ${GREP_LINE} && echo FOUND`,
        ],
        { cwd: dir, encoding: 'utf8' },
      );
      expect(result.stdout).not.toContain('FOUND');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
