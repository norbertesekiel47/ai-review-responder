import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

// Here rather than beside the script: vitest's include roots are scripts/ci/**,
// src/**, worker/**, tests/** and e2e/**, so a suite under .agents/ would never
// run. Same reason as edit-surface-guard.test.ts.
//
// WHAT THIS PINS. Three mechanics of a red-team mutation pass are unverifiable
// as prose, and each was a review finding before it was code:
//
//   * the JOURNAL is written before the mutation lands, so a dead subagent
//     cannot strand a mutation in the worktree;
//   * the FINALIZER restores only content it recorded and ABORTS on anything
//     else, so a concurrent edit is never overwritten;
//   * the paused SUPERVISOR gives every run a process group whose identity is
//     durable before anything executes — with two crash windows the plan names
//     explicitly: death BEFORE the release byte, and descendants ORPHANED after
//     the group leader exits.

const RUNNER = resolve(process.cwd(), '.agents/skills/red-team/scripts/mutation-runner.mjs');

const GIT_FREE_ENV = Object.fromEntries(
  Object.entries(process.env).filter(([key]) => !key.startsWith('GIT_')),
) as NodeJS.ProcessEnv;

let repo: string;

function git(...args: string[]): string {
  const result = spawnSync('git', args, { cwd: repo, encoding: 'utf8', env: GIT_FREE_ENV });
  if (result.status !== 0) throw new Error(`git ${args.join(' ')} failed: ${result.stderr}`);
  return result.stdout.trim();
}

function write(relativePath: string, contents: string): void {
  const absolute = join(repo, relativePath);
  mkdirSync(dirname(absolute), { recursive: true });
  writeFileSync(absolute, contents);
}

function read(relativePath: string): string {
  return readFileSync(join(repo, relativePath), 'utf8');
}

interface RunResult { status: number; stdout: string; stderr: string }

function run(...args: string[]): RunResult {
  const result = spawnSync('node', [RUNNER, ...args], {
    cwd: repo,
    encoding: 'utf8',
    env: { ...GIT_FREE_ENV, SUPER_SECRET_TOKEN: 'do-not-leak' },
  });
  return { status: result.status ?? -1, stdout: result.stdout, stderr: result.stderr };
}

interface Journal {
  runs: number;
  mutations: { path: string; originalOid: string; mutantOid: string | null; state: string }[];
  dotenv: { open: boolean; files: { path: string; backupPath: string; scrubbedSha256: string }[] };
  supervisors: { pid: number; pgid: number; startedAt: string | null; active: boolean }[];
}

function journal(): Journal {
  return JSON.parse(read('.feature/red-team-journal.json')) as Journal;
}

function writeJournal(value: Journal): void {
  write('.feature/red-team-journal.json', JSON.stringify(value, null, 2));
}

// Zombies excluded, exactly as the runner does: a process awaiting its parent's
// wait() can no longer execute a mutation.
function groupIsEmpty(pgid: number): boolean {
  const output = spawnSync('ps', ['-Ao', 'pid=,pgid=,stat='], { encoding: 'utf8' }).stdout ?? '';
  return !output
    .split('\n')
    .map((line) => line.trim().split(/\s+/))
    .filter((parts) => parts.length >= 3 && !parts[2]!.startsWith('Z'))
    .some((parts) => Number(parts[1]) === pgid);
}

async function waitFor(predicate: () => boolean, timeoutMs = 5_000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return true;
    await new Promise((r) => { setTimeout(r, 50); });
  }
  return predicate();
}

/**
 * A real, live process group recorded in the journal.
 *
 * The reap path has to be exercised against a process that actually exists —
 * an invented PID would test nothing. `detached: true` makes the child its own
 * group leader, so pid === pgid exactly as the supervisor's does.
 */
function adoptLiveGroup(overrides: { startedAt?: string }): { pid: number; pgid: number } {
  const child = spawn('/bin/sleep', ['45'], { detached: true, stdio: 'ignore' });
  child.unref();
  const pid = child.pid as number;
  const startedAt = overrides.startedAt
    ?? (spawnSync('ps', ['-o', 'lstart=', '-p', String(pid)], { encoding: 'utf8' }).stdout ?? '').trim();
  const existing = existsSync(join(repo, '.feature/red-team-journal.json'))
    ? journal()
    : { runs: 0, mutations: [], dotenv: { open: false, files: [] }, supervisors: [] } as Journal;
  existing.supervisors.push({ pid, pgid: pid, startedAt, active: true });
  writeJournal(existing);
  return { pid, pgid: pid };
}

