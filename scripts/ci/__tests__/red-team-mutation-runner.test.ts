import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Timeout budget (PR #1428, landed with the #1393 fix): this suite spawns a git
// repo and the runner per case, so its wall time is dominated by process
// start-up. It passes in isolation but timed out twice under `pnpm test`'s
// parallel load during #1363's gate runs, and read 300s total at load average
// 50. Every case gets the same generous budget: a vitest timeout only bounds
// wall time and changes no assertion.
//
// #1462: one case kept a literal `30000` that overrode this budget; it runs
// ~15s idle and ~80s at load average 50, so it failed only under load. The
// "suite timeout budget" test below fails on any literal per-case timeout in
// this file or its -doc-reads sibling.
//
// #1346: the cases that read a REAL committed docs/reviews/red-team/**
// findings.json at run time — the owner-approved Run C fourth round, the
// owner-approved Run D second pass, and the #1185 / Run C budget-continuation
// grants inside "the mutation budget" — moved to
// red-team-mutation-runner-doc-reads.test.ts, which is wired into the
// docs-only lane. Every docs/reviews/red-team/** path still named here (the
// `support`/`allowed_edit_surface` fixture arrays, `seedSidecar`'s mkdtemp
// writes) is a string this suite never opens — this file's own scan of itself
// is still a candidate for `NOT_DOC_READING` in ci-audit-wiring.test.ts, and
// stays excused there as "not a read".
const SUITE_TIMEOUT_MS = 120_000;
vi.setConfig({ testTimeout: SUITE_TIMEOUT_MS, hookTimeout: SUITE_TIMEOUT_MS });

describe('suite timeout budget', () => {
  // #1462: an explicit per-case timeout overrides the setConfig budget above.
  it('gives no case in this file or its -doc-reads sibling a literal timeout', () => {
    const here = dirname(fileURLToPath(import.meta.url));
    const literals = ['red-team-mutation-runner.test.ts', 'red-team-mutation-runner-doc-reads.test.ts']
      .flatMap((name) => (readFileSync(join(here, name), 'utf8').match(/\}, *\d[\d_]*\)/g) ?? [])
        .map((hit) => `${name}: ${hit}`));
    expect(literals).toEqual([]);
  });
});

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
// Spelled out, never imported: a test that reads the runner's own constant
// cannot notice the constant being edited.
const ORDINARY_MAX_RUNS = 400;

const GIT_FREE_ENV = Object.fromEntries(
  Object.entries(process.env).filter(([key]) => !key.startsWith('GIT_')),
) as NodeJS.ProcessEnv;

// Several cases import the runner and call it IN PROCESS, where its git calls
// inherit this process's environment. A git hook (the lefthook pre-push run)
// exports GIT_DIR, which pointed those calls at the pushing repository instead
// of the fixture — `fatal: path 'src/gate.ts' exists on disk, but not in <sha>`.
// Reproduced on main with GIT_DIR set; found pushing #1302.
for (const key of Object.keys(process.env)) {
  if (key.startsWith('GIT_')) delete process.env[key];
}

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

