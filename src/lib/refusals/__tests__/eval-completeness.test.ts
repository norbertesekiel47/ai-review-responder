// The eval's guard on itself — #1009 slice 2, task T1 (title 26).
//
// WHY THIS FILE EXISTS AT ALL. `scripts/verify-gate.sh`'s `promised-tests` row
// greps for a test's TITLE and nothing else. A file of markered-out cases
// therefore satisfies every promised title while executing zero assertions, and
// the whole eval can be inert with the gate still green. The repo has hit this
// before — `src/lib/kpi/__tests__/fragments.test.ts` records a surviving marker
// as review-blocking.
//
// WHY THE SCAN RUNS AT MODULE SCOPE. A markered-out case never runs, so a check
// living inside this case's body could be switched off exactly the way it
// exists to prevent. Vitest still LOADS the module, though — so a module-scope
// check executes and fails collection whether or not the case below is marked.
// That is what makes the guard independent of itself, and it is the correction
// plan review round 3 forced. The case body then re-asserts the SAME computed
// result, so the failure reads as a failing test rather than only as a
// collection error.
//
// WHY THE SCAN SET INCLUDES THIS FILE. Title 26 is a claim about the seven
// files AS A SET. Scanning only the other six would make it partial and would
// leave the one file whose job is completeness unchecked.
//
// WHAT WAS REJECTED, AND WHY. Round 3 proposed a new syntax-aware `ci:*` audit
// script instead. `scripts/diff-coverage.ts` — the guard an earlier draft
// wrongly claimed already covered this — excludes `__tests__` and `.test.*` and
// measures only ADDED PRODUCTION lines, so it passes at T1 with nothing to
// cover and passes later off the other twenty-seven cases' coverage. It catches
// a WHOLLY inert eval, never a single inert case. A new `ci:*` entry, against
// that, must be added to `package.json`, `ci.yml`'s lint job and `lefthook.yml`
// together, with `src/__tests__/ci-audit-wiring.test.ts` failing whenever those
// three drift — a permanent repo-wide obligation bought for one branch's eval
// hygiene. Owner decision, 2026-08-30: the module-scope check. The general
// problem outlives this branch and is recorded as a step-8 promotion item.

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * Every test file this branch adds or extends. Seven rows, seven distinct
 * files, and this file is one of them.
 */
const EVAL_FILES = [
  'src/lib/refusals/__tests__/vocabulary.test.ts',
  'src/lib/refusals/__tests__/write.test.ts',
  'src/lib/refusals/__tests__/write.integration.test.ts',
  'src/lib/auto-approval/__tests__/suspension.integration.test.ts',
  'worker/background/schedulers/__tests__/AutonomyGovernorScheduler.test.ts',
  'worker/background/pollers/__tests__/ArchivalPoller.integration.test.ts',
  'src/lib/refusals/__tests__/eval-completeness.test.ts',
] as const;

/**
 * The banned markers, assembled from parts rather than written out.
 *
 * Spelling a marker literally anywhere in this file would make the scan flag
 * its own source — so the caller names and the suffixes are separate string
 * literals and the pattern is built at run time. Same reason the prose above
 * never puts a caller name immediately before one.
 */
const MARKER_CALLERS = ['it', 'test', 'describe'] as const;
const MARKER_SUFFIXES = ['todo', 'skip', 'fails', 'only'] as const;

function markerPattern(): RegExp {
  return new RegExp(
    `\\b(?:${MARKER_CALLERS.join('|')})\\s*\\.\\s*(?:${MARKER_SUFFIXES.join('|')})\\b`,
    'g',
  );
}

/** An executing case: `it(` or `test(` with no marker between name and paren. */
const ACTIVE_CASE_PATTERN = /\b(?:it|test)\s*\(/;

export interface EvalFileFinding {
  file: string;
  reason: string;
}

/**
 * Reads all seven files and returns every violation. Pure, so the module-scope
 * guard and the case below assert the identical computed result rather than two
 * separately-derived ones.
 */
function scanEvalFiles(): EvalFileFinding[] {
  const findings: EvalFileFinding[] = [];
  for (const file of EVAL_FILES) {
    let source: string;
    try {
      source = readFileSync(join(process.cwd(), file), 'utf8');
    } catch {
      findings.push({ file, reason: 'the file this eval promised is missing' });
      continue;
    }

    const markers = [...source.matchAll(markerPattern())].map((match) => match[0]);
    if (markers.length > 0) {
      findings.push({ file, reason: `carries inert-test markers: ${markers.join(', ')}` });
    }

    // Presence of a marker is not the only way to be inert: a file with no
    // executing case at all satisfies nothing while tripping no marker.
    if (!ACTIVE_CASE_PATTERN.test(source)) {
      findings.push({ file, reason: 'contains no executing case' });
    }
  }
  return findings;
}

/**
 * MODULE SCOPE, and it throws. This line is what makes the guard independent of
 * whether the case below ever runs.
 */
const MODULE_SCOPE_FINDINGS = scanEvalFiles();
if (MODULE_SCOPE_FINDINGS.length > 0) {
  throw new Error(
    `#1009 eval is not fully active:\n${MODULE_SCOPE_FINDINGS.map(
      (finding) => `  - ${finding.file}: ${finding.reason}`,
    ).join('\n')}`,
  );
}

describe('#1009 eval completeness', () => {
  it('every test file this branch adds is free of .todo, .skip and .fails markers', () => {
    // Seven rows and seven distinct files: the row count and the file count have
    // to agree, because round 2's first defect was exactly these drifting apart.
    expect(EVAL_FILES).toHaveLength(7);
    expect(new Set(EVAL_FILES).size).toBe(EVAL_FILES.length);

    // The same computed result the module-scope guard already enforced. If the
    // guard were ever weakened to a no-op, this re-derivation still fails — and
    // it makes the failure legible as a test rather than a collection error.
    expect(scanEvalFiles()).toEqual([]);
    expect(MODULE_SCOPE_FINDINGS).toEqual([]);

    // The scanner itself must be able to fail. A pattern that matched nothing
    // would make every assertion above vacuous, which is the exact class of
    // defect this case exists to catch.
    const marked = `${MARKER_CALLERS[0]}.${MARKER_SUFFIXES[0]}('inert', () => {})`;
    expect(markerPattern().test(marked)).toBe(true);
    expect(ACTIVE_CASE_PATTERN.test("it('runs', () => {})")).toBe(true);
  });
});
