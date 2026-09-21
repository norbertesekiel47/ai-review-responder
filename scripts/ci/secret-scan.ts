// scripts/ci/secret-scan.ts
//
// Issue #1374. `keys.md` landed at the repo root in commit 24353cf1 ("Sprint
// 1: scaffolding", 2026-04-06) with a full credential set, then was deleted
// from the tree — but git history is permanent, and nothing stopped it from
// happening again. This is the gate: gitleaks over the commits THIS PUSH/PR
// adds, `origin/main..HEAD`, never the working tree. A secret one commit adds
// and a later commit in the same push removes is still caught, because the
// scan reads commits, not files.
//
// FAIL CLOSED, on purpose, in every branch: an absent gitleaks binary, an
// unresolvable `origin/main`, and a gitleaks error that is not a finding all
// exit non-zero, locally and in CI. "A gate that cannot see must never pass."
//
// THE ORIGIN/MAIN TRAP (verified empirically against gitleaks 8.30.1, not
// assumed): `gitleaks git --log-opts="<ref>..HEAD"` for a REF THAT DOES NOT
// EXIST prints an ERR line to stderr ("unknown revision or path not in the
// working tree") but still exits 0 with "0 commits scanned" — the exact same
// shape as a real, valid, empty range. gitleaks cannot tell those two cases
// apart, so this script resolves `origin/main` itself with
// `git rev-parse --verify` BEFORE ever invoking gitleaks, and fails if that
// resolution fails. Only once origin/main is confirmed to exist does "0
// commits scanned" mean what it says.
//
// WHY A JSON REPORT TO STDOUT, NOT LOG-TEXT MATCHING: `--report-format json
// --report-path -` writes gitleaks' redacted findings (or `[]`) to stdout,
// completely separate from its unstructured, ANSI-colored log lines on
// stderr. That gives a stable, parseable signal for "finding vs clean vs
// broke" instead of grepping "leaks found" out of a banner that could change
// wording across gitleaks releases. Verified: a genuine gitleaks error (e.g.
// unreadable config) writes NOTHING to stdout and exits 1 — the same exit
// code a real finding uses — so parsing stdout is also how this script tells
// the two apart, which log-line-count alone cannot do.
import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

/** The commit range every invocation scans — never the working tree. */
export const RANGE = 'origin/main..HEAD';

/** `[extend] useDefault = true` plus the RepWorth allowlist. */
export const GITLEAKS_CONFIG_PATH = '.gitleaks.toml';

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

export interface ScanOutcome {
  exitCode: number;
  message: string;
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

/**
 * The behavior contract, with `exec` injected so every branch is a pure unit
 * test — no real gitleaks process, git repo, or network call.
 */
export function runSecretScan({ exec, env, log }: SecretScanDeps): ScanOutcome {
  const inCi = Boolean(env.CI);
  log(`secret-scan: starting${inCi ? ' (CI)' : ''} — range ${RANGE}`);

  const binaryCheck = exec('gitleaks', ['version']);
  if (!ok(binaryCheck)) {
    log(GITLEAKS_INSTALL_HELP);
    return { exitCode: 1, message: GITLEAKS_INSTALL_HELP };
  }

  // Resolved BEFORE gitleaks ever runs — see the header comment on why.
  const resolveResult = exec('git', ['rev-parse', '--verify', 'origin/main']);
  if (!ok(resolveResult)) {
    const message =
      'secret-scan: origin/main could not be resolved (run `git fetch origin`). '
      + 'A gate that cannot see the diff must never pass.';
    log(message);
    return { exitCode: 1, message };
  }

  const countResult = exec('git', ['rev-list', '--count', RANGE]);
  const scannedCommits = ok(countResult) ? Number.parseInt(countResult.stdout.trim(), 10) : 0;
  const commitCount = Number.isFinite(scannedCommits) ? scannedCommits : 0;

  const scanResult = exec('gitleaks', [
    'git',
    `--log-opts=${RANGE}`,
    '--redact',
    '--config',
    GITLEAKS_CONFIG_PATH,
    '--report-format',
    'json',
    '--report-path',
    '-',
    '.',
  ]);

  const report = parseReport(scanResult.stdout);

  if (report !== null && report.length === 0) {
    const message = `secret-scan: passed (${commitCount} commit(s) scanned in ${RANGE})`;
    log(message);
    return { exitCode: 0, message };
  }

  if (report !== null && report.length > 0) {
    const message = [
      `secret-scan: FAILED — gitleaks found ${report.length} potential secret(s) in ${RANGE}:`,
      summarizeFindings(report),
      '',
      'Rotate the value FIRST, then remove it — never just delete the line. '
      + 'See docs/runbooks/secrets-rotation-api-keys.md.',
    ].join('\n');
    log(message);
    return { exitCode: 1, message };
  }

  // report === null: gitleaks exited with something other than a valid
  // report — a real error, not a finding. Fail closed and surface stderr.
  const message = [
    `secret-scan: gitleaks exited with an error (status ${String(scanResult.status)}) that is `
    + 'not a finding — failing closed, because a gate that cannot see must never pass.',
    scanResult.stderr.trim(),
  ].filter(Boolean).join('\n');
  log(message);
  return { exitCode: 1, message };
}

function realExec(command: string, args: readonly string[]): ExecResult {
  const result = spawnSync(command, args, { encoding: 'utf8' });
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
