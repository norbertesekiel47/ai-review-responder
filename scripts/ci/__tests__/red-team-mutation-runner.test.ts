import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
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

  it.each(['other branch', 'first round'])('preserves the ordinary 30-launch cap for %s with E evidence present', (scope) => {
    prepare();
    if (scope === 'other branch') git('branch', '-m', 'codex/other');
    else write('.feature/red-team-journal.json', JSON.stringify({ ...journal(), round: 1 }));
    expect(run('run', ...HOME_FLAG(), '--', '/usr/bin/true').status).toBe(0);
    expect(JSON.parse(read('.feature/red-team-journal.json')).budgetAuthorization).toBeUndefined();
    writeJournal({ ...journal(), runs: 30 });
    expectRefused(30);
  });
});

describe('the owner-approved Run D second pass', () => {
  const report = 'docs/reviews/red-team/codex-owner-operator-run-d-7749f8/findings.json';
  const markdown = report.replace('.json', '.md');
  const intakePath = 'docs/superpowers/plans/codex-owner-operator-run-d-intake.json';
  const support = [
    '.agents/skills/red-team/scripts/mutation-runner.mjs', '.agents/skills/red-team/SKILL.md',
    '.claude/skills/red-team/SKILL.md', 'scripts/ci/__tests__/red-team-mutation-runner.test.ts',
  ];
  const addedTests = [
    'watchdog recovery of exhausted dispatching Operator work preserves live claims and other topics',
    'watchdog recovery of exhausted dispatching work defers a turn locked by completion',
  ];
  const approval = {
    id: 'owner-run-d-second-pass-200', date: '2026-09-14', finding_ids: [],
    text: 'Question: May I make the Run D-only verifier change described in /private/tmp/run-d-next-pass-proposal.md and run its second adversarial pass, capped at 200 local test launches? This covers the 35 unmeasured cases, the recovery correction and verifier safeguards, includes only the named supporting paths, preserves earlier evidence, uses Codex only, and grants no third round.\nOwner: Go for it',
  };

  function prepare(approve = true): void {
    git('branch', '-m', 'codex/owner-operator-run-d');
    write('.gitignore', '.feature/\nred-team-home/\n');
    const inventory = JSON.parse(readFileSync(resolve(process.cwd(), report), 'utf8')).inventory
      .slice(0, 226).map(({ id, file, test }: { id: string; file: string; test: string }) => (
        { id, file, test, outcome: 'skipped-budget', reason: 'Original fixture evidence' }
      ));
    const historical = {
      mode: 'feature', branch: 'codex/owner-operator-run-d', round: 1,
      head_sha: '8b1c612b08d2b93208b4fbb7102f7d917ea9b9c2', inventory,
      counts: { discovered: 226, skipped_budget: 226 },
      findings: [{ id: 'original', reason: 'Original finding evidence' }], authorizations: [],
    };
    const intake = { version: 1, goal: 'Run D recovery', allowed_edit_surface: ['src/gate.ts'], tests_to_add: ['original test'] };
    write(report, JSON.stringify(historical));
    write(markdown, '# Original Run D evidence\n\nPreserve this trailing newline.\n');
    write(intakePath, JSON.stringify(intake));
    git('add', '.gitignore', report, markdown, intakePath);
    git('commit', '-qm', 'corrected Run D baseline with original evidence');
    const baseline = git('rev-parse', 'HEAD');
    const blob = git('rev-parse', `HEAD:${report}`);
    const markdownBlob = git('rev-parse', `HEAD:${markdown}`);
    runner = join(repo, '.feature/fixture-run-d-runner.mjs');
    mkdirSync(dirname(runner), { recursive: true });
    // Replace immutable fixture objects only, never add a runtime bypass.
    writeFileSync(runner, readFileSync(RUNNER, 'utf8')
      .replace("const RUN_D_BASELINE = 'bd23d56e542a825da1dc16b2c0375127ded2443c';", `const RUN_D_BASELINE = '${baseline}';`)
      .replace("const RUN_D_HISTORY_BLOB = '6cacfba8fcfddd2fe6c2832e8a1d51c8e88d93f0';", `const RUN_D_HISTORY_BLOB = '${blob}';`)
      .replace("const RUN_D_MARKDOWN_BLOB = '52625d75432e613c6ae6c7f535219c81d1f9d9ec';", `const RUN_D_MARKDOWN_BLOB = '${markdownBlob}';`));
    if (approve) {
      write(report, JSON.stringify({ ...historical, authorizations: [approval] }));
      write(markdown, `${read(markdown)}\nOwner authorization appended.\n`);
      write(intakePath, JSON.stringify({ ...intake,
        allowed_edit_surface: [...support, ...intake.allowed_edit_surface],
        tests_to_add: [...addedTests, ...intake.tests_to_add],
      }));
      git('add', report, markdown, intakePath);
      git('commit', '-qm', 'exact owner grant and scoped intake amendment');
    }
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

  it('pins Run D HEAD and grant from zero before the first child can execute', () => {
    prepare();
    const result = run('run', ...HOME_FLAG(), '--', process.execPath, '-e',
      'const j=JSON.parse(require("node:fs").readFileSync(".feature/red-team-journal.json","utf8"));process.exit(j.runs===1&&j.budgetAuthorization?.maxRuns===200&&j.budgetAuthorization?.firstRun===1&&j.supervisors.at(-1)?.active===true?0:9)');
    expect(result.status).toBe(0);
    expect(JSON.parse(read('.feature/red-team-journal.json')).budgetAuthorization).toMatchObject({
      id: approval.id, maxRuns: 200, firstRun: 1, headSha: git('rev-parse', 'HEAD'),
    });
    expect(run('run', ...HOME_FLAG(), '--', '/usr/bin/true').status).toBe(0);
    expect(journal().runs).toBe(2);
  });

  it.each(['missing', 'uncommitted', 'text', 'date', 'duplicate', 'extra field', 'finding ids', 'malformed']) (
    'refuses Run D %s approval before the first child launches', (mismatch) => {
      prepare(!['missing', 'uncommitted'].includes(mismatch));
      const sidecar = JSON.parse(read(report));
      if (mismatch === 'uncommitted') sidecar.authorizations.push(approval);
      if (mismatch === 'text') sidecar.authorizations[0].text = 'Owner: Go for it';
      if (mismatch === 'date') sidecar.authorizations[0].date = '2026-09-15';
      if (mismatch === 'duplicate') sidecar.authorizations.push(approval);
      if (mismatch === 'extra field') sidecar.authorizations[0].maxRuns = 201;
      if (mismatch === 'finding ids') sidecar.authorizations[0].finding_ids = ['waived'];
      write(report, mismatch === 'malformed' ? '{' : JSON.stringify(sidecar));
      if (mismatch !== 'uncommitted') {
        git('add', report);
        git('commit', '--allow-empty', '-qm', 'invalid grant');
      }
      expectRefused();
      expect(journal().supervisors).toEqual([]);
    },
  );

  it.each(['identity', 'inventory length', 'outcome', 'count', 'finding', 'report head', 'report round', 'markdown bytes', 'markdown missing']) (
    'preserves original Run D history by rejecting altered %s', (mismatch) => {
      prepare();
      const sidecar = JSON.parse(read(report));
      if (mismatch === 'identity') sidecar.inventory[0].test = 'different test';
      if (mismatch === 'inventory length') sidecar.inventory.pop();
      if (mismatch === 'outcome') sidecar.inventory[0].outcome = 'killed';
      if (mismatch === 'count') sidecar.counts.skipped_budget = 0;
      if (mismatch === 'finding') sidecar.findings[0].reason = 'rewritten finding';
      if (mismatch === 'report head') sidecar.head_sha = '0'.repeat(40);
      if (mismatch === 'report round') sidecar.round = 2;
      if (mismatch === 'markdown bytes') write(markdown, read(markdown).replace('newline.\n', 'newline.X'));
      if (mismatch === 'markdown missing') git('rm', '-q', markdown);
      write(report, JSON.stringify(sidecar));
      git('add', report);
      if (mismatch !== 'markdown missing') git('add', markdown);
      git('commit', '-qm', 'tampered historical evidence');
      expectRefused();
    },
  );

  it.each(['malformed', 'missing support', 'extra support', 'duplicate support', 'goal', 'missing recovery test']) (
    'rejects a Run D intake with %s before granting any budget', (mismatch) => {
      prepare();
      const intake = JSON.parse(read(intakePath));
      if (mismatch === 'missing support') intake.allowed_edit_surface.shift();
      if (mismatch === 'extra support') intake.allowed_edit_surface.push('src/**');
      if (mismatch === 'duplicate support') intake.allowed_edit_surface.push(support[0]);
      if (mismatch === 'goal') intake.goal = 'unrelated work';
      if (mismatch === 'missing recovery test') intake.tests_to_add.shift();
      write(intakePath, mismatch === 'malformed' ? '{' : JSON.stringify(intake));
      git('add', intakePath);
      git('commit', '-qm', 'invalid intake');
      expectRefused();
    },
  );

  it.each(['ancestry', 'committed production', 'unstaged', 'staged', 'untracked']) (
    'rejects Run D %s scope drift at startup', (mismatch) => {
      prepare();
      if (mismatch === 'ancestry') {
        const unrelated = git('commit-tree', git('rev-parse', 'HEAD^{tree}'), '-m', 'unrelated history');
        git('update-ref', 'HEAD', unrelated);
      } else if (mismatch === 'untracked') write('src/foreign.ts', 'untracked code');
      else {
        write('src/gate.ts', 'export const allow = () => true;');
        if (mismatch !== 'unstaged') git('add', 'src/gate.ts');
        if (mismatch === 'committed production') git('commit', '-qm', 'unexpected product edit');
      }
      expectRefused();
    },
  );

  it.each(['HEAD', 'approval', 'branch', 'round', 'journal grant', 'missing pin', 'first run']) (
    'rejects Run D %s drift after pinning and preserves its launch count', (mismatch) => {
      prepare();
      expect(run('run', ...HOME_FLAG(), '--', '/usr/bin/true').status).toBe(0);
      if (mismatch === 'HEAD') git('commit', '--allow-empty', '-qm', 'new head');
      if (mismatch === 'approval') {
        const sidecar = JSON.parse(read(report));
        sidecar.authorizations[0].text = 'new grant';
        write(report, JSON.stringify(sidecar));
        git('add', report);
        git('commit', '-qm', 'change grant');
      }
      if (mismatch === 'branch') git('branch', '-m', 'codex/other');
      const value = JSON.parse(read('.feature/red-team-journal.json'));
      if (mismatch === 'round') value.round = 1;
      if (mismatch === 'journal grant') value.budgetAuthorization.maxRuns = 201;
      if (mismatch === 'missing pin') delete value.budgetAuthorization;
      if (mismatch === 'first run') value.budgetAuthorization.firstRun = 2;
      writeJournal(value);
      expectRefused(1);
    },
  );

  it('allows a journaled Run D mutant and restores it while refusing unjournaled replacement', () => {
    prepare();
    expect(run('run', ...HOME_FLAG(), '--', '/usr/bin/true').status).toBe(0);
    write('.feature/mutant.ts', 'export const allow = () => true;');
    expect(run('mutate', '--file', 'src/gate.ts', '--mutant', join(repo, '.feature/mutant.ts')).status).toBe(0);
    expect(run('run', ...HOME_FLAG(), '--', '/usr/bin/true').status).toBe(0);
    write('src/gate.ts', 'export const allow = () => false;');
    expectRefused(2);
    write('src/gate.ts', read('.feature/mutant.ts'));
    expect(run('finalize').status).toBe(0);
    expect(read('src/gate.ts')).toBe('export const allow = (n: number) => n > 0;\n');
  });

  it('allows Run D launch 200 and refuses 201 without granting a third round from denial text', () => {
    prepare();
    expect(run('run', ...HOME_FLAG(), '--', '/usr/bin/true').status).toBe(0);
    writeJournal({ ...journal(), runs: 199 });
    expect(run('run', ...HOME_FLAG(), '--', '/usr/bin/true').status).toBe(0);
    expectRefused(200);
    expect(run('round-start').stderr).toContain('grants no third round');
    expect(journal().runs).toBe(200);
    write('.feature/red-team-journal.json', JSON.stringify({ ...journal(), round: 3 }));
    expectRefused(200);
  });

  it.each([-1, 0.5, '0', null])('rejects malformed Run D run count %s', (runs) => {
    prepare();
    write('.feature/red-team-journal.json', JSON.stringify({ ...journal(), runs }));
    expect(run('run', ...HOME_FLAG(), '--', '/usr/bin/true').status).toBe(1);
    expect(journal().runs).toBe(runs);
    expect(journal().supervisors).toEqual([]);
  });

  it.each([0, 3, 4, '2', null])('refuses Run D round %s from zero without a fallback launch', (round) => {
    prepare();
    write('.feature/red-team-journal.json', JSON.stringify({ ...journal(), round }));
    expectRefused();
    expect(journal().supervisors).toEqual([]);
  });

  it('refuses to retroactively pin a Run D budget after an unpinned launch count', () => {
    prepare();
    writeJournal({ ...journal(), runs: 1 });
    expectRefused(1);
    expect(JSON.parse(read('.feature/red-team-journal.json')).budgetAuthorization).toBeUndefined();
  });

  it.each(['other branch', 'first round'])('preserves ordinary launches and cap for %s', (scope) => {
    prepare();
    if (scope === 'other branch') git('branch', '-m', 'codex/other');
    else write('.feature/red-team-journal.json', JSON.stringify({ ...journal(), round: 1 }));
    expect(run('run', ...HOME_FLAG(), '--', '/usr/bin/true').status).toBe(0);
    expect(JSON.parse(read('.feature/red-team-journal.json')).budgetAuthorization).toBeUndefined();
    writeJournal({ ...journal(), runs: 30 });
    expectRefused(30);
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
