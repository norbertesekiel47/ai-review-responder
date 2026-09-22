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
// WHY REVIEW NEVER FAILS ON ITS OWN CONTENT. An assertion moves into a shared
// helper; three unit tests are replaced by one stronger integration test; an
// allowlist entry is legitimate. A gate that failed on "assertions decreased"
// would be answered with meaningless assertions — the opposite of what it is
// for. The reviewer brief (`review-prompts.md` § Weakened checks) owns the
// judgement; this file owns only that the question gets asked.
//
// WHAT IT DOES FAIL ON (#1386): a REVIEW row whose EXPLANATION was never
// written down. The audit detected the reduction and assigned the answer to a
// human; before #1386 that answer landed in a per-branch review file that
// nothing read afterwards, so every architecture pass since 2026-09-13
// re-derived the same scattered list with a repo-wide `rg`. The requirement is
// therefore the same shape as `ci:merge-ledger`'s: one row in an append-only
// registry, `.claude/reference/verifier-exceptions.md`.
//
// THE MATCH KEY is `<branch>::<check>` — the branch with every `/` replaced by
// `-`, then the REVIEW rule name. Per BRANCH, because an exception is a fact
// about one change and a key that outlived its branch would be satisfied
// forever by one ancient row. Per RULE rather than per FILE, because that is
// the granularity reviewers already answer at: the ten-row precedent in
// `docs/reviews/fix-1301-migration-guard-execution/weakened-checks-reasons.md`
// is written as three sections, one per rule.
//
// The registry's `Live?` column is deliberately NOT read. A branch's own row is
// live by construction at PR time, and a gate that read that cell would wedge
// an old branch the day someone retired its row.
//
// ESCAPE HATCH for a FAIL: end the added line with
//   // weakened-check-ok: <reason>
// The line then reports as REVIEW with the reason — so a waiver is never
// silent, and it now needs a registry row like any other REVIEW row.
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

import { baseRefFor, isTestFile } from './merge-ledger-audit';

