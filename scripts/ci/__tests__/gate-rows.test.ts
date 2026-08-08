import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
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
    // The truncation itself now lives only in gate-rows.sh, where the hash
    // suffix is applied in the same expression.
    expect(source).not.toContain('cut -c1-40');
  });

  it('registers every launched row through assert_unique_row_name', () => {
    const launchBody = source.slice(
      source.indexOf('launch() {'),
      source.indexOf('launch lint'),
    );
    expect(launchBody).toContain('assert_unique_row_name');
    expect(launchBody).toContain('gate_abort');
  });
});
