import { describe, expect, it } from 'vitest';
import {
  GITLEAKS_CONFIG_PATH,
  GITLEAKS_INSTALL_HELP,
  RANGE,
  runSecretScan,
  type ExecFn,
  type ExecResult,
} from '../secret-scan';

// #1374. gitleaks scans the commits in origin/main..HEAD — not the working
// tree, not the file tree — so a secret one commit adds and a later commit in
// the same push removes is still caught. `exec` is injected so every branch a
// real invocation could take (binary absent, ref unresolvable, a finding, a
// non-finding error, an empty range) is a pure unit test with no real gitleaks
// process, git repo, or network call. Same idiom as merge-ledger-audit: the
// decision logic is fully tested, `main()` is left as the thin shell that
// wires the real `spawnSync`.

const OK: ExecResult = { status: 0, stdout: '', stderr: '' };

/** One recorded call, keyed loosely enough to stay useful past small arg tweaks. */
type CallKey = 'gitleaks-version' | 'git-resolve' | 'git-count' | 'gitleaks-scan' | 'unknown';

function keyFor(command: string, args: readonly string[]): CallKey {
  if (command === 'gitleaks' && args[0] === 'version') return 'gitleaks-version';
  if (command === 'git' && args[0] === 'rev-parse') return 'git-resolve';
  if (command === 'git' && args[0] === 'rev-list') return 'git-count';
  if (command === 'gitleaks' && args[0] === 'git') return 'gitleaks-scan';
  return 'unknown';
}

/**
 * A fake exec keyed by call purpose rather than call order, so each test only
 * states the ONE response it cares about and every other call takes a
 * realistic default (binary present, origin/main resolves to a fixed SHA, an
 * empty range, a clean gitleaks pass).
 */
function fakeExec(
  overrides: Partial<Record<CallKey, ExecResult>>,
  calls: { command: string; args: string[] }[] = [],
): ExecFn {
  const defaults: Record<CallKey, ExecResult> = {
    'gitleaks-version': OK,
    'git-resolve': { status: 0, stdout: 'deadbeefcafe0123456789abcdef0123456789\n', stderr: '' },
    'git-count': { status: 0, stdout: '0\n', stderr: '' },
    'gitleaks-scan': { status: 0, stdout: '[]', stderr: 'no leaks found\n' },
    unknown: { status: 1, stdout: '', stderr: 'unexpected call' },
  };
  return (command, args) => {
    calls.push({ command, args: [...args] });
    const key = keyFor(command, args);
    return overrides[key] ?? defaults[key];
  };
}

const noopLog = (): void => {};

describe('runSecretScan', () => {
  it('fails with the install command when the gitleaks binary is absent', () => {
    const exec = fakeExec({ 'gitleaks-version': { status: 1, stdout: '', stderr: 'not found' } });
    const result = runSecretScan({ exec, env: {}, log: noopLog });
    expect(result.exitCode).not.toBe(0);
    expect(result.message).toContain(GITLEAKS_INSTALL_HELP);
    expect(result.message).toContain('brew install gitleaks');
    expect(result.message).toContain('https://github.com/gitleaks/gitleaks/releases');
  });

  it('fails when origin/main cannot be resolved', () => {
    const exec = fakeExec({
      'git-resolve': { status: 1, stdout: '', stderr: 'fatal: ambiguous argument' },
    });
    const result = runSecretScan({ exec, env: {}, log: noopLog });
    expect(result.exitCode).not.toBe(0);
    expect(result.message).toContain('origin/main');
    expect(result.message).not.toMatch(/0 commit/);
  });

  it('scans the commit range origin/main..HEAD with redaction on', () => {
    const calls: { command: string; args: string[] }[] = [];
    const exec = fakeExec({}, calls);
    runSecretScan({ exec, env: {}, log: noopLog });

    expect(RANGE).toBe('origin/main..HEAD');
    const scanCall = calls.find((c) => c.command === 'gitleaks' && c.args[0] === 'git');
    expect(scanCall).toBeDefined();
    expect(scanCall!.args).toContain('--redact');
    expect(scanCall!.args).toContain(`--log-opts=${RANGE}`);
    expect(scanCall!.args).toContain(GITLEAKS_CONFIG_PATH);
  });

  it('exits non-zero when gitleaks reports a finding', () => {
    const finding = JSON.stringify([
      { RuleID: 'jwt', File: 'secret.txt', Commit: 'abc123', Secret: 'REDACTED' },
    ]);
    const exec = fakeExec({
      'gitleaks-scan': { status: 1, stdout: finding, stderr: 'leaks found: 1\n' },
    });
    const result = runSecretScan({ exec, env: {}, log: noopLog });
    expect(result.exitCode).not.toBe(0);
    expect(result.message).toContain('jwt');
    // The finding is already redacted by gitleaks; the script must never
    // invent a value of its own to print alongside it.
    expect(result.message).not.toMatch(/REDACTED[^"\s]/);
  });

  it('fails closed when gitleaks exits with an error that is not a finding', () => {
    const exec = fakeExec({
      'gitleaks-scan': { status: 1, stdout: '', stderr: 'FTL unable to load gitleaks config' },
    });
    const result = runSecretScan({ exec, env: {}, log: noopLog });
    expect(result.exitCode).not.toBe(0);
    expect(result.message).toContain('gitleaks exited');
    expect(result.message).not.toContain('leaks found');
  });

  it('reports the scanned commit count when the range is empty', () => {
    const exec = fakeExec({ 'git-count': { status: 0, stdout: '0\n', stderr: '' } });
    const result = runSecretScan({ exec, env: {}, log: noopLog });
    expect(result.exitCode).toBe(0);
    expect(result.message).toMatch(/0 commit/);
  });

  it('passes with a non-empty range and reports the count', () => {
    const exec = fakeExec({ 'git-count': { status: 0, stdout: '3\n', stderr: '' } });
    const result = runSecretScan({ exec, env: {}, log: noopLog });
    expect(result.exitCode).toBe(0);
    expect(result.message).toMatch(/3 commit/);
  });
});
