import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// #1346: the doc-reading slice of red-team-status.test.ts, split out so the
// docs-only lane can run it without paying for the whole 71s suite.
//
// `prepare()` below reaches `readFileSync(resolve(process.cwd(), report),
// ...)` against the REAL committed
// docs/reviews/red-team/codex-owner-operator-run-c-14b9e1/findings.json — the
// immutable historical-evidence fixture for the owner-approved Run C
// fourth-round proof. It is the ONLY real doc read in red-team-status.test.ts:
// every other describe block there builds its sidecar from `seedRepo` inside
// the mkdtemp fixture repo and never opens a file under process.cwd(). A
// docs-only PR that edits that committed findings.json has to run this block;
// nothing else moved.
//
// Preamble duplicated from red-team-status.test.ts rather than shared: same
// reasoning as red-team-mutation-runner-doc-reads.test.ts's header — each
// original file's fixture scaffolding is that file's own contract, not a
// shared library.
//
// WHY THIS FILE NEEDS A LONGER TIMEOUT THAN THE 5s DEFAULT: every case drives
// the checker as a CLI against a fixture repo `beforeEach` builds with real
// `git` commands, and the Run C fourth-round admission path validates a full
// historical report, ordered inventory identities and a journal prefix — one
// of the heaviest shapes in the original suite. Same 30s budget as the file
// it split from.
vi.setConfig({ testTimeout: 30_000, hookTimeout: 30_000 });

const CHECKER = resolve(
  process.cwd(),
  '.agents/skills/feature/scripts/red-team-status.mjs',
);

// git exports GIT_DIR and friends into hook and test processes; inherited here
// they would retarget every git call at the CALLER's repository.
const GIT_FREE_ENV = Object.fromEntries(
  Object.entries(process.env).filter(([key]) => !key.startsWith('GIT_')),
) as NodeJS.ProcessEnv;

const BRANCH = 'feat-red-team-fixture';

let repo: string;
let checker = CHECKER;

function git(...args: string[]): string {
  const result = spawnSync('git', args, { cwd: repo, encoding: 'utf8', env: GIT_FREE_ENV });
  if (result.status !== 0) {
    throw new Error(`git ${args.join(' ')} failed: ${result.stderr}`);
  }
  return result.stdout.trim();
}

function write(relativePath: string, contents: string): void {
  const absolute = join(repo, relativePath);
  mkdirSync(dirname(absolute), { recursive: true });
  writeFileSync(absolute, contents);
}

interface CheckResult {
  status: number;
  stdout: string;
  stderr: string;
}

function check(...args: string[]): CheckResult {
  const result = spawnSync('node', [checker, ...args], {
    cwd: repo,
    encoding: 'utf8',
    env: GIT_FREE_ENV,
  });
  return { status: result.status ?? -1, stdout: result.stdout, stderr: result.stderr };
}

/**
 * The expected report directory, taken from the checker's own absence message.
 *
 * Re-deriving the slug in the test would create a second owner of the identity
 * rule; asking the checker is both shorter and a real assertion — an operator
 * with no sidecar needs exactly this path. Since the risk-scoped waiver, a
 * normal-risk feature run reports the path on stdout inside its WAIVED line
 * (exit 0) while every failing shape still names it on stderr, so both streams
 * are searched.
 */
function reportDirFromAbsence(...args: string[]): string {
  const { stdout, stderr } = check(...args);
  const combined = `${stderr}\n${stdout}`;
  const match = combined.match(/no red-team sidecar at (\S+)\/findings\.json/);
  if (!match?.[1]) throw new Error(`could not read the expected path from:\n${combined}`);
  return match[1];
}

function sha256(value: string | Buffer): string {
  return createHash('sha256').update(value).digest('hex');
}

interface Sidecar {
  schema: number;
  mode: string;
  run_id: string;
  branch: string | null;
  fork_sha: string;
  merge_base_sha: string;
  head_sha: string;
  intake_sha256: string | null;
  risk: string;
  round: number;
  generated_at: string;
  inventory: Record<string, unknown>[];
  findings: Record<string, unknown>[];
  authorizations: Record<string, unknown>[];
  remeasurement?: Record<string, unknown>;
  counts: Record<string, number>;
  status: string;
}

const KILLED_ROW = {
  id: 'M1',
  test: 'settles a batch once',
  file: 'src/lib/thing/__tests__/thing.test.ts',
  outcome: 'killed',
};

