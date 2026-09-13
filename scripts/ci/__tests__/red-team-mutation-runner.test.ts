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
let runner = RUNNER;

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
  const result = spawnSync('node', [runner, ...args], {
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
  runner = RUNNER;
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

describe('the owner-approved Run C fourth round', () => {
  const report = 'docs/reviews/red-team/codex-owner-operator-run-c-14b9e1/findings.json';
  const markdown = report.replace('.json', '.md');
  const approval = {
    id: 'owner-run-c-fourth-round-prompt-regression', date: '2026-09-13', finding_ids: [],
    text: 'Question: May I make the Run C-only verifier change described in /private/tmp/run-c-fourth-round-proposal.md and run a fourth verification round, capped at 150 local test launches? It covers the prompt fix and the verifier’s own safeguards, preserves all earlier evidence, uses Codex only, and keeps further rounds blocked.\nOwner: Yes, approve the scoped fourth round',
  };

  function prepare(approve = true): string {
    git('branch', '-m', 'codex/owner-operator-run-c');
    const inventory = JSON.parse(readFileSync(resolve(process.cwd(), report), 'utf8')).inventory
      .slice(0, 785).map(({ id, file, test }: { id: string; file: string; test: string }) => (
        { id, file, test, outcome: 'excluded', reason: 'Historical fixture evidence, retained verbatim.' }
      ));
    const historical = {
      mode: 'feature', branch: 'codex/owner-operator-run-c', round: 3,
      head_sha: '2565c78585d6b08837e01dbb2a4a3ba3c265eff0', inventory,
      findings: [{ id: 'historical', reason: 'original evidence' }],
      authorizations: [{ id: 'third', text: 'third round authorized' }],
    };
    write(report, JSON.stringify(historical));
    write(markdown, '# Historical duty evidence\n\nSibling search used fixture scope.\n');
    git('add', report, markdown);
    git('commit', '-qm', 'historical third round');
    const baseline = git('rev-parse', 'HEAD');
    const blob = git('rev-parse', `HEAD:${report}`);
    const markdownBlob = git('rev-parse', `HEAD:${markdown}`);
    // Private immutable fixture pins: no CLI/environment bypass in the real runner.
    runner = join(repo, 'fixture-fourth-runner.mjs');
    writeFileSync(runner, readFileSync(RUNNER, 'utf8')
      .replace("const RUN_C_FOURTH_BASELINE = 'fb536c09711ec331262f5efc64ff42f066bec3ba';", `const RUN_C_FOURTH_BASELINE = '${baseline}';`)
      .replace("const RUN_C_HISTORY_BLOB = 'd2de690d9154e591d83cbb9e9591db8d0567d318';", `const RUN_C_HISTORY_BLOB = '${blob}';`)
      .replace("const RUN_C_HISTORY_MARKDOWN_BLOB = 'caae5b4d877e254033485a73f38f56b074c8910e';", `const RUN_C_HISTORY_MARKDOWN_BLOB = '${markdownBlob}';`));
    if (approve) {
      write(report, JSON.stringify({ ...historical, authorizations: [...historical.authorizations, approval] }));
      git('add', report);
      git('commit', '-qm', 'commit exact fourth-round approval');
    }
    write('.feature/red-team-journal.json', JSON.stringify({
      version: 1, round: 3, runs: 22, mutations: [], dotenv: { open: false, files: [] }, supervisors: [],
    }));
    return baseline;
  }

  function fourthJournal(): void {
    write('.feature/red-team-journal.json', JSON.stringify({ ...journal(), round: 4, runs: 0 }));
  }

  it('opens only the committed canonical third-to-fourth transition', () => {
    prepare();
    expect(run('round-start').status).toBe(0);
    expect(JSON.parse(read('.feature/red-team-journal.json'))).toMatchObject({ round: 4, runs: 0 });
  });

  it.each(['deleted', 'replaced'])(
    'refuses admission when committed historical Markdown is %s', (change) => {
      prepare();
      if (change === 'deleted') git('rm', '-q', markdown);
      else {
        write(markdown, '# A replacement report without the historical duties\n');
        git('add', markdown);
      }
      git('commit', '-qm', 'discard historical Markdown');
      expect(run('round-start').status).toBe(1);
      expect(JSON.parse(read('.feature/red-team-journal.json'))).toMatchObject({ round: 3, runs: 22 });
    },
  );

  it.each(['missing', 'uncommitted', 'branch', 'path', 'third text', 'second text', 'date', 'identity', 'history', 'ancestry', 'product', 'dirty', 'staged'])(
    'refuses fourth-round admission for %s without resetting round three', (mismatch) => {
      const baseline = prepare(mismatch !== 'missing' && mismatch !== 'uncommitted');
      const sidecar = JSON.parse(read(report));
      if (mismatch === 'uncommitted') {
        sidecar.authorizations.push(approval);
        write(report, JSON.stringify(sidecar));
      }
      if (mismatch === 'branch') git('branch', '-m', 'codex/other');
      if (mismatch === 'path') {
        write('docs/reviews/red-team/foreign/findings.json', read(report));
        git('rm', '-q', report);
        git('add', 'docs/reviews/red-team/foreign/findings.json');
        git('commit', '-qm', 'foreign report');
      }
      if (['third text', 'second text', 'date', 'identity', 'history'].includes(mismatch)) {
        if (mismatch === 'third text') sidecar.authorizations.at(-1).text = 'third round authorized';
        if (mismatch === 'second text') sidecar.authorizations.at(-1).id = 'owner-run-c-budget-next-pass';
        if (mismatch === 'date') sidecar.authorizations.at(-1).date = '2026-09-14';
        if (mismatch === 'identity') sidecar.inventory[0].test = 'rewritten test';
        if (mismatch === 'history') sidecar.findings[0].reason = 'rewritten evidence';
        write(report, JSON.stringify(sidecar));
        git('add', report);
        git('commit', '-qm', 'mismatched admission');
      }
      if (mismatch === 'ancestry') {
        writeFileSync(runner, readFileSync(runner, 'utf8').replace(
          `const RUN_C_FOURTH_BASELINE = '${baseline}';`, `const RUN_C_FOURTH_BASELINE = '${'1'.repeat(40)}';`,
        ));
      }
      if (['product', 'dirty', 'staged'].includes(mismatch)) {
        write('src/gate.ts', 'export const allow = () => true;\n');
        if (mismatch !== 'dirty') git('add', 'src/gate.ts');
        if (mismatch === 'product') git('commit', '-qm', 'unapproved product path');
      }
      expect(run('round-start').status).toBe(1);
      expect(JSON.parse(read('.feature/red-team-journal.json'))).toMatchObject({ round: 3, runs: 22 });
    },
  );

  it('pins the grant before releasing the first supervisor', () => {
    prepare();
    fourthJournal();
    const result = run('run', ...HOME_FLAG(), '--', process.execPath, '-e',
      'const j=JSON.parse(require("node:fs").readFileSync(".feature/red-team-journal.json","utf8"));process.exit(j.runs===1&&j.budgetAuthorization?.maxRuns===150&&j.budgetAuthorization?.firstRun===1&&j.supervisors.at(-1)?.active===true?0:9)');
    expect(result.status).toBe(0);
    expect(JSON.parse(read('.feature/red-team-journal.json')).budgetAuthorization).toMatchObject({
      id: approval.id, maxRuns: 150, firstRun: 1, headSha: git('rev-parse', 'HEAD'),
    });
  });

  it('refuses an ungranted first launch without executing its child', () => {
    prepare(false);
    fourthJournal();
    const result = run('run', ...HOME_FLAG(), '--', process.execPath, '-e', 'require("node:fs").writeFileSync("launched","yes")');
    expect(result.status).toBe(1);
    expect(journal().runs).toBe(0);
    expect(existsSync(join(repo, 'launched'))).toBe(false);
  });

  it.each(['approval', 'head', 'grant'])(
    'refuses %s drift between launches and preserves the count', (mismatch) => {
      prepare();
      fourthJournal();
      expect(run('run', ...HOME_FLAG(), '--', '/usr/bin/true').status).toBe(0);
      if (mismatch === 'approval') {
        const sidecar = JSON.parse(read(report));
        sidecar.authorizations.at(-1).text = 'edited approval';
        write(report, JSON.stringify(sidecar));
        git('add', report);
        git('commit', '-qm', 'change approval');
      } else if (mismatch === 'head') git('commit', '--allow-empty', '-qm', 'change head');
      else {
        const value = JSON.parse(read('.feature/red-team-journal.json'));
        expect(value.budgetAuthorization).toMatchObject({ maxRuns: 150, firstRun: 1 });
        value.budgetAuthorization.maxRuns = 151;
        writeJournal(value);
      }
      expect(run('run', ...HOME_FLAG(), '--', '/usr/bin/true').status).toBe(1);
      expect(journal().runs).toBe(1);
    },
  );

  it('permits launch 150, refuses 151, and never opens a fifth round', () => {
    prepare();
    fourthJournal();
    expect(run('run', ...HOME_FLAG(), '--', '/usr/bin/true').status).toBe(0);
    writeJournal({ ...journal(), runs: 149 });
    expect(run('run', ...HOME_FLAG(), '--', '/usr/bin/true').status).toBe(0);
    const refused = run('run', ...HOME_FLAG(), '--', '/usr/bin/true');
    expect(refused.status).toBe(1);
    expect(refused.stderr).toContain('budget exhausted (150');
    expect(journal().runs).toBe(150);
    expect(run('round-start').status).toBe(1);
    expect(journal().runs).toBe(150);
  });
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

  function authorize1185(): void {
    git('branch', '-m', 'feat/1185');
    write('docs/reviews/red-team/feat-1185-67f43e/findings.json', JSON.stringify({
      mode: 'feature', branch: 'feat/1185', round: 1,
      head_sha: '0b374b6a9b76ac4eee3222d84b47eae3e359bf4d',
      // The committed report is the immutable candidate-identity fixture for
      // this one-ticket exception; outcomes/evidence are deliberately ignored.
      inventory: JSON.parse(readFileSync(resolve(process.cwd(),
        'docs/reviews/red-team/feat-1185-67f43e/findings.json'), 'utf8')).inventory
        .filter((row: { id: string }) => /^RT-\d+$/.test(row.id))
        .map(({ id, file, test }: { id: string; file: string; test: string }) => ({ id, file, test })),
      authorizations: [{
        id: 'owner-1185-budget-continuation', date: '2026-09-09', finding_ids: [],
        text: 'Question: Approve the ticket-scoped verifier change needed to finish those 439 cases—at least 878 additional test runs? The red-team skill limits verification to “30 mutation runs per round,” which is the remaining blocker.\nOwner: I approve',
      }],
    }));
  }

  it('continues the approved #1185 round without resetting spent launches', () => {
    exhausted();
    authorize1185();
    expect(run('run', ...HOME_FLAG(), '--', '/usr/bin/true').status).toBe(0);
    expect(journal().runs).toBe(31);
    const recorded = JSON.parse(read('.feature/red-team-journal.json'));
    expect(recorded.round).toBe(1);
    expect(recorded.budgetAuthorization).toMatchObject({
      id: 'owner-1185-budget-continuation', maxRuns: 1400, firstRun: 31,
    });
  });

  it('refuses launch 1401 even with #1185 owner authorization', () => {
    exhausted();
    authorize1185();
    writeJournal({ ...journal(), runs: 1400 });
    expect(run('run', ...HOME_FLAG(), '--', '/usr/bin/true').stderr).toContain('budget exhausted (1400');
    expect(journal().runs).toBe(1400);
  });

  it.each(['branch', 'round', 'head', 'inventory', 'identity', 'text', 'missing', 'malformed']) (
    'keeps the default cap when #1185 authorization has a %s mismatch', (mismatch) => {
      exhausted();
      authorize1185();
      const path = 'docs/reviews/red-team/feat-1185-67f43e/findings.json';
      const sidecar = JSON.parse(read(path));
      if (mismatch === 'branch') git('branch', '-m', 'feat/other');
      if (mismatch === 'round') write('.feature/red-team-journal.json', JSON.stringify({ ...journal(), round: 2 }));
      if (mismatch === 'head') sidecar.head_sha = '1'.repeat(40);
      if (mismatch === 'inventory') sidecar.inventory.pop();
      if (mismatch === 'identity') sidecar.inventory[0].test = 'a different candidate';
      if (mismatch === 'text') sidecar.authorizations[0].text = 'I approve a report amendment';
      if (mismatch === 'missing') sidecar.authorizations = [];
      write(path, mismatch === 'malformed' ? '{' : JSON.stringify(sidecar));
      const result = run('run', ...HOME_FLAG(), '--', '/usr/bin/true');
      expect(result.status).toBe(1);
      expect(result.stderr).toContain('budget exhausted (30');
      expect(journal().runs).toBe(30);
    },
  );

  const runCReport = 'docs/reviews/red-team/codex-owner-operator-run-c-14b9e1/findings.json';

  function authorizeRunC(): string {
    git('branch', '-m', 'codex/owner-operator-run-c');
    const baseline = git('rev-parse', 'HEAD');
    // The fixture has its own immutable product commit. Substitute only that
    // SHA in a private copy, so these executable tests survive squash merges
    // without retaining the feature branch's Git objects or adding a runtime override.
    runner = join(repo, 'fixture-mutation-runner.mjs');
    writeFileSync(runner, readFileSync(RUNNER, 'utf8').replace(
      "const RUN_C_BASELINE = '72cc51abd5d45b10cd7abf3c993f9039c5e63f65';",
      `const RUN_C_BASELINE = '${baseline}';`,
    ));
    const inventory = JSON.parse(readFileSync(resolve(process.cwd(), runCReport), 'utf8')).inventory
      .slice(0, 710).map(({ id, file, test }: { id: string; file: string; test: string }) => ({ id, file, test }));
    write(runCReport, JSON.stringify({
      mode: 'feature', branch: 'codex/owner-operator-run-c', round: 1,
      head_sha: '5f2c201769ba982f49b9ecbd82678b45e75b19b1', inventory,
      authorizations: [{
        id: 'owner-run-c-budget-next-pass', date: '2026-09-13',
        finding_ids: ['RT-P1-1', 'RT-P1-2', 'RT-P1-3'],
        text: "Question: May I make a Run C-only change to the verifier’s limit, allowing up to 1,500 local test runs to finish those checks?\nOwner: I'll finish everything from C, D, and E. I give you the approval.",
      }],
    }));
    git('add', runCReport);
    git('commit', '-qm', 'record the approved Run C extension');
    write('.feature/red-team-journal.json', JSON.stringify({
      version: 1, round: 2, runs: 30, mutations: [], dotenv: { open: false, files: [] }, supervisors: [],
    }));
    return baseline;
  }

  it('continues only the approved Run C next pass and durably pins its committed HEAD', () => {
    authorizeRunC();
    expect(run('run', ...HOME_FLAG(), '--', '/usr/bin/true').status).toBe(0);
    expect(journal().runs).toBe(31);
    expect(JSON.parse(read('.feature/red-team-journal.json')).budgetAuthorization).toMatchObject({
      id: 'owner-run-c-budget-next-pass', maxRuns: 1500, firstRun: 31,
      headSha: git('rev-parse', 'HEAD'),
    });
    expect(run('run', ...HOME_FLAG(), '--', '/usr/bin/true').status).toBe(0);
    expect(journal().runs).toBe(32);
  });

  it('pins the approved Run C candidate on its first launch from zero', () => {
    authorizeRunC();
    writeJournal({ ...journal(), runs: 0 });
    expect(run('run', ...HOME_FLAG(), '--', '/usr/bin/true').status).toBe(0);
    expect(journal().runs).toBe(1);
    expect(JSON.parse(read('.feature/red-team-journal.json')).budgetAuthorization).toMatchObject({
      id: 'owner-run-c-budget-next-pass', firstRun: 1, headSha: git('rev-parse', 'HEAD'),
    });
  });

  it.each(['another branch', 'another round'])(
    'retains the ordinary first launch and 30-run limit for %s', (scope) => {
      authorizeRunC();
      write('.feature/red-team-journal.json', JSON.stringify({
        ...journal(), runs: 0, round: scope === 'another round' ? 1 : 2,
      }));
      if (scope === 'another branch') git('branch', '-m', 'codex/another-task');
      expect(run('run', ...HOME_FLAG(), '--', '/usr/bin/true').status).toBe(0);
      expect(journal().runs).toBe(1);
      expect(JSON.parse(read('.feature/red-team-journal.json')).budgetAuthorization).toBeUndefined();
      writeJournal({ ...journal(), runs: 30 });
      const refused = run('run', ...HOME_FLAG(), '--', '/usr/bin/true');
      expect(refused.status).toBe(1);
      expect(refused.stderr).toContain('budget exhausted (30');
    },
  );

  it('permits Run C launch 1500 and refuses launch 1501 without resetting the counter', () => {
    authorizeRunC();
    writeJournal({ ...journal(), runs: 1499 });
    expect(run('run', ...HOME_FLAG(), '--', '/usr/bin/true').status).toBe(0);
    const refused = run('run', ...HOME_FLAG(), '--', '/usr/bin/true');
    expect(refused.status).toBe(1);
    expect(refused.stderr).toContain('budget exhausted (1500');
    expect(journal().runs).toBe(1500);
  });

  it.each(['branch', 'round', 'report-round', 'head', 'inventory', 'identity', 'text', 'date', 'missing', 'malformed', 'product', 'ancestry'])(
    'refuses a %s mismatch before launching the scoped Run C pass', (mismatch) => {
      authorizeRunC();
      const ordinaryScope = mismatch === 'branch' || mismatch === 'round';
      if (!ordinaryScope) writeJournal({ ...journal(), runs: 0 });
      const sidecar = JSON.parse(read(runCReport));
      if (mismatch === 'branch') git('branch', '-m', 'codex/other');
      if (mismatch === 'round') write('.feature/red-team-journal.json', JSON.stringify({ ...journal(), round: 3 }));
      if (mismatch === 'report-round') sidecar.round = 2;
      if (mismatch === 'head') sidecar.head_sha = '1'.repeat(40);
      if (mismatch === 'inventory') sidecar.inventory.pop();
      if (mismatch === 'identity') sidecar.inventory[0].test = 'another test';
      if (mismatch === 'text') sidecar.authorizations[0].text = 'I approve another task';
      if (mismatch === 'date') sidecar.authorizations[0].date = '2026-09-14';
      if (mismatch === 'missing') sidecar.authorizations = [];
      write(runCReport, mismatch === 'malformed' ? '{' : JSON.stringify(sidecar));
      git('add', runCReport);
      if (mismatch === 'product') {
        write('src/gate.ts', 'export const allow = () => true;');
        git('add', 'src/gate.ts');
      }
      git('commit', '--allow-empty', '-qm', 'fixture mismatch');
      if (mismatch === 'ancestry') {
        const unrelated = git('commit-tree', git('rev-parse', 'HEAD^{tree}'), '-m', 'unrelated history');
        git('update-ref', 'HEAD', unrelated);
      }
      const refused = run('run', ...HOME_FLAG(), '--', '/usr/bin/true');
      expect(refused.status).toBe(1);
      expect(refused.stderr).toContain(ordinaryScope ? 'budget exhausted (30' : 'Run C startup preconditions failed');
      expect(journal().runs).toBe(ordinaryScope ? 30 : 0);
      expect(journal().supervisors).toEqual([]);
      expect(JSON.parse(read('.feature/red-team-journal.json')).budgetAuthorization).toBeUndefined();
    },
  );

  it('refuses even documentation-only HEAD drift after the Run C first launch', () => {
    authorizeRunC();
    writeJournal({ ...journal(), runs: 0 });
    expect(run('run', ...HOME_FLAG(), '--', '/usr/bin/true').status).toBe(0);
    write('docs/reviews/codex-owner-operator-run-c/evidence.md', 'another report commit');
    git('add', 'docs/reviews/codex-owner-operator-run-c/evidence.md');
    git('commit', '-qm', 'drift after the candidate was pinned');
    const refused = run('run', ...HOME_FLAG(), '--', '/usr/bin/true');
    expect(refused.status).toBe(1);
    expect(refused.stderr).toContain('pinned HEAD changed');
    expect(journal().runs).toBe(1);
  });

  it('does not treat an uncommitted Run C approval as authorization', () => {
    const baseline = authorizeRunC();
    writeJournal({ ...journal(), runs: 0 });
    git('update-ref', 'HEAD', baseline);
    const refused = run('run', ...HOME_FLAG(), '--', '/usr/bin/true');
    expect(refused.status).toBe(1);
    expect(refused.stderr).toContain('Run C startup preconditions failed');
    expect(journal().runs).toBe(0);
    expect(journal().supervisors).toEqual([]);
    expect(JSON.parse(read('.feature/red-team-journal.json')).budgetAuthorization).toBeUndefined();
  });

  it.each(['unstaged', 'staged'])(
    'rejects an unexpected %s product edit before the first Run C launch', (kind) => {
      authorizeRunC();
      writeJournal({ ...journal(), runs: 0 });
      write('src/gate.ts', 'export const allow = () => true;');
      if (kind === 'staged') git('add', 'src/gate.ts');
      const refused = run('run', ...HOME_FLAG(), '--', '/usr/bin/true');
      expect(refused.status).toBe(1);
      expect(refused.stderr).toContain('Run C startup preconditions failed');
      expect(journal().runs).toBe(0);
      expect(journal().supervisors).toEqual([]);
      expect(JSON.parse(read('.feature/red-team-journal.json')).budgetAuthorization).toBeUndefined();
    },
  );

  it('allows only the journaled Run C mutant and denies an unrelated edit after pinning', () => {
    authorizeRunC();
    expect(run('run', ...HOME_FLAG(), '--', '/usr/bin/true').status).toBe(0);
    write('mutant.ts', 'export const allow = () => true;');
    expect(run('mutate', '--file', 'src/gate.ts', '--mutant', join(repo, 'mutant.ts')).status).toBe(0);
    expect(run('run', ...HOME_FLAG(), '--', '/usr/bin/true').status).toBe(0);
    write('src/gate.ts', 'export const allow = () => false;');
    const refused = run('run', ...HOME_FLAG(), '--', '/usr/bin/true');
    expect(refused.status).toBe(1);
    expect(refused.stderr).toContain('pinned HEAD changed');
    expect(journal().runs).toBe(32);
    // Restore the exact journaled mutant so the real finalizer can undo it.
    write('src/gate.ts', read('mutant.ts'));
    expect(run('finalize').status).toBe(0);
    expect(read('src/gate.ts')).toBe('export const allow = (n: number) => n > 0;\n');
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

  // Two rounds is what a run reaches on its own, and the runner enforces that
  // rather than trusting the caller to count. #1184 added ONE exception — a third
  // round the owner authorized IN the sidecar — and an exception is only worth
  // having if its condition binds, so every direction is pinned here.
  function seedSidecar(text: string): void {
    write('docs/reviews/red-team/fixture-run/findings.json', JSON.stringify({
      branch: 'fixture',
      authorizations: [{ id: 'AUTH-1', date: '2026-09-08', finding_ids: ['F1'], text }],
    }, null, 2));
  }

  it('refuses an UNAUTHORIZED third round', () => {
    expect(run('round-start').status).toBe(0);
    expect(run('round-start').status).toBe(0);
    const third = run('round-start');
    expect(third.status).toBe(1);
    expect(third.stderr).toContain('needs a recorded owner authorization');
  });

  it('refuses a third round when the sidecar authorizes something else', () => {
    // A near-miss must fail closed: an authorization exists, but it is not the one
    // that opens a third round.
    seedSidecar('owner 2026-09-08: accepted-risk on F4, alerting follow-up');
    expect(run('round-start').status).toBe(0);
    expect(run('round-start').status).toBe(0);
    expect(run('round-start').stderr).toContain('needs a recorded owner authorization');
  });

  it('opens a third round the sidecar records an owner authorization for', () => {
    seedSidecar('owner 2026-09-08: third round authorized, journal reset by owner');
    expect(run('round-start').status).toBe(0);
    expect(run('round-start').status).toBe(0);
    const third = run('round-start');
    expect(third.status).toBe(0);
    expect(third.stdout).toContain('round 3 open');
  });

  it('refuses a FOURTH round even with the authorization present', () => {
    seedSidecar('owner 2026-09-08: third round authorized, journal reset by owner');
    for (let index = 0; index < 3; index += 1) expect(run('round-start').status).toBe(0);
    const fourth = run('round-start');
    expect(fourth.status).toBe(1);
    expect(fourth.stderr).toContain('hard cap of 3');
  });

  it('ignores an authorization recorded for a DIFFERENT branch', () => {
    write('docs/reviews/red-team/other-run/findings.json', JSON.stringify({
      branch: 'some-other-branch',
      authorizations: [{
        id: 'AUTH-1',
        date: '2026-09-08',
        finding_ids: ['F1'],
        text: 'owner 2026-09-08: third round authorized, journal reset by owner',
      }],
    }, null, 2));
    expect(run('round-start').status).toBe(0);
    expect(run('round-start').status).toBe(0);
    expect(run('round-start').stderr).toContain('needs a recorded owner authorization');
  });

  it('fails closed on an unparseable sidecar rather than crashing', () => {
    write('docs/reviews/red-team/fixture-run/findings.json', '{ not json');
    expect(run('round-start').status).toBe(0);
    expect(run('round-start').status).toBe(0);
    const third = run('round-start');
    expect(third.status).toBe(1);
    expect(third.stderr).toContain('needs a recorded owner authorization');
  });
});
