// scripts/ci/merge-ledger-audit.ts
//
// Issue #896 part 1. The arch counter in `.claude/reference/arch-review-log.md`
// has been wrong by its own rule at FOUR consecutive architecture passes —
// 2026-08-10 (3 missed increments), 2026-08-18 (read 8, measured 11),
// 2026-08-22 (read 3, hand-corrected to 7 the same evening) and the pass that
// filed this audit. The log states the cause in its own words:
//
//   "nothing outside the `/feature` workflow's step 8 ever increments it, so
//    any merge that does not run that workflow is invisible by construction."
//
// Nine merges in one window rewrote the enforcement surface with no trace in
// 628 lines of log — including #849, which deleted `.github/workflows/fallow.yml`
// and rewrote `src/__tests__/ci-audit-wiring.test.ts`, the test that exists to
// stop exactly that drift. In the next window #905 landed 51 production files
// and left no row at all.
//
// THE AUDIT RUNS ON THE MERGING PR, NOT ON A POST-MERGE SWEEP, and that is the
// whole design: "the sweep did not run" IS the failure mode, so a check that
// itself runs after the merge inherits it.
//
// TWO TRIGGERS, either one sufficient:
//
//   1. PRODUCTION — the diff changes a non-test file under `src/`, `worker/`
//      or `supabase/`. This is the arch log's OWN counting rule, restated in
//      code so the two cannot drift.
//
//   2. GOVERNANCE — the diff touches any path in GOVERNANCE_PATHS below: the
//      skills, the hooks, the gate scripts, the CI audits, the workflows,
//      `lefthook.yml`, `package.json`. This catches #803's class — 667 → 207
//      lines deleted from `/feature`'s step 8 — with NO line-counting
//      judgement at all, which is why it is the cheapest rule that works.
//
// THE REQUIREMENT is one added line in `.claude/reference/arch-review-log.md`.
// Deliberately not a format: prescribing a row shape would make this audit the
// owner of the log's prose, and the log's entries legitimately differ in length
// from one line to forty. What it owns is that the merge left a trace at all.
//
// WHAT IT DOES NOT DO. It never reads or writes the counter number. The
// counter is a judgement about which merges "count", and an audit that
// incremented it would be asserting that judgement on every PR — including the
// docs-only ones the rule excludes. Leaving the number to the pass and
// enforcing only the TRACE keeps this check mechanical.
import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

/** The ledger every triggering merge must leave a line in. */
export const LEDGER_PATH = '.claude/reference/arch-review-log.md';

/** Roots whose non-test files are "production" for the arch log's own rule. */
const PRODUCTION_ROOTS = ['src/', 'worker/', 'supabase/'] as const;

/**
 * The governance surface, as issue #896 names it. Re-verified 2026-08-22:
 * every entry still resolves in the tree, and the set needs no revision.
 *
 * A trailing `/` is a PREFIX (the whole subtree); anything else is an exact
 * path, except `scripts/feature-*.sh`, which is the one glob — the `/feature`
 * workflow's scripts are added and renamed as the workflow changes shape, and
 * enumerating them is how one would be missed.
 */
export const GOVERNANCE_PATHS = [
  '.agents/skills/',
  '.claude/skills/',
  '.claude/hooks/',
  '.codex/hooks/',
  '.github/workflows/',
  'scripts/ci/',
  'scripts/verify-gate.sh',
  'scripts/arm-check.sh',
  'lefthook.yml',
  'package.json',
] as const;

const FEATURE_SCRIPT = /^scripts\/feature-[\w-]+\.sh$/;

/** The test lane, which the arch log's rule excludes by name. */
export function isTestFile(path: string): boolean {
  return path.includes('__tests__/')
    || /\.(?:test|spec)\.[cm]?[jt]sx?$/.test(path)
    || path.startsWith('e2e/')
    || path.startsWith('tests/');
}

/** Trigger 1: a non-test file under a production root. */
export function isProductionFile(path: string): boolean {
  if (isTestFile(path)) return false;
  return PRODUCTION_ROOTS.some((root) => path.startsWith(root));
}

/** Trigger 2: a file on the governance surface. */
export function isGovernanceFile(path: string): boolean {
  if (FEATURE_SCRIPT.test(path)) return true;
  return GOVERNANCE_PATHS.some((entry) =>
    entry.endsWith('/') ? path.startsWith(entry) : path === entry);
}