function countsFor(sidecar: Pick<Sidecar, 'inventory' | 'findings'>): Record<string, number> {
  const rows = sidecar.inventory;
  const findings = sidecar.findings;
  const byOutcome = (outcome: string) => rows.filter((row) => row.outcome === outcome).length;
  const openOf = (severity: string) =>
    findings.filter((f) => f.severity === severity && f.disposition === 'open').length;
  return {
    inventory_total: rows.length,
    killed: byOutcome('killed'),
    survived_confirmed_p0: byOutcome('survived-confirmed-P0'),
    equivalent: byOutcome('equivalent'),
    inconclusive: byOutcome('inconclusive'),
    skipped_budget: byOutcome('skipped-budget'),
    excluded: byOutcome('excluded'),
    findings_total: findings.length,
    p0_open: openOf('P0'),
    p1_open: openOf('P1'),
    p2_open: openOf('P2'),
    accepted_risk: findings.filter((f) => f.disposition === 'accepted-risk').length,
    fixed: findings.filter((f) => f.disposition === 'fixed').length,
    rejected: findings.filter((f) => f.disposition === 'rejected').length,
  };
}

/**
 * A repository whose HEAD carries a committed red-team report.
 *
 * The report is committed AFTER `head_sha` on purpose: that is the real
 * ordering (mutations run on committed HEAD, the report lands after), and it is
 * the only shape in which the narrowed staleness exclusion means anything.
 */
function seedRepo(options: {
  branch?: string;
  intake?: Record<string, unknown> | null;
  patch?: (sidecar: Sidecar) => void;
  mode?: string;
  detached?: boolean;
  checkerArgs?: (shas: { forkSha: string; headSha: string }) => string[];
} = {}): { reportDir: string; sidecar: Sidecar } {
  const branch = options.branch ?? BRANCH;
  git('init', '-q', '-b', branch);
  git('config', 'user.email', 'red-team@example.test');
  git('config', 'user.name', 'red team');
  write('src/thing.ts', 'export const thing = 1;\n');
  git('add', 'src/thing.ts');
  git('commit', '-qm', 'base');
  const forkSha = git('rev-parse', 'HEAD');

  write('src/thing.ts', 'export const thing = 2;\n');
  git('add', 'src/thing.ts');
  git('commit', '-qm', 'work');
  const headSha = git('rev-parse', 'HEAD');

  const intake = options.intake === undefined ? { risk: 'normal' } : options.intake;
  const intakeJson = intake === null ? null : `${JSON.stringify(intake, null, 2)}\n`;
  if (intakeJson !== null) write('.feature/intake.json', intakeJson);

  if (options.detached) git('checkout', '-q', '--detach', 'HEAD');

  const reportDir = reportDirFromAbsence(...(options.checkerArgs?.({ forkSha, headSha }) ?? []));
  const mode = options.mode ?? 'feature';
  const slug = reportDir.split('/').pop() as string;

  const sidecar: Sidecar = {
    schema: 1,
    mode,
    run_id: `${mode}-${slug}`,
    branch: options.detached ? null : branch,
    fork_sha: forkSha,
    merge_base_sha: forkSha,
    head_sha: headSha,
    intake_sha256: intakeJson === null ? null : sha256(intakeJson),
    risk: 'normal',
    round: 1,
    generated_at: '2026-08-27T00:00:00.000Z',
    inventory: [{ ...KILLED_ROW }],
    findings: [],
    authorizations: [],
    counts: {},
    status: 'CLEAR',
  };
  options.patch?.(sidecar);
  sidecar.counts = { ...countsFor(sidecar), ...(sidecar.counts ?? {}) };

  write(`${reportDir}/findings.json`, `${JSON.stringify(sidecar, null, 2)}\n`);
  write(`${reportDir}/findings.md`, '# Red-team findings\n\nStatus: CLEAR\n');
  git('add', `${reportDir}/findings.json`, `${reportDir}/findings.md`);
  git('commit', '-qm', 'red-team report');

  return { reportDir, sidecar };
}

function rewriteSidecar(reportDir: string, mutate: (sidecar: Sidecar) => void): void {
  const path = `${reportDir}/findings.json`;
  const sidecar = JSON.parse(readFileSync(join(repo, path), 'utf8')) as Sidecar;
  mutate(sidecar);
  write(path, `${JSON.stringify(sidecar, null, 2)}\n`);
  git('add', path);
  git('commit', '-qm', 'amend report');
}