const HOME_FLAG = () => ['--tmp-home', join(repo, 'red-team-home')];

beforeEach(() => {
  repo = spawnSync('python3', [
    '-c', 'import os,sys;print(os.path.realpath(sys.argv[1]))',
    mkdtempSync(join(tmpdir(), 'red-team-runner-')),
  ], { encoding: 'utf8' }).stdout.trim();
  git('init', '-q', '-b', 'fixture');
  git('config', 'user.email', 'red-team@example.test');
  git('config', 'user.name', 'red team');
  write('src/gate.ts', 'export const allow = (n: number) => n > 0;\n');
  git('add', 'src/gate.ts');
  git('commit', '-qm', 'base');
});

afterEach(() => {
  // Never leave a fixture process behind, whatever the assertions did.
  if (existsSync(join(repo, '.feature/red-team-journal.json'))) {
    for (const supervisor of journal().supervisors) {
      try { process.kill(-supervisor.pgid, 'SIGKILL'); } catch { /* already gone */ }
    }
  }
  rmSync(repo, { recursive: true, force: true });
});

describe('the vitest oracle helpers', () => {
  // `-t` is a REGULAR EXPRESSION filter. An unescaped title selects the wrong
  // set of tests, and a kill counted from that run proves nothing.
  it('escapes every regex metacharacter in a test title', () => {
    const result = run('escape-test-name', '--', 'settles (once) [P0] a+b');
    expect(result.status).toBe(0);
    expect(result.stdout.trim()).toBe('settles \\(once\\) \\[P0\\] a\\+b');
  });

  it('accepts exactly one executed test', () => {
    write('report.json', JSON.stringify({
      testResults: [{ assertionResults: [
        { fullName: 'a b', status: 'failed' },
        { fullName: 'a c', status: 'skipped' },
      ] }],
    }));
    const result = run('assert-one-test', '--report', join(repo, 'report.json'));
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('exactly one test executed');
  });

  it.each([
    ['zero', [{ fullName: 'a', status: 'skipped' }]],
    ['two', [{ fullName: 'a', status: 'passed' }, { fullName: 'b', status: 'failed' }]],
  ])('calls %s executed tests INCONCLUSIVE, never a kill', (_label, assertionResults) => {
    write('report.json', JSON.stringify({ testResults: [{ assertionResults }] }));
    const result = run('assert-one-test', '--report', join(repo, 'report.json'));
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('INCONCLUSIVE');
  });
});

describe('the environment allowlist', () => {
  // An ALLOWLIST, not a denylist: the denylist round 3 rejected omitted
  // ZERNIO_*, SUPABASE_SERVICE_KEY, Redis, Sentry and every future provider.
  it('emits only the allowlisted keys and drops everything else', () => {
    const result = run('env', ...HOME_FLAG());
    expect(result.status).toBe(0);
    const env = JSON.parse(result.stdout) as Record<string, string>;
    expect(Object.keys(env).sort()).toEqual([
      'CI', 'HOME', 'MOCK_EXTERNAL_APIS', 'NODE_ENV', 'PATH',
      'REPWORTH_DISABLE_LIVE_DB_SUITES', 'TMPDIR',
    ]);
    expect(JSON.stringify(env)).not.toContain('do-not-leak');
  });

  // Process-env scrubbing alone is defeated by a disk reload:
  // resolveTestDatabaseUrl() falls back to reading .env.local. Without a
  // validated local database the repo's own kill switch goes on.
  it('sets the live-DB kill switch when no database is supplied', () => {
    const env = JSON.parse(run('env', ...HOME_FLAG()).stdout) as Record<string, string>;
    expect(env.REPWORTH_DISABLE_LIVE_DB_SUITES).toBe('1');
    expect(env.TEST_DATABASE_POOL_URL).toBeUndefined();
  });

  it('accepts a localhost database and drops the kill switch', () => {
    const env = JSON.parse(
      run('env', ...HOME_FLAG(), '--test-db', 'postgres://u:p@127.0.0.1:5432/t').stdout,
    ) as Record<string, string>;
    expect(env.TEST_DATABASE_POOL_URL).toBe('postgres://u:p@127.0.0.1:5432/t');
    expect(env.REPWORTH_DISABLE_LIVE_DB_SUITES).toBeUndefined();
  });

  it('refuses a remote database host — a mutation removes the guard that made it safe', () => {
    const result = run('env', ...HOME_FLAG(), '--test-db', 'postgres://u:p@db.supabase.co:5432/t');
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('non-local test database host');
  });
});

