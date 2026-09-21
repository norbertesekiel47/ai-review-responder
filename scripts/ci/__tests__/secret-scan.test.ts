import { describe, expect, it } from 'vitest';
import {
  CI_PINNED_GITLEAKS_VERSION,
  DIFF_MERGES_FLAG,
  GITLEAKS_CONFIG_PATH,
  GITLEAKS_INSTALL_HELP,
  rangeFor,
  runSecretScan,
  type ExecFn,
  type ExecResult,
} from '../secret-scan';

// #1374. gitleaks scans the commits in <base ref>..HEAD — not the working
// tree, not the file tree — so a secret one commit adds and a later commit in
// the same push removes is still caught. `exec` is injected so every branch a
// real invocation could take (binary absent, ref unresolvable, an unreadable
// commit count, a finding, a non-finding error, a report that is empty because
// the scan never ran, an empty range) is a pure unit test with no real gitleaks
// process, git repo, or network call. Same idiom as merge-ledger-audit: the
// decision logic is fully tested, `main()` is left as the thin shell that
// wires the real `spawnSync`.
//
// The fake's DEFAULTS are the shape the real binary prints on a healthy clean
// scan — including the `N commits scanned.` line — deliberately: the round-1
// review found that a "clean" default of `status: 0, stdout: '[]'` alone is
// byte-identical to the shape a BROKEN scan produces, so the suite was
// encoding the failure as its definition of success.

/** One realistic `git log --numstat` record: a commit with one added line. */
function gitLogRecord(sha: string): string {
  return `\u001e${sha}\n\n1\t0\tsrc/file.ts\n`;
}

function gitLogFor(commitCount: number): string {
  return Array.from({ length: commitCount }, (_, i) => gitLogRecord(`sha${i}`)).join('');
}

/** gitleaks' own stderr on a healthy clean scan, minus the ASCII banner. */
function cleanGitleaksStderr(commitCount: number): string {
  return [
    `9:41AM INF ${commitCount} commits scanned.`,
    '9:41AM INF scanned ~875 bytes (875 bytes) in 30.8ms',
    '9:41AM INF no leaks found',
    '',
  ].join('\n');
}

/** One recorded call, keyed loosely enough to stay useful past small arg tweaks. */
type CallKey = 'gitleaks-version' | 'git-resolve' | 'git-count' | 'gitleaks-scan' | 'unknown';

function keyFor(command: string, args: readonly string[]): CallKey {
  if (command === 'gitleaks' && args[0] === 'version') return 'gitleaks-version';
  if (command === 'git' && args[0] === 'rev-parse') return 'git-resolve';
  if (command === 'git' && args[0] === 'log') return 'git-count';
  if (command === 'gitleaks' && args[0] === 'git') return 'gitleaks-scan';
  return 'unknown';
}

/**
 * A fake exec keyed by call purpose rather than call order, so each test only
 * states the ONE response it cares about and every other call takes a
 * realistic default (binary present, the base ref resolves to a fixed SHA, a
 * three-commit range, a clean gitleaks pass over those same three commits).
 */
function fakeExec(
  overrides: Partial<Record<CallKey, ExecResult>>,
  calls: { command: string; args: string[] }[] = [],
): ExecFn {
  const defaults: Record<CallKey, ExecResult> = {
    'gitleaks-version': { status: 0, stdout: `${CI_PINNED_GITLEAKS_VERSION}\n`, stderr: '' },
    'git-resolve': { status: 0, stdout: 'deadbeefcafe0123456789abcdef0123456789\n', stderr: '' },
    'git-count': { status: 0, stdout: gitLogFor(3), stderr: '' },
    'gitleaks-scan': { status: 0, stdout: '[]', stderr: cleanGitleaksStderr(3) },
    unknown: { status: 1, stdout: '', stderr: 'unexpected call' },
  };
  return (command, args) => {
    calls.push({ command, args: [...args] });
    const key = keyFor(command, args);
    return overrides[key] ?? defaults[key];
  };
}

/** Collects the injected log — the single place a reader learns what happened. */
function recordingLog(): { lines: string[]; log: (line: string) => void; text: () => string } {
  const lines: string[] = [];
  return { lines, log: (line) => lines.push(line), text: () => lines.join('\n') };
}

