// scripts/ci/weakened-checks-audit.ts
//
// "No unacknowledged increase in debt" needs one thing no other audit looks
// at: a change that goes green by WEAKENING the check instead of fixing the
// code. Every other gate reads the tree; this one reads the diff, because a
// skipped test and a deleted assertion are both invisible in the final tree.
//
// TWO TIERS, and the split is the whole design:
//
//   FAIL   — a known prohibited relaxation. Deterministic, no context needed,
//            and the repo carries ZERO of each today (verified 2026-09-18), so
//            the rule costs nothing until someone breaks it:
//              - a focused test (`.only`, `fit`, `fdescribe`)
//              - a disabled test (`.skip`, `.todo`, `xit`, `xdescribe`)
//              - a lowered changed-line coverage floor (`DIFF_COVERAGE_MIN`)
//
//   REVIEW — a change that MAY weaken protection and needs a reasoned answer.
//            Printed, never failed:
//              - a test file deleted
//              - a test file that lost more `expect(` calls than it gained
//              - a new suppression comment
//              - unfinished work in production code (a stub that throws, an
//                empty `catch`, a TODO/FIXME where the code should be)
//              - a change to the quality configuration itself
//              - a FAIL waived with the marker below
//
// WHY REVIEW NEVER FAILS. An assertion moves into a shared helper; three unit
// tests are replaced by one stronger integration test; an allowlist entry is
// legitimate. A gate that failed on "assertions decreased" would be answered
// with meaningless assertions — the opposite of what it is for. The reviewer
// brief (`review-prompts.md` § Weakened checks) owns the judgement; this file
// owns only that the question gets asked.
//
// ESCAPE HATCH for a FAIL: end the added line with
//   // weakened-check-ok: <reason>
// The line then reports as REVIEW with the reason, so a waiver is never silent.
import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

import { baseRefFor, isTestFile } from './merge-ledger-audit';

export interface DiffLine {
  file: string;
  text: string;
}

export interface ParsedDiff {
  added: DiffLine[];
  removed: DiffLine[];
  deletedFiles: string[];
}

export interface Finding {
  tier: 'FAIL' | 'REVIEW';
  rule: string;
  file: string;
  detail: string;
}

