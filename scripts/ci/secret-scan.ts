// scripts/ci/secret-scan.ts
//
// Issue #1374. `keys.md` landed at the repo root in commit 24353cf1 ("Sprint
// 1: scaffolding", 2026-04-06) with a full credential set, then was deleted
// from the tree — but git history is permanent, and nothing stopped it from
// happening again. This is the gate: gitleaks over the commits THIS PUSH/PR
// adds, `<base ref>..HEAD` (`origin/main..HEAD` off a `main`-based branch),
// never the working tree. A secret one commit adds and a later commit in the
// same push removes is still caught, because the scan reads commits, not
// files.
//
// FAIL CLOSED, on purpose, in every branch: an absent gitleaks binary, an
// unresolvable base ref, an unreadable commit count, a gitleaks error that is
// not a finding, and — the round-1 review's P1 — a gitleaks run that reports
// nothing because it scanned nothing, all exit non-zero, locally and in CI.
// "A gate that cannot see must never pass."
//
// THE BASE-REF TRAP (verified empirically against gitleaks 8.30.1, not
// assumed): `gitleaks git --log-opts="<ref>..HEAD"` for a REF THAT DOES NOT
// EXIST prints an ERR line to stderr ("unknown revision or path not in the
// working tree") but still exits 0 with "0 commits scanned" — the exact same
// shape as a real, valid, empty range. So this script resolves the base ref
// itself with `git rev-parse --verify` BEFORE ever invoking gitleaks.
//
// THE EMPTY-REPORT TRAP (the same family, larger than the ref case —
// reproduced end-to-end in a scratch repo, 2026-09-21): make gitleaks' own
// `git log` write ANYTHING to stderr — an uninstalled `.gitattributes`
// textconv driver, a partial clone that cannot fetch a blob, a `warning:`
// from a damaged commit-graph — and gitleaks aborts the whole scan, prints
// `ERR error="stderr is not empty"` and `INF 0 commits scanned.`, writes `[]`
// to stdout and EXITS 0. A real private key sitting in the range shipped
// green. An empty report is therefore not evidence of a clean range; it is
// only evidence of an empty report. A PASS requires all four of:
//   1. gitleaks exit status 0;
//   2. stdout parses to `[]`;
//   3. gitleaks' OWN scanned-commit count (its `N commits scanned.` log line
//      — the only place the binary publishes it; there is no structured-log
//      or report field for it, confirmed against `gitleaks git --help`)
//      is AT LEAST the number of commits in the range that add a text line;
//   4. no git error marker (`ERR`/`FTL`/`fatal:`) on gitleaks' stderr.
// Anything else fails closed, naming the condition that failed.
//
// WHY A LOWER BOUND AND NOT AN EQUALITY, AND WHY NOT `git rev-list --count`
// (measured against gitleaks 8.30.1 with a `git` shim on PATH, 2026-09-21):
// gitleaks runs `git -C . log -p -U0 <log-opts>` and counts a commit when that
// commit yields at least one hunk on a file that SURVIVES the commit — added
// OR removed lines. It does not count empty commits, whole-file deletions,
// 100%-similarity renames, mode-only changes or binary-only changes, all of
// which `git rev-list --count` does count, so the raw range count is
// systematically too high and cannot be the comparand.
//
// The reverse error is just as real: a commit that only REMOVES lines from a
// surviving file — a revert, a "delete dead code" commit — is counted by
// gitleaks and is NOT counted by `countCommitsAddingText`, so an equality
// check fails an honest push. That shape is ordinary in an unsquashed
// `origin/main..HEAD`, which is exactly what this gate scans.
//
// So the two sides are deliberately asymmetric. `countCommitsAddingText` reads
// the SAME `--diff-merges` flag and counts commits with a `--numstat` row whose
// added column is a number greater than zero (binary `-` rows excluded); every
// measured case agrees that gitleaks counts AT LEAST those, and it may count
// more. The gate therefore fails only when gitleaks scanned FEWER commits than
// that minimum — proof the scan stopped short. Equal or greater passes.
//
// LIMITS — what a sufficient count does NOT prove: it says the scan did not
// stop short; it does not say every byte in the range was read. A file that
// `.gitattributes` marks `-diff` or `binary` yields no text hunk, so gitleaks
// never sees its content — and `--numstat` reports `-`/`-` for it too, so the
// minimum does not rise either. Measured: a complete PEM committed as a `*.pem`
// path with a `-diff` attribute PASSES this gate; the identical commit without
// the attribute fails it. Closing that would mean modelling git attributes
// here; instead it is a documented limit (runbook, "Known limit"), and a PR
// that adds `-diff`/`binary` attributes for a text file deserves a human look.
//
// MERGE COMMITS — `--diff-merges=remerge` (measured, not assumed): `git log
// -p` shows NO diff for a merge, so a secret pasted in while resolving a
// conflict was invisible to this gate. Of the variants tried against a
// scratch repo whose merge resolution introduced a fake private key present
// in neither parent — `-m` (finds it, but reports it TWICE, once per parent),
// `--cc` and `-c` (find nothing), `--first-parent -m` (finds it, but drops
// every side-branch commit from the scan) — only `--diff-merges=remerge`
// reports the evil-merge delta exactly once while still scanning all three
// commits. It needs git >= 2.35; an older git makes both the count read and
// gitleaks' log fail, which fails closed rather than silently skipping.
//
// WHY A JSON REPORT TO STDOUT, NOT LOG-TEXT MATCHING: `--report-format json
// --report-path -` writes gitleaks' redacted findings (or `[]`) to stdout,
// completely separate from its log lines on stderr. That gives a stable,
// parseable signal for "finding vs clean vs broke" instead of grepping "leaks
// found" out of a banner that could change wording across releases. A genuine
// gitleaks error (e.g. unreadable config) writes NOTHING to stdout and exits
// 1 — the same exit code a real finding uses — so parsing stdout is also how
// this script tells those two apart.
//
// VERSION PINNING IS CI-ONLY, BY DESIGN: `.github/workflows/ci.yml` downloads
// gitleaks CI_PINNED_GITLEAKS_VERSION and verifies its sha256 before running
// it. A developer machine runs whatever `brew install gitleaks` put there —
// there is no local pin. That is why the first line of output names the LOCAL
// version next to the CI pin: a drift is then visible in every hook and CI
// log instead of being discovered by a disagreement about a finding.
import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