describe('runSecretScan', () => {
  it('fails with the install command when the gitleaks binary is absent', () => {
    const exec = fakeExec({ 'gitleaks-version': { status: 1, stdout: '', stderr: 'not found' } });
    const out = recordingLog();
    const result = runSecretScan({ exec, env: {}, log: out.log });
    expect(result.exitCode).not.toBe(0);
    expect(out.text()).toContain(GITLEAKS_INSTALL_HELP);
    expect(out.text()).toContain('brew install gitleaks');
    expect(out.text()).toContain('https://github.com/gitleaks/gitleaks/releases');
  });

  it('prints the local gitleaks version and the CI pin on its first line', () => {
    const exec = fakeExec({
      'gitleaks-version': { status: 0, stdout: '8.99.0\n', stderr: '' },
    });
    const out = recordingLog();
    runSecretScan({ exec, env: {}, log: out.log });
    // The local install is whatever Homebrew put there; only CI is pinned, so
    // a drift has to be visible in the hook and CI output itself.
    expect(out.lines[0]).toContain('8.99.0');
    expect(out.lines[0]).toContain(CI_PINNED_GITLEAKS_VERSION);
  });

  it('fails when origin/main cannot be resolved', () => {
    const exec = fakeExec({
      'git-resolve': { status: 1, stdout: '', stderr: 'fatal: ambiguous argument' },
    });
    const out = recordingLog();
    const result = runSecretScan({ exec, env: {}, log: out.log });
    expect(result.exitCode).not.toBe(0);
    expect(out.text()).toContain('origin/main could not be resolved');
    expect(out.text()).not.toMatch(/passed \(/);
  });

  it('scans the commit range origin/main..HEAD with redaction on', () => {
    const calls: { command: string; args: string[] }[] = [];
    const exec = fakeExec({}, calls);
    runSecretScan({ exec, env: {}, log: () => {} });

    expect(rangeFor('origin/main')).toBe('origin/main..HEAD');
    const scanCall = calls.find((c) => c.command === 'gitleaks' && c.args[0] === 'git');
    expect(scanCall).toBeDefined();
    expect(scanCall!.args).toContain('--redact');
    expect(scanCall!.args).toContain(`--log-opts=${DIFF_MERGES_FLAG} origin/main..HEAD`);
    // The flags have to stay PAIRED, not merely present — a reordering that
    // detached `--config` from its value would still pass a `toContain`.
    const args = scanCall!.args;
    expect(args[args.indexOf('--config') + 1]).toBe(GITLEAKS_CONFIG_PATH);
    expect(args[args.indexOf('--report-format') + 1]).toBe('json');
    expect(args[args.indexOf('--report-path') + 1]).toBe('-');
  });

  it('scans a non-main base ref when GITHUB_BASE_REF names one', () => {
    const calls: { command: string; args: string[] }[] = [];
    const exec = fakeExec({}, calls);
    runSecretScan({ exec, env: { GITHUB_BASE_REF: 'staging' }, log: () => {} });

    const resolveCall = calls.find((c) => c.command === 'git' && c.args[0] === 'rev-parse');
    expect(resolveCall!.args).toContain('origin/staging');
    const scanCall = calls.find((c) => c.command === 'gitleaks' && c.args[0] === 'git');
    expect(scanCall!.args).toContain(`--log-opts=${DIFF_MERGES_FLAG} origin/staging..HEAD`);
    const countCall = calls.find((c) => c.command === 'git' && c.args[0] === 'log');
    expect(countCall!.args).toContain('origin/staging..HEAD');
  });

  it('passes the merge-diff flag so a secret added in a merge resolution is scanned', () => {
    const calls: { command: string; args: string[] }[] = [];
    const exec = fakeExec({}, calls);
    runSecretScan({ exec, env: {}, log: () => {} });

    // `git log -p` shows no diff for a merge commit, so without this flag a
    // credential pasted in while resolving a conflict is never read.
    const scanCall = calls.find((c) => c.command === 'gitleaks' && c.args[0] === 'git');
    expect(scanCall!.args.some((a) => a.includes(DIFF_MERGES_FLAG))).toBe(true);
    // The expected count must be read over the SAME flag, or the two sides of
    // the cross-check would be counting different commits.
    const countCall = calls.find((c) => c.command === 'git' && c.args[0] === 'log');
    expect(countCall!.args).toContain(DIFF_MERGES_FLAG);
  });

  it('exits non-zero when gitleaks reports a finding', () => {
    const finding = JSON.stringify([
      { RuleID: 'jwt', File: 'secret.txt', Commit: 'abc123', Secret: 'REDACTED' },
    ]);
    const exec = fakeExec({
      'gitleaks-scan': { status: 1, stdout: finding, stderr: '9:41AM WRN leaks found: 1\n' },
    });
    const out = recordingLog();
    const result = runSecretScan({ exec, env: {}, log: out.log });
    expect(result.exitCode).not.toBe(0);
    expect(out.text()).toContain('jwt');
    // The finding is already redacted by gitleaks; the script must never
    // invent a value of its own to print alongside it.
    expect(out.text()).not.toMatch(/REDACTED[^"\s]/);
  });

  it('fails closed when gitleaks exits with an error that is not a finding', () => {
    const exec = fakeExec({
      'gitleaks-scan': { status: 1, stdout: '', stderr: 'FTL unable to load gitleaks config' },
    });
    const out = recordingLog();
    const result = runSecretScan({ exec, env: {}, log: out.log });
    expect(result.exitCode).not.toBe(0);
    expect(out.text()).toContain('gitleaks exited');
    expect(out.text()).not.toContain('leaks found');
  });

  it('fails closed when gitleaks exits 0 with an empty report but scanned fewer commits than the range holds', () => {
    // The reproduced P1: anything that makes gitleaks' own `git log` write to
    // stderr aborts the scan, and gitleaks still exits 0 with `[]`.
    const exec = fakeExec({
      'git-count': { status: 0, stdout: gitLogFor(3), stderr: '' },
      'gitleaks-scan': { status: 0, stdout: '[]', stderr: cleanGitleaksStderr(0) },
    });
    const out = recordingLog();
    const result = runSecretScan({ exec, env: {}, log: out.log });
    expect(result.exitCode).not.toBe(0);
    expect(out.text()).toContain('scanned 0 commit(s)');
    expect(out.text()).toContain('fewer than the 3 commit(s)');
    expect(out.text()).toContain('that add text');
    expect(out.text()).not.toMatch(/passed \(/);
  });

  it('fails closed when an empty report comes back with a non-zero exit status', () => {
    const exec = fakeExec({
      'gitleaks-scan': { status: 2, stdout: '[]', stderr: cleanGitleaksStderr(3) },
    });
    const out = recordingLog();
    const result = runSecretScan({ exec, env: {}, log: out.log });
    expect(result.exitCode).not.toBe(0);
    expect(out.text()).toContain('exited 2');
  });

  it('fails closed when the commit count cannot be read', () => {
    const exec = fakeExec({
      'git-count': { status: 128, stdout: '', stderr: 'fatal: bad revision' },
    });
    const out = recordingLog();
    const result = runSecretScan({ exec, env: {}, log: out.log });
    expect(result.exitCode).not.toBe(0);
    expect(out.text()).toContain('commit count');
    // Never a silent 0: the old code printed `passed (0 commit(s) scanned)`.
    expect(out.text()).not.toMatch(/passed \(/);
  });

  it('fails closed when gitleaks reports a git error on stderr', () => {
    const exec = fakeExec({
      'gitleaks-scan': {
        status: 0,
        stdout: '[]',
        stderr: [
          '9:41AM ERR [git] fatal: unable to read files to diff',
          '9:41AM ERR error="stderr is not empty"',
          '9:41AM INF 3 commits scanned.',
          '',
        ].join('\n'),
      },
    });
    const out = recordingLog();
    const result = runSecretScan({ exec, env: {}, log: out.log });
    // Even with a matching count, a git error means the scan aborted.
    expect(result.exitCode).not.toBe(0);
    expect(out.text()).toContain('git error');
    expect(out.text()).not.toMatch(/passed \(/);
  });

  it('fails closed when gitleaks reports no scanned-commit count at all', () => {
    const exec = fakeExec({
      'gitleaks-scan': { status: 0, stdout: '[]', stderr: '9:41AM INF no leaks found\n' },
    });
    const out = recordingLog();
    const result = runSecretScan({ exec, env: {}, log: out.log });
    expect(result.exitCode).not.toBe(0);
    expect(out.text()).toContain('did not report a scanned-commit count');
  });

  it('reports the scanned commit count when the range is empty', () => {
    const exec = fakeExec({
      'git-count': { status: 0, stdout: '', stderr: '' },
      'gitleaks-scan': { status: 0, stdout: '[]', stderr: cleanGitleaksStderr(0) },
    });
    const out = recordingLog();
    const result = runSecretScan({ exec, env: {}, log: out.log });
    expect(result.exitCode).toBe(0);
    expect(out.text()).toMatch(/passed \(0 commit/);
  });

  it('passes with a non-empty range and reports gitleaks own count', () => {
    const exec = fakeExec({
      'git-count': { status: 0, stdout: gitLogFor(3), stderr: '' },
      'gitleaks-scan': { status: 0, stdout: '[]', stderr: cleanGitleaksStderr(3) },
    });
    const out = recordingLog();
    const result = runSecretScan({ exec, env: {}, log: out.log });
    expect(result.exitCode).toBe(0);
    expect(out.text()).toMatch(/passed \(3 commit/);
  });

  it('derives the minimum from text-adding commits only (empty, rename and binary rows excluded)', () => {
    // `git rev-list --count` over the same range would say 4 and fail an
    // honest push: gitleaks does not count empty commits, 100%-similarity
    // renames or binary-only changes, so only the added-line rows set the bar.
    const gitLog = [
      '\u001esha-added\n\n2\t0\tsrc/a.ts\n',
      '\u001esha-empty\n\n',
      '\u001esha-renamed\n\n0\t0\tsrc/c.ts => src/d.ts\n',
      '\u001esha-binary\n\n-\t-\tassets/logo.png\n',
    ].join('');
    const exec = fakeExec({
      'git-count': { status: 0, stdout: gitLog, stderr: '' },
      'gitleaks-scan': { status: 0, stdout: '[]', stderr: cleanGitleaksStderr(1) },
    });
    const out = recordingLog();
    const result = runSecretScan({ exec, env: {}, log: out.log });
    expect(result.exitCode).toBe(0);
    expect(out.text()).toMatch(/passed \(1 commit/);
  });

  it('passes when a line-deletion-only commit makes gitleaks count more than the minimum', () => {
    // Measured: gitleaks counts a commit when it yields any hunk on a file
    // that SURVIVES the commit — removed lines included — while the minimum
    // counts added lines only. `src/b.ts` still exists, so gitleaks counts
    // this commit, and the script must not read that surplus as a shortfall.
    const exec = fakeExec({
      'git-count': { status: 0, stdout: '\u001esha-deleted-lines\n\n0\t7\tsrc/b.ts\n', stderr: '' },
      'gitleaks-scan': { status: 0, stdout: '[]', stderr: cleanGitleaksStderr(1) },
    });
    const out = recordingLog();
    const result = runSecretScan({ exec, env: {}, log: out.log });
    expect(result.exitCode).toBe(0);
    expect(out.text()).toMatch(/passed \(1 commit/);
  });

  it('passes on a revert, where gitleaks counts both the add and the undo', () => {
    // Add one line, then revert it: minimum 1 (only the add has added lines),
    // gitleaks 2 (the revert's removal is a hunk on a surviving file).
    const gitLog = [
      '\u001esha-add\n\n1\t0\tsrc/a.ts\n',
      '\u001esha-revert\n\n0\t1\tsrc/a.ts\n',
    ].join('');
    const exec = fakeExec({
      'git-count': { status: 0, stdout: gitLog, stderr: '' },
      'gitleaks-scan': { status: 0, stdout: '[]', stderr: cleanGitleaksStderr(2) },
    });
    const out = recordingLog();
    const result = runSecretScan({ exec, env: {}, log: out.log });
    expect(result.exitCode).toBe(0);
    expect(out.text()).toMatch(/passed \(2 commit/);
  });
});
