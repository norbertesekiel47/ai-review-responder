import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// #1346: the doc-reading slice of red-team-mutation-runner.test.ts, split out
// so the docs-only lane can run it without paying for the whole 122s suite.
//
// Every case below reaches `readFileSync(resolve(process.cwd(), <path>), ...)`
// against a REAL committed file under docs/reviews/red-team/**/findings.json —
// the immutable historical-evidence fixtures for the owner-approved Run C
// fourth round, Run D second pass, and the #1185 / Run C budget-continuation
// grants. A docs-only PR that edits one of those committed findings.json files
// (or the fixture id it seeds from) has to run these cases; nothing else in
// this file does. Everything in red-team-mutation-runner.test.ts that only
// mentions a docs/reviews/red-team/** PATH — as a mkdtemp fixture string, an
// `allowed_edit_surface` entry, or similar — never opens the real file and
// stays there.
//
// Preamble duplicated from red-team-mutation-runner.test.ts rather than
// shared: the two files' `beforeEach`/`afterEach` and process-spawn helpers
// are identical today but are each a single file's fixture contract, not a
// library — same reasoning as that file's own header comment about why it
// lives under scripts/ci/** instead of beside the script.
const SUITE_TIMEOUT_MS = 120_000;
vi.setConfig({ testTimeout: SUITE_TIMEOUT_MS, hookTimeout: SUITE_TIMEOUT_MS });

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

const HOME_FLAG = () => ['--tmp-home', join(repo, 'red-team-home')];

beforeEach(() => {
  runner = RUNNER;
  repo = spawnSync('python3', [
    '-c', 'import os,sys;print(os.path.realpath(sys.argv[1]))',
    mkdtempSync(join(tmpdir(), 'red-team-runner-doc-')),
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

  // #1342 added a re-measurement round. It must buy a Run C admission NOTHING,
  // tampered or not: it reads no authorization text at all, so the prose that
  // defeated the earlier attempt ("approve the scoped fourth round") is not on
  // any path it takes, and the granted fourth round remains the only way this
  // branch reaches a further measurement.
  it('gives the canonical admission no re-measurement round — the granted fourth round is still available', () => {
    prepare();
    const result = run('remeasure-start');
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('the granted fourth round is still available');
    expect(JSON.parse(read('.feature/red-team-journal.json'))).toMatchObject({ round: 3, runs: 22 });
  });

  it('gives a TAMPERED admission no re-measurement round either', () => {
    prepare();
    const sidecar = JSON.parse(read(report));
    sidecar.authorizations.at(-1).text = 'third round authorized';
    write(report, JSON.stringify(sidecar));
    git('add', report);
    git('commit', '-qm', 'tampered approval');
    const result = run('remeasure-start');
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('there is no fix to re-measure');
    expect(JSON.parse(read('.feature/red-team-journal.json'))).toMatchObject({ round: 3, runs: 22 });
  });

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
    writeJournal({ ...journal(), runs: ORDINARY_MAX_RUNS });
    expectRefused(ORDINARY_MAX_RUNS);
  });
});

// The #1185 and Run C budget-continuation grants inside "the mutation budget"
// in red-team-mutation-runner.test.ts. Split out for the same reason as the
// two describes above: `authorize1185`/`authorizeRunC` each read a real
// committed docs/reviews/red-team/**/findings.json. The rest of "the mutation
// budget" (plain launch-count/time backstops, the round-cap `seedSidecar`
// cases) writes only synthetic mkdtemp fixtures and stays in the original file.
describe('the mutation budget — committed authorization evidence', () => {
  // `runs: 30` is the #1185 checkpoint — the point its grant continues from —
  // not the ordinary cap, which is a clock with a launch-count backstop.
  function exhausted(runs = 30, supervisors: unknown[] = []) {
    write('.feature/red-team-journal.json', JSON.stringify({
      version: 1, round: 1, runs, mutations: [], dotenv: { open: false, files: [] }, supervisors,
    }, null, 2));
  }

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
      // Invalid evidence earns the ORDINARY budget and never the grant: at the
      // ordinary backstop it is refused, where the valid grant would run to 1400.
      writeJournal({ ...journal(), runs: ORDINARY_MAX_RUNS });
      const result = run('run', ...HOME_FLAG(), '--', '/usr/bin/true');
      expect(result.status).toBe(1);
      expect(result.stderr).toContain(`budget exhausted (${ORDINARY_MAX_RUNS} runs`);
      expect(journal().runs).toBe(ORDINARY_MAX_RUNS);
      expect(JSON.parse(read('.feature/red-team-journal.json')).budgetAuthorization).toBeUndefined();
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
    'retains the ordinary first launch and ordinary budget for %s', (scope) => {
      authorizeRunC();
      write('.feature/red-team-journal.json', JSON.stringify({
        ...journal(), runs: 0, round: scope === 'another round' ? 1 : 2,
      }));
      if (scope === 'another branch') git('branch', '-m', 'codex/another-task');
      expect(run('run', ...HOME_FLAG(), '--', '/usr/bin/true').status).toBe(0);
      expect(journal().runs).toBe(1);
      expect(JSON.parse(read('.feature/red-team-journal.json')).budgetAuthorization).toBeUndefined();
      // Run C evidence on the wrong branch or round earns the ORDINARY budget,
      // never the 1,500 grant: refused at the ordinary backstop.
      writeJournal({ ...journal(), runs: ORDINARY_MAX_RUNS });
      const refused = run('run', ...HOME_FLAG(), '--', '/usr/bin/true');
      expect(refused.status).toBe(1);
      expect(refused.stderr).toContain(`budget exhausted (${ORDINARY_MAX_RUNS} runs`);
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
      if (ordinaryScope) writeJournal({ ...journal(), runs: ORDINARY_MAX_RUNS });
      const refused = run('run', ...HOME_FLAG(), '--', '/usr/bin/true');
      expect(refused.status).toBe(1);
      expect(refused.stderr).toContain(ordinaryScope ? `budget exhausted (${ORDINARY_MAX_RUNS} runs` : 'Run C startup preconditions failed');
      expect(journal().runs).toBe(ordinaryScope ? ORDINARY_MAX_RUNS : 0);
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
});