import { baseRefFor } from './merge-ledger-audit';

/** `[extend] useDefault = true` plus the RepWorth allowlist. */
export const GITLEAKS_CONFIG_PATH = '.gitleaks.toml';

/**
 * The release `.github/workflows/ci.yml` pins by sha256. Printed beside the
 * local version so a Homebrew drift is visible; nothing here enforces it.
 */
export const CI_PINNED_GITLEAKS_VERSION = '8.30.1';

/**
 * Shows the conflict-resolution delta of a merge commit, exactly once, and
 * nothing else — see the header. Passed to BOTH gitleaks' `--log-opts` and
 * the `git log` the expected commit count is read from, so the two count the
 * same set of commits.
 */
export const DIFF_MERGES_FLAG = '--diff-merges=remerge';

/** `<base ref>..HEAD` — the commits this push/PR adds, never the working tree. */
export function rangeFor(baseRef: string): string {
  return `${baseRef}..HEAD`;
}

export const GITLEAKS_INSTALL_HELP =
  'gitleaks is not installed. Install it with `brew install gitleaks` (macOS/Linux via '
  + 'Homebrew), or download a release for your platform from '
  + 'https://github.com/gitleaks/gitleaks/releases (Linux, no Homebrew).';

/** One shelled-out call's result — the shape `spawnSync` already returns. */
export interface ExecResult {
  status: number | null;
  stdout: string;
  stderr: string;
}

/** The injected seam: every test drives `runSecretScan` through this alone. */
export type ExecFn = (command: string, args: readonly string[]) => ExecResult;

export interface SecretScanDeps {
  exec: ExecFn;
  env: Record<string, string | undefined>;
  log: (line: string) => void;
}

/** One producer of the terminal result; everything a reader needs is on `log`. */
export interface ScanOutcome {
  exitCode: number;
}

function ok(result: ExecResult): boolean {
  return result.status === 0;
}

/** One gitleaks finding, as it appears in the redacted JSON report. */
interface Finding {
  RuleID?: string;
  File?: string;
  Commit?: string;
}