describe('the watcher precondition', () => {
  it('passes when nothing is serving or watching the worktree', () => {
    write('ps.txt', ' 101 /usr/sbin/cupsd\n 102 node scripts/thing.mjs\n');
    expect(run('watchers', '--ps-source', join(repo, 'ps.txt')).status).toBe(0);
  });

  it.each([
    'next dev',
    'tsx watch worker/index.ts',
    'pnpm worker',
    'bash scripts/dev-stack.sh',
    'playwright test',
  ])('aborts when a process matching "%s" is live', (command) => {
    write('ps.txt', ` 999 node /x/${command}\n`);
    const result = run('watchers', '--ps-source', join(repo, 'ps.txt'));
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('ABORT');
  });

  // Measured on a real machine: the SHELL that invoked the check was reported,
  // because its own command line embedded a script containing "next dev". Same
  // self-match that makes a grep-based guard block its own documentation.
  it('never reports the checking process or its own ancestry', () => {
    const marker = 'RTSELFMATCH';
    // The shell's argv contains both the watcher token and the marker, so a
    // self-match would surface the marker in the refusal.
    const result = spawnSync(
      '/bin/bash',
      ['-c', `: "next dev ${marker}"; node ${RUNNER} watchers`],
      { cwd: repo, encoding: 'utf8', env: GIT_FREE_ENV },
    );
    const output = `${result.stdout}${result.stderr}`;
    expect(output).not.toContain(marker);
  });
});

describe('the journal and the finalizer', () => {
  function mutate(contents: string): RunResult {
    write('mutant.ts', contents);
    return run('mutate', '--file', 'src/gate.ts', '--mutant', join(repo, 'mutant.ts'));
  }

  it('journals the original blob before applying, then records the mutant blob', () => {
    expect(mutate('export const allow = (n: number) => true;\n').status).toBe(0);
    const entry = journal().mutations[0]!;
    expect(entry.state).toBe('applied');
    expect(entry.originalOid).toMatch(/^[0-9a-f]{40}$/);
    expect(entry.mutantOid).toMatch(/^[0-9a-f]{40}$/);
    expect(entry.originalOid).not.toBe(entry.mutantOid);
    expect(read('src/gate.ts')).toContain('=> true');
  });

  it('restores the original and leaves a clean tree', () => {
    mutate('export const allow = (n: number) => true;\n');
    expect(run('finalize').status).toBe(0);
    expect(read('src/gate.ts')).toBe('export const allow = (n: number) => n > 0;\n');
    expect(git('status', '--porcelain', '--untracked-files=no')).toBe('');
    expect(journal().mutations[0]!.state).toBe('restored');
  });

  // Round 3's finding: restoring a whole path from HEAD can destroy an edit
  // made during the run. Foreign content is never overwritten.
  it('ABORTS on content that is neither the original nor the journaled mutant', () => {
    mutate('export const allow = (n: number) => true;\n');
    write('src/gate.ts', 'export const allow = (n: number) => n >= 0; // a human edited this\n');
    const result = run('finalize');
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('ABORT, nothing touched');
    expect(read('src/gate.ts')).toContain('a human edited this');
    expect(journal().mutations[0]!.state).toBe('applied');
  });

  it('is idempotent: a second finalize over a restored tree still succeeds', () => {
    mutate('export const allow = (n: number) => true;\n');
    expect(run('finalize').status).toBe(0);
    expect(run('finalize').status).toBe(0);
  });

  it('treats a file already back at its original content as done', () => {
    mutate('export const allow = (n: number) => true;\n');
    write('src/gate.ts', 'export const allow = (n: number) => n > 0;\n');
    expect(run('finalize').status).toBe(0);
    expect(journal().mutations[0]!.state).toBe('restored');
  });
});