const WAIVER = /\/\/\s*weakened-check-ok:\s*(\S.*)$/;
const FOCUSED_TEST = /\b(?:(?:it|test|describe)\.only|fit|fdescribe)\s*\(/;
const DISABLED_TEST = /\b(?:(?:it|test|describe)\.(?:skip|todo)|x(?:it|test|describe))\s*\(/;
const EXPECT_CALL = /\bexpect\s*\(/g;
const SUPPRESSION =
  /eslint-disable|@ts-expect-error|@ts-ignore|@ts-nocheck|fallow-ignore|outbox-seam-ignore|simplify-ignore|(?:istanbul|v8) ignore/;
const UNFINISHED = /not[ -]?implemented|\b(?:TODO|FIXME)\b|catch\s*(?:\([^)]*\))?\s*\{\s*\}/i;
const COVERAGE_FLOOR = /DIFF_COVERAGE_MIN\b[^\d\n]{0,12}(\d{1,3})/;
const DEFAULT_COVERAGE_FLOOR = 80;

/** The files that DEFINE the checks. A change here is always worth a look. */
const QUALITY_CONFIG = new Set([
  '.fallowrc.jsonc',
  'eslint.config.mjs',
  'vitest.config.ts',
  'lefthook.yml',
  '.github/workflows/ci.yml',
  'scripts/verify-gate.sh',
  'scripts/diff-coverage.ts',
]);
const AUDIT_SCRIPT = /^scripts\/ci\/[\w-]+-audit\.ts$/;

/** Code only: a TODO in a doc or a plan is a note, not unfinished work. */
function isSourceFile(path: string): boolean {
  return /\.(?:[cm]?[jt]sx?|sql|sh)$/.test(path);
}

export function isQualityConfig(path: string): boolean {
  return QUALITY_CONFIG.has(path) || AUDIT_SCRIPT.test(path);
}

/** Added and removed lines per file from a `git diff -U0` text. */
export function parseUnifiedDiff(diff: string): ParsedDiff {
  const parsed: ParsedDiff = { added: [], removed: [], deletedFiles: [] };
  let file = '';
  // `+++ x` inside a hunk is an added line that starts with `++`, not a header.
  let inHunk = false;
  for (const line of diff.split('\n')) {
    if (line.startsWith('diff --git ')) {
      inHunk = false;
      file = line.slice(line.lastIndexOf(' b/') + 3);
    } else if (!inHunk && line.startsWith('deleted file mode')) {
      parsed.deletedFiles.push(file);
    } else if (line.startsWith('@@')) {
      inHunk = true;
    } else if (inHunk && line.startsWith('+')) {
      parsed.added.push({ file, text: line.slice(1) });
    } else if (inHunk && line.startsWith('-')) {
      parsed.removed.push({ file, text: line.slice(1) });
    }
  }
  return parsed;
}

function count(lines: readonly DiffLine[], file: string, pattern: RegExp): number {
  return lines
    .filter((line) => line.file === file)
    .reduce((total, line) => total + (line.text.match(pattern)?.length ?? 0), 0);
}

function testLineFindings(line: DiffLine): Finding[] {
  const rule = FOCUSED_TEST.test(line.text)
    ? 'focused-test'
    : DISABLED_TEST.test(line.text) ? 'disabled-test' : null;
  if (rule === null) return [];
  const waiver = WAIVER.exec(line.text);
  return [waiver
    ? { tier: 'REVIEW', rule: `${rule}-waived`, file: line.file, detail: waiver[1] ?? '' }
    : { tier: 'FAIL', rule, file: line.file, detail: line.text.trim() }];
}

/** The floor a line sets, or null when the line does not set one. */
function coverageFloor(text: string): number | null {
  const match = COVERAGE_FLOOR.exec(text);
  return match ? Number(match[1]) : null;
}

function coverageFloorFindings(parsed: ParsedDiff): Finding[] {
  return parsed.added.flatMap((line): Finding[] => {
    const next = coverageFloor(line.text);
    if (next === null) return [];
    const previous = parsed.removed
      .filter((removed) => removed.file === line.file)
      .map((removed) => coverageFloor(removed.text))
      .find((floor): floor is number => floor !== null) ?? DEFAULT_COVERAGE_FLOOR;
    return next < previous
      ? [{ tier: 'FAIL', rule: 'coverage-floor-lowered', file: line.file, detail: `${previous} → ${next}` }]
      : [];
  });
}

function reviewFindings(parsed: ParsedDiff): Finding[] {
  const findings: Finding[] = [];
  const touched = [...new Set([...parsed.added, ...parsed.removed].map((line) => line.file))];

  for (const file of parsed.deletedFiles.filter(isTestFile)) {
    findings.push({ tier: 'REVIEW', rule: 'test-file-deleted', file, detail: 'where did its coverage go?' });
  }
  for (const file of touched) {
    if (isTestFile(file) && !parsed.deletedFiles.includes(file)) {
      const removed = count(parsed.removed, file, EXPECT_CALL);
      const added = count(parsed.added, file, EXPECT_CALL);
      if (removed > added) {
        findings.push({ tier: 'REVIEW', rule: 'assertions-removed', file, detail: `-${removed} / +${added} expect(` });
      }
    }
    if (isQualityConfig(file)) {
      findings.push({ tier: 'REVIEW', rule: 'quality-config-changed', file, detail: 'confirm no check was relaxed' });
    }
  }
  for (const line of parsed.added) {
    if (SUPPRESSION.test(line.text)) {
      findings.push({ tier: 'REVIEW', rule: 'suppression-added', file: line.file, detail: line.text.trim() });
    }
    if (isSourceFile(line.file) && !isTestFile(line.file) && UNFINISHED.test(line.text)) {
      findings.push({ tier: 'REVIEW', rule: 'unfinished-work', file: line.file, detail: line.text.trim() });
    }
  }
  return findings;
}

/** Every finding for one diff, FAIL rows first. */
export function evaluateDiff(parsed: ParsedDiff): Finding[] {
  const fails = [
    ...parsed.added.filter((line) => isTestFile(line.file)).flatMap(testLineFindings),
    ...coverageFloorFindings(parsed),
  ];
  const all = [...fails, ...reviewFindings(parsed)];
  return [...all.filter((f) => f.tier === 'FAIL'), ...all.filter((f) => f.tier === 'REVIEW')];
}

export function formatReport(findings: readonly Finding[]): { text: string; exitCode: number } {
  const fails = findings.filter((finding) => finding.tier === 'FAIL');
  if (findings.length === 0) return { text: 'weakened-checks-audit: passed (no finding)', exitCode: 0 };
  const rows = findings.map((f) => `  ${f.tier.padEnd(6)} ${f.rule}  ${f.file}  — ${f.detail}`);
  const head = fails.length > 0
    ? `weakened-checks-audit: failed (${fails.length} prohibited relaxation(s))`
    : `weakened-checks-audit: passed (${findings.length} row(s) for the reviewer)`;
  const foot = fails.length > 0
    ? ['', '  Fix the code, not the check. A genuine exception ends the line with',
      '  `// weakened-check-ok: <reason>` and is then reported for review.']
    : ['', '  REVIEW rows never fail. The reviewer gives a reason for each one.'];
  return { text: [head, ...rows, ...foot].join('\n'), exitCode: fails.length > 0 ? 1 : 0 };
}

function git(...args: string[]): string {
  return execFileSync('git', args, { encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 });
}

function main(): never {
  const baseRef = baseRefFor(process.env.GITHUB_BASE_REF);
  let mergeBase: string;
  try {
    mergeBase = git('merge-base', 'HEAD', baseRef).trim();
  } catch {
    // Same rule as merge-ledger-audit: a gate that cannot see the diff fails in
    // CI and skips on a fresh local clone.
    const message = `weakened-checks-audit: cannot resolve ${baseRef} — no merge-base with HEAD`;
    if (process.env.CI) {
      console.error(`${message}. Check out with full history (fetch-depth: 0).`);
      process.exit(1);
    }
    console.log(`${message}; skipped (run \`git fetch origin\` to enable it locally).`);
    process.exit(0);
  }

  // Working tree vs merge-base, so an uncommitted `.only` is caught before the
  // commit and not only at push time.
  const report = formatReport(evaluateDiff(parseUnifiedDiff(git('diff', '-U0', '--no-renames', mergeBase))));
  if (report.exitCode === 0) console.log(report.text);
  else console.error(report.text);
  process.exit(report.exitCode);
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  main();
}