/** `stdout` parsed as a gitleaks JSON report, or null when it is not one. */
function parseReport(stdout: string): Finding[] | null {
  const trimmed = stdout.trim();
  if (trimmed === '') return null;
  try {
    const parsed: unknown = JSON.parse(trimmed);
    return Array.isArray(parsed) ? (parsed as Finding[]) : null;
  } catch {
    return null;
  }
}

/** At most five findings, named without ever repeating the redacted secret text. */
function summarizeFindings(findings: readonly Finding[]): string {
  const shown = findings
    .slice(0, 5)
    .map((f) => `  - ${f.RuleID ?? 'unknown-rule'} in ${f.File ?? 'unknown file'} (commit ${f.Commit ?? 'unknown'})`);
  const more = findings.length > 5 ? `\n  ... and ${findings.length - 5} more` : '';
  return `${shown.join('\n')}${more}`;
}

/** Record separator for the per-commit `git log` read — never valid in a path. */
const COMMIT_RECORD_SEPARATOR = '\u001e';

/** `--no-color` is passed, but a stray ANSI sequence must never fool a matcher. */
const ANSI_PATTERN = /\u001b\[[0-9;]*m/g;

function stripAnsi(text: string): string {
  return text.replace(ANSI_PATTERN, '');
}

/**
 * The MINIMUM number of commits gitleaks must report as scanned: those adding
 * at least one text line under the same `--diff-merges` flag (a binary `-`
 * row is not a number, so it does not count). gitleaks always counts these and
 * may count more — see the header on why this is a lower bound, not an
 * equality. Called only after the `git log` that produced `gitLogStdout`
 * exited 0 — a git that could not answer is a failure upstream of here, never
 * a silent 0.
 */
export function countCommitsAddingText(gitLogStdout: string): number {
  return gitLogStdout
    .split(COMMIT_RECORD_SEPARATOR)
    .filter((record) => record.trim() !== '')
    .filter((record) =>
      record
        .split('\n')
        .slice(1)
        .some((row) => {
          const added = Number.parseInt(row.split('\t')[0] ?? '', 10);
          return Number.isFinite(added) && added > 0;
        }))
    .length;
}

/**
 * gitleaks' OWN count, off its `N commits scanned.` log line. `null` when the
 * line is absent or unparseable — which is itself a failure: the pass branch
 * has nothing to cross-check against.
 */
export function parseGitleaksScannedCommits(stderr: string): number | null {
  const match = /(\d+)\s+commits?\s+scanned/.exec(stripAnsi(stderr));
  if (!match) return null;
  const parsed = Number.parseInt(match[1] ?? '', 10);
  return Number.isFinite(parsed) ? parsed : null;
}

/**
 * The first line of gitleaks' stderr that reports a git-side error. gitleaks
 * aborts the scan on any non-empty git stderr and still exits 0, so this is
 * the marker that the scan never happened.
 */
export function findGitErrorLine(stderr: string): string | null {
  const lines = stripAnsi(stderr).split('\n');
  const hit = lines.find((line) => /(^|\s)(ERR|FTL)\s/.test(line) || /\bfatal:\s/.test(line));
  return hit ? hit.trim() : null;
}

/**
 * The behavior contract, with `exec` injected so every branch is a pure unit
 * test — no real gitleaks process, git repo, or network call.
 */
export function runSecretScan({ exec, env, log }: SecretScanDeps): ScanOutcome {
  const inCi = Boolean(env.CI);
  const baseRef = baseRefFor(env.GITHUB_BASE_REF);
  const range = rangeFor(baseRef);

  const binaryCheck = exec('gitleaks', ['version']);
  if (!ok(binaryCheck)) {
    log(GITLEAKS_INSTALL_HELP);
    return { exitCode: 1 };
  }
  const localVersion = binaryCheck.stdout.trim() || 'unknown';
  log(
    `secret-scan: gitleaks ${localVersion} (local install; CI pins `
    + `${CI_PINNED_GITLEAKS_VERSION} by sha256) — range ${range}${inCi ? ' (CI)' : ''}`,
  );

  // Resolved BEFORE gitleaks ever runs — see the header comment on why.
  const resolveResult = exec('git', ['rev-parse', '--verify', baseRef]);
  if (!ok(resolveResult)) {
    log(
      `secret-scan: ${baseRef} could not be resolved (run \`git fetch origin\`). `
      + 'A gate that cannot see the diff must never pass.',
    );
    return { exitCode: 1 };
  }

  const countResult = exec('git', [
    'log',
    `--format=${COMMIT_RECORD_SEPARATOR}%H`,
    '--numstat',
    DIFF_MERGES_FLAG,
    range,
  ]);
  if (!ok(countResult)) {
    log(
      `secret-scan: the commit count for ${range} could not be read `
      + `(git exited ${String(countResult.status)}) — failing closed, because a gate that `
      + 'cannot see must never pass.'
      + (countResult.stderr.trim() ? `\n${countResult.stderr.trim()}` : ''),
    );
    return { exitCode: 1 };
  }
  const minimumExpectedCommits = countCommitsAddingText(countResult.stdout);

  const scanResult = exec('gitleaks', [
    'git',
    `--log-opts=${DIFF_MERGES_FLAG} ${range}`,
    '--redact',
    '--no-color',
    '--config',
    GITLEAKS_CONFIG_PATH,
    '--report-format',
    'json',
    '--report-path',
    '-',
    '.',
  ]);

  const report = parseReport(scanResult.stdout);

  if (report === null) {
    // gitleaks exited with something other than a valid report — a real
    // error, not a finding. Fail closed and surface stderr.
    log([
      `secret-scan: gitleaks exited with an error (status ${String(scanResult.status)}) that is `
      + 'not a finding — failing closed, because a gate that cannot see must never pass.',
      scanResult.stderr.trim(),
    ].filter(Boolean).join('\n'));
    return { exitCode: 1 };
  }

  if (report.length > 0) {
    log([
      `secret-scan: FAILED — gitleaks found ${report.length} potential secret(s) in ${range}:`,
      summarizeFindings(report),
      '',
      'Rotate the value FIRST, then remove it — never just delete the line. '
      + 'See docs/runbooks/secrets-rotation-api-keys.md.',
    ].join('\n'));
    return { exitCode: 1 };
  }

  // An EMPTY report. On its own that proves nothing — see the header. Three
  // more conditions have to hold before it may be read as "clean".
  if (scanResult.status !== 0) {
    log(
      `secret-scan: FAILED — gitleaks returned an empty report but exited `
      + `${String(scanResult.status)}; an empty report from a non-zero exit is not a clean range.`,
    );
    return { exitCode: 1 };
  }

  const gitErrorLine = findGitErrorLine(scanResult.stderr);
  if (gitErrorLine !== null) {
    log(
      'secret-scan: FAILED — gitleaks reported a git error, so its scan aborted and the empty '
      + `report means nothing:\n  ${gitErrorLine}`,
    );
    return { exitCode: 1 };
  }

  const scannedCommits = parseGitleaksScannedCommits(scanResult.stderr);
  if (scannedCommits === null) {
    log(
      'secret-scan: FAILED — gitleaks did not report a scanned-commit count, so its empty '
      + `report cannot be cross-checked against the ${minimumExpectedCommits} commit(s) in `
      + `${range} that add text.`,
    );
    return { exitCode: 1 };
  }

  // A LOWER BOUND: gitleaks counts every text-adding commit and may also count
  // line-deletion-only ones, so only a SHORTFALL proves the scan stopped short.
  if (scannedCommits < minimumExpectedCommits) {
    log(
      `secret-scan: FAILED — gitleaks scanned ${scannedCommits} commit(s), fewer than the `
      + `${minimumExpectedCommits} commit(s) in ${range} that add text. The scan did not cover `
      + 'the range, so its empty report is not a pass.',
    );
    return { exitCode: 1 };
  }

  log(`secret-scan: passed (${scannedCommits} commit(s) scanned in ${range})`);
  return { exitCode: 0 };
}

function realExec(command: string, args: readonly string[]): ExecResult {
  // 64 MB: a `git log --numstat` over a long range and a gitleaks JSON report
  // both outgrow Node's 1 MB default, and an overflow would surface as a
  // spurious fail-closed rather than a real signal.
  const result = spawnSync(command, args, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  return {
    status: result.status,
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? '',
  };
}

function main(): void {
  const outcome = runSecretScan({
    exec: realExec,
    env: process.env,
    log: (line) => {
      if (line) console.log(line);
    },
  });
  process.exit(outcome.exitCode);
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  main();
}