describe('the dotenv rename-swap', () => {
  // .env* files are gitignored, so the blob-OID machinery cannot restore them
  // and secrets must never enter git objects or the journal.
  it('swaps the real file to a backup and journals only paths and a hash', () => {
    write('.env.local', 'ZERNIO_API_KEY=real-secret\n');
    expect(run('dotenv-swap', '--test-db', 'postgres://u:p@localhost:5432/t').status).toBe(0);
    expect(read('.env.local')).not.toContain('real-secret');
    expect(read('.env.local')).toContain('MOCK_EXTERNAL_APIS=true');
    expect(read('.env.local.red-team-backup')).toContain('real-secret');
    const recorded = journal();
    expect(recorded.dotenv.open).toBe(true);
    expect(JSON.stringify(recorded)).not.toContain('real-secret');
  });

  it('restores the real file and closes the swap', () => {
    write('.env.local', 'ZERNIO_API_KEY=real-secret\n');
    run('dotenv-swap');
    expect(run('dotenv-restore').status).toBe(0);
    expect(read('.env.local')).toBe('ZERNIO_API_KEY=real-secret\n');
    expect(existsSync(join(repo, '.env.local.red-team-backup'))).toBe(false);
    expect(journal().dotenv.open).toBe(false);
  });

  // Round 6's finding: restoring without checking the destination silently
  // discards an edit made during the run.
  it('ABORTS and keeps both files when the scrubbed copy was modified', () => {
    write('.env.local', 'ZERNIO_API_KEY=real-secret\n');
    run('dotenv-swap');
    write('.env.local', 'MOCK_EXTERNAL_APIS=true\nSOMEONE_ADDED=this\n');
    const result = run('dotenv-restore');
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('both files kept');
    expect(read('.env.local')).toContain('SOMEONE_ADDED');
    expect(read('.env.local.red-team-backup')).toContain('real-secret');
  });

  // Found by exercising the real .env.local: after an abort the documented
  // resolution is a hand `mv`, and the journal then stayed open FOREVER, failing
  // every later transition with no escape.
  it('closes the entry when the backup is gone and the real file is already back', () => {
    write('.env.local', 'ZERNIO_API_KEY=real-secret\n');
    run('dotenv-swap');
    // What a human does after an abort: put the real file back, drop the backup.
    write('.env.local', 'ZERNIO_API_KEY=real-secret\n');
    rmSync(join(repo, '.env.local.red-team-backup'));

    const result = run('dotenv-restore');
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('restored 1 file');
    expect(journal().dotenv.open).toBe(false);
    expect(read('.env.local')).toBe('ZERNIO_API_KEY=real-secret\n');
  });

  // The other half of that fork, and the reason the hash is journaled: if the
  // destination is STILL the scrubbed copy, the real content is gone. Closing
  // the entry would bless a scrubbed dotenv as the operator's own file.
  it('FAILS when the backup is gone and the destination is still the scrubbed copy', () => {
    write('.env.local', 'ZERNIO_API_KEY=real-secret\n');
    run('dotenv-swap');
    rmSync(join(repo, '.env.local.red-team-backup'));

    const result = run('dotenv-restore');
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('the real file is LOST');
    expect(journal().dotenv.open).toBe(true);
  });

  it('refuses a second swap while one is open', () => {
    write('.env.local', 'A=1\n');
    run('dotenv-swap');
    expect(run('dotenv-swap').stderr).toContain('already open');
  });
});