export interface DiffClassification {
  production: string[];
  governance: string[];
}

/** Both trigger sets for one changed-file list. A path can be in both. */
export function classifyDiff(changed: readonly string[]): DiffClassification {
  return {
    production: changed.filter(isProductionFile),
    governance: changed.filter(isGovernanceFile),
  };
}

/** At most three paths, so the failure names the trigger without a wall of text. */
function sample(paths: readonly string[]): string {
  const shown = paths.slice(0, 3).join(', ');
  return paths.length > 3 ? `${shown} (+${paths.length - 3} more)` : shown;
}

/**
 * The finding, or null when the diff is clean.
 *
 * `ledgerLinesAdded` is ADDED lines only: a diff that merely deletes from the
 * log has not recorded this merge, and a diff that rewrites one line in place
 * has (git counts that as one added and one deleted).
 */
export function evaluateFinding(input: {
  changed: readonly string[];
  ledgerLinesAdded: number;
}): string | null {
  const { production, governance } = classifyDiff(input.changed);
  if (production.length === 0 && governance.length === 0) return null;
  if (input.ledgerLinesAdded > 0) return null;

  const reasons: string[] = [];
  if (production.length > 0) {
    reasons.push(`${production.length} production file(s): ${sample(production)}`);
  }
  if (governance.length > 0) {
    reasons.push(`${governance.length} governance file(s): ${sample(governance)}`);
  }
  return `this PR changes ${reasons.join(' and ')}, and adds no line to ${LEDGER_PATH}`;
}

function git(...args: string[]): string {
  return execFileSync('git', args, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 }).trim();
}

/** `origin/<base branch>` on a PR, `origin/main` otherwise. */
export function baseRefFor(githubBaseRef: string | undefined): string {
  return githubBaseRef ? `origin/${githubBaseRef}` : 'origin/main';
}

/** Added-line count for one path in a diff, from `--numstat`'s first column. */
export function parseAddedLines(numstat: string): number {
  const [row] = numstat.split('\n').filter(Boolean);
  if (!row) return 0;
  const added = Number.parseInt(row.split('\t')[0] ?? '', 10);
  // `-` in place of a count is git's marker for a binary file. Not our case,
  // but NaN must never read as "a line was added".
  return Number.isFinite(added) ? added : 0;
}

function main(): void {
  const baseRef = baseRefFor(process.env.GITHUB_BASE_REF);
  let mergeBase: string;
  try {
    mergeBase = git('merge-base', 'HEAD', baseRef);
  } catch {
    // In CI this is a real failure: a gate that cannot see the diff must say so
    // rather than pass, which is the exact "it did not run" shape this audit
    // exists to end. Locally a missing `origin/main` is a fresh clone, not a
    // violation.
    const message = `merge-ledger-audit: cannot resolve ${baseRef} — no merge-base with HEAD`;
    if (process.env.CI) {
      console.error(`${message}. Check out with full history (fetch-depth: 0).`);
      process.exit(1);
    }
    console.log(`${message}; skipped (run \`git fetch origin\` to enable it locally).`);
    return;
  }

  const changed = git('diff', '--name-only', '--no-renames', mergeBase, 'HEAD')
    .split('\n')
    .filter(Boolean);
  const ledgerLinesAdded = parseAddedLines(
    git('diff', '--numstat', mergeBase, 'HEAD', '--', LEDGER_PATH),
  );

  const finding = evaluateFinding({ changed, ledgerLinesAdded });
  if (finding) {
    console.error('merge-ledger-audit: failed');
    console.error(`  ${finding}`);
    console.error('');
    console.error(`  Add one line to ${LEDGER_PATH} describing what this merge changed.`);
    console.error('  The counter number is NOT this audit\'s business — leave it to the pass.');
    console.error('  Why: nothing outside /feature step 8 increments that log, so a merge that');
    console.error('  skips the workflow is invisible by construction (#896, #849, #905).');
    process.exit(1);
  }

  const { production, governance } = classifyDiff(changed);
  if (production.length === 0 && governance.length === 0) {
    console.log(
      `merge-ledger-audit: passed (${changed.length} changed file(s); no production or governance trigger)`,
    );
    return;
  }
  console.log(
    `merge-ledger-audit: passed (${production.length} production + ${governance.length} governance file(s); `
      + `${ledgerLinesAdded} line(s) added to ${LEDGER_PATH})`,
  );
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  main();
}