beforeEach(() => {
  checker = CHECKER;
  // realpath: macOS $TMPDIR is a symlink and `git rev-parse --show-toplevel`
  // answers with the resolved path, which the checker's path joins rely on.
  repo = mkdtempSync(join(tmpdir(), 'red-team-status-doc-'));
  repo = spawnSync('python3', ['-c', 'import os,sys;print(os.path.realpath(sys.argv[1]))', repo], {
    encoding: 'utf8',
  }).stdout.trim();
});

afterEach(() => {
  rmSync(repo, { recursive: true, force: true });
});

describe('the committed Run C fourth-round proof', () => {
  const reportDir = 'docs/reviews/red-team/codex-owner-operator-run-c-14b9e1';
  const report = `${reportDir}/findings.json`;
  const markdown = `${reportDir}/findings.md`;
  const historicalMarkdown = '# Historical duty evidence\n\nSibling search used fixture scope.\n';
  const approval = {
    id: 'owner-run-c-fourth-round-prompt-regression', date: '2026-09-13', finding_ids: [],
    text: 'Question: May I make the Run C-only verifier change described in /private/tmp/run-c-fourth-round-proposal.md and run a fourth verification round, capped at 150 local test launches? It covers the prompt fix and the verifier’s own safeguards, preserves all earlier evidence, uses Codex only, and keeps further rounds blocked.\nOwner: Yes, approve the scoped fourth round',
  };

  function prepare(committedApproval = true): { head: string; baseline: string } {
    const { sidecar } = seedRepo({ intake: { risk: 'high' } });
    git('branch', '-m', 'codex/owner-operator-run-c');
    sidecar.branch = 'codex/owner-operator-run-c';
    sidecar.run_id = 'feature-codex-owner-operator-run-c-14b9e1';
    sidecar.risk = 'high';
    sidecar.round = 3;
    sidecar.head_sha = '2565c78585d6b08837e01dbb2a4a3ba3c265eff0';
    sidecar.inventory = JSON.parse(readFileSync(resolve(process.cwd(), report), 'utf8')).inventory
      .slice(0, 785).map(({ id, file, test }: { id: string; file: string; test: string }) => (
        { id, file, test, outcome: 'excluded', reason: 'Historical fixture evidence, retained verbatim.' }
      ));
    sidecar.findings = [{
      id: 'HISTORICAL', severity: 'P2', title: 'Historical resolved finding',
      at: 'src/thing.ts:1', duty: 2, disposition: 'fixed', reason: 'Historical correction retained.',
    }];
    sidecar.authorizations = [{ id: 'third', date: '2026-09-13', finding_ids: ['HISTORICAL'], text: 'third round authorized' }];
    sidecar.counts = countsFor(sidecar);
    write(report, JSON.stringify(sidecar));
    write(markdown, historicalMarkdown);
    git('add', reportDir);
    git('commit', '-qm', 'immutable historical evidence');
    const baseline = git('rev-parse', 'HEAD');
    const blob = git('rev-parse', `HEAD:${report}`);
    const markdownBlob = git('rev-parse', `HEAD:${markdown}`);
    const runnerPath = '.agents/skills/red-team/scripts/mutation-runner.mjs';
    write('fixture-fourth-runner.mjs', readFileSync(resolve(process.cwd(), runnerPath), 'utf8')
      .replace("const RUN_C_FOURTH_BASELINE = 'fb536c09711ec331262f5efc64ff42f066bec3ba';", `const RUN_C_FOURTH_BASELINE = '${baseline}';`)
      .replace("const RUN_C_HISTORY_BLOB = 'd2de690d9154e591d83cbb9e9591db8d0567d318';", `const RUN_C_HISTORY_BLOB = '${blob}';`)
      .replace("const RUN_C_HISTORY_MARKDOWN_BLOB = 'caae5b4d877e254033485a73f38f56b074c8910e';", `const RUN_C_HISTORY_MARKDOWN_BLOB = '${markdownBlob}';`));
    checker = join(repo, 'fixture-fourth-checker.mjs');
    writeFileSync(checker, readFileSync(CHECKER, 'utf8').replace(
      '../../red-team/scripts/mutation-runner.mjs', './fixture-fourth-runner.mjs',
    ));
    if (committedApproval) {
      sidecar.authorizations.push(approval);
      write(report, JSON.stringify(sidecar));
      git('add', report);
      git('commit', '-qm', 'commit approval before measurement');
    }
    const head = git('rev-parse', 'HEAD');
    if (!committedApproval) sidecar.authorizations.push(approval);
    sidecar.round = 4;
    sidecar.head_sha = head;
    sidecar.inventory.push({ ...KILLED_ROW, id: 'R4-NEW' });
    sidecar.counts = countsFor(sidecar);
    write(report, JSON.stringify(sidecar));
    write(markdown, `${historicalMarkdown}\n## Round 4\nFresh results appended after the preserved duties.\n`);
    git('add', report, markdown);
    git('commit', '-qm', 'append fourth-round results after measurement');
    write('.feature/red-team-journal.json', JSON.stringify({
      round: 4, runs: 2, mutations: [], supervisors: [], dotenv: { open: false, files: [] },
      budgetAuthorization: { id: approval.id, headSha: head, maxRuns: 150, firstRun: 1, sha256: sha256(JSON.stringify(approval)) },
    }));
    return { head, baseline };
  }

  it('accepts appended fourth-round results only with committed admission and launch proof', () => {
    prepare();
    const result = check();
    expect(result.stderr).toBe('');
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('round 4');
  });

  it('rejects approval first written in the final report after measurement', () => {
    prepare(false);
    expect(check().status).toBe(1);
  });

  it.each(['deleted', 'rewritten', 'trailing newline removed'])(
    'rejects final evidence when historical Markdown is %s', (change) => {
      prepare();
      if (change === 'deleted') git('rm', '-q', markdown);
      else {
        write(markdown, change === 'rewritten' ? '# Replacement round 4 results\n' : historicalMarkdown.trimEnd());
        git('add', markdown);
      }
      git('commit', '-qm', 'discard historical narrative bytes');
      expect(check().status).toBe(1);
    },
  );

  it.each(['missing approval', 'foreign branch', 'wrong text', 'wrong date', 'measured head', 'identity', 'history', 'intake', 'dirty', 'unrestored', 'grant', 'missing journal', 'budget', 'fifth', 'accepted risk'])(
    'rejects fourth-round evidence with %s', (mismatch) => {
      const { baseline } = prepare();
      if (['missing approval', 'foreign branch', 'wrong text', 'wrong date', 'measured head', 'identity', 'history', 'fifth', 'accepted risk'].includes(mismatch)) {
        rewriteSidecar(reportDir, (sidecar) => {
          if (mismatch === 'missing approval') sidecar.authorizations.pop();
          if (mismatch === 'foreign branch') sidecar.branch = 'codex/other';
          if (mismatch === 'wrong text') sidecar.authorizations.at(-1)!.text = 'third round authorized';
          if (mismatch === 'wrong date') sidecar.authorizations.at(-1)!.date = '2026-09-14';
          if (mismatch === 'measured head') sidecar.head_sha = baseline;
          if (mismatch === 'identity') sidecar.inventory[0]!.test = 'rewritten identity';
          if (mismatch === 'history') sidecar.inventory[0]!.reason = 'rewritten historical evidence';
          if (mismatch === 'fifth') sidecar.round = 5;
          if (mismatch === 'accepted risk') {
            sidecar.findings.push({
              id: 'R4-RISK', severity: 'P2', title: 'Unapproved risk', at: 'src/thing.ts:1', duty: 2,
              disposition: 'accepted-risk', authorization: approval.id,
            });
            sidecar.counts = countsFor(sidecar);
          }
        });
      } else if (mismatch === 'intake') write('.feature/intake.json', JSON.stringify({ risk: 'high', edited: true }));
      else if (mismatch === 'dirty') write('src/thing.ts', 'export const thing = 99;\n');
      else if (mismatch === 'missing journal') rmSync(join(repo, '.feature/red-team-journal.json'));
      else {
        const journal = JSON.parse(readFileSync(join(repo, '.feature/red-team-journal.json'), 'utf8'));
        if (mismatch === 'unrestored') journal.mutations = [{ path: 'src/thing.ts', state: 'applied' }];
        if (mismatch === 'grant') journal.budgetAuthorization.sha256 = '0'.repeat(64);
        if (mismatch === 'budget') journal.runs = 151;
        write('.feature/red-team-journal.json', JSON.stringify(journal));
      }
      expect(check().status).toBe(1);
    },
  );
});