/** The append-only registry every REVIEW row's explanation must appear in. */
export const REGISTRY_PATH = '.claude/reference/verifier-exceptions.md';

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
// TODO/FIXME are case-SENSITIVE on purpose: `it.todo(` and a `todoList`
// variable are not unfinished work.
const UNFINISHED = /[Nn]ot[ -]?[Ii]mplemented|\b(?:TODO|FIXME)\b|catch\s*(?:\([^)]*\))?\s*\{\s*\}/;
// An ASSIGNMENT or a default only — `=60`, `:-60`, `?? '60'`. A bare mention
// in a comment (or in this file's own pattern) sets nothing.
const COVERAGE_FLOOR = /DIFF_COVERAGE_MIN\s*(?:=|:-|\?\?)\s*['"]?(\d{1,3})/;
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

/** Code only: a marker quoted in a doc, a skill or a plan is prose, not a finding. */
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
  // A test file cannot set the floor; one that mentions it is a fixture.
  return parsed.added.filter((line) => !isTestFile(line.file)).flatMap((line): Finding[] => {
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

const review = (rule: string, file: string, detail: string): Finding => ({ tier: 'REVIEW', rule, file, detail });

/** REVIEW rows for one surviving (not deleted) touched file. */
function touchedFileFindings(file: string, parsed: ParsedDiff): Finding[] {
  const findings: Finding[] = [];
  if (isTestFile(file) && !parsed.deletedFiles.includes(file)) {
    const removed = count(parsed.removed, file, EXPECT_CALL);
    const added = count(parsed.added, file, EXPECT_CALL);
    if (removed > added) findings.push(review('assertions-removed', file, `-${removed} / +${added} expect(`));
  }
  if (isQualityConfig(file)) findings.push(review('quality-config-changed', file, 'confirm no check was relaxed'));
  return findings;
}

/** REVIEW rows for one added line. Only code counts; prose quoting a marker is not a finding. */
function addedLineFindings(line: DiffLine): Finding[] {
  if (!isSourceFile(line.file)) return [];
  const findings: Finding[] = [];
  if (SUPPRESSION.test(line.text)) findings.push(review('suppression-added', line.file, line.text.trim()));
  if (!isTestFile(line.file) && UNFINISHED.test(line.text)) {
    findings.push(review('unfinished-work', line.file, line.text.trim()));
  }
  return findings;
}

function reviewFindings(parsed: ParsedDiff): Finding[] {
  const touched = [...new Set([...parsed.added, ...parsed.removed].map((line) => line.file))];
  return [
    ...parsed.deletedFiles.filter(isTestFile).map((file) => review('test-file-deleted', file, 'where did its coverage go?')),
    ...touched.flatMap((file) => touchedFileFindings(file, parsed)),
    ...parsed.added.flatMap(addedLineFindings),
  ];
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

/** One REVIEW rule on one branch: the key, and the files that raised it. */
export interface RegistryGap {
  /** `<branch>::<rule>` — what the registry row's first cell must spell. */
  key: string;
  rule: string;
  files: string[];
}

/**
 * The key a REVIEW row carries and a registry row repeats.
 *
 * `/` becomes `-` so the key is one word in a Markdown cell and matches the
 * `/feature` deviations filenames the historical rows were reconciled from
 * (`feat/899-…` and `feat-899-…` were the same branch, spelled both ways).
 */
export function exceptionKey(branch: string, rule: string): string {
  return `${branch.replaceAll('/', '-')}::${rule}`;
}

/**
 * The head branch for this diff, or null when it cannot be determined.
 *
 * `GITHUB_HEAD_REF` first: CI checks a PR out detached, so `rev-parse
 * --abbrev-ref HEAD` there is the literal string `HEAD`, which is not a branch.
 */
export function branchFor(githubHeadRef: string | undefined, gitBranch: string): string | null {
  const head = githubHeadRef?.trim();
  if (head) return head;
  const local = gitBranch.trim();
  return local && local !== 'HEAD' ? local : null;
}

/**
 * Every key the registry declares — the first cell of a table row, in
 * backticks. Prose and the format table are ignored for free: their first
 * cells do not start with a backtick.
 */
export function parseRegistryKeys(markdown: string): Set<string> {
  const keys = new Set<string>();
  for (const line of markdown.split('\n')) {
    const key = /^\|\s*`([^`]+)`\s*\|/.exec(line)?.[1]?.trim();
    if (key) keys.add(key);
  }
  return keys;
}

/**
 * REVIEW rules on this branch with no registry row, one gap per rule.
 *
 * FAIL rows are excluded on purpose: a prohibited relaxation is not an
 * exception to be registered, it is a change to be reverted. A waived FAIL is
 * already a REVIEW row (`*-waived`) and is included.
 */
export function registryGaps(
  findings: readonly Finding[],
  branch: string,
  declaredKeys: ReadonlySet<string>,
): RegistryGap[] {
  const filesByRule = new Map<string, string[]>();
  for (const finding of findings) {
    if (finding.tier !== 'REVIEW') continue;
    const files = filesByRule.get(finding.rule) ?? [];
    if (!files.includes(finding.file)) files.push(finding.file);
    filesByRule.set(finding.rule, files);
  }
  return [...filesByRule.entries()]
    .map(([rule, files]) => ({ key: exceptionKey(branch, rule), rule, files }))
    .filter((gap) => !declaredKeys.has(gap.key));
}

/** At most three paths, so the failure names the trigger without a wall of text. */
function sample(paths: readonly string[]): string {
  const shown = paths.slice(0, 3).join(', ');
  return paths.length > 3 ? `${shown} (+${paths.length - 3} more)` : shown;
}

function gapLines(gaps: readonly RegistryGap[]): string[] {
  if (gaps.length === 0) return [];
  return [
    '',
    `  No row in ${REGISTRY_PATH} for:`,
    ...gaps.map((gap) => `    ${gap.key}  — ${gap.files.length} file(s): ${sample(gap.files)}`),
    '',
    '  A REVIEW row is a question; the registry row is the written ANSWER. An',
    '  answer kept in a per-branch review file is read exactly once (#1386).',
    '  Add one row per key: date, PR, the check, the reason, and whether it is live.',
  ];
}

export function formatReport(
  findings: readonly Finding[],
  gaps: readonly RegistryGap[] = [],
): { text: string; exitCode: number } {
  const fails = findings.filter((finding) => finding.tier === 'FAIL');
  if (findings.length === 0) return { text: 'weakened-checks-audit: passed (no finding)', exitCode: 0 };
  const rows = findings.map((f) => `  ${f.tier.padEnd(6)} ${f.rule}  ${f.file}  — ${f.detail}`);
  const head = fails.length > 0
    ? `weakened-checks-audit: failed (${fails.length} prohibited relaxation(s))`
    : gaps.length > 0
      ? `weakened-checks-audit: failed (${gaps.length} REVIEW rule(s) with no registry entry)`
      : `weakened-checks-audit: passed (${findings.length} row(s) for the reviewer)`;
  const foot = fails.length > 0
    ? ['', '  Fix the code, not the check. A genuine exception ends the line with',
      '  `// weakened-check-ok: <reason>` and is then reported for review.']
    : gaps.length > 0
      ? []
      : ['', `  REVIEW rows are answered in ${REGISTRY_PATH}, one row per key.`];
  return {
    text: [head, ...rows, ...gapLines(gaps), ...foot].join('\n'),
    exitCode: fails.length > 0 || gaps.length > 0 ? 1 : 0,
  };
}

function git(...args: string[]): string {
  return execFileSync('git', args, { encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 });
}

/** The registry's text, or '' when it is missing — then every REVIEW row gaps, naming the path. */
function readRegistry(): string {
  try {
    return readFileSync(join(git('rev-parse', '--show-toplevel').trim(), REGISTRY_PATH), 'utf8');
  } catch {
    return '';
  }
}

/** The branch this diff belongs to, or '' when git cannot say. */
function currentBranch(): string {
  try {
    return git('rev-parse', '--abbrev-ref', 'HEAD');
  } catch {
    return '';
  }
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
  const findings = evaluateDiff(parseUnifiedDiff(git('diff', '-U0', '--no-renames', mergeBase)));

  // The registry check needs a branch name to build the key from. Same policy
  // as an unresolvable base ref: a gate that cannot see its input says so in
  // CI rather than passing, and skips on a detached local checkout.
  const branch = branchFor(process.env.GITHUB_HEAD_REF, currentBranch());
  if (branch === null) {
    const message = 'weakened-checks-audit: cannot determine the head branch — the registry key needs it';
    if (process.env.CI) {
      console.error(`${message}. Set GITHUB_HEAD_REF (it is set on every pull_request run).`);
      process.exit(1);
    }
    console.log(`${message}; the ${REGISTRY_PATH} check is skipped on this detached checkout.`);
  }
  const gaps = branch === null ? [] : registryGaps(findings, branch, parseRegistryKeys(readRegistry()));

  const report = formatReport(findings, gaps);
  if (report.exitCode === 0) console.log(report.text);
  else console.error(report.text);
  process.exit(report.exitCode);
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  main();
}