describe('the paused supervisor', () => {
  it('runs a command in its own process group and reaps it', () => {
    const result = run('run', ...HOME_FLAG(), '--', '/usr/bin/true');
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('group reaped');
    const supervisor = journal().supervisors[0]!;
    expect(supervisor.pgid).toBe(supervisor.pid);
    expect(supervisor.active).toBe(false);
    expect(groupIsEmpty(supervisor.pgid)).toBe(true);
  });

  it('kills the whole group on timeout and reports 124', () => {
    const result = run('run', ...HOME_FLAG(), '--timeout', '800', '--', '/bin/sleep', '45');
    expect(result.status).toBe(124);
    expect(result.stderr).toContain('TIMEOUT');
    expect(groupIsEmpty(journal().supervisors[0]!.pgid)).toBe(true);
  });

  // CRASH CASE 1 — the parent dies BEFORE writing the release byte.
  //
  // The release channel IS the parent's stdin pipe, so a dead parent releases
  // nothing: the supervisor takes EOF and exits without executing the command.
  // What must hold is that the identity was already durable at that moment and
  // that a later reap closes the entry instead of guessing.
  it('never executes the command when the parent dies before the release', async () => {
    const marker = join(repo, 'executed.marker');
    const result = run(
      'run', ...HOME_FLAG(), '--no-release',
      '--', '/bin/sh', '-c', `touch ${marker}; sleep 45`,
    );
    expect(result.status).toBe(0);

    const supervisor = journal().supervisors[0]!;
    expect(supervisor.pgid).toBe(supervisor.pid);
    expect(supervisor.startedAt).toBeTruthy();
    expect(supervisor.active).toBe(true);

    expect(await waitFor(() => groupIsEmpty(supervisor.pgid))).toBe(true);
    expect(existsSync(marker)).toBe(false);

    expect(run('reap').status).toBe(0);
    expect(journal().supervisors[0]!.active).toBe(false);
  }, 20_000);

  // CRASH CASE 2 — the group LEADER exits while a descendant survives. POSIX
  // forbids reusing a PGID while any member lives, so targeting the group is
  // still safe even though the leader's start time can no longer be read.
  it('kills descendants orphaned after the group leader exits', async () => {
    const result = run(
      'run', ...HOME_FLAG(), '--timeout', '10000',
      '--', '/bin/sh', '-c', 'sleep 45 & exec /usr/bin/true',
    );
    expect(result.status).toBe(0);
    const { pgid } = journal().supervisors[0]!;
    expect(await waitFor(() => groupIsEmpty(pgid))).toBe(true);
  }, 20_000);

  // The PID-reuse guard. A stale journal entry must never let the finalizer
  // signal a process the OS has since handed to something else.
  it('refuses to signal a live PID whose start time differs from the journal', async () => {
    const { pgid } = adoptLiveGroup({ startedAt: 'Thu Jan  1 00:00:00 1970' });
    expect(await waitFor(() => !groupIsEmpty(pgid))).toBe(true);

    const result = run('reap');
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('was reused');
    expect(groupIsEmpty(pgid)).toBe(false);
    expect(journal().supervisors[0]!.active).toBe(true);
  }, 20_000);

  it('reaps a live journaled group whose identity does match', async () => {
    const { pgid } = adoptLiveGroup({});
    expect(await waitFor(() => !groupIsEmpty(pgid))).toBe(true);

    expect(run('reap').status).toBe(0);
    expect(groupIsEmpty(pgid)).toBe(true);
    expect(journal().supervisors[0]!.active).toBe(false);
  }, 20_000);

  // The finalizer must not restore files while a run could still be writing.
  it('refuses to restore files while a process group is still live', async () => {
    write('mutant.ts', 'export const allow = (n: number) => true;\n');
    run('mutate', '--file', 'src/gate.ts', '--mutant', join(repo, 'mutant.ts'));
    const { pgid } = adoptLiveGroup({ startedAt: 'Thu Jan  1 00:00:00 1970' });
    expect(await waitFor(() => !groupIsEmpty(pgid))).toBe(true);

    const result = run('finalize');
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('files were NOT restored');
    expect(read('src/gate.ts')).toContain('=> true');
  }, 20_000);
});

describe('the mutation budget', () => {
  function exhausted() {
    write('.feature/red-team-journal.json', JSON.stringify({
      version: 1, round: 1, runs: 30, mutations: [], dotenv: { open: false, files: [] }, supervisors: [],
    }, null, 2));
  }

  it('refuses a run past the 30-per-round cap and names the resulting status', () => {
    exhausted();
    const result = run('run', ...HOME_FLAG(), '--', '/usr/bin/true');
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('budget exhausted');
    expect(result.stderr).toContain('INCOMPLETE_BUDGET');
  });

  // The budget is per ROUND, and the journal outlives a round. Without a reset
  // the second round would open already exhausted, having executed nothing.
  it('resets the counter when a new round opens', () => {
    exhausted();
    const opened = run('round-start');
    expect(opened.status).toBe(0);
    expect(opened.stdout).toContain('round 2 open');
    expect(journal().runs).toBe(0);
    expect(run('run', ...HOME_FLAG(), '--', '/usr/bin/true').status).toBe(0);
  });

  it('refuses to open a round over an unrestored mutation', () => {
    write('mutant.ts', 'export const allow = (n: number) => true;\n');
    run('mutate', '--file', 'src/gate.ts', '--mutant', join(repo, 'mutant.ts'));
    const result = run('round-start');
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('did not finalize');
    expect(read('src/gate.ts')).toContain('=> true');
  });

  it('refuses to open a round over an open dotenv swap', () => {
    write('.env.local', 'A=1\n');
    run('dotenv-swap');
    expect(run('round-start').stderr).toContain('dotenv swap is still open');
  });

  // Two rounds is the hard cap the loop protocol states; the runner enforces it
  // rather than trusting the caller to count.
  it('refuses to open a third round', () => {
    expect(run('round-start').status).toBe(0);
    expect(run('round-start').status).toBe(0);
    const third = run('round-start');
    expect(third.status).toBe(1);
    expect(third.stderr).toContain('hard cap of 2');
  });
});