function writeJournal(value: unknown): void {
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

// `process.kill(-1)` signals EVERY process the user owns and `-0` signals this
// process's own group. A fixture journal with `pgid: 1` once sent SIGKILL to the
// whole login session from this teardown (2026-09-18), so the rule is enforced
// here and no longer left to each fixture author.
function isSignalSafePgid(pgid: unknown): pgid is number {
  return Number.isInteger(pgid) && (pgid as number) > 1;
}

afterEach(() => {
  // Never leave a fixture process behind, whatever the assertions did.
  if (existsSync(join(repo, '.feature/red-team-journal.json'))) {
    for (const supervisor of journal().supervisors) {
      if (!isSignalSafePgid(supervisor.pgid)) continue;
      try { process.kill(-supervisor.pgid, 'SIGKILL'); } catch { /* already gone */ }
    }
  }
  rmSync(repo, { recursive: true, force: true });
});

describe('the owner-approved Run E second pass', () => {
  const report = 'docs/reviews/red-team/codex-owner-operator-run-e-eb15ab/findings.json';
  const markdown = report.replace('.json', '.md');
  const intakePath = 'docs/superpowers/plans/codex-owner-operator-run-e-intake.json';
  const support = [
    '.agents/skills/red-team/scripts/mutation-runner.mjs', '.agents/skills/red-team/SKILL.md',
    '.claude/skills/red-team/SKILL.md', 'scripts/ci/__tests__/red-team-mutation-runner.test.ts',
    '.agents/skills/feature/scripts/red-team-status.mjs', 'scripts/ci/__tests__/red-team-status.test.ts',
    'docs/runbooks/beta-launch-alerting.md',
  ];
  const addedTests = [
    'adopts a rejected timeline Apply and refreshes its Restore source: %s',
    'pins Run E HEAD and grant before the first child executes',
    'allows Run E launch 1600 and refuses 1601 and a third round',
    'certifies Run E round 2 only with intact admission history and a closed capped launch journal',
    'rejects Run E third and higher reports before generic authorization prose',
  ];
  const approval = {
    id: 'owner-run-e-second-pass-1600', date: '2026-09-15', finding_ids: [],
    text: 'Question: May I apply the reviewed Run E proposal at /private/tmp/run-e-next-pass-proposal.md and run one second adversarial pass, capped at 1,600 local test launches? This covers the 707 remaining cases, the Restore fix and verifier safeguards, the named supporting files and staging alert setup. It preserves earlier evidence and your approval in history, leaves the final risk-waiver list empty, uses Codex only, and grants no third round.\nOwner: Yes, approve the scoped E second pass',
  };

  function prepare(approve = true): void {
    git('branch', '-m', 'codex/owner-operator-run-e');
    write('.gitignore', '.feature/\nred-team-home/\n');
    const inventory = Array.from({ length: 2113 }, (_, index) => ({
      id: `original-${index}`, file: 'src/gate.test.ts', test: `original case ${index}`,
      outcome: 'skipped-budget', reason: 'Original fixture evidence',
    }));
    const historical = {
      mode: 'feature', branch: 'codex/owner-operator-run-e', round: 1,
      head_sha: '890eea76c8c04b8d2acfcc73a895ec3112560e38', inventory,
      counts: { discovered: 2113, skipped_budget: 2113 },
      findings: [{ id: 'original', reason: 'Original finding evidence' }], authorizations: [],
    };
    const intake = { version: 1, goal: 'Run E Restore',
      allowed_edit_surface: ['src/gate.ts', 'docs/reviews/red-team/codex-owner-operator-run-e/**'],
      tests_to_add: ['original test'],
    };
    write(intakePath, JSON.stringify(intake));
    git('add', '.gitignore', intakePath);
    git('commit', '-qm', 'corrected E code baseline without original reports');
    const baseline = git('rev-parse', 'HEAD');
    write(report, JSON.stringify(historical));
    write(markdown, '# Original E evidence\n\nPreserve this trailing newline.\n');
    git('add', report, markdown);
    git('commit', '-qm', 'publish unchanged E history after corrected code');
    const historyCommit = git('rev-parse', 'HEAD');
    const pins: Record<string, string> = {
      RUN_E_BASELINE: baseline,
      RUN_E_HISTORY_COMMIT: historyCommit,
      RUN_E_HISTORY_BLOB: git('rev-parse', `HEAD:${report}`),
      RUN_E_HISTORY_MARKDOWN_BLOB: git('rev-parse', `HEAD:${markdown}`),
      RUN_E_HISTORY_SHA256: createHash('sha256').update(read(report)).digest('hex'),
      RUN_E_MARKDOWN_SHA256: createHash('sha256').update(read(markdown)).digest('hex'),
      RUN_E_IDENTITY_SHA256: createHash('sha256').update(JSON.stringify(inventory.map(({ id, file, test }) => ({ id, file, test })))).digest('hex'),
    };
    runner = join(repo, '.feature/fixture-run-e-runner.mjs');
    let fixtureRunner = readFileSync(RUNNER, 'utf8');
    for (const [name, value] of Object.entries(pins)) {
      const declaration = new RegExp(`const ${name} = '[^']+';`, 'g');
      if (fixtureRunner.match(declaration)?.length !== 1) throw new Error(`missing unique fixture trust anchor ${name}`);
      fixtureRunner = fixtureRunner.replace(declaration, `const ${name} = '${value}';`);
    }
    write('.feature/fixture-run-e-runner.mjs', fixtureRunner);
    if (approve) {
      write(report, JSON.stringify({ ...historical, authorizations: [approval] }));
      write(markdown, `${read(markdown)}\n${approval.text}\n`);
      write(intakePath, JSON.stringify({ ...intake,
        allowed_edit_surface: [...support, 'src/gate.ts', 'docs/reviews/red-team/codex-owner-operator-run-e-eb15ab/**'],
        tests_to_add: [...addedTests, ...intake.tests_to_add],
      }));
      git('add', report, markdown, intakePath);
      git('commit', '-qm', 'exact E owner grant and finite intake amendment');
    }
    write('.feature/intake.json', read(intakePath));
    write('.feature/red-team-journal.json', JSON.stringify({
      version: 1, round: 2, runs: 0, mutations: [], dotenv: { open: false, files: [] }, supervisors: [],
    }));
  }

  function expectRefused(count = 0): void {
    const result = run('run', ...HOME_FLAG(), '--', process.execPath, '-e',
      'require("node:fs").writeFileSync(".feature/child-launched","yes")');
    expect(result.status).toBe(1);
    expect(journal().runs).toBe(count);
    expect(existsSync(join(repo, '.feature/child-launched'))).toBe(false);
  }

  it('pins Run E HEAD and grant before the first child executes', () => {
    prepare();
    const result = run('run', ...HOME_FLAG(), '--', process.execPath, '-e',
      'const j=JSON.parse(require("node:fs").readFileSync(".feature/red-team-journal.json","utf8"));process.exit(j.runs===1&&j.budgetAuthorization?.maxRuns===1600&&j.budgetAuthorization?.firstRun===1&&j.supervisors.at(-1)?.active===true?0:9)');
    expect(result.status).toBe(0);
    expect(JSON.parse(read('.feature/red-team-journal.json')).budgetAuthorization).toMatchObject({
      id: approval.id, maxRuns: 1600, firstRun: 1, headSha: git('rev-parse', 'HEAD'),
      sha256: createHash('sha256').update(JSON.stringify(approval)).digest('hex'),
    });
    expect(run('run', ...HOME_FLAG(), '--', '/usr/bin/true').status).toBe(0);
    expect(journal().runs).toBe(2);
  });

  it.each(['missing', 'uncommitted', 'text', 'date', 'duplicate', 'extra field', 'finding ids', 'malformed'])(
    'refuses Run E %s approval before any child executes', (mismatch) => {
      prepare(!['missing', 'uncommitted'].includes(mismatch));
      const sidecar = JSON.parse(read(report));
      if (mismatch === 'uncommitted') sidecar.authorizations.push(approval);
      if (mismatch === 'text') sidecar.authorizations[0].text += '.';
      if (mismatch === 'date') sidecar.authorizations[0].date = '2026-09-14';
      if (mismatch === 'duplicate') sidecar.authorizations.push(approval);
      if (mismatch === 'extra field') sidecar.authorizations[0].maxRuns = 1601;
      if (mismatch === 'finding ids') sidecar.authorizations[0].finding_ids = ['waived'];
      write(report, mismatch === 'malformed' ? '{' : JSON.stringify(sidecar));
      if (mismatch !== 'uncommitted') { git('add', report); git('commit', '--allow-empty', '-qm', 'invalid grant'); }
      expectRefused();
      expect(journal().supervisors).toEqual([]);
    },
  );

  it.each(['identity', 'order', 'outcome', 'count', 'finding', 'report head', 'markdown bytes', 'markdown grant', 'history hash'])(
    'preserves Run E historical evidence when rejecting altered %s', (mismatch) => {
      prepare();
      const sidecar = JSON.parse(read(report));
      if (mismatch === 'identity') sidecar.inventory[0].test = 'replacement identity';
      if (mismatch === 'order') [sidecar.inventory[0], sidecar.inventory[1]] = [sidecar.inventory[1], sidecar.inventory[0]];
      if (mismatch === 'outcome') sidecar.inventory[0].outcome = 'killed';
      if (mismatch === 'count') sidecar.counts.skipped_budget = 0;
      if (mismatch === 'finding') sidecar.findings[0].reason = 'rewritten finding';
      if (mismatch === 'report head') sidecar.head_sha = '0'.repeat(40);
      if (mismatch === 'markdown bytes') write(markdown, read(markdown).replace('newline.\n', 'newline.X'));
      if (mismatch === 'markdown grant') write(markdown, read(markdown).replace(approval.text, 'shortened approval'));
      if (mismatch === 'history hash') writeFileSync(runner, readFileSync(runner, 'utf8')
        .replace(/const RUN_E_HISTORY_SHA256 = '[^']+';/, `const RUN_E_HISTORY_SHA256 = '${'0'.repeat(64)}';`));
      write(report, JSON.stringify(sidecar));
      git('add', report, markdown);
      git('commit', '--allow-empty', '-qm', 'invalid historical evidence');
      expectRefused();
    },
  );

  it.each(['missing support', 'extra support', 'duplicate support', 'goal', 'missing test', 'report typo', 'runtime mismatch'])(
    'rejects Run E intake %s without granting a fallback launch', (mismatch) => {
      prepare();
      const intake = JSON.parse(read(intakePath));
      if (mismatch === 'missing support') intake.allowed_edit_surface.shift();
      if (mismatch === 'extra support') intake.allowed_edit_surface.push('src/**');
      if (mismatch === 'duplicate support') intake.allowed_edit_surface.push(support[0]);
      if (mismatch === 'goal') intake.goal = 'other product';
      if (mismatch === 'missing test') intake.tests_to_add.shift();
      if (mismatch === 'report typo') intake.allowed_edit_surface = intake.allowed_edit_surface.map((path: string) =>
        path.replace('run-e-eb15ab/**', 'run-e/**'));
      if (mismatch === 'runtime mismatch') write('.feature/intake.json', JSON.stringify({ ...intake, goal: 'uncommitted scope' }));
      else {
        write(intakePath, JSON.stringify(intake));
        write('.feature/intake.json', read(intakePath));
        git('add', intakePath); git('commit', '-qm', 'invalid intake');
      }
      expectRefused();
    },
  );

  it.each(['ancestry', 'committed production', 'unstaged', 'staged', 'untracked'])(
    'rejects Run E %s drift before startup', (mismatch) => {
      prepare();
      if (mismatch === 'ancestry') git('update-ref', 'HEAD', git('commit-tree', git('rev-parse', 'HEAD^{tree}'), '-m', 'unrelated'));
      else if (mismatch === 'untracked') write('src/foreign.ts', 'untracked');
      else {
        write('src/gate.ts', 'export const allow = () => true;');
        if (mismatch !== 'unstaged') git('add', 'src/gate.ts');
        if (mismatch === 'committed production') git('commit', '-qm', 'unapproved product');
      }
      expectRefused();
    },
  );

  it.each(['HEAD', 'branch', 'round', 'grant hash', 'missing pin', 'first run'])(
    'rejects Run E %s drift after admission without resetting launches', (mismatch) => {
      prepare();
      expect(run('run', ...HOME_FLAG(), '--', '/usr/bin/true').status).toBe(0);
      if (mismatch === 'HEAD') git('commit', '--allow-empty', '-qm', 'moved head');
      if (mismatch === 'branch') git('branch', '-m', 'codex/other');
      const value = JSON.parse(read('.feature/red-team-journal.json'));
      if (mismatch === 'round') value.round = 1;
      if (mismatch === 'grant hash') value.budgetAuthorization.sha256 = '0'.repeat(64);
      if (mismatch === 'missing pin') delete value.budgetAuthorization;
      if (mismatch === 'first run') value.budgetAuthorization.firstRun = 2;
      writeJournal(value);
      expectRefused(1);
    },
  );

  it('allows a journaled Run E mutant and refuses foreign replacement without overwriting it', () => {
    prepare();
    expect(run('run', ...HOME_FLAG(), '--', '/usr/bin/true').status).toBe(0);
    write('.feature/mutant.ts', 'export const allow = () => true;');
    expect(run('mutate', '--file', 'src/gate.ts', '--mutant', join(repo, '.feature/mutant.ts')).status).toBe(0);
    expect(run('run', ...HOME_FLAG(), '--', '/usr/bin/true').status).toBe(0);
    write('src/gate.ts', 'foreign edit');
    expectRefused(2);
    expect(run('finalize').status).toBe(1);
    expect(read('src/gate.ts')).toBe('foreign edit');
    write('src/gate.ts', read('.feature/mutant.ts'));
    expect(run('finalize').status).toBe(0);
    expect(read('src/gate.ts')).toBe('export const allow = (n: number) => n > 0;\n');
  });

  it('refuses to reset an already pinned Run E budget through round-start', () => {
    prepare();
    expect(run('run', ...HOME_FLAG(), '--', '/usr/bin/true').status).toBe(0);
    const pinned = JSON.parse(read('.feature/red-team-journal.json'));
    for (const round of [0, 1, 2, '1', null]) {
      const changed = { ...pinned, round };
      write('.feature/red-team-journal.json', JSON.stringify(changed));
      expect(run('round-start').status).toBe(1);
      expect(JSON.parse(read('.feature/red-team-journal.json'))).toEqual(changed);
      expect(existsSync(join(repo, '.feature/child-launched'))).toBe(false);
    }
    for (const change of [{ round: '1' }, { round: null }, { runs: -1 }, { runs: 0.5 }, { runs: '0' }, { runs: null }]) {
      const unpinned = { ...pinned, budgetAuthorization: undefined, ...change };
      write('.feature/red-team-journal.json', JSON.stringify(unpinned));
      const before = read('.feature/red-team-journal.json');
      expect(run('round-start').status).toBe(1);
      expect(read('.feature/red-team-journal.json')).toBe(before);
    }
  });

  it('requires a clean Run E first baseline even when a mutant is journaled', () => {
    prepare();
    write('.feature/mutant.ts', 'export const allow = () => true;');
    expect(run('mutate', '--file', 'src/gate.ts', '--mutant', join(repo, '.feature/mutant.ts')).status).toBe(0);
    expectRefused();
    expect(JSON.parse(read('.feature/red-team-journal.json')).budgetAuthorization).toBeUndefined();
    expect(journal().supervisors).toEqual([]);
    expect(run('finalize').status).toBe(0);
    expect(run('run', ...HOME_FLAG(), '--', '/usr/bin/true').status).toBe(0);
    expect(journal().runs).toBe(1);
  });

  it('allows Run E launch 1600 and refuses 1601 and a third round', () => {
    prepare();
    expect(run('run', ...HOME_FLAG(), '--', '/usr/bin/true').status).toBe(0);
    writeJournal({ ...journal(), runs: 1599 });
    expect(run('run', ...HOME_FLAG(), '--', '/usr/bin/true').status).toBe(0);
    expectRefused(1600);
    expect(run('round-start').stderr).toContain('grants no third round');
    expect(journal().runs).toBe(1600);
    write('.feature/red-team-journal.json', JSON.stringify({ ...journal(), round: 3 }));
    expectRefused(1600);
  });

  it('rejects invalid Run E counters and direct rounds without launching', () => {
    prepare();
    const original = JSON.parse(read('.feature/red-team-journal.json'));
    for (const runs of [-1, 0.5, '0', null]) {
      write('.feature/red-team-journal.json', JSON.stringify({ ...original, runs }));
      expect(run('run', ...HOME_FLAG(), '--', '/usr/bin/true').status).toBe(1);
      expect(journal().runs).toBe(runs);
      expect(journal().supervisors).toEqual([]);
    }
    for (const round of [0, 3, 4, '2', null]) {
      write('.feature/red-team-journal.json', JSON.stringify({ ...original, round }));
      expectRefused();
    }
    write('.feature/red-team-journal.json', JSON.stringify({ ...original, runs: 1 }));
    expectRefused(1);
  });

  describe('Run E same-round continuation', () => {
    const reviewDocument = 'docs/reviews/codex-owner-operator-run-e/budget-extension-review.md';
    const checkpointMarker = '<!-- RUN_E_CHECKPOINT_124_START -->';
    const originalDocument = '# Original admission review\n\nThe original discovery proof remains unchanged.\n';
    type ContinuationPin = { headSha: string; checkpointSha256: string; firstRun: number };
    type ContinuationJournal = Journal & {
      version: number;
      round: number;
      budgetAuthorization: { id: string; maxRuns: number; sha256: string; headSha: string; firstRun: number };
      continuationAdmission?: ContinuationPin;
    };

    const digest = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
    const section = (name: string, value: unknown) => [
      `<!-- RUN_E_${name}_START -->`, '```json', JSON.stringify(value), '```',
      `<!-- RUN_E_${name}_END -->`, '',
    ].join('\n');
    // These identities are inert historical records, not fake live processes.
    // An out-of-range pgid makes the shared teardown's process.kill throw
    // before the OS can receive a signal for an unrelated process.
    const inactiveSupervisor = (index: number) => ({
      pid: Number.MAX_SAFE_INTEGER - index, pgid: Number.MAX_SAFE_INTEGER - index,
      startedAt: 'historical-fixture', active: false,
    });

    function continuationJournal(): ContinuationJournal {
      return JSON.parse(read('.feature/red-team-journal.json')) as ContinuationJournal;
    }

    function replaceContinuationAnchor(name: string, value: string): void {
      const source = readFileSync(runner, 'utf8');
      const declaration = new RegExp(`const ${name} = '[^']+';`, 'g');
      expect(source.match(declaration), name).toHaveLength(1);
      writeFileSync(runner, source.replace(declaration, `const ${name} = '${value}';`));
    }

    function prepareContinuation() {
      prepare();
      write(reviewDocument, originalDocument);
      git('add', reviewDocument);
      git('commit', '-qm', 'original E admission with immutable discovery proof');
      const originalHead = git('rev-parse', 'HEAD');
      const originalOid = git('rev-parse', 'HEAD:src/gate.ts');
      const checkpoint: ContinuationJournal = {
        ...continuationJournal(),
        runs: 124,
        mutations: Array.from({ length: 62 }, (_, index) => ({
          path: `src/prior-${index}.ts`, originalOid, mutantOid: originalOid, state: 'restored',
        })),
        supervisors: Array.from({ length: 124 }, (_, index) => inactiveSupervisor(index)),
        budgetAuthorization: {
          id: approval.id, maxRuns: 1600, sha256: digest(approval), headSha: originalHead, firstRun: 1,
        },
      };
      const scope = { schema: 1, sourceHead: originalHead, groups: [{
        id: 'unchanged-behind-mock', ids: ['original-160'],
        reason: 'Reviewed source correction: the unchanged mock cuts the changed runtime edge.',
      }] };
      const checkpointSha256 = digest(checkpoint);
      const document = originalDocument + section('CHECKPOINT_124', checkpoint)
        + section('CONTINUATION_SCOPE_CORRECTIONS', scope);
      write(reviewDocument, document);
      git('add', reviewDocument);
      git('commit', '-qm', 'single finite E continuation admission');
      // Only trust anchors are rebound, after the real disposable histories
      // exist. The public runner executes its actual proof and launch protocol.
      replaceContinuationAnchor('RUN_E_ORIGINAL_ADMISSION', originalHead);
      replaceContinuationAnchor('RUN_E_CHECKPOINT_SHA256', checkpointSha256);
      replaceContinuationAnchor('RUN_E_CONTINUATION_SCOPE_SHA256', digest(scope));
      writeJournal(checkpoint);
      return {
        checkpoint, checkpointSha256, document, originalHead,
        successorHead: git('rev-parse', 'HEAD'),
      };
    }

    function expectContinuationRefused(): void {
      const before = read('.feature/red-team-journal.json');
      const result = run('run', ...HOME_FLAG(), '--', process.execPath, '-e',
        'require("node:fs").writeFileSync(".feature/child-launched","yes")');
      expect(result.status).toBe(1);
      expect(read('.feature/red-team-journal.json')).toBe(before);
      expect(existsSync(join(repo, '.feature/child-launched'))).toBe(false);
    }

    function launch125(): void {
      expect(run('run', ...HOME_FLAG(), '--', '/usr/bin/true').status).toBe(0);
      expect(journal().runs).toBe(125);
    }

    it('pins Run E continuation before launch 125 while preserving the original budget and checkpoint', () => {
      const fixture = prepareContinuation();
      const result = run('run', ...HOME_FLAG(), '--', process.execPath, '-e',
        'const fs=require("node:fs");const j=JSON.parse(fs.readFileSync(".feature/red-team-journal.json","utf8"));fs.writeFileSync(".feature/continuation-observed.json",JSON.stringify(j))');
      expect(result.status).toBe(0);
      const observed = JSON.parse(read('.feature/continuation-observed.json')) as ContinuationJournal;
      expect(observed.runs).toBe(125);
      expect(observed.budgetAuthorization).toEqual(fixture.checkpoint.budgetAuthorization);
      expect(observed.continuationAdmission).toEqual({
        headSha: fixture.successorHead, checkpointSha256: fixture.checkpointSha256, firstRun: 125,
      });
      expect(observed.mutations).toEqual(fixture.checkpoint.mutations);
      expect(observed.supervisors.slice(0, 124)).toEqual(fixture.checkpoint.supervisors);
      expect(observed.supervisors[124]?.active).toBe(true);
      expect(continuationJournal().supervisors[124]?.active).toBe(false);
    });

    it('allows a journaled mutant after the first Run E continuation baseline without replacing either pin', () => {
      const fixture = prepareContinuation();
      launch125();
      const pin = continuationJournal().continuationAdmission;
      write('.feature/mutant.ts', 'export const allow = () => true;\n');
      expect(run('mutate', '--file', 'src/gate.ts', '--mutant', join(repo, '.feature/mutant.ts')).status).toBe(0);
      expect(run('run', ...HOME_FLAG(), '--', process.execPath, '-e',
        'process.exit(require("node:fs").readFileSync("src/gate.ts","utf8").includes("() => true")?0:7)').status).toBe(0);
      expect(journal().runs).toBe(126);
      expect(continuationJournal().budgetAuthorization).toEqual(fixture.checkpoint.budgetAuthorization);
      expect(continuationJournal().continuationAdmission).toEqual(pin);
      expect(journal().mutations.slice(0, 62)).toEqual(fixture.checkpoint.mutations);
      expect(run('finalize').status).toBe(0);
      expect(read('src/gate.ts')).toBe('export const allow = (n: number) => n > 0;\n');
    });

    it('refuses missing or altered committed Run E continuation checkpoint evidence', () => {
      const fixture = prepareContinuation();
      for (const document of [
        originalDocument,
        fixture.document.replace('"runs":124', '"runs":123'),
        fixture.document.replace(checkpointMarker, `${checkpointMarker}\n${checkpointMarker}`),
      ]) {
        write(reviewDocument, document);
        git('add', reviewDocument);
        git('commit', '-qm', 'invalid committed checkpoint evidence');
        expectContinuationRefused();
      }
    });

    it('refuses Run E continuation when either immutable proof digest does not match', () => {
      const fixture = prepareContinuation();
      const originalRunner = readFileSync(runner, 'utf8');
      for (const anchor of ['RUN_E_CHECKPOINT_SHA256', 'RUN_E_CONTINUATION_SCOPE_SHA256']) {
        writeFileSync(runner, originalRunner);
        replaceContinuationAnchor(anchor, '0'.repeat(64));
        expectContinuationRefused();
      }
      expect(continuationJournal().budgetAuthorization.headSha).toBe(fixture.originalHead);
    });

    it('refuses changed or removed Run E checkpoint mutation and supervisor prefixes', () => {
      const { checkpoint } = prepareContinuation();
      const changedMutation = structuredClone(checkpoint);
      changedMutation.mutations[0]!.originalOid = '0'.repeat(40);
      const removedMutation = structuredClone(checkpoint);
      removedMutation.mutations.shift();
      const changedSupervisor = structuredClone(checkpoint);
      changedSupervisor.supervisors[0]!.startedAt = 'rewritten history';
      const removedSupervisor = structuredClone(checkpoint);
      removedSupervisor.supervisors.shift();
      for (const value of [changedMutation, removedMutation, changedSupervisor, removedSupervisor]) {
        writeJournal(value);
        expectContinuationRefused();
      }
    });

    it('refuses Run E continuation counter rollback and invented launches without supervisors', () => {
      const { checkpoint } = prepareContinuation();
      for (const runs of [123, 125, 124.5, '124', null]) {
        write('.feature/red-team-journal.json', JSON.stringify({ ...checkpoint, runs }));
        expectContinuationRefused();
      }
      writeJournal(checkpoint);
      launch125();
      const pinned = continuationJournal();
      writeJournal({ ...pinned, runs: 124, supervisors: pinned.supervisors.slice(0, 124) });
      expectContinuationRefused();
    });

    it('refuses rewriting the original Run E budget pin when admitting continuation', () => {
      const { checkpoint } = prepareContinuation();
      for (const change of [
        { headSha: git('rev-parse', 'HEAD') }, { firstRun: 125 },
        { sha256: '0'.repeat(64) }, { maxRuns: 1601 }, { id: 'replacement-grant' },
      ]) {
        writeJournal({ ...checkpoint, budgetAuthorization: { ...checkpoint.budgetAuthorization, ...change } });
        expectContinuationRefused();
      }
      write('.feature/red-team-journal.json', JSON.stringify({ ...checkpoint, budgetAuthorization: undefined }));
      expectContinuationRefused();
    });

    it('refuses a missing or altered Run E continuation pin after launch 125', () => {
      const fixture = prepareContinuation();
      launch125();
      const pinned = continuationJournal();
      for (const pin of [
        undefined,
        { ...pinned.continuationAdmission!, headSha: fixture.originalHead },
        { ...pinned.continuationAdmission!, checkpointSha256: '0'.repeat(64) },
        { ...pinned.continuationAdmission!, firstRun: 126 },
      ]) {
        writeJournal({ ...pinned, continuationAdmission: pin });
        expectContinuationRefused();
      }
    });

    it('requires a clean first Run E continuation baseline even for a journaled mutant', () => {
      prepareContinuation();
      write('.feature/mutant.ts', 'export const allow = () => true;\n');
      expect(run('mutate', '--file', 'src/gate.ts', '--mutant', join(repo, '.feature/mutant.ts')).status).toBe(0);
      expectContinuationRefused();
      expect(continuationJournal().continuationAdmission).toBeUndefined();
      expect(run('finalize').status).toBe(0);
      // Restoration closes the new record; it must not erase it to make an
      // unpinned checkpoint look exact again.
      expectContinuationRefused();
      expect(journal().runs).toBe(124);
    });

    it('refuses committed product intake history and unrelated support drift in Run E continuation', () => {
      prepareContinuation();
      for (const path of [
        'src/gate.ts', intakePath, report, markdown, 'docs/runbooks/beta-launch-alerting.md',
      ]) {
        const present = existsSync(join(repo, path));
        const original = present ? read(path) : '';
        write(path, `${original}\nUnapproved continuation change\n`);
        git('add', path);
        git('commit', '-qm', 'change outside finite continuation support');
        expectContinuationRefused();
        if (present) write(path, original);
        else rmSync(join(repo, path));
        git('add', path);
        git('commit', '-qm', 'restore disposable fixture boundary');
      }
      write('src/untracked.ts', 'foreign file');
      expectContinuationRefused();
    });

    it('refuses rewriting the original discovery document while appending Run E continuation proof', () => {
      const fixture = prepareContinuation();
      write(reviewDocument, fixture.document.replace('original discovery proof remains unchanged', 'original discovery proof was replaced'));
      git('add', reviewDocument);
      git('commit', '-qm', 'overwrite original discovery evidence');
      expectContinuationRefused();
    });

    it('refuses a second Run E continuation successor without resetting its spent budget', () => {
      prepareContinuation();
      launch125();
      const pinned = continuationJournal();
      write(reviewDocument, `${read(reviewDocument)}\nA second supporting correction.\n`);
      git('add', reviewDocument);
      git('commit', '-qm', 'unadmitted second successor');
      expectContinuationRefused();
      expect(continuationJournal()).toEqual(pinned);
    });

    it('keeps Run E continuation branch and third-round boundaries closed', () => {
      prepareContinuation();
      launch125();
      const pinned = continuationJournal();
      expect(run('round-start').status).toBe(1);
      expect(continuationJournal()).toEqual(pinned);
      writeJournal({ ...pinned, round: 3 });
      expectContinuationRefused();
      writeJournal(pinned);
      git('branch', '-m', 'codex/foreign-continuation');
      expectContinuationRefused();
      // Removing every mutable hint of E must not recover the generic round-1
      // allowance or let round-start replace the spent continuation journal.
      // The committed successor ancestry still identifies this execution.
      for (const branch of ['codex/owner-operator-run-e', 'codex/renamed-stripped-continuation']) {
        git('branch', '-m', branch);
        const stripped = {
          version: 1, round: 1, runs: 0, mutations: [], supervisors: [],
          dotenv: { open: false, files: [] },
        };
        write('.feature/red-team-journal.json', JSON.stringify(stripped));
        expectContinuationRefused();
        const beforeRoundStart = read('.feature/red-team-journal.json');
        expect(run('round-start').status, branch).toBe(1);
        expect(read('.feature/red-team-journal.json'), branch).toBe(beforeRoundStart);
        expect(existsSync(join(repo, '.feature/child-launched'))).toBe(false);
      }
    });

    it('allows Run E continuation launch 1600 and refuses 1601 under the original cap', () => {
      const fixture = prepareContinuation();
      launch125();
      const pinned = continuationJournal();
      writeJournal({ ...pinned, runs: 1599, supervisors: [
        ...pinned.supervisors,
        ...Array.from({ length: 1599 - pinned.supervisors.length }, (_, index) => inactiveSupervisor(1000 + index)),
      ] });
      expect(run('run', ...HOME_FLAG(), '--', '/usr/bin/true').status).toBe(0);
      expect(journal().runs).toBe(1600);
      expectContinuationRefused();
      expect(continuationJournal().budgetAuthorization).toEqual(fixture.checkpoint.budgetAuthorization);
      expect(continuationJournal().continuationAdmission).toEqual(pinned.continuationAdmission);
    });

    it('refuses structurally invalid Run E continuation checkpoints even with matching fixture digests', () => {
      const fixture = prepareContinuation();
      const originalRunner = readFileSync(runner, 'utf8');
      const invalid = [
        { ...fixture.checkpoint, unexpectedAuthority: true },
        { ...fixture.checkpoint, mutations: fixture.checkpoint.mutations.slice(1) },
        { ...fixture.checkpoint, supervisors: fixture.checkpoint.supervisors.map((entry, index) =>
          index === 0 ? { ...entry, active: true } : entry) },
        { ...fixture.checkpoint, dotenv: { open: true, files: [] } },
      ];
      for (const checkpoint of invalid) {
        const document = fixture.document.replace(JSON.stringify(fixture.checkpoint), JSON.stringify(checkpoint));
        write(reviewDocument, document);
        git('add', reviewDocument);
        git('commit', '-qm', 'malformed checkpoint with independently rebound fixture digest');
        writeFileSync(runner, originalRunner);
        replaceContinuationAnchor('RUN_E_CHECKPOINT_SHA256', digest(checkpoint));
        writeJournal(checkpoint);
        expectContinuationRefused();
      }
    });
    describe('Run E finite corrective admission', () => {
      const settingsPath = 'src/lib/auto-approval/__tests__/settings.test.ts';
      const deviationsPath = 'docs/superpowers/plans/codex-owner-operator-run-e-deviations.md';
      const correctedSettings = "export const locationId = 'bbbbbbbb-0000-4000-8000-000000000001';\n";
      const checkpointRuns = 126;
      type CorrectivePin = { headSha: string; predecessorHeadSha: string; checkpointSha256: string; firstRun: number };
      type CorrectiveJournal = ContinuationJournal & { correctiveAdmission?: CorrectivePin };

      function correctiveJournal(): CorrectiveJournal {
        return JSON.parse(read('.feature/red-team-journal.json')) as CorrectiveJournal;
      }

      function resetCorrectiveFixture(): void {
        rmSync(repo, { recursive: true, force: true });
        mkdirSync(repo, { recursive: true });
        git('init', '-q', '-b', 'fixture');
        git('config', 'user.email', 'red-team@example.test');
        git('config', 'user.name', 'red team');
        write('src/gate.ts', 'export const allow = (n: number) => n > 0;\n');
        git('add', 'src/gate.ts');
        git('commit', '-qm', 'independent corrective fixture baseline');
      }

      function prepareCorrective(options: {
        changeDocument?: (document: string) => string;
        settingsContents?: string;
        extraChange?: { path: string; contents: string };
      } = {}) {
        const continuation = prepareContinuation();
        write(deviationsPath, '# Preserved predecessor deviations\n');
        git('add', deviationsPath);
        git('commit', '-qm', 'freeze synthetic continuation predecessor');
        const predecessorHead = git('rev-parse', 'HEAD');
        const checkpoint: CorrectiveJournal = {
          ...structuredClone(continuation.checkpoint), runs: checkpointRuns,
          mutations: [...continuation.checkpoint.mutations, {
            path: 'src/gate.ts', originalOid: git('rev-parse', 'HEAD:src/gate.ts'),
            mutantOid: git('rev-parse', 'HEAD:src/gate.ts'), state: 'restored',
          }],
          supervisors: [...continuation.checkpoint.supervisors, inactiveSupervisor(124), inactiveSupervisor(125)],
          continuationAdmission: { headSha: predecessorHead, checkpointSha256: continuation.checkpointSha256, firstRun: 125 },
        };
        const checkpointSha256 = digest(checkpoint);
        const blob = createHash('sha1').update(`blob ${Buffer.byteLength(correctedSettings)}\0${correctedSettings}`).digest('hex');
        replaceContinuationAnchor('RUN_E_CORRECTIVE_PREDECESSOR', predecessorHead);
        replaceContinuationAnchor('RUN_E_CORRECTIVE_CHECKPOINT_SHA256', checkpointSha256);
        let source = readFileSync(runner, 'utf8');
        const runsAnchor = /const RUN_E_CORRECTIVE_CHECKPOINT_RUNS = -?\d+;/g;
        const blobsAnchor = /const RUN_E_CORRECTIVE_TEST_BLOBS = Object\.freeze\(\{[\s\S]*?\}\);/g;
        expect(source.match(runsAnchor)).toHaveLength(1);
        expect(source.match(blobsAnchor)).toHaveLength(1);
        source = source.replace(runsAnchor, `const RUN_E_CORRECTIVE_CHECKPOINT_RUNS = ${checkpointRuns};`)
          .replace(blobsAnchor, `const RUN_E_CORRECTIVE_TEST_BLOBS = Object.freeze(${JSON.stringify({ [settingsPath]: blob })});`);
        writeFileSync(runner, source);
        const document = `${read(reviewDocument)}${section('CORRECTIVE_CHECKPOINT', checkpoint)}`;
        write(reviewDocument, options.changeDocument?.(document) ?? document);
        write(settingsPath, options.settingsContents ?? correctedSettings);
        git('add', reviewDocument, settingsPath);
        if (options.extraChange) {
          write(options.extraChange.path, options.extraChange.contents);
          git('add', options.extraChange.path);
        }
        git('commit', '-qm', 'exact finite corrective candidate');
        const headSha = git('rev-parse', 'HEAD');
        const pin: CorrectivePin = { headSha, predecessorHeadSha: predecessorHead, checkpointSha256, firstRun: checkpointRuns + 1 };
        writeJournal(checkpoint);
        return { checkpoint, pin, predecessorHead, document };
      }

      function expectCorrectiveRefused(label: string): void {
        const before = read('.feature/red-team-journal.json');
        const result = run('run', ...HOME_FLAG(), '--', process.execPath, '-e',
          'require("node:fs").writeFileSync(".feature/corrective-child-launched","yes")');
        expect(result.status, label).toBe(1);
        expect(read('.feature/red-team-journal.json'), label).toBe(before);
        expect(existsSync(join(repo, '.feature/corrective-child-launched')), label).toBe(false);
      }


      describe('Run E finite staging diagnostic admission', () => {
        const diagnosticPath = 'src/diagnostic.ts';
        const diagnosticCode = 'export const diagnostic = "closed";\n';
        const stagingRuns = 128;
        type StagingJournal = CorrectiveJournal & { stagingCorrectionAdmission?: CorrectivePin };

        function prepareStaging(options: {
          changeDocument?: (document: string) => string;
          diagnosticContents?: string;
          extraPath?: string;
        } = {}) {
          const previous = prepareCorrective();
          const checkpoint: StagingJournal = {
            ...structuredClone(previous.checkpoint), runs: stagingRuns,
            correctiveAdmission: previous.pin,
            mutations: [...previous.checkpoint.mutations, {
              path: settingsPath, originalOid: git('rev-parse', `HEAD:${settingsPath}`),
              mutantOid: git('rev-parse', `HEAD:${settingsPath}`), state: 'restored',
            }],
            supervisors: [...previous.checkpoint.supervisors, inactiveSupervisor(126), inactiveSupervisor(127)],
          };
          const historical = JSON.parse(read(report));
          historical.round = 2;
          historical.head_sha = previous.pin.headSha;
          write(report, JSON.stringify(historical));
          write(markdown, read(markdown) + '\n# Frozen completed corrective evidence\n');
          git('add', report, markdown);
          git('commit', '-qm', 'publish immutable completed corrective report');
          const publication = git('rev-parse', 'HEAD');
          write(diagnosticPath, options.diagnosticContents ?? diagnosticCode);
          git('add', diagnosticPath);
          git('commit', '-qm', 'intermediate diagnostic candidate');
          const diagnosticHead = git('rev-parse', 'HEAD');
          const checkpointSha256 = digest(checkpoint);
          for (const [name, value] of Object.entries({
            RUN_E_STAGING_PREDECESSOR: previous.pin.headSha,
            RUN_E_STAGING_PUBLICATION: publication,
            RUN_E_STAGING_DIAGNOSTIC: diagnosticHead,
            RUN_E_STAGING_CHECKPOINT_SHA256: checkpointSha256,
            RUN_E_STAGING_REPORT_SHA256: createHash('sha256').update(read(report)).digest('hex'),
            RUN_E_STAGING_MARKDOWN_SHA256: createHash('sha256').update(read(markdown)).digest('hex'),
          })) replaceContinuationAnchor(name, value);
          const blob = createHash('sha1').update(`blob ${Buffer.byteLength(diagnosticCode)}\0${diagnosticCode}`).digest('hex');
          let source = readFileSync(runner, 'utf8');
          const runsAnchor = /const RUN_E_STAGING_CHECKPOINT_RUNS = \d+;/g;
          const blobsAnchor = /const RUN_E_STAGING_BLOBS = Object\.freeze\(\{[\s\S]*?\}\);/g;
          expect(source.match(runsAnchor)).toHaveLength(1);
          expect(source.match(blobsAnchor)).toHaveLength(1);
          source = source.replace(runsAnchor, `const RUN_E_STAGING_CHECKPOINT_RUNS = ${stagingRuns};`)
            .replace(blobsAnchor, `const RUN_E_STAGING_BLOBS = Object.freeze(${JSON.stringify({ [diagnosticPath]: blob })});`);
          writeFileSync(runner, source);
          const document = read(reviewDocument) + section('STAGING_CHECKPOINT_776', checkpoint);
          write(reviewDocument, options.changeDocument?.(document) ?? document);
          git('add', reviewDocument);
          if (options.extraPath) {
            write(options.extraPath, 'unreviewed\n');
            git('add', options.extraPath);
          }
          git('commit', '-qm', 'finite staging admission support');
          const headSha = git('rev-parse', 'HEAD');
          const pin: CorrectivePin = {
            headSha, predecessorHeadSha: previous.pin.headSha, checkpointSha256, firstRun: stagingRuns + 1,
          };
          writeJournal(checkpoint);
          return { checkpoint, pin, document };
        }

        function stagingJournal(): StagingJournal {
          return JSON.parse(read('.feature/red-team-journal.json')) as StagingJournal;
        }

        it('pins the staging diagnostic before its next launch and preserves all three historical admissions', () => {
          prepareCorrective();
          expect(run('run', ...HOME_FLAG(), '--', '/usr/bin/true')).toMatchObject({ status: 0, stderr: '' });
          resetCorrectiveFixture();
          const fixture = prepareStaging();
          const result = run('run', ...HOME_FLAG(), '--', process.execPath, '-e',
            'const fs=require("node:fs");fs.writeFileSync(".feature/staging-observed.json",fs.readFileSync(".feature/red-team-journal.json"))');
          expect(result).toMatchObject({ status: 0, stderr: '' });
          const observed = JSON.parse(read('.feature/staging-observed.json')) as StagingJournal;
          expect(observed.runs).toBe(stagingRuns + 1);
          expect(observed.stagingCorrectionAdmission).toEqual(fixture.pin);
          for (const key of ['budgetAuthorization', 'continuationAdmission', 'correctiveAdmission'] as const) {
            expect(observed[key]).toEqual(fixture.checkpoint[key]);
          }
          expect(observed.mutations).toEqual(fixture.checkpoint.mutations);
          expect(observed.supervisors.slice(0, stagingRuns)).toEqual(fixture.checkpoint.supervisors);
          expect(observed.supervisors[stagingRuns]?.active).toBe(true);
          expect(stagingJournal().supervisors[stagingRuns]?.active).toBe(false);
        }, SUITE_TIMEOUT_MS);

        it('requires a clean first staging baseline and restores a later journaled diagnostic mutant', () => {
          prepareStaging();
          write('.feature/staging-mutant.ts', diagnosticCode + '// mutant\n');
          expect(run('mutate', '--file', diagnosticPath, '--mutant', join(repo, '.feature/staging-mutant.ts')).status).toBe(0);
          expectCorrectiveRefused('journaled dirty first staging baseline');
          expect(stagingJournal().stagingCorrectionAdmission).toBeUndefined();
          expect(run('finalize').status).toBe(0);
          expectCorrectiveRefused('first checkpoint cannot acquire an extra restored mutation');
          resetCorrectiveFixture();
          const secondFixture = prepareStaging();
          expect(run('run', ...HOME_FLAG(), '--', '/usr/bin/true').status).toBe(0);
          write('.feature/staging-mutant.ts', diagnosticCode + '// mutant\n');
          expect(run('mutate', '--file', diagnosticPath, '--mutant', join(repo, '.feature/staging-mutant.ts')).status).toBe(0);
          expect(run('run', ...HOME_FLAG(), '--', process.execPath, '-e',
            `process.exit(require('node:fs').readFileSync('${diagnosticPath}','utf8').includes('// mutant')?0:7)`).status).toBe(0);
          expect(stagingJournal().runs).toBe(stagingRuns + 2);
          expect(stagingJournal().mutations.slice(0, secondFixture.checkpoint.mutations.length)).toEqual(secondFixture.checkpoint.mutations);
          expect(run('finalize').status).toBe(0);
          expect(read(diagnosticPath)).toBe(diagnosticCode);
          expect(stagingJournal().mutations.at(-1)?.state).toBe('restored');
        }, SUITE_TIMEOUT_MS);

        it('rejects altered staging checkpoint history, diagnostic blobs, and unreviewed paths without a child', () => {
          const variants: Array<Parameters<typeof prepareStaging>[0]> = [
            { diagnosticContents: diagnosticCode + '// changed\n' },
            { extraPath: 'src/unreviewed.ts' },
            { changeDocument: (document) => document.replace('STAGING_CHECKPOINT_776_START', 'UNCOMMITTED_CHECKPOINT_START') },
            { changeDocument: (document) => document.replace('"runs":128', '"runs":127') },
          ];
          for (const [index, options] of variants.entries()) {
            resetCorrectiveFixture();
            const fixture = prepareStaging(options);
            expectCorrectiveRefused(`staging evidence ${index}`);
            write(reviewDocument, fixture.document);
            expectCorrectiveRefused(`live repair cannot replace committed evidence ${index}`);
          }
        }, SUITE_TIMEOUT_MS);

        it('refuses staging counter rollback, changed old pins, stripped admissions, and renamed round resets', () => {
          prepareStaging();
          expect(run('run', ...HOME_FLAG(), '--', '/usr/bin/true').status).toBe(0);
          const pinned = stagingJournal();
          const changes: Array<[string, (journal: StagingJournal) => void]> = [
            ['staging pin missing', (value) => { delete value.stagingCorrectionAdmission; }],
            ['counter rollback', (value) => { value.runs = stagingRuns; value.supervisors.pop(); }],
            ['counter without supervisor', (value) => { value.runs += 1; }],
            ['supervisor prefix changed', (value) => { value.supervisors[0]!.active = true; }],
            ['mutation prefix changed', (value) => { value.mutations[0]!.state = 'prepared'; }],
            ['original pin changed', (value) => { value.budgetAuthorization.headSha = '0'.repeat(40); }],
            ['continuation pin changed', (value) => { value.continuationAdmission!.firstRun = 126; }],
            ['corrective pin changed', (value) => { value.correctiveAdmission!.firstRun = 128; }],
            ['staging pin changed', (value) => { value.stagingCorrectionAdmission!.firstRun = 128; }],
          ];
          for (const [label, change] of changes) {
            const value = structuredClone(pinned);
            change(value);
            writeJournal(value);
            expectCorrectiveRefused(label);
          }
          for (const branch of ['codex/owner-operator-run-e', 'codex/renamed-staging-diagnostic']) {
            git('branch', '-m', branch);
            writeJournal({ version: 1, round: 1, runs: 0, mutations: [], supervisors: [], dotenv: { open: false, files: [] } });
            expectCorrectiveRefused(branch);
            const before = read('.feature/red-team-journal.json');
            expect(run('round-start').status).toBe(1);
            expect(read('.feature/red-team-journal.json')).toBe(before);
          }
        }, SUITE_TIMEOUT_MS);

        it('allows staging launch 1600 but refuses 1601, third-round prose, and a second staging candidate', () => {
          prepareStaging();
          expect(run('run', ...HOME_FLAG(), '--', '/usr/bin/true').status).toBe(0);
          const capped = stagingJournal();
          capped.supervisors.push(...Array.from({ length: 1599 - capped.runs }, (_, index) => inactiveSupervisor(capped.runs + index)));
          capped.runs = 1599;
          writeJournal(capped);
          expect(run('run', ...HOME_FLAG(), '--', '/usr/bin/true').status).toBe(0);
          expect(stagingJournal().runs).toBe(1600);
          expectCorrectiveRefused('staging launch 1601');
          for (const text of ['no third round', 'third round authorized']) {
            const value = stagingJournal();
            value.round = 3;
            writeJournal(value);
            const sidecar = JSON.parse(read(report));
            sidecar.authorizations.push({ id: 'forged', date: '2026-09-15', finding_ids: [], text });
            write(report, JSON.stringify(sidecar));
            expectCorrectiveRefused(text);
          }
          resetCorrectiveFixture();
          prepareStaging();
          expect(run('run', ...HOME_FLAG(), '--', '/usr/bin/true').status).toBe(0);
          write(reviewDocument, read(reviewDocument) + '\nAnother candidate is not admitted.\n');
          git('add', reviewDocument);
          git('commit', '-qm', 'second staging candidate below cap');
          expectCorrectiveRefused('second staging candidate');
        }, SUITE_TIMEOUT_MS);
      });

      it('pins the finite Run E correction before launch N+1 and preserves both earlier admissions', () => {
        // Exercise the real missing-predecessor probe before rebinding its anchor.
        prepareContinuation();
        expect(run('run', ...HOME_FLAG(), '--', '/usr/bin/true')).toMatchObject({ status: 0, stderr: '' });
        resetCorrectiveFixture();
        const fixture = prepareCorrective();
        const result = run('run', ...HOME_FLAG(), '--', process.execPath, '-e',
          'const fs=require("node:fs");fs.writeFileSync(".feature/corrective-observed.json",fs.readFileSync(".feature/red-team-journal.json"))');
        expect(result).toMatchObject({ status: 0, stderr: '' });
        const observed = JSON.parse(read('.feature/corrective-observed.json')) as CorrectiveJournal;
        expect(observed.runs).toBe(checkpointRuns + 1);
        expect(observed.budgetAuthorization).toEqual(fixture.checkpoint.budgetAuthorization);
        expect(observed.continuationAdmission).toEqual(fixture.checkpoint.continuationAdmission);
        expect(observed.correctiveAdmission).toEqual(fixture.pin);
        expect(observed.mutations).toEqual(fixture.checkpoint.mutations);
        expect(observed.supervisors.slice(0, checkpointRuns)).toEqual(fixture.checkpoint.supervisors);
        expect(observed.supervisors[checkpointRuns]?.active).toBe(true);
        expect(correctiveJournal().supervisors[checkpointRuns]?.active).toBe(false);
      }, SUITE_TIMEOUT_MS);

      it('runs and restores a later corrective journaled mutant while refusing a dirty first baseline', () => {
        const fixture = prepareCorrective();
        expect(run('run', ...HOME_FLAG(), '--', '/usr/bin/true').status).toBe(0);
        write('.feature/corrective-mutant.ts', `${correctedSettings}// journaled corrective mutant\n`);
        expect(run('mutate', '--file', settingsPath, '--mutant', join(repo, '.feature/corrective-mutant.ts')).status).toBe(0);
        expect(run('run', ...HOME_FLAG(), '--', process.execPath, '-e',
          `process.exit(require("node:fs").readFileSync(${JSON.stringify(settingsPath)},"utf8").includes("journaled corrective mutant")?0:7)`).status).toBe(0);
        expect(correctiveJournal().runs).toBe(checkpointRuns + 2);
        expect(correctiveJournal().budgetAuthorization).toEqual(fixture.checkpoint.budgetAuthorization);
        expect(correctiveJournal().continuationAdmission).toEqual(fixture.checkpoint.continuationAdmission);
        expect(correctiveJournal().correctiveAdmission).toEqual(fixture.pin);
        expect(correctiveJournal().mutations.slice(0, fixture.checkpoint.mutations.length)).toEqual(fixture.checkpoint.mutations);
        expect(run('finalize').status).toBe(0);
        expect(read(settingsPath)).toBe(correctedSettings);
        expect(correctiveJournal().mutations.at(-1)?.state).toBe('restored');
        resetCorrectiveFixture();
        prepareCorrective();
        write('.feature/corrective-mutant.ts', `${correctedSettings}// dirty first candidate\n`);
        expect(run('mutate', '--file', settingsPath, '--mutant', join(repo, '.feature/corrective-mutant.ts')).status).toBe(0);
        expectCorrectiveRefused('journaled mutation before first corrective baseline');
        expect(correctiveJournal().correctiveAdmission).toBeUndefined();
        expect(run('finalize').status).toBe(0);
        expectCorrectiveRefused('restoration cannot erase the extra pre-admission mutation');
      }, SUITE_TIMEOUT_MS);

      it('rejects uncommitted or altered corrective checkpoint evidence, exact test blobs, and extra paths', () => {
        const variants: Array<{ label: string; options: Parameters<typeof prepareCorrective>[0] }> = [
          { label: 'missing checkpoint', options: { changeDocument: (document) => document.replace(/<!-- RUN_E_CORRECTIVE_CHECKPOINT_START -->[\s\S]*?<!-- RUN_E_CORRECTIVE_CHECKPOINT_END -->\n/, '') } },
          { label: 'changed checkpoint', options: { changeDocument: (document) => document.replace('"runs":126', '"runs":125') } },
          { label: 'changed predecessor review prefix', options: { changeDocument: (document) => `replacement prefix\n${document}` } },
          { label: 'wrong settings blob', options: { settingsContents: `${correctedSettings}// unreviewed addition\n` } },
          { label: 'extra product path', options: { extraChange: { path: 'src/gate.ts', contents: 'export const allow = () => true;\n' } } },
          { label: 'rewritten predecessor deviations', options: { extraChange: { path: deviationsPath, contents: '# Replacement deviations\n' } } },
        ];
        for (const variant of variants) {
          resetCorrectiveFixture();
          const fixture = prepareCorrective(variant.options);
          expectCorrectiveRefused(variant.label);
          // A repaired live document cannot replace the committed checkpoint.
          if (variant.label.includes('checkpoint')) {
            write(reviewDocument, fixture.document);
            expectCorrectiveRefused(`${variant.label} with a repaired live document`);
          }
        }
      }, SUITE_TIMEOUT_MS);

      it('refuses corrective pin stripping, prefix changes, counter rollback, and renamed round downgrades', () => {
        const fixture = prepareCorrective();
        expect(run('run', ...HOME_FLAG(), '--', '/usr/bin/true').status).toBe(0);
        const pinned = correctiveJournal();
        const changes: Array<[string, (value: CorrectiveJournal) => void]> = [
          ['missing corrective pin', (value) => { delete value.correctiveAdmission; }],
          ['missing original pin', (value) => { Reflect.deleteProperty(value, 'budgetAuthorization'); }],
          ['missing continuation pin', (value) => { delete value.continuationAdmission; }],
          ['changed corrective head', (value) => { value.correctiveAdmission!.headSha = fixture.predecessorHead; }],
          ['changed predecessor pin', (value) => { value.correctiveAdmission!.predecessorHeadSha = fixture.checkpoint.budgetAuthorization.headSha; }],
          ['changed checkpoint pin', (value) => { value.correctiveAdmission!.checkpointSha256 = '0'.repeat(64); }],
          ['changed first run', (value) => { value.correctiveAdmission!.firstRun = checkpointRuns; }],
          ['changed old pin', (value) => { value.continuationAdmission!.firstRun = checkpointRuns + 1; }],
          ['mutation prefix', (value) => { value.mutations[0]!.originalOid = '0'.repeat(40); }],
          ['supervisor prefix', (value) => { value.supervisors[0]!.startedAt = 'replacement'; }],
          ['counter rollback', (value) => { value.runs = checkpointRuns; value.supervisors.pop(); }],
          ['counter without supervisor', (value) => { value.runs += 1; }],
          ['negative counter', (value) => { value.runs = -1; }],
          ['fractional counter', (value) => { value.runs = checkpointRuns + 0.5; }],
          ['string counter', (value) => { Reflect.set(value, 'runs', String(checkpointRuns)); }],
          ['null counter', (value) => { Reflect.set(value, 'runs', null); }],
          ['third round', (value) => { value.round = 3; }],
        ];
        for (const [label, change] of changes) {
          const value = structuredClone(pinned);
          change(value);
          writeJournal(value);
          expectCorrectiveRefused(label);
        }
        writeJournal(pinned);
        git('branch', '-m', 'codex/renamed-pinned-corrective');
        expectCorrectiveRefused('renamed branch with round two and all pins intact');
        for (const branch of ['codex/owner-operator-run-e', 'codex/renamed-corrective-fixture']) {
          git('branch', '-m', branch);
          writeJournal({ version: 1, round: 1, runs: 0, mutations: [], supervisors: [], dotenv: { open: false, files: [] } });
          expectCorrectiveRefused(`stripped round-one ${branch}`);
          const before = read('.feature/red-team-journal.json');
          expect(run('round-start').status, branch).toBe(1);
          expect(read('.feature/red-team-journal.json')).toBe(before);
        }
      }, SUITE_TIMEOUT_MS);

      it('allows corrective launch 1600 but refuses 1601, third-round prose, and another candidate', () => {
        const fixture = prepareCorrective();
        expect(run('run', ...HOME_FLAG(), '--', '/usr/bin/true').status).toBe(0);
        const pinned = correctiveJournal();
        writeJournal({ ...pinned, runs: 1599, supervisors: [
          ...pinned.supervisors,
          ...Array.from({ length: 1599 - pinned.supervisors.length }, (_, index) => inactiveSupervisor(1000 + index)),
        ] });
        expect(run('run', ...HOME_FLAG(), '--', '/usr/bin/true').status).toBe(0);
        expect(correctiveJournal().runs).toBe(1600);
        expect(correctiveJournal().correctiveAdmission).toEqual(fixture.pin);
        expectCorrectiveRefused('launch 1601');
        for (const text of ['third round authorized', 'no third round']) {
          const evidence = JSON.parse(read(report));
          evidence.authorizations[0].text = text;
          write(report, JSON.stringify(evidence));
          const before = read('.feature/red-team-journal.json');
          expect(run('round-start').status, text).toBe(1);
          expect(read('.feature/red-team-journal.json')).toBe(before);
        }
        // Test successor refusal below the cap so budget exhaustion cannot mask it.
        resetCorrectiveFixture();
        prepareCorrective();
        expect(run('run', ...HOME_FLAG(), '--', '/usr/bin/true').status).toBe(0);
        write(reviewDocument, `${read(reviewDocument)}\nUnadmitted additional candidate.\n`);
        git('add', reviewDocument);
        git('commit', '-qm', 'additional candidate after corrective pin');
        expectCorrectiveRefused('additional candidate below the cap');
      }, SUITE_TIMEOUT_MS);
    });

  });

  it('refuses E third-round opening for both positive and negated prose and a renamed pinned branch', () => {
    prepare();
    expect(run('run', ...HOME_FLAG(), '--', '/usr/bin/true').status).toBe(0);
    for (const text of ['third round authorized', 'no third round']) {
      const sidecar = JSON.parse(read(report));
      sidecar.authorizations[0].text = text;
      write(report, JSON.stringify(sidecar));
      expect(run('round-start').status).toBe(1);
      expect(journal().runs).toBe(1);
    }
    git('branch', '-m', 'codex/other');
    expect(run('round-start').status).toBe(1);
    expectRefused(1);
  });

  it.each(['other branch', 'first round'])('preserves the ordinary budget for %s with E evidence present', (scope) => {
    prepare();
    if (scope === 'other branch') git('branch', '-m', 'codex/other');
    else write('.feature/red-team-journal.json', JSON.stringify({ ...journal(), round: 1 }));
    expect(run('run', ...HOME_FLAG(), '--', '/usr/bin/true').status).toBe(0);
    expect(JSON.parse(read('.feature/red-team-journal.json')).budgetAuthorization).toBeUndefined();
    writeJournal({ ...journal(), runs: ORDINARY_MAX_RUNS });
    expectRefused(ORDINARY_MAX_RUNS);
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

  // A fixture process list must be resolved with a FIXTURE cwd lookup. This
  // pid is live and its cwd is the checkout running the test, never the
  // fixture root: resolved with the real `lsof` the abort silently disappears,
  // and the cases above pass only because pid 999 happens not to exist here.
  // The pid is listed, never signalled.
  it('resolves a fixture process list without reading the machine\'s live cwds', () => {
    write('ps.txt', ` ${process.pid} node /x/next dev\n`);
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
  }, SUITE_TIMEOUT_MS);

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
  }, SUITE_TIMEOUT_MS);

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
  }, SUITE_TIMEOUT_MS);

  it('reaps a live journaled group whose identity does match', async () => {
    const { pgid } = adoptLiveGroup({});
    expect(await waitFor(() => !groupIsEmpty(pgid))).toBe(true);

    expect(run('reap').status).toBe(0);
    expect(groupIsEmpty(pgid)).toBe(true);
    expect(journal().supervisors[0]!.active).toBe(false);
  }, SUITE_TIMEOUT_MS);

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
  }, SUITE_TIMEOUT_MS);
});

