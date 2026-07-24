// scripts/diff-coverage.ts — changed-line coverage check for the /feature
// review gate (`scripts/verify-gate.sh --review`).
//
// Mechanically catches "wrote code, wrote no test for it": every ADDED line
// of production source (src/ and worker/ — tests and .d.ts excluded;
// scripts/ is deliberately out of scope, ops glue is verified by usage)
// must be covered above the threshold. Reads the istanbul-format
// `coverage/coverage-final.json` that `pnpm test:coverage` (vitest v8
// provider) emits.
//
// Usage: pnpm exec tsx scripts/diff-coverage.ts [--min <pct>] [--base <ref>]
//   --min   threshold percent (default $DIFF_COVERAGE_MIN or 80)
//   --base  diff base ref (default origin/main; diffed from the merge-base
//           against the WORKING TREE, so uncommitted work counts)
//
// Line semantics: an added line counts only if it is instrumented (has a
// statement); comment/type/import-only lines are ignored. A line is covered
// when any statement touching it has a hit count > 0 — the same
// conservative-toward-uncovered reading the fallow coverage gate uses.
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { relative, resolve } from 'node:path';

interface IstanbulLoc {
  start: { line: number };
  end: { line: number };
}
interface IstanbulFileCoverage {
  path: string;
  statementMap: Record<string, IstanbulLoc>;
  s: Record<string, number>;
}

function argValue(flag: string, fallback: string): string {
  const args = process.argv.slice(2);
  const index = args.indexOf(flag);
  if (index >= 0) {
    const value = args[index + 1];
    if (value) return value;
  }
  return fallback;
}

const minPercent = Number(argValue('--min', process.env.DIFF_COVERAGE_MIN ?? '80'));
const baseRef = argValue('--base', 'origin/main');

const coveragePath = resolve('coverage/coverage-final.json');
if (!existsSync(coveragePath)) {
  console.error(`diff-coverage: ${coveragePath} missing — run \`pnpm test:coverage\` first.`);
  process.exit(1);
}

const mergeBase = execFileSync('git', ['merge-base', 'HEAD', baseRef], {
  encoding: 'utf8',
}).trim();
const diff = execFileSync(
  'git',
  ['diff', '-U0', mergeBase, '--', 'src', 'worker'],
  { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 },
);

const isProductionSource = (file: string): boolean =>
  /\.(ts|tsx)$/.test(file) &&
  !file.endsWith('.d.ts') &&
  !/__tests__|\.test\./.test(file);

const addedLinesByFile = new Map<string, number[]>();

// Untracked NEW files never appear in `git diff` — count every line as added,
// or a brand-new uncovered module would escape the check entirely.
const untracked = execFileSync(
  'git',
  ['ls-files', '--others', '--exclude-standard', '--', 'src', 'worker'],
  { encoding: 'utf8' },
)
  .split('\n')
  .filter((file) => file && isProductionSource(file));
for (const file of untracked) {
  const lineCount = readFileSync(file, 'utf8').split('\n').length;
  addedLinesByFile.set(
    file,
    Array.from({ length: lineCount }, (_, index) => index + 1),
  );
}

let currentFile = '';
for (const line of diff.split('\n')) {
  const fileMatch = line.match(/^\+\+\+ b\/(.+)$/);
  if (fileMatch) {
    currentFile = fileMatch[1] ?? '';
    continue;
  }
  const hunkMatch = line.match(/^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/);
  if (hunkMatch && currentFile && isProductionSource(currentFile)) {
    const start = Number(hunkMatch[1]);
    const count = hunkMatch[2] === undefined ? 1 : Number(hunkMatch[2]);
    if (count === 0) continue;
    const lines = addedLinesByFile.get(currentFile) ?? [];
    for (let offset = 0; offset < count; offset++) lines.push(start + offset);
    addedLinesByFile.set(currentFile, lines);
  }
}

if (addedLinesByFile.size === 0) {
  console.log('diff-coverage: no added production-source lines — PASS (nothing to cover).');
  process.exit(0);
}

const coverage = JSON.parse(readFileSync(coveragePath, 'utf8')) as Record<
  string,
  IstanbulFileCoverage
>;
const coveredByFile = new Map<string, Set<number>>();
const instrumentedByFile = new Map<string, Set<number>>();
for (const entry of Object.values(coverage)) {
  const rel = relative(process.cwd(), entry.path);
  const covered = new Set<number>();
  const instrumented = new Set<number>();
  for (const [id, loc] of Object.entries(entry.statementMap)) {
    const hit = (entry.s[id] ?? 0) > 0;
    for (let line = loc.start.line; line <= loc.end.line; line++) {
      instrumented.add(line);
      if (hit) covered.add(line);
    }
  }
  coveredByFile.set(rel, covered);
  instrumentedByFile.set(rel, instrumented);
}

let totalCountable = 0;
let totalCovered = 0;
const uncoveredReport: string[] = [];
for (const [file, lines] of addedLinesByFile) {
  const instrumented = instrumentedByFile.get(file);
  if (!instrumented) {
    // Added file entirely absent from the report = never imported by any test.
    uncoveredReport.push(`  ${file}: not in coverage report at all (${lines.length} added lines)`);
    totalCountable += lines.length;
    continue;
  }
  const covered = coveredByFile.get(file) ?? new Set<number>();
  const countable = lines.filter((line) => instrumented.has(line));
  const hit = countable.filter((line) => covered.has(line));
  totalCountable += countable.length;
  totalCovered += hit.length;
  const missed = countable.filter((line) => !covered.has(line));
  if (missed.length > 0) {
    uncoveredReport.push(`  ${file}: uncovered added lines ${summarizeRanges(missed)}`);
  }
}

function summarizeRanges(lines: number[]): string {
  const [first, ...rest] = lines;
  if (first === undefined) return '';
  const ranges: string[] = [];
  let start = first;
  let prev = first;
  for (const line of rest) {
    if (line === prev + 1) {
      prev = line;
      continue;
    }
    ranges.push(start === prev ? `${start}` : `${start}-${prev}`);
    start = line;
    prev = line;
  }
  ranges.push(start === prev ? `${start}` : `${start}-${prev}`);
  return ranges.join(', ');
}

const percent = totalCountable === 0 ? 100 : (totalCovered / totalCountable) * 100;
console.log(
  `diff-coverage: ${totalCovered}/${totalCountable} added instrumented lines covered (${percent.toFixed(1)}%, min ${minPercent}%)`,
);
if (uncoveredReport.length > 0) {
  console.log('Uncovered:');
  for (const line of uncoveredReport) console.log(line);
}
if (percent < minPercent) {
  console.error(`diff-coverage: FAIL — below ${minPercent}% threshold.`);
  process.exit(1);
}
console.log('diff-coverage: PASS');