// `kill(-1)` reaches every process the user owns. The journal is a file, so a
// corrupt entry must not be able to aim reapGroup there. process.kill is STUBBED
// for the whole case: if the guard ever regresses, this test fails — it must
// never be able to send the signal it is checking for.
describe('reapGroup refuses a pgid that is not a process group', () => {
  it.each([[1], [0], [-1], [-5], [1.5], [Number.NaN], ['1'], [null], [undefined]])('refuses pgid %j without signalling', async (pgid) => {
    const kill = vi.spyOn(process, 'kill').mockImplementation(() => { throw new Error('a signal was attempted'); });
    try {
      const { reapGroup } = await import(/* @vite-ignore */ RUNNER) as {
        reapGroup: (supervisor: unknown) => Promise<{ ok: boolean; reason?: string }>;
      };
      // A dead leader (start time unknown) is the branch that used to fall through.
      const result = await reapGroup({ pid: Number.MAX_SAFE_INTEGER, pgid, startedAt: 'fixture' });
      expect(result.ok).toBe(false);
      expect(result.reason).toContain('not a signalable process group');
      expect(kill).not.toHaveBeenCalled();
    } finally {
      kill.mockRestore();
    }
  });
});

describe('the mutation budget', () => {
  // `runs: 30` is the #1185 checkpoint — the point its grant continues from —
  // not the ordinary cap, which is a clock with a launch-count backstop.
  function exhausted(runs = 30, supervisors: unknown[] = []) {
    write('.feature/red-team-journal.json', JSON.stringify({
      version: 1, round: 1, runs, mutations: [], dotenv: { open: false, files: [] }, supervisors,
    }, null, 2));
  }
  // Inert records, never live processes: an out-of-range pgid cannot name one.
  const INERT = { pid: Number.MAX_SAFE_INTEGER, pgid: Number.MAX_SAFE_INTEGER, startedAt: 'budget-fixture', active: false, command: 'true', at: 'budget-fixture' };
  const spent = (elapsedMs: number) => ({ ...INERT, timeoutMs: 120_000, elapsedMs });

  it('refuses a launch once the round has spent its test-time budget, and names the status', () => {
    exhausted(3, [spent(600_000), spent(599_000), spent(1_000)]);
    const result = run('run', ...HOME_FLAG(), '--', '/usr/bin/true');
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('budget exhausted (1200s of 1200s test time');
    expect(result.stderr).toContain('INCOMPLETE_BUDGET');
    expect(journal().runs).toBe(3);
  });

  // The regression this replaced: 30 launches at the measured 2.8s is 84s of a
  // 1200s budget, and the old count cap stopped the round there.
  it('allows launch 31 when thirty fast launches have spent almost nothing', () => {
    exhausted(30, Array.from({ length: 30 }, () => spent(2_800)));
    const result = run('run', ...HOME_FLAG(), '--', '/usr/bin/true');
    expect(result.status, result.stderr).toBe(0);
    expect(journal().runs).toBe(31);
    expect(JSON.parse(read('.feature/red-team-journal.json')).budgetAuthorization).toBeUndefined();
    expect(result.stdout).toMatch(/run: budget — \d+s of 1200s test time, 31 of 400 launches/);
  });

  it('records what each ordinary launch cost, so the clock is measured and not guessed', () => {
    exhausted(0);
    expect(run('run', ...HOME_FLAG(), '--', '/usr/bin/true').status).toBe(0);
    const [entry] = JSON.parse(read('.feature/red-team-journal.json')).supervisors;
    expect(entry.timeoutMs).toBe(120_000);
    expect(entry.elapsedMs).toBeGreaterThanOrEqual(0);
    expect(entry.elapsedMs).toBeLessThan(60_000);
  });

  it('charges a launch that never recorded its end the whole timeout', () => {
    exhausted(10, Array.from({ length: 10 }, () => INERT));
    const result = run('run', ...HOME_FLAG(), '--', '/usr/bin/true');
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('budget exhausted (1200s');
  });

  it('keeps a launch-count backstop against a loop of instant commands', () => {
    exhausted(ORDINARY_MAX_RUNS);
    const result = run('run', ...HOME_FLAG(), '--', '/usr/bin/true');
    expect(result.status).toBe(1);
    expect(result.stderr).toContain(`budget exhausted (${ORDINARY_MAX_RUNS} runs`);
  });

  it.each(['120001', '0', 'abc'])('refuses an ordinary launch whose --timeout is %s', (timeout) => {
    exhausted(0);
    const result = run('run', ...HOME_FLAG(), '--timeout', timeout, '--', '/usr/bin/true');
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('--timeout must be between 1 and 120000ms');
    expect(journal().runs).toBe(0);
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

describe('Operator same-round continuation safeguards', () => {
  const digest = (value: string) => createHash('sha256').update(value).digest('hex');

  async function helpers() {
    return import(/* @vite-ignore */ RUNNER) as Promise<{
      validateOperatorHistory: (manifest: unknown, historical: unknown, journal: unknown) => unknown;
      operatorLaunchAllowed: (runs: number, timeout: number) => boolean;
      operatorCorrectionHistory: (checkpoint: unknown, journal: unknown) => boolean;
      operatorSelectionHistory: (checkpoint: unknown, journal: unknown) => boolean;
      operatorCandidateSelector: (candidate: { id: string; test: string }, correctionId?: string) => string;
      operatorLegacyReconstruction: (id: string, original: string, from: string, to: string, mutant: string) => boolean;
      operatorMeasuredAssertion: (launch: unknown, candidate: unknown, status: string) => boolean;
      escapeTestName: (test: string) => string;
      findWorktreeWatchers: (
        psOutput: string, ignorePids: Set<number>, root: string, cwdOf?: (pid: number) => string | null,
      ) => string[];
      processServes: (root: string, pid: number, cwdOf?: (pid: number) => string | null) => boolean;
      operatorRunRejectionReason: (input: {
        admissionValid: boolean; phaseValid: boolean; candidateMetadataValid: boolean; argvMatches: boolean;
        resultPathValid: boolean; supervisorClash: boolean; launchAllowed: boolean; dotenvSafe: boolean;
        noRelease: boolean;
      }) => string | null;
    }>;
  }

  /**
   * A committed Operator continuation that `validateOperatorAdmission` actually
   * ADMITS: product baseline, restored checkpoint reports, both scheduling
   * exceptions, the immutable admission manifest and the matching journal.
   *
   * Shared, because the watcher precondition is the LAST thing the admission
   * gate checks — nothing cheaper reaches it, and a test that stops at the
   * helper cannot see the production call site at all.
   */
  async function buildOperatorAdmissionFixture() {
    const { symlinkSync } = await import('node:fs');
    const review = 'docs/reviews/codex-operator-fallow-refactor/budget-extension-review.md';
    const reportPath = 'docs/reviews/red-team/codex-operator-fallow-refactor-3b29b6/findings.json';
    const markdownPath = reportPath.replace('.json', '.md');
    const intakePath = 'docs/superpowers/plans/codex-operator-fallow-refactor-intake.json';
    const runnerTest = 'scripts/ci/__tests__/red-team-mutation-runner.test.ts';
    const statusTest = 'scripts/ci/__tests__/red-team-status.test.ts';
    const axes = ['spec-correctness', 'security', 'database', 'standards-maintainability']
      .map((axis) => `docs/reviews/codex-operator-fallow-refactor/${axis}.md`);
    git('branch', '-m', 'codex/operator-fallow-refactor');
    write('.gitignore', '.feature/\nnode_modules/\n.env*\n');
    write('package.json', '{"type":"module"}\n');
    write('vitest.config.mjs', "export default { root: '.', test: { include: ['src/gate.test.ts'], environment: 'node', setupFiles: [] } };\n");
    write('src/gate.test.ts', 'import { it, expect } from "vitest"; import { allow } from "./gate"; it("fixture candidate 1", () => expect(allow(1)).toBe(true));\n');
    write(runnerTest, '// original runner assertions retained\n');
    write(statusTest, '// original status assertions retained\n');
    const initialIntake = JSON.stringify({ command: 'pnpm test --maxWorkers=2 --coverage --coverage.reportsDirectory=.feature/operator-live-coverage/full && merge .feature/operator-live-coverage' });
    write(intakePath, initialIntake);
    write(intakePath.replace('-intake.json', '-deviations.md'), 'fixture original deviations\n');
    git('add', '.');
    git('commit', '-qm', 'fixture product baseline');
    const baselineHead = git('rev-parse', 'HEAD');
    const originalOid = git('rev-parse', 'HEAD:src/gate.ts');
    const mutantSource = read('src/gate.ts').replace('n > 0', 'n < 0');
    write('.feature/mutant.ts', mutantSource);
    const mutantOid = git('hash-object', '-w', '--', '.feature/mutant.ts');
    const inventory = Array.from({ length: 501 }, (_, index) => ({ id: `rt-${String(index + 1).padStart(4, '0')}`,
      file: 'src/gate.test.ts', test: `fixture candidate ${index + 1}`, outcome: index >= 55 && index <= 58 ? 'excluded' : 'skipped-budget',
      reason: index >= 55 && index <= 58 ? 'original exclusion' : 'original budget exhausted' }));
    const historical = { inventory, branch: 'codex/operator-fallow-refactor', round: 1, head_sha: baselineHead };
    const historicalRaw = JSON.stringify(historical);
    const historicalMarkdown = 'Original measured narrative remains byte-identical.\n';
    write(reportPath, historicalRaw);
    write(markdownPath, historicalMarkdown);
    for (const axis of axes) write(axis, `Pinned ${axis}\n`);
    git('add', '.');
    git('commit', '-qm', 'fixture restored checkpoint reports');
    const checkpointHead = git('rev-parse', 'HEAD');
    const jsonBlob = git('rev-parse', `HEAD:${reportPath}`);
    const markdownBlob = git('rev-parse', `HEAD:${markdownPath}`);
    write(intakePath, initialIntake.replace('--maxWorkers=2', '--maxWorkers=1'));
    git('add', intakePath);
    git('commit', '-qm', 'fixture schedule one');
    const scheduleOne = git('rev-parse', 'HEAD');
    write(intakePath, read(intakePath).replace('pnpm test --maxWorkers=1 --coverage', 'pnpm test --project=integration --maxWorkers=1 --coverage')
      .replaceAll('.feature/operator-live-coverage', '.feature/operator-integration-coverage'));
    git('add', intakePath);
    git('commit', '-qm', 'fixture schedule two');
    const scheduleTwo = git('rev-parse', 'HEAD');
    const checkpoint = { version: 1, round: 1, runs: 30, dotenv: { open: false, files: [] },
      mutations: Array.from({ length: 15 }, () => ({ path: 'src/gate.ts', originalOid, mutantOid,
        patchSha256: digest(mutantSource), state: 'restored' })),
      supervisors: Array.from({ length: 30 }, (_, index) => ({ pid: 900000 + index, pgid: 900000 + index, active: false })) };
    const legacyCandidateNumbers = [126, 127, 137, 138, 139, 140, 142, 117, 118, 120, 122, 155, 156, 261, 262];
    const legacyAttempts = Array.from({ length: 15 }, (_, index) => {
      const legacyResult = join(repo, `.feature/legacy-${index}.json`);
      const legacyLog = join(repo, `.feature/legacy-${index}.log`);
      writeFileSync(legacyResult, '{}');
      writeFileSync(legacyLog, 'retained supervisor result\n');
      const artifact = { resultPath: legacyResult, resultSha256: digest('{}'), logPath: legacyLog,
        logSha256: digest('retained supervisor result\n') };
      const candidate = inventory[legacyCandidateNumbers[index]! - 1]!;
      return { mutationIndex: index, candidateId: candidate.id, selector: candidate.test,
        attempt: 1, baseline: { ...artifact, launch: index * 2 + 1 }, mutant: { ...artifact, launch: index * 2 + 2 } };
    });
    const measurements = legacyAttempts.map((mapping, index) => ({ ...inventory[legacyCandidateNumbers[index]! - 1],
      mutation: { file: 'src/gate.ts', from: 'n > 0', to: 'n < 0' },
      baseline: { report: mapping.baseline.resultPath }, mutant: { report: mapping.mutant.resultPath } }));
    const measurementsPath = join(repo, '.feature/measurements.json');
    const measurementsRaw = JSON.stringify(measurements);
    writeFileSync(measurementsPath, measurementsRaw);
    const corrections = ([[46, 46], [55, 55], [63, 65], [73, 79], [81, 87], [109, 116],
      [125, 125], [128, 128], [132, 133], [136, 136], [145, 154], [172, 172], [175, 190],
      [192, 193], [195, 195], [201, 201], [208, 208], [210, 246], [276, 279], [310, 332],
      [334, 334], [342, 343], [346, 501]] as const)
      .flatMap(([first, last]) => Array.from({ length: last - first + 1 }, (_, index) => ({
        id: `rt-${String(first + index).padStart(4, '0')}`, reason: 'Direction B discovery correction: fixture call path',
        proof: 'Independent fixture proof: no changed production hunk is reachable.',
      })));
    const additionalCorrections = [8, 18, 19, 21, 23, 24, 25, 26, 27, 28, 29, 31, 32, 33, 34, 42, 43, 47, 48, 49, 50, 51, 52, 53, 54, 119, 131, 135, 143, 163, 171, 194, 196, 197, 199, 202, 207, 209, 257, 272, 282, 286, 287, 288, 289, 290, 291, 292, 293, 294, 295, 296, 297, 298, 299, 300, 301, 302, 303, 304, 305, 306, 307, 308, 309, 338, 339, 340]
      .map((id) => ({ id: `rt-${String(id).padStart(4, '0')}`,
        reason: 'Direction B additional discovery correction: fixture contract scope',
        proof: 'Fixture assertions target a different unchanged contract despite incidental changed-code execution.',
        category: 'B', evidence: ['src/gate.test.ts:1'] }));
    const inventoryHash = digest(JSON.stringify(inventory.map(({ id, file, test }) => ({ id, file, test }))));
    const journalHash = digest(JSON.stringify(checkpoint));
    const manifest = { schema: 1, id: 'operator-fallow-round-1-continuation-2026-09-15', branch: 'codex/operator-fallow-refactor',
      round: 1, maxRuns: 1500, maxTimeoutMs: 120000, maxMutantsPerCandidate: 2,
      ownerApproval: '[@Computer](plugin://computer-use@openai-bundled) you can proceed and finish the remaining work please',
      productBaseline: baselineHead, checkpointHead, schedulingHeads: [scheduleOne, scheduleTwo],
      historicalReportSha256: digest(historicalRaw), historicalMarkdownSha256: digest(historicalMarkdown),
      inventorySha256: inventoryHash, journalSha256: journalHash, checkpointJournal: checkpoint,
      axisBlobs: Object.fromEntries(axes.map((axis) => [axis, git('rev-parse', `HEAD:${axis}`)])), suffix: [], legacyAttempts,
      measurements: { path: measurementsPath, sha256: digest(measurementsRaw) }, discoveryCorrections: [...corrections, ...additionalCorrections],
      discoveryAdjudication: { arbiter: 'inventory_scope_audit', decision: 'exclude-never-measured',
        idsSha256: digest(JSON.stringify(corrections.map(({ id }) => id))),
        ownerApproval: 'Approve the exact 287 documented discovery corrections',
        proposalSha256: 'f8b5181724be926ee0d6a732d56b40a2c62678d824e76ca161176e12e81de637' },
      additionalDiscoveryAdjudication: { arbiter: 'root-and-independent-discovery-review', decision: 'exclude-never-measured-contract-scope',
        idsSha256: digest(JSON.stringify(additionalCorrections.map(({ id }) => id))),
        ownerApproval: 'Approve the exact 68 additional documented discovery corrections',
        proposalSha256: '47a86bfaeaf00295109a950da50d6ab3dfa540fb547b440f586ca5889ef96440' } };
    write(review, `## Operator continuation manifest\n\n\x60\x60\x60json\n${JSON.stringify(manifest)}\n\x60\x60\x60\n`);
    git('add', review);
    git('commit', '-qm', 'fixture immutable admission');
    const admissionHead = git('rev-parse', 'HEAD');
    write('.feature/intake.json', read(intakePath));
    writeJournal(checkpoint);
    // Never expose the real node_modules directory to a fixture package manager:
    // pnpm 11 performs an implicit install before exec and rewrites its metadata.
    mkdirSync(join(repo, 'node_modules'), { recursive: true });
    symlinkSync(resolve(process.cwd(), 'node_modules/vitest'), join(repo, 'node_modules/vitest'), 'dir');
    const shimDirectory = join(repo, '.feature/bin');
    mkdirSync(shimDirectory, { recursive: true });
    writeFileSync(join(shimDirectory, 'pnpm'), `#!${process.execPath}\nimport { spawnSync } from 'node:child_process';\nconst r=spawnSync(process.execPath,[${JSON.stringify(resolve(process.cwd(), 'node_modules/vitest/vitest.mjs'))},...process.argv.slice(5)],{stdio:'inherit',env:process.env});\nprocess.exit(r.status??1);\n`, { mode: 0o755 });
    const fixtureRun = (...args: string[]): RunResult => {
      const result = spawnSync(process.execPath, [runner, ...args], { cwd: repo, encoding: 'utf8',
        env: { ...GIT_FREE_ENV, PATH: `${shimDirectory}:${GIT_FREE_ENV.PATH}` } });
      return { status: result.status ?? -1, stdout: result.stdout, stderr: result.stderr };
    };
    runner = join(repo, '.feature/operator-runner.mjs');
    let source = readFileSync(RUNNER, 'utf8');
    const replacements = new Map([
      ['2ac6ff871b4496f996c37aaaaade9bdc7eee9a62', baselineHead], ['8660fd1d01e35c22b9142b4fc2a020c05946f1c5', checkpointHead],
      ['15a5f447f9c415be5671ddd432917f472f939b9f', scheduleOne], ['8ea2ac28f49724dd6df65435fe956d781dd72638', scheduleTwo],
      ['08cdc7ea5f3d566993ff1deba8246f04340121ef', jsonBlob], ['e8c8f894ee43ad34519e5c7d34211c5be276e39c', markdownBlob],
      ['9b1f54e102b0badf1a7c515084984e8c92f997971d381f78bc241b0b614a6073', journalHash],
      ['378cb2ba55fafec04566cda2b201631143432d3f34c5d71ac4fd1ca1bc353972', inventoryHash],
      ['cb2c6819986e93c46e4a9c928c83974429696e00044404b78ac50a67e22c6c60', digest(JSON.stringify(corrections))],
      ['5ef86e871b2f321bdd70694555205a2098a9c549f66dd57f10f624651dd70482', digest(JSON.stringify(additionalCorrections))],
    ]);
    for (const [original, replacement] of replacements) source = source.replaceAll(original, replacement);
    writeFileSync(runner, source);
    const metadata = ['--candidate', 'rt-0001', '--attempt', '1', '--test-file', 'src/gate.test.ts',
      '--selector', 'fixture candidate 1', '--target', 'src/gate.ts', '--mutant-sha256', digest(mutantSource)];
    const launch = (phase: string, runnerFlags: string[] = [], commandFlags: string[] = []) => {
      const result = join(repo, `.feature/${phase}.json`);
      return fixtureRun('run', ...metadata, '--phase', phase, '--result', result, ...runnerFlags, '--', 'pnpm', '--config.verify-deps-before-run=false', 'exec', 'vitest', 'run',
        'src/gate.test.ts', '--testNamePattern', 'fixture candidate 1', '--reporter=json', `--outputFile=${result}`, '--maxWorkers=1', ...commandFlags);
    };
    return { review, reportPath, markdownPath, intakePath, runnerTest, statusTest, axes,
      baselineHead, checkpointHead, admissionHead, mutantSource, inventory, historical,
      historicalRaw, checkpoint, manifest, shimDirectory, fixtureRun, metadata, launch };
  }

  /**
   * `ps` and `lsof` replaced on PATH, so the admission gate's watcher scan
   * reads THIS fixture and never the developer's machine. The `ps` shim
   * answers only the full listing (`-A…`), which leaves `selfAncestry()`
   * empty; the `lsof` shim answers the cwd probe and logs every call, so a
   * "refused" verdict can be shown to come from the cwd it reported rather
   * than from `processServes`'s fail-closed path.
   *
   * `verdict()` calls the PRODUCTION entry point. Asserting on
   * `findWorktreeWatchers` alone leaves the admission call site unpinned:
   * reverting it to the machine-global `findWatchers(...)` — undoing the whole
   * narrowing — kept all 248 tests green (measured 2026-09-19).
   */
  function shimProcessTable(shimDirectory: string, psOutput: string, cwd: string) {
    const lsofLog = join(shimDirectory, 'lsof-calls.log');
    writeFileSync(join(shimDirectory, 'ps'), `#!${process.execPath}\n`
      + `if (process.argv.slice(2).some((flag) => flag.startsWith('-A'))) process.stdout.write(${JSON.stringify(psOutput)});\n`,
      { mode: 0o755 });
    writeFileSync(join(shimDirectory, 'lsof'), `#!${process.execPath}\n`
      + `const call = process.argv.slice(2).join(' ');\n`
      + `process.stdout.write('n' + ${JSON.stringify(cwd)} + '\\n');\n`
      + `import('node:fs').then((fs) => fs.appendFileSync(${JSON.stringify(lsofLog)}, call + '\\n'));\n`,
      { mode: 0o755 });
    const verdict = (): string => spawnSync(process.execPath, ['--input-type=module', '-e',
      'const m=await import(process.argv[2]);const fs=await import("node:fs");'
      + 'const p=m.validateOperatorAdmission(process.cwd(),JSON.parse(fs.readFileSync(".feature/red-team-journal.json")));'
      + 'console.log(p ? "admitted" : "refused");',
      'fixture-check', runner],
    { cwd: repo, encoding: 'utf8', env: { ...GIT_FREE_ENV, PATH: `${shimDirectory}:${GIT_FREE_ENV.PATH}` } }).stdout.trim();
    return { verdict, lsofLog };
  }

  // #1338-style regression: WATCHER_PATTERNS matches by TEXT alone, machine-
  // wide. An unrelated checkout's dev server must never block admission for
  // THIS worktree — that was the live defect, proven by neutralising the
  // watcher expression to `false` and watching the giant fixture below pass.
  it('admits an operator continuation while an unrelated checkout runs a dev server', async () => {
    const { findWorktreeWatchers } = await helpers();
    const pid = Number.MAX_SAFE_INTEGER - 101;
    const psOutput = `${pid} node /unrelated/checkout/node_modules/.bin/next dev\n`;
    const cwdOf = (candidate: number) => (candidate === pid ? '/unrelated/checkout' : null);
    expect(findWorktreeWatchers(psOutput, new Set(), repo, cwdOf)).toEqual([]);
    const { shimDirectory } = await buildOperatorAdmissionFixture();
    const { verdict } = shimProcessTable(shimDirectory, psOutput, '/unrelated/checkout');
    expect(verdict()).toBe('admitted');
  });

  // The complementary case, and the safety-critical direction: narrowing to
  // this worktree must not disarm the gate it narrows. A watcher whose cwd IS
  // this worktree still blocks admission at the production call site.
  it('refuses an operator continuation while a watcher serves this worktree', async () => {
    const { findWorktreeWatchers } = await helpers();
    const pid = Number.MAX_SAFE_INTEGER - 102;
    const psOutput = `${pid} node ${repo}/node_modules/.bin/next dev\n`;
    const cwdOf = (candidate: number) => (candidate === pid ? repo : null);
    const matches = findWorktreeWatchers(psOutput, new Set(), repo, cwdOf);
    expect(matches).toHaveLength(1);
    expect(matches[0]).toContain('next dev');
    const { shimDirectory } = await buildOperatorAdmissionFixture();
    const { verdict, lsofLog } = shimProcessTable(shimDirectory, psOutput, repo);
    expect(verdict()).toBe('refused');
    // Not the fail-closed path: the gate really read this pid's cwd, and it
    // was this worktree. An unreadable cwd would refuse for another reason.
    expect(readFileSync(lsofLog, 'utf8')).toContain(String(pid));
  });

  it('names the failing admission condition instead of one fused message', async () => {
    const { operatorRunRejectionReason } = await helpers();
    const passing = {
      admissionValid: true, phaseValid: true, candidateMetadataValid: true, argvMatches: true, resultPathValid: true,
      supervisorClash: false, launchAllowed: true, dotenvSafe: true, noRelease: false,
    };
    const admissionReason = operatorRunRejectionReason({ ...passing, admissionValid: false });
    const argvReason = operatorRunRejectionReason({ ...passing, argvMatches: false });
    expect(operatorRunRejectionReason(passing)).toBeNull();
    expect(admissionReason).not.toBeNull();
    expect(argvReason).not.toBeNull();
    expect(admissionReason).not.toBe(argvReason);
    expect(admissionReason).toMatch(/admission/i);
    expect(argvReason).toMatch(/test command/i);
  });

  // An unknown --phase is a NINTH cause. It also suppresses the candidate
  // metadata lookup, so reporting it as "candidate metadata is invalid" would
  // re-fuse the ninth cause into the eighth one's name.
  it('names an unknown --phase as its own cause, not as invalid candidate metadata', async () => {
    const { operatorRunRejectionReason } = await helpers();
    const passing = {
      admissionValid: true, phaseValid: true, candidateMetadataValid: true, argvMatches: true, resultPathValid: true,
      supervisorClash: false, launchAllowed: true, dotenvSafe: true, noRelease: false,
    };
    const phaseReason = operatorRunRejectionReason({ ...passing, phaseValid: false, candidateMetadataValid: false });
    const metadataReason = operatorRunRejectionReason({ ...passing, candidateMetadataValid: false });
    expect(phaseReason).toMatch(/phase/i);
    expect(metadataReason).toMatch(/candidate metadata/i);
    expect(phaseReason).not.toBe(metadataReason);
  });

  function historyFixture() {
    const inventory = Array.from({ length: 501 }, (_, index) => ({
      id: `candidate-${index}`, file: 'src/gate.test.ts', test: `case ${index} [exact]`,
    }));
    const checkpoint = {
      version: 1, round: 1, runs: 30, dotenv: { open: false, files: [] },
      mutations: Array.from({ length: 15 }, () => ({ path: 'src/gate.ts', state: 'restored' })),
      supervisors: Array.from({ length: 30 }, (_, index) => ({ pid: 900000 + index, active: false })),
    };
    const logPath = join(repo, 'retained.log');
    writeFileSync(logPath, 'retained original supervisor output\n');
    const artifact = { resultPath: null, resultSha256: null, logPath, logSha256: digest(readFileSync(logPath, 'utf8')) };
    const manifest = {
      checkpointJournal: checkpoint, journalSha256: digest(JSON.stringify(checkpoint)),
      inventorySha256: digest(JSON.stringify(inventory)), suffix: [] as typeof inventory,
      legacyAttempts: Array.from({ length: 15 }, (_, index) => ({
        mutationIndex: index, candidateId: inventory[index]!.id,
        selector: `case ${index} \\[exact\\]`, attempt: 1,
        baseline: { ...artifact, launch: index * 2 + 1 }, mutant: { ...artifact, launch: index * 2 + 2 },
      })),
    };
    return { manifest, historical: { inventory }, checkpoint: structuredClone(checkpoint) };
  }

  it('continues at launch 31 and shares the finite ceiling through launch 1500', async () => {
    const { operatorLaunchAllowed } = await helpers();
    expect(operatorLaunchAllowed(30, 120000)).toBe(true);
    expect(operatorLaunchAllowed(1499, 120000)).toBe(true);
    expect(operatorLaunchAllowed(1500, 120000)).toBe(false);
    expect(operatorLaunchAllowed(29, 120000)).toBe(false);
    expect(operatorLaunchAllowed(Number.NaN, 120000)).toBe(false);
    const { operatorCandidateSelector } = await helpers();
    const exact = { id: 'rt-0103', test: 'GET Rules timeline cursor?cursorId=0003' };
    const ordinary = operatorCandidateSelector(exact);
    const anchored = operatorCandidateSelector(exact, 'operator-fallow-round-1-selection-and-resolves');
    expect(anchored).toBe(`^${ordinary}$`);
    expect(new RegExp(anchored).test(exact.test)).toBe(true);
    expect(new RegExp(anchored).test(`${exact.test}&cursorAppliedAt=not-a-date`)).toBe(false);
    expect(new RegExp(ordinary).test(`${exact.test}&cursorAppliedAt=not-a-date`)).toBe(true);
    expect(operatorCandidateSelector(exact, 'other')).toBe(ordinary);
    expect(operatorCandidateSelector({ ...exact, id: 'rt-0104' }, 'operator-fallow-round-1-selection-and-resolves')).toBe(ordinary);
    const metadataPath = join(repo, 'metadata-fixture.mjs');
    writeFileSync(metadataPath, `${readFileSync(RUNNER, 'utf8')}\nexport { operatorRunMetadata };\n`);
    const metadata = await import(/* @vite-ignore */ metadataPath) as {
      operatorRunMetadata: (root: string, parsed: unknown, proof: unknown, journal: unknown, phase: string) => unknown;
    };
    const fixtureHead = git('rev-parse', 'HEAD');
    const row = { ...exact, file: 'src/gate.test.ts' };
    const parsed = { candidate: row.id, 'test-file': row.file, selector: anchored, attempt: '1',
      target: 'src/gate.ts', 'mutant-sha256': 'c'.repeat(64) };
    const proof = { inventory: [row], controlHead: fixtureHead, admissionHead: 'a'.repeat(40),
      correction: {}, selectionCorrection: { id: 'operator-fallow-round-1-selection-and-resolves' }, attempts: new Map() };
    const prior = { mutations: [], supervisors: [{ candidateId: row.id, phase: 'baseline', attempt: 1,
      selector: ordinary, controlHead: 'e3bd968ae9fca8e0d787291cf067c266e67d89f9', code: 0 }] };
    const before = JSON.stringify(prior);
    expect(metadata.operatorRunMetadata(repo, parsed, proof, prior, 'baseline')).toMatchObject({
      candidateId: row.id, attempt: 1, selector: anchored, selectorCorrection: 'operator-fallow-round-1-selection-and-resolves' });
    expect(JSON.stringify(prior)).toBe(before);
    expect(metadata.operatorRunMetadata(repo, { ...parsed, selector: ordinary }, proof, prior, 'baseline')).toBeNull();
    expect(metadata.operatorRunMetadata(repo, parsed, { ...proof, selectionCorrection: { id: 'other' } }, prior, 'baseline')).toBeNull();
  });

  it('rejects invalid and over-ceiling continuation timeouts', async () => {
    const { operatorLaunchAllowed } = await helpers();
    for (const timeout of [0, -1, Number.NaN, Number.POSITIVE_INFINITY, 120001]) {
      expect(operatorLaunchAllowed(30, timeout)).toBe(false);
    }
    expect(operatorLaunchAllowed(30, 1)).toBe(true);
  });

  it('preserves every original mutation and supervisor in the checkpoint prefix', async () => {
    const { validateOperatorHistory } = await helpers();
    const fixture = historyFixture();
    expect(validateOperatorHistory(fixture.manifest, fixture.historical, fixture.checkpoint)).not.toBeNull();
    fixture.checkpoint.mutations[0]!.path = 'src/foreign.ts';
    expect(validateOperatorHistory(fixture.manifest, fixture.historical, fixture.checkpoint)).toBeNull();
    const second = historyFixture();
    second.checkpoint.supervisors[0]!.pid += 1;
    expect(validateOperatorHistory(second.manifest, second.historical, second.checkpoint)).toBeNull();
    const { operatorLegacyReconstruction: reconstruct } = await helpers();
    const first = 'actorName: facts.actorName,';
    const firstMutant = 'actorName: null,';
    const secondToken = 'if (!write.ok) return write.result;';
    const secondMutant = "if (!write.ok) return { kind: 'not_found' } as ApplyResult;";
    expect(reconstruct('rt-0127', `${first}\n${first}`, first, firstMutant, `${firstMutant}\n${first}`)).toBe(true);
    expect(reconstruct('rt-0127', `${first}\n${first}`, first, firstMutant, `${first}\n${firstMutant}`)).toBe(false);
    expect(reconstruct('rt-0142', `${secondToken}\n${secondToken}`, secondToken, secondMutant, `${secondToken}\n${secondMutant}`)).toBe(true);
    expect(reconstruct('rt-0142', `${secondToken}\n${secondToken}`, secondToken, secondMutant, `${secondMutant}\n${secondToken}`)).toBe(false);
    expect(reconstruct('rt-0127', `${first}\n${first}`, first, firstMutant, `${firstMutant}\n${firstMutant}`)).toBe(false);
    expect(reconstruct('rt-0142', `${secondToken}\n${secondToken}`, secondToken, secondMutant, `${secondMutant}\n${secondMutant}`)).toBe(false);
    expect(reconstruct('rt-0001', `${first}\n${first}`, first, firstMutant, `${firstMutant}\n${first}`)).toBe(false);
    expect(reconstruct('rt-0127', `${first}\n${first}\n${first}`, first, firstMutant, `${firstMutant}\n${first}\n${first}`)).toBe(false);
    expect(reconstruct('rt-0127', 'x\nx', 'x', 'y', 'y\nx')).toBe(false);
    expect(reconstruct('rt-0001', 'before x after', 'x', 'y', 'before y after')).toBe(true);
    expect(reconstruct('rt-0001', 'before x after', '', 'y', 'before x after')).toBe(false);
    const { operatorCorrectionHistory } = await helpers();
    const used = { version: 1, round: 1, runs: 42, dotenv: { open: false },
      budgetAuthorization: { firstRun: 31, headSha: 'original', maxRuns: 1500 },
      mutations: Array.from({ length: 21 }, (_, index) => ({ state: 'restored', path: `retained-${index}` })),
      supervisors: Array.from({ length: 42 }, (_, index) => ({ active: false, pid: index, resultSha256: 'original' })) };
    expect(operatorCorrectionHistory(used, structuredClone(used))).toBe(true);
    for (const change of ['round', 'runs', 'mutation', 'launch', 'artifact', 'budget', 'reset']) {
      const current = structuredClone(used);
      if (change === 'round') current.round = 2;
      if (change === 'runs') current.runs = 41;
      if (change === 'mutation') current.mutations[20]!.path = 'rewritten';
      if (change === 'launch') current.supervisors[41]!.pid += 1;
      if (change === 'artifact') current.supervisors[41]!.resultSha256 = 'rewritten';
      if (change === 'budget') current.budgetAuthorization.firstRun = 43;
      if (change === 'reset') current.mutations = [];
      expect(operatorCorrectionHistory(used, current)).toBe(false);
    }
    const { operatorSelectionHistory } = await helpers();
    const completed = { ...structuredClone(used), runs: 43,
      supervisors: [...structuredClone(used.supervisors), { active: false, pid: 43, resultSha256: 'two-test-baseline' }] };
    expect(operatorSelectionHistory(completed, structuredClone(completed))).toBe(true);
    const appended = { ...structuredClone(completed), runs: 44,
      supervisors: [...structuredClone(completed.supervisors), { active: false, pid: 44, resultSha256: 'exact-baseline' }] };
    expect(operatorSelectionHistory(completed, appended)).toBe(true);
    for (const change of ['old-baseline', 'reset', 'budget', 'round', 'mutation']) {
      const current = structuredClone(appended);
      if (change === 'old-baseline') current.supervisors[42]!.resultSha256 = 'rewritten';
      if (change === 'reset') current.runs = 42;
      if (change === 'budget') current.budgetAuthorization.firstRun = 44;
      if (change === 'round') current.round = 2;
      if (change === 'mutation') current.mutations[0]!.path = 'changed';
      expect(operatorSelectionHistory(completed, current)).toBe(false);
    }


  });

  it('rejects missing swapped or reset legacy candidate launch mappings', async () => {
    const { validateOperatorHistory } = await helpers();
    for (const change of ['missing', 'phase', 'attempt', 'selector']) {
      const fixture = historyFixture();
      if (change === 'missing') fixture.manifest.legacyAttempts.pop();
      if (change === 'phase') fixture.manifest.legacyAttempts[0]!.baseline.launch = 2;
      if (change === 'attempt') fixture.manifest.legacyAttempts[0]!.attempt = 0;
      if (change === 'selector') fixture.manifest.legacyAttempts[0]!.selector = 'case.*';
      expect(validateOperatorHistory(fixture.manifest, fixture.historical, fixture.checkpoint)).toBeNull();
    }
  });

  it('rejects changed inventory identities duplicate selectors and unapproved suffix files', async () => {
    const { validateOperatorHistory } = await helpers();
    for (const change of ['identity', 'duplicate', 'path', 'alias']) {
      const fixture = historyFixture();
      if (change === 'identity') fixture.historical.inventory[0]!.id = 'replacement';
      if (change === 'duplicate') fixture.manifest.suffix.push({ ...fixture.historical.inventory[0]! });
      if (change === 'path') fixture.manifest.suffix.push({ id: 'new', file: 'src/new.test.ts', test: 'new' });
      if (change === 'alias') fixture.manifest.suffix.push({ id: 'new', file: './scripts/ci/__tests__/red-team-status.test.ts', test: 'new' });
      expect(validateOperatorHistory(fixture.manifest, fixture.historical, fixture.checkpoint)).toBeNull();
    }
  });

  it('counts retained attempts and refuses a third semantic mutant', async () => {
    const { validateOperatorHistory } = await helpers();
    const fixture = historyFixture();
    const mutation = { path: 'src/gate.ts', target: 'src/gate.ts', state: 'restored', candidateId: 'candidate-0',
      selector: 'case 0 \\[exact\\]', attempt: 2, originalOid: 'a'.repeat(40), mutantSha256: 'b'.repeat(64) };
    const extended = { ...fixture.checkpoint,
      mutations: [...fixture.checkpoint.mutations, mutation] as (typeof fixture.checkpoint.mutations[number] | typeof mutation)[] };
    expect(validateOperatorHistory(fixture.manifest, fixture.historical, extended)).not.toBeNull();
    extended.mutations.push({ ...mutation, attempt: 3 });
    expect(validateOperatorHistory(fixture.manifest, fixture.historical, extended)).toBeNull();
    extended.mutations.pop();
    extended.mutations[15] = { ...mutation, attempt: 1 };
    expect(validateOperatorHistory(fixture.manifest, fixture.historical, extended)).toBeNull();
  });

  it('rejects reset counters lower rounds and missing candidate metadata', async () => {
    const { validateOperatorHistory } = await helpers();
    const fixture = historyFixture();
    for (const journalValue of [{ ...fixture.checkpoint, runs: 0 }, { ...fixture.checkpoint, round: 0 },
      { ...fixture.checkpoint, runs: 31 }, { ...fixture.checkpoint, mutations: [...fixture.checkpoint.mutations, { state: 'restored' }] }]) {
      expect(validateOperatorHistory(fixture.manifest, fixture.historical, journalValue)).toBeNull();
    }
  });

  it('retains lineage after branch rename and journal deletion without generic fallback', () => {
    const review = 'docs/reviews/codex-operator-fallow-refactor/budget-extension-review.md';
    write(review, 'not an admission');
    git('add', review);
    git('commit', '-qm', 'remember attempted continuation');
    git('branch', '-m', 'renamed-continuation');
    expect(run('round-start').status).toBe(1);
    expect(run('run', '--', 'node', '-e', 'process.exit(0)').status).toBe(1);
    expect(existsSync(join(repo, '.feature/red-team-journal.json'))).toBe(false);
  });

  // #1302: #1297 squash-merged the Operator review into main, so every branch
  // cut from main carries the file. Once the admission commit is on
  // origin/main the continuation is finished and presence alone must not match.
  it('opens a round on a branch cut from main after the Operator admission merged', () => {
    const review = 'docs/reviews/codex-operator-fallow-refactor/budget-extension-review.md';
    write(review, 'merged admission');
    git('add', review);
    git('commit', '-qm', 'squash-merge the operator continuation');
    git('update-ref', 'refs/remotes/origin/main', 'HEAD');
    git('checkout', '-qb', 'fix-unrelated-work');
    expect(run('round-start').status).toBe(0);
  });

  it('keeps continuation lineage when the admission commit is not on origin/main', () => {
    const review = 'docs/reviews/codex-operator-fallow-refactor/budget-extension-review.md';
    git('update-ref', 'refs/remotes/origin/main', 'HEAD');
    write(review, 'branch-only admission');
    git('add', review);
    git('commit', '-qm', 'admission exists only on the branch');
    git('branch', '-m', 'renamed-continuation');
    const result = run('round-start');
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('Operator continuation');
  });

  it('refuses mutation and launch before immutable admission even on the exact branch', () => {
    git('branch', '-m', 'codex/operator-fallow-refactor');
    write('mutant.txt', 'changed');
    expect(run('mutate', '--file', 'src/gate.ts', '--mutant', join(repo, 'mutant.txt')).status).toBe(1);
    expect(run('run', '--', 'node', '-e', 'process.exit(0)').status).toBe(1);
    expect(read('src/gate.ts')).toContain('n > 0');
    expect(existsSync(join(repo, '.feature/red-team-journal.json'))).toBe(false);
  });

  it('rejects altered retained result digests instead of trusting legacy mapping prose', async () => {
    const { validateOperatorHistory } = await helpers();
    const fixture = historyFixture();
    writeFileSync(fixture.manifest.legacyAttempts[0]!.baseline.logPath, 'rewritten');
    expect(validateOperatorHistory(fixture.manifest, fixture.historical, fixture.checkpoint)).toBeNull();
  });

  it('runs an admitted baseline mutant and restoration with corroborated report evidence', async () => {
    const { review, reportPath, intakePath, runnerTest, statusTest, mutantSource, inventory, historical,
      historicalRaw, admissionHead, metadata, fixtureRun, launch } = await buildOperatorAdmissionFixture();
    let source = readFileSync(runner, 'utf8');
    // Each rejection is pinned to ITS OWN cause, not merely "some rejection
    // happened" — a fused message made both of these pass vacuously whenever
    // an unrelated watcher elsewhere blocked admission instead (see the two
    // "operator continuation" watcher-scope tests above).
    const argvMismatch = launch('baseline', [], ['--reporter=default']);
    expect(argvMismatch.status, argvMismatch.stderr).toBe(1);
    expect(argvMismatch.stderr).toContain('test command');
    const unknownPhase = launch('warmup');
    expect(unknownPhase.status, unknownPhase.stderr).toBe(1);
    expect(unknownPhase.stderr).toContain('phase');
    write('.env.local', 'MOCK_EXTERNAL_APIS=false\n');
    const dotenvUnsafe = launch('baseline');
    expect(dotenvUnsafe.status, dotenvUnsafe.stderr).toBe(1);
    expect(dotenvUnsafe.stderr).toContain('dotenv');
    rmSync(join(repo, '.env.local'));
    expect(journal().runs).toBe(30);
    const baseline = launch('baseline');
    expect(baseline, baseline.stderr + git('status', '--porcelain')).toMatchObject({ status: 0 });
    expect(journal().runs).toBe(31);
    expect(fixtureRun('mutate', ...metadata, '--file', 'src/gate.test.ts', '--mutant', join(repo, '.feature/mutant.ts')).status).toBe(1);
    const mutation = fixtureRun('mutate', ...metadata, '--file', 'src/gate.ts', '--mutant', join(repo, '.feature/mutant.ts'));
    expect(mutation, mutation.stderr + git('status', '--porcelain')).toMatchObject({ status: 0 });
    expect(launch('mutant', ['--mock-external', 'false']).status).toBe(1);
    write('src/gate.ts', 'export const allow = (n: number) => n > 0;\n');
    expect(launch('mutant').status).toBe(1);
    expect(journal().runs).toBe(31);
    write('src/gate.ts', mutantSource);
    expect(launch('mutant').status).toBe(1);
    expect(journal().runs).toBe(32);
    expect(fixtureRun('finalize').status).toBe(0);
    expect(read('src/gate.ts')).toContain('n > 0');
    const sidecar = { ...historical, head_sha: admissionHead, intake_sha256: digest(read(intakePath)), authorizations: [],
      inventory: inventory.map((row, index) => index === 0 ? { ...row, outcome: 'killed' } : row) };
    write(reportPath, JSON.stringify(sidecar));
    const validation = spawnSync('node', ['--input-type=module', '-e',
      'const m=await import(process.argv[2]);const fs=await import("node:fs");console.log(m.validOperatorReport(process.cwd(),JSON.parse(fs.readFileSync(process.argv[3])),JSON.parse(fs.readFileSync(".feature/red-team-journal.json"))));',
      'fixture-check', runner, reportPath], { cwd: repo, encoding: 'utf8', env: GIT_FREE_ENV });
    expect(validation.status, validation.stderr).toBe(0);
    expect(validation.stdout.trim()).toBe('true');
    // A used admission stays immutable: exercise its one corrective child in this disposable repo.
    write(reportPath, historicalRaw);
    const used = JSON.parse(read('.feature/red-team-journal.json')) as {
      version: number; round: number; runs: number; dotenv: { open: boolean; files: unknown[] };
      budgetAuthorization: Record<string, unknown>; mutations: Record<string, unknown>[]; supervisors: Record<string, unknown>[];
    };
    const makeReceipt = (entry: Record<string, unknown>, number: number, candidateNumber: number) => {
      const phase = entry.phase as string;
      const resultPath = join(repo, `.feature/correction-${number}.json`);
      const result = JSON.stringify({ numFailedTestSuites: phase === 'mutant' ? 2 : 0,
        testResults: [{ name: join(repo, 'src/gate.test.ts'), status: phase === 'mutant' ? 'failed' : 'passed', message: '',
          assertionResults: [{ fullName: `fixture candidate ${candidateNumber}`, status: phase === 'mutant' ? 'failed' : 'passed',
            failureMessages: phase === 'mutant' ? ['AssertionError: expected true to be false'] : [] }] }] });
      writeFileSync(resultPath, result);
      const { supervisorPath: _path, supervisorSha256: _sha, ...prior } = entry;
      const row = { ...prior, candidateId: `rt-${String(candidateNumber).padStart(4, '0')}`,
        selector: `fixture candidate ${candidateNumber}`, resultPath, resultSha256: digest(result) };
      const supervisorPath = `${resultPath}.receipt.json`;
      const raw = JSON.stringify(row);
      writeFileSync(supervisorPath, raw);
      return { ...row, supervisorPath, supervisorSha256: digest(raw) };
    };
    for (let candidateNumber = 2; candidateNumber <= 6; candidateNumber += 1) {
      used.mutations.push({ ...used.mutations[15]!, candidateId: `rt-${String(candidateNumber).padStart(4, '0')}`,
        selector: `fixture candidate ${candidateNumber}` });
      used.supervisors.push(makeReceipt(used.supervisors[30]!, used.supervisors.length + 1, candidateNumber));
      used.supervisors.push(makeReceipt(used.supervisors[31]!, used.supervisors.length + 1, candidateNumber));
    }
    used.runs = 42;
    const usedSha = digest(JSON.stringify(used));
    const recordsPath = join(repo, '.feature/original-pilot-records.json');
    writeFileSync(recordsPath, '[]');
    const correctionEvidence = { records: { path: recordsPath, sha256: digest('[]') },
      pairs: Array.from({ length: 6 }, (_, index) => ({ id: `rt-${String(index + 1).padStart(4, '0')}`,
        measurementPath: recordsPath, measurementSha256: digest('[]') })) };
    const correctionEvidenceSha = digest(JSON.stringify(correctionEvidence));
    source = source.replaceAll('03502fdcee60e61b891636a625c95c6a9dadec9b', admissionHead)
      .replaceAll('91b56fcabdcc94a08d0fa18cce3db5e8fc3f287eb32148cc3fe5036432cc2e8b', usedSha)
      .replaceAll('e66e50ea3da81d9057d823f25e9870f61ebe10e296a10504f811a83ceecde359', correctionEvidenceSha);
    writeFileSync(runner, source);
    write('.agents/skills/red-team/scripts/mutation-runner.mjs', source);
    write('.agents/skills/feature/scripts/red-team-status.mjs', '// fixture status verifier\n');
    const controlPaths = ['.agents/skills/red-team/scripts/mutation-runner.mjs',
      '.agents/skills/feature/scripts/red-team-status.mjs', runnerTest, statusTest];
    const correction = { schema: 1, id: 'operator-fallow-round-1-file-accounting-42', admission: admissionHead,
      authority: 'existing-approved-verifier-support-scope', checkpoint: used, evidence: correctionEvidence,
      sourceBlobs: Object.fromEntries(controlPaths.map((path) => [path, git('hash-object', '--', path)])) };
    const originalReview = read(review);
    const correctionSuffix = `\n## Operator failed-file accounting correction\n\n\x60\x60\x60json\n${JSON.stringify(correction)}\n\x60\x60\x60\n`;
    write(review, originalReview + correctionSuffix);
    write(intakePath.replace('-intake.json', '-deviations.md'), 'fixture original deviations\ncorrective appendix\n');
    writeJournal(used);
    git('add', '.');
    git('commit', '-qm', 'one finite used-admission correction');
    const controlHead = git('rev-parse', 'HEAD');
    const admissionCheck = () => spawnSync('node', ['--input-type=module', '-e',
      'const m=await import(process.argv[2]);const fs=await import("node:fs");const p=m.validateOperatorAdmission(process.cwd(),JSON.parse(fs.readFileSync(".feature/red-team-journal.json")));console.log(p?JSON.stringify({head:p.admissionHead,control:p.controlHead}):"null");',
      'fixture-check', runner], { cwd: repo, encoding: 'utf8', env: GIT_FREE_ENV });
    expect(admissionCheck().stdout.trim()).toBe(JSON.stringify({ head: admissionHead, control: controlHead }));
    const grantBefore = JSON.stringify(used.budgetAuthorization);
    const continuedMetadata = [...metadata];
    continuedMetadata[continuedMetadata.indexOf('--attempt') + 1] = '2';
    const correctedLaunch = (phase: string) => {
      const result = join(repo, `.feature/corrected-${phase}.json`);
      return fixtureRun('run', ...continuedMetadata, '--phase', phase, '--result', result, '--', 'pnpm',
        '--config.verify-deps-before-run=false', 'exec', 'vitest', 'run', 'src/gate.test.ts', '--testNamePattern',
        'fixture candidate 1', '--reporter=json', `--outputFile=${result}`, '--maxWorkers=1');
    };
    expect(correctedLaunch('baseline').status).toBe(0);
    expect(journal().runs).toBe(43);
    expect(fixtureRun('mutate', ...continuedMetadata, '--file', 'src/gate.ts', '--mutant', join(repo, '.feature/mutant.ts')).status).toBe(0);
    expect(correctedLaunch('mutant').status).toBe(1);
    expect(fixtureRun('finalize').status).toBe(0);
    const continued = JSON.parse(read('.feature/red-team-journal.json')) as typeof used;
    expect(continued.runs).toBe(44);
    expect(JSON.stringify(continued.budgetAuthorization)).toBe(grantBefore);
    expect(continued.supervisors.slice(0, 42)).toEqual(used.supervisors);
    expect(continued.mutations.slice(0, 21)).toEqual(used.mutations);
    expect(continued.supervisors.slice(42).every((row) => row.controlHead === controlHead && row.admission === admissionHead)).toBe(true);
    expect(continued.mutations[21]!.controlHead).toBe(controlHead);
    const correctedSidecar = { ...sidecar, head_sha: controlHead, operatorVerifierCorrection: {
      id: correction.id, controlHead, checkpointSha256: usedSha,
      reevaluations: correctionEvidence.pairs.map((pair) => ({ candidateId: pair.id, measurementSha256: pair.measurementSha256,
        originalSuggestion: 'inconclusive', outcome: sidecar.inventory.find((row) => row.id === pair.id)!.outcome })) } };
    write(reportPath, JSON.stringify(correctedSidecar));
    const correctedReport = () => spawnSync('node', ['--input-type=module', '-e',
      'const m=await import(process.argv[2]);const fs=await import("node:fs");console.log(m.validOperatorReport(process.cwd(),JSON.parse(fs.readFileSync(process.argv[3])),JSON.parse(fs.readFileSync(".feature/red-team-journal.json"))));',
      'fixture-check', runner, reportPath], { cwd: repo, encoding: 'utf8', env: GIT_FREE_ENV });
    expect(correctedReport().stdout.trim()).toBe('true');
    write(reportPath, JSON.stringify({ ...correctedSidecar, operatorVerifierCorrection: undefined }));
    expect(correctedReport().stdout.trim()).toBe('false');
    write(reportPath, historicalRaw);
    write(review, 'changed original prefix\n' + originalReview + correctionSuffix);
    expect(admissionCheck().stdout.trim()).toBe('null');
    write(review, originalReview + correctionSuffix);
    write('.agents/skills/feature/scripts/red-team-status.mjs', '// forbidden later verifier change\n');
    git('add', '.');
    git('commit', '-qm', 'forbidden second control revision');
    expect(admissionCheck().stdout.trim()).toBe('null');

  }, SUITE_TIMEOUT_MS);
});

// #1342. A finding raised in the last permitted round has no way to have its
// OWN fix measured: fixing it moves HEAD and the sidecar goes stale by
// construction. `remeasure-start` is the exit, and it is deliberately NOT a
// fourth round — generalising the round-3 PROSE rule was tried on #1340 and
// reverted, because RUN_C_FOURTH_TEXT contains the literal phrase "approve the
// scoped fourth round" and a prose match on the round number therefore admits
// a TAMPERED Run C admission. Nothing below reads any authorization text.
describe('the re-measurement round', () => {
  const reportDir = 'docs/reviews/red-team/fixture-run';
  const report = `${reportDir}/findings.json`;

  function sidecarJson(round: number, headSha: string, authorizations: unknown[]): string {
    return JSON.stringify({
      branch: git('branch', '--show-current'), round, head_sha: headSha, authorizations,
    }, null, 2);
  }

  /**
   * A run that spent `round` rounds and committed its report.
   *
   * The authorization has to be on disk BEFORE the third `round-start`, which
   * is the real ordering: `round-start` reads the sidecar to decide whether the
   * owner granted the round it is being asked to open.
   */
  function spent(round: number, authorizations: unknown[] = []): void {
    write(report, sidecarJson(round, 'x'.repeat(40), authorizations));
    for (let index = 0; index < round; index += 1) expect(run('round-start').status).toBe(0);
    write(report, sidecarJson(round, git('rev-parse', 'HEAD'), authorizations));
    git('add', report);
    git('commit', '-qm', `round ${round} report`);
  }

  /** …and then committed the fix for what that round raised. */
  function spentAndFixed(round: number, authorizations: unknown[] = []): void {
    spent(round, authorizations);
    write('src/gate.ts', 'export const allow = (n: number) => n >= 0;\n');
    git('add', 'src/gate.ts');
    git('commit', '-qm', 'fix what the round raised');
  }

  const THIRD_ROUND_GRANT = [{
    id: 'AUTH-1', date: '2026-09-21', finding_ids: ['F1'],
    text: 'owner 2026-09-21: third round authorized',
  }];

  it('opens after an authorized third round and resets the counter', () => {
    spentAndFixed(3, THIRD_ROUND_GRANT);
    const result = run('remeasure-start');
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('re-measurement of round 3 open');
    const value = journal() as unknown as {
      round: number; runs: number; remeasurement: { ofRound: number };
    };
    expect(value.round).toBe(3);
    expect(value.runs).toBe(0);
    expect(value.remeasurement.ofRound).toBe(3);
  });

  it('opens after round 2 when no third round is authorized', () => {
    spentAndFixed(2);
    expect(run('remeasure-start').status).toBe(0);
    expect((journal() as unknown as { remeasurement: { ofRound: number } }).remeasurement.ofRound).toBe(2);
  });

  // It opens exactly where the fresh-round cap closes. A fresh round is the
  // stronger instrument and must be used while one is still reachable.
  it('refuses while a fresh third round is authorized and unspent', () => {
    spentAndFixed(2, THIRD_ROUND_GRANT);
    const result = run('remeasure-start');
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('a fresh third round is authorized and still available');
  });

  // `round-start` reads the working tree. An uncommitted edit stripping the
  // authorization would open this exit while a fresh round was still reachable,
  // so the COMMITTED copy is consulted too — it is the one the checker
  // re-derives the same refusal from.
  it('refuses on the committed grant even after the working tree is edited', () => {
    spentAndFixed(2, THIRD_ROUND_GRANT);
    write(report, sidecarJson(2, git('rev-parse', 'HEAD'), []));
    const result = run('remeasure-start');
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('a fresh third round is authorized and still available');
  });

  it('refuses after round 1, where a fresh round is always available', () => {
    spentAndFixed(1);
    const result = run('remeasure-start');
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('a re-measurement round follows round 2 or 3');
  });

  // THE BOUND that makes this an exit rather than a raised cap.
  it('refuses a SECOND re-measurement round', () => {
    spentAndFixed(3, THIRD_ROUND_GRANT);
    expect(run('remeasure-start').status).toBe(0);
    const second = run('remeasure-start');
    expect(second.status).toBe(1);
    expect(second.stderr).toContain('already spent its one re-measurement round');
  });

  // THE OTHER BOUND: it can never be used to open a fresh adversarial round.
  it('cannot be used to open a fresh round', () => {
    spentAndFixed(3, THIRD_ROUND_GRANT);
    expect(run('remeasure-start').status).toBe(0);
    const fresh = run('round-start');
    expect(fresh.status).toBe(1);
    expect(fresh.stderr).toContain('no fresh round follows one');
    expect((journal() as unknown as { remeasurement: unknown }).remeasurement).toBeDefined();
  });

  // Committing the round's own report already moves HEAD past the head it
  // measured, so "head_sha is behind HEAD" proves nothing. Work committed
  // AFTER the report commit is what proves a fix exists to re-measure.
  it('refuses when nothing was committed after the round report', () => {
    spent(3, THIRD_ROUND_GRANT);
    const result = run('remeasure-start');
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('there is no fix to re-measure');
  });

  it('refuses over a sidecar that is not committed', () => {
    write(report, sidecarJson(3, 'x'.repeat(40), THIRD_ROUND_GRANT));
    for (let index = 0; index < 3; index += 1) expect(run('round-start').status).toBe(0);
    write(report, sidecarJson(3, git('rev-parse', 'HEAD'), THIRD_ROUND_GRANT));
    write('src/gate.ts', 'export const allow = (n: number) => n >= 0;\n');
    git('add', 'src/gate.ts');
    git('commit', '-qm', 'fix');
    const result = run('remeasure-start');
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('no committed red-team sidecar');
  });

  it('refuses over an unrestored mutation', () => {
    spentAndFixed(3, THIRD_ROUND_GRANT);
    write('mutant.ts', 'export const allow = () => true;\n');
    expect(run('mutate', '--file', 'src/gate.ts', '--mutant', join(repo, 'mutant.ts')).status).toBe(0);
    const result = run('remeasure-start');
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('did not finalize');
  });

  it('ignores a sidecar recorded for a DIFFERENT branch', () => {
    write(report, sidecarJson(3, 'x'.repeat(40), THIRD_ROUND_GRANT));
    for (let index = 0; index < 3; index += 1) expect(run('round-start').status).toBe(0);
    git('rm', '-q', '--cached', '--ignore-unmatch', report);
    rmSync(join(repo, report));
    write('docs/reviews/red-team/other-run/findings.json', JSON.stringify({
      branch: 'some-other-branch', round: 3, head_sha: git('rev-parse', 'HEAD'), authorizations: [],
    }, null, 2));
    git('add', 'docs/reviews/red-team/other-run/findings.json');
    git('commit', '-qm', 'foreign report');
    write('src/gate.ts', 'export const allow = (n: number) => n >= 0;\n');
    git('add', 'src/gate.ts');
    git('commit', '-qm', 'fix');
    const result = run('remeasure-start');
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('no committed red-team sidecar');
  });

  it.each(['codex/owner-operator-run-d', 'codex/owner-operator-run-e'])(
    'refuses on %s, whose grant admits no further round', (branch) => {
      spentAndFixed(3, THIRD_ROUND_GRANT);
      git('branch', '-m', branch);
      const result = run('remeasure-start');
      expect(result.status).toBe(1);
      expect(result.stderr).toContain('admits no further round of any kind');
    },
  );

  it('refuses while a branch-pinned budget grant is in force', () => {
    spentAndFixed(3, THIRD_ROUND_GRANT);
    writeJournal({
      ...journal(),
      budgetAuthorization: { id: 'owner-run-c-fourth-round-prompt-regression', maxRuns: 150, firstRun: 1 },
    });
    const result = run('remeasure-start');
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('admits no re-measurement round');
  });
});
