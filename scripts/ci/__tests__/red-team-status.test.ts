import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

// Lives here, not beside the script, for the reason edit-surface-guard.test.ts
// states: vitest's include roots are scripts/ci/**, src/**, worker/**, tests/**
// and e2e/** — a test under .agents/ would silently never run. The checker is
// therefore exercised the way the feature workflows invoke it, as a CLI.
//
// WHAT THIS PINS. `red-team-status.mjs` is the only thing standing between a
// self-inconsistent red-team report and a `reviewed` phase, and every rule it
// enforces was a review finding before it was code: recomputation instead of
// trusting `status`, run binding that never reads its identity out of the file
// under validation, a staleness window narrowed to the run's own two artifacts,
// high-risk P1 adjudication as an exit code, and the dotenv-backup class that
// `git status` cannot see.

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
  repo = mkdtempSync(join(tmpdir(), 'red-team-status-'));
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

describe('the committed Run E second-pass proof', () => {
  const branch = 'codex/owner-operator-run-e';
  const reportDir = 'docs/reviews/red-team/codex-owner-operator-run-e-eb15ab';
  const report = `${reportDir}/findings.json`;
  const markdown = `${reportDir}/findings.md`;
  const intakePath = 'docs/superpowers/plans/codex-owner-operator-run-e-intake.json';
  const journalPath = '.feature/red-team-journal.json';
  const scopePath = 'docs/reviews/codex-owner-operator-run-e/budget-extension-review.md';
  const scopeManifest = { schema: 1, sourceHead: '54cb1a05e82de192355e379b7eb7b76182189306', groups: [
    { id: 'unchanged-mocked-case', reason: 'Root-reviewed discovery correction: the unchanged whole-module mock cuts the changed runtime edge.', ids: ['E0'] },
  ] };
  const scopeStart = '<!-- RUN_E_SCOPE_CORRECTIONS_START -->';
  const scopeEnd = '<!-- RUN_E_SCOPE_CORRECTIONS_END -->';
  const scopeDocument = `${scopeStart}\n\`\`\`json\n${JSON.stringify(scopeManifest)}\n\`\`\`\n${scopeEnd}\n`;
  const approval = {
    id: 'owner-run-e-second-pass-1600', date: '2026-09-15', finding_ids: [],
    text: 'Question: May I apply the reviewed Run E proposal at /private/tmp/run-e-next-pass-proposal.md and run one second adversarial pass, capped at 1,600 local test launches? This covers the 707 remaining cases, the Restore fix and verifier safeguards, the named supporting files and staging alert setup. It preserves earlier evidence and your approval in history, leaves the final risk-waiver list empty, uses Codex only, and grants no third round.\nOwner: Yes, approve the scoped E second pass',
  };
  const supportingPaths = [
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

  function prepareE(scopeProof: string | null = scopeDocument, publishFinal = true): { final: Sidecar; journal: Record<string, unknown>; historyCommit: string; admissionMarkdown: string } {
    checker = CHECKER;
    const { sidecar } = seedRepo({ intake: { risk: 'high' } });
    git('branch', '-m', branch);
    const originalIntake = { risk: 'high', allowed_edit_surface: ['docs/reviews/red-team/codex-owner-operator-run-e/**'], tests_to_add: ['original promise'] };
    write(intakePath, JSON.stringify(originalIntake));
    git('add', intakePath);
    git('commit', '-qm', 'corrected code baseline without original reports');
    const baseline = git('rev-parse', 'HEAD');
    Object.assign(sidecar, {
      branch, run_id: 'feature-codex-owner-operator-run-e-eb15ab', risk: 'high', round: 1,
      head_sha: '890eea76c8c04b8d2acfcc73a895ec3112560e38', status: 'INCOMPLETE_BUDGET',
      inventory: Array.from({ length: 2113 }, (_, index) => ({
        id: `E${index}`, file: KILLED_ROW.file, test: `original case ${index}`,
        outcome: index === 0 || index === 3 ? 'skipped-budget' : index === 1 ? 'killed' : 'excluded',
        reason: index === 0 || index === 3 ? 'Original budget exhausted.' : 'Original evidence retained.',
      })),
      findings: [{ id: 'E-P1', severity: 'P1', title: 'Historical finding', at: 'src/thing.ts:1', duty: 2, disposition: 'open' }],
      authorizations: [],
    });
    sidecar.counts = countsFor(sidecar);
    const history = JSON.stringify(sidecar);
    const historyMarkdown = '# Original E evidence\n\nExact historical duties.\n\n';
    write(report, history);
    write(markdown, historyMarkdown);
    git('add', report, markdown);
    git('commit', '-qm', 'publish immutable original evidence');
    const historyCommit = git('rev-parse', 'HEAD');
    const anchors: Record<string, string> = {
      RUN_E_BASELINE: baseline,
      RUN_E_HISTORY_COMMIT: historyCommit,
      RUN_E_HISTORY_BLOB: git('rev-parse', `HEAD:${report}`),
      RUN_E_HISTORY_MARKDOWN_BLOB: git('rev-parse', `HEAD:${markdown}`),
      RUN_E_HISTORY_SHA256: sha256(history),
      RUN_E_MARKDOWN_SHA256: sha256(historyMarkdown),
      RUN_E_IDENTITY_SHA256: sha256(JSON.stringify(sidecar.inventory.map(({ id, file, test }) => ({ id, file, test })))),
    };
    // Rebind only immutable trust anchors for this disposable repository;
    // exercise the actual admission helper and checker, without mocked proofs.
    let runner = readFileSync(resolve(process.cwd(), '.agents/skills/red-team/scripts/mutation-runner.mjs'), 'utf8');
    for (const [name, value] of Object.entries(anchors)) {
      const declaration = new RegExp(`const ${name} = '[^']*';`);
      expect(runner).toMatch(declaration);
      runner = runner.replace(declaration, `const ${name} = '${value}';`);
    }
    write('fixture-e-runner.mjs', runner);
    checker = join(repo, 'fixture-e-checker.mjs');
    const checkerSource = readFileSync(CHECKER, 'utf8');
    const scopeAnchor = /const RUN_E_SCOPE_CORRECTIONS_SHA256 = '[^']*';/g;
    expect(checkerSource.match(scopeAnchor)).toHaveLength(1);
    writeFileSync(checker, checkerSource.replace(
      '../../red-team/scripts/mutation-runner.mjs', './fixture-e-runner.mjs',
    ).replace(scopeAnchor, `const RUN_E_SCOPE_CORRECTIONS_SHA256 = '${sha256(JSON.stringify(scopeManifest))}';`));
    sidecar.authorizations = [approval];
    write(report, JSON.stringify(sidecar));
    const admissionMarkdown = `${historyMarkdown}## Execution admission\n${approval.text}\n`;
    write(markdown, admissionMarkdown);
    const intake = JSON.stringify({ ...originalIntake,
      allowed_edit_surface: ['docs/reviews/red-team/codex-owner-operator-run-e-eb15ab/**', ...supportingPaths],
      tests_to_add: [...addedTests, ...originalIntake.tests_to_add],
    });
    write(intakePath, intake);
    write('.feature/intake.json', intake);
    git('add', report, markdown, intakePath);
    if (scopeProof !== null) {
      write(scopePath, scopeProof);
      git('add', scopePath);
    }
    git('commit', '-qm', 'commit exact execution admission');
    const admissionHead = git('rev-parse', 'HEAD');
    const originalAdmissionAnchor = /const RUN_E_ORIGINAL_ADMISSION = '[^']*';/g;
    expect(runner.match(originalAdmissionAnchor)).toHaveLength(1);
    write('fixture-e-runner.mjs', runner.replace(originalAdmissionAnchor, `const RUN_E_ORIGINAL_ADMISSION = '${admissionHead}';`));
    Object.assign(sidecar, { round: 2, head_sha: admissionHead, intake_sha256: sha256(intake), status: 'CLEAR', authorizations: [] });
    sidecar.inventory[0] = { ...sidecar.inventory[0], outcome: 'killed', reason: 'New individual baseline and mutant measured green/red; selector original case 0.' };
    sidecar.inventory[3] = { ...sidecar.inventory[3], outcome: 'killed', reason: 'New individual baseline and mutant measured green/red; selector original case 3.' };
    sidecar.inventory.push({ ...KILLED_ROW, id: 'E-APPENDED' });
    sidecar.findings[0] = { ...sidecar.findings[0], disposition: 'fixed', reason: 'Root verified correction and its new measurement.' };
    sidecar.counts = countsFor(sidecar);
    if (publishFinal) {
      write(report, JSON.stringify(sidecar));
      write(markdown, `${admissionMarkdown}\n# Final E result\nNew evidence appended after exact admission.\n`);
      git('add', report, markdown);
      git('commit', '-qm', 'final results after admitted measurement');
    }
    const journal = {
      round: 2, runs: 4, mutations: [], supervisors: [], dotenv: { open: false, files: [] },
      budgetAuthorization: { id: approval.id, headSha: admissionHead, maxRuns: 1600, firstRun: 1, sha256: sha256(JSON.stringify(approval)) },
    };
    write(journalPath, JSON.stringify(journal));
    return { final: sidecar, journal, historyCommit, admissionMarkdown };
  }

  describe('same-round continuation certification', () => {
    interface ContinuationJournal {
      version: number;
      round: number;
      runs: number;
      mutations: Array<{ path: string; state: string }>;
      supervisors: Array<{ pgid: number; active: boolean }>;
      dotenv: { open: boolean; files: string[] };
      budgetAuthorization: { id: string; maxRuns: number; sha256: string; headSha: string; firstRun: number };
      continuationAdmission?: { headSha: string; checkpointSha256: string; firstRun: number };
    }

    const correctionReason = 'Root-reviewed source correction: original case 3 stops at its unchanged mock boundary; no changed runtime behavior is reached.';
    const section = (name: string, value: unknown) =>
      `<!-- RUN_E_${name}_START -->\n\`\`\`json\n${JSON.stringify(value)}\n\`\`\`\n<!-- RUN_E_${name}_END -->\n`;

    function prepareContinuation(options: {
      changeDocument?: (document: string) => string;
      extraChange?: { path: string; contents: string };
    } = {}) {
      const fixture = prepareE(scopeDocument, false);
      const originalHead = fixture.final.head_sha;
      const checkpoint: ContinuationJournal = {
        version: 1, round: 2, runs: 124,
        mutations: Array.from({ length: 62 }, (_, index) => ({ path: `src/checkpoint-${index}.ts`, state: 'restored' })),
        // These inert values cannot name a process group on the host.
        supervisors: Array.from({ length: 124 }, (_, index) => ({ pgid: Number.MAX_SAFE_INTEGER - index, active: false })),
        dotenv: { open: false, files: [] },
        budgetAuthorization: { id: approval.id, maxRuns: 1600, sha256: sha256(JSON.stringify(approval)), headSha: originalHead, firstRun: 1 },
      };
      const corrections = { schema: 1, sourceHead: originalHead, groups: [
        { id: 'continuation-mock-boundary', reason: correctionReason, ids: ['E3', 'E-DISCOVERY-DELTA'] },
      ] };
      const checkpointDigest = sha256(JSON.stringify(checkpoint));
      let runner = readFileSync(join(repo, 'fixture-e-runner.mjs'), 'utf8');
      for (const [name, value] of Object.entries({
        RUN_E_ORIGINAL_ADMISSION: originalHead,
        RUN_E_CHECKPOINT_SHA256: checkpointDigest,
        RUN_E_CONTINUATION_SCOPE_SHA256: sha256(JSON.stringify(corrections)),
      })) {
        const anchor = new RegExp(`const ${name} = '[^']*';`, 'g');
        expect(runner.match(anchor)).toHaveLength(1);
        runner = runner.replace(anchor, `const ${name} = '${value}';`);
      }
      write('fixture-e-runner.mjs', runner);
      const document = `${scopeDocument}${section('CHECKPOINT_124', checkpoint)}${section('CONTINUATION_SCOPE_CORRECTIONS', corrections)}`;
      write(scopePath, options.changeDocument?.(document) ?? document);
      const supportPath = 'scripts/ci/__tests__/red-team-status.test.ts';
      write(supportPath, '// Synthetic continuation support change.\n');
      git('add', scopePath, supportPath);
      if (options.extraChange) {
        write(options.extraChange.path, options.extraChange.contents);
        git('add', options.extraChange.path);
      }
      git('commit', '-qm', 'commit reviewed same-round successor');
      const successorHead = git('rev-parse', 'HEAD');
      const journal: ContinuationJournal = {
        ...structuredClone(checkpoint), runs: 125,
        supervisors: [...checkpoint.supervisors, { pgid: Number.MAX_SAFE_INTEGER - 124, active: false }],
        continuationAdmission: { headSha: successorHead, checkpointSha256: checkpointDigest, firstRun: 125 },
      };
      fixture.final.head_sha = successorHead;
      fixture.final.inventory[0] = { ...fixture.final.inventory[0], outcome: 'excluded', reason: scopeManifest.groups[0]!.reason };
      fixture.final.inventory[3] = { ...fixture.final.inventory[3], outcome: 'excluded', reason: correctionReason };
      fixture.final.inventory.push({ ...KILLED_ROW, id: 'E-DISCOVERY-DELTA', outcome: 'excluded', reason: correctionReason });
      fixture.final.counts = countsFor(fixture.final);
      write(report, JSON.stringify(fixture.final));
      write(markdown, `${fixture.admissionMarkdown}\n# Continuation result\nMeasured continuation and exact source corrections.\n`);
      git('add', report, markdown);
      git('commit', '-qm', 'publish continuation results separately');
      write(journalPath, JSON.stringify(journal));
      return { ...fixture, journal, originalHead, successorHead, document };
    }

    function expectContinuationRejected(label: string): void {
      const result = check();
      expect(result.status, label).toBe(1);
      expect(result.stderr, label).toContain('Run E round 2 requires');
    }

    function recreateFixture(): void {
      rmSync(repo, { recursive: true, force: true });
      mkdirSync(repo, { recursive: true });
    }

    it('certifies a closed Run E continuation with both exact correction manifests and a separate final report', () => {
      const fixture = prepareContinuation();
      expect(git('rev-parse', 'HEAD')).not.toBe(fixture.successorHead);
      expect(git('rev-parse', 'HEAD^')).toBe(fixture.successorHead);
      expect(fixture.journal.budgetAuthorization.headSha).toBe(fixture.originalHead);
      expect(check()).toMatchObject({ status: 0, stderr: '' });
      const capped = structuredClone(fixture.journal);
      capped.runs = 1600;
      capped.supervisors.push(...Array.from({ length: 1475 }, (_, index) => ({ pgid: Number.MAX_SAFE_INTEGER - 125 - index, active: false })));
      write(journalPath, JSON.stringify(capped));
      expect(check()).toMatchObject({ status: 0, stderr: '' });
    });

    it('rejects continuation exclusions with altered reasons, unapproved IDs, or previously measured outcomes', () => {
      const fixture = prepareContinuation();
      expect(check().status).toBe(0);
      for (const [index, reason] of [
        [3, `${correctionReason} Additional waiver.`],
        [0, correctionReason],
        [1, correctionReason],
        [2, correctionReason],
      ] as const) {
        const final = structuredClone(fixture.final);
        final.inventory[index] = { ...final.inventory[index], outcome: 'excluded', reason };
        final.counts = countsFor(final);
        write(report, JSON.stringify(final));
        expectContinuationRejected(`correction for E${index}: ${reason}`);
      }
      for (const change of ['missing appended ID', 'altered appended reason']) {
        const final = structuredClone(fixture.final);
        const index = final.inventory.findIndex((row) => row.id === 'E-DISCOVERY-DELTA');
        expect(index).toBeGreaterThan(2112);
        if (change === 'missing appended ID') final.inventory.splice(index, 1);
        else final.inventory[index]!.reason = `${correctionReason} Additional waiver.`;
        final.counts = countsFor(final);
        write(report, JSON.stringify(final));
        expectContinuationRejected(change);
      }
    }, 15_000);

    it('requires the exact committed continuation checkpoint even when the live document is repaired', () => {
      for (const changeDocument of [
        (document: string) => document.replace(/<!-- RUN_E_CHECKPOINT_124_START -->[\s\S]*?<!-- RUN_E_CHECKPOINT_124_END -->\n/, ''),
        (document: string) => document.replace('"runs":124', '"runs":123'),
      ]) {
        recreateFixture();
        const fixture = prepareContinuation({ changeDocument });
        write(scopePath, fixture.document);
        expectContinuationRejected('missing or altered committed checkpoint');
      }
    }, 15_000);

    it('rejects continuation journal prefix edits, missing pins, and a second successor pin', () => {
      const fixture = prepareContinuation();
      expect(check().status).toBe(0);
      const changes: Array<[string, (journal: ContinuationJournal) => void]> = [
        ['mutation prefix', (journal) => { journal.mutations[0]!.path = 'src/replacement.ts'; }],
        ['supervisor prefix', (journal) => { journal.supervisors[0]!.pgid -= 1; }],
        ['truncated mutations', (journal) => { journal.mutations.shift(); }],
        ['open appended mutation', (journal) => { journal.mutations.push({ path: 'src/unrestored.ts', state: 'applied' }); }],
        ['active appended supervisor', (journal) => { journal.supervisors[124]!.active = true; }],
        ['open dotenv scrub', (journal) => { journal.dotenv.open = true; }],
        ['missing continuation pin', (journal) => { delete journal.continuationAdmission; }],
        ['missing original authorization pin', (journal) => { Reflect.deleteProperty(journal, 'budgetAuthorization'); }],
        ['checkpoint pin', (journal) => { journal.continuationAdmission!.checkpointSha256 = '0'.repeat(64); }],
        ['retroactive first run', (journal) => { journal.continuationAdmission!.firstRun = 124; }],
        ['second successor pin', (journal) => { journal.continuationAdmission!.headSha = git('rev-parse', 'HEAD'); }],
        ['original authorization pin', (journal) => { journal.budgetAuthorization.headSha = fixture.successorHead; }],
      ];
      for (const [label, change] of changes) {
        const journal = structuredClone(fixture.journal);
        change(journal);
        write(journalPath, JSON.stringify(journal));
        expectContinuationRejected(label);
      }
      write(journalPath, JSON.stringify(fixture.journal));
      write(report, JSON.stringify({ ...fixture.final, head_sha: fixture.originalHead }));
      expectContinuationRejected('fallback to original admission after continuation pin');
    }, 15_000);

    it('keeps continuation in round two without a counter reset or a fresh 1600 launch allowance', () => {
      const fixture = prepareContinuation();
      expect(check().status).toBe(0);
      for (const runs of [0, 124, 1601]) {
        const journal = structuredClone(fixture.journal);
        journal.runs = runs;
        journal.supervisors = Array.from({ length: runs }, (_, index) => ({ pgid: Number.MAX_SAFE_INTEGER - index, active: false }));
        write(journalPath, JSON.stringify(journal));
        expectContinuationRejected(`counter ${runs}`);
      }
      write(journalPath, JSON.stringify({ ...fixture.journal, runs: 126 }));
      expectContinuationRejected('counter without its supervisor');
      for (const round of [1, 3]) {
        write(journalPath, JSON.stringify({ ...fixture.journal, round }));
        write(report, JSON.stringify({ ...fixture.final, round }));
        expect(check().status, `round ${round}`).toBe(1);
      }
    });

    it('requires the committed continuation scope digest and preserves the original review prefix', () => {
      for (const changeDocument of [
        (document: string) => document.replace(correctionReason, 'Unreviewed exclusion reason.'),
        (document: string) => document.replace('RUN_E_CONTINUATION_SCOPE_CORRECTIONS_START', 'MISSING_SCOPE_START'),
        (document: string) => `Rewritten original prefix\n${document}`,
      ]) {
        recreateFixture();
        const fixture = prepareContinuation({ changeDocument });
        write(scopePath, fixture.document);
        expectContinuationRejected('committed scope or original review prefix');
      }
    }, 20_000);

    it('preserves historical identities, findings, and admission markdown through continuation', () => {
      const fixture = prepareContinuation();
      expect(check().status).toBe(0);
      const changes: Array<(final: Sidecar) => void> = [
        (final) => { final.inventory[0]!.test = 'Replacement identity'; },
        (final) => { final.findings[0]!.title = 'Replacement finding'; },
        (final) => { final.inventory[2]!.reason = 'Rewritten original exclusion'; },
      ];
      for (const change of changes) {
        const final = structuredClone(fixture.final);
        change(final);
        write(report, JSON.stringify(final));
        expectContinuationRejected('rewritten original evidence');
      }
      write(report, JSON.stringify(fixture.final));
      const finalMarkdown = readFileSync(join(repo, markdown), 'utf8');
      for (const text of [
        finalMarkdown.replace('Exact historical duties.', 'Replacement duties.'),
        finalMarkdown.replace(approval.text, 'Replacement execution authority.'),
      ]) {
        write(markdown, text);
        expectContinuationRejected('rewritten admission markdown');
      }
    });

    it('rejects continuation commits that change product code, canonical intake, or a ninth support path', () => {
      for (const extraChange of [
        { path: 'src/thing.ts', contents: 'export const thing = 3;\n' },
        { path: intakePath, contents: '{"risk":"normal"}\n' },
        { path: 'docs/runbooks/beta-launch-alerting.md', contents: 'Outside the eight continuation paths.\n' },
      ]) {
        recreateFixture();
        prepareContinuation({ extraChange });
        expectContinuationRejected(extraChange.path);
      }
    }, 20_000);
    describe('finite corrective admission certification', () => {
      const settingsPath = 'src/lib/auto-approval/__tests__/settings.test.ts';
      const deviationsPath = 'docs/superpowers/plans/codex-owner-operator-run-e-deviations.md';
      const correctedSettings = "export const locationId = 'bbbbbbbb-0000-4000-8000-000000000001';\n";
      const checkpointRuns = 126;
      type CorrectivePin = { headSha: string; predecessorHeadSha: string; checkpointSha256: string; firstRun: number };
      type CorrectiveJournal = ContinuationJournal & { correctiveAdmission?: CorrectivePin };

      function committedText(revision: string, path: string): string {
        const result = spawnSync('git', ['show', `${revision}:${path}`], { cwd: repo, encoding: 'utf8', env: GIT_FREE_ENV });
        if (result.status !== 0) throw new Error(`missing committed fixture evidence: ${revision}:${path}`);
        return result.stdout;
      }

      function prepareCorrective(options: {
        changeDocument?: (document: string) => string;
        settingsContents?: string;
        extraChange?: { path: string; contents: string };
      } = {}) {
        const fixture = prepareContinuation();
        // The old helper publishes a report after admission. Restore its exact
        // archived admission bytes before freezing the synthetic predecessor.
        write(report, committedText(fixture.successorHead, report));
        write(markdown, committedText(fixture.successorHead, markdown));
        write(deviationsPath, '# Preserved predecessor deviations\n');
        git('add', report, markdown, deviationsPath);
        git('commit', '-qm', 'freeze corrective predecessor with original admission evidence');
        const predecessorHead = git('rev-parse', 'HEAD');
        const checkpoint: CorrectiveJournal = {
          ...structuredClone(fixture.journal), runs: checkpointRuns,
          mutations: [...fixture.journal.mutations, { path: 'src/thing.ts', state: 'restored' }],
          supervisors: [...fixture.journal.supervisors, { pgid: Number.MAX_SAFE_INTEGER - 125, active: false }],
          continuationAdmission: { ...fixture.journal.continuationAdmission!, headSha: predecessorHead },
        };
        const checkpointSha256 = sha256(JSON.stringify(checkpoint));
        const blob = createHash('sha1').update(`blob ${Buffer.byteLength(correctedSettings)}\0${correctedSettings}`).digest('hex');
        const runnerPath = join(repo, 'fixture-e-runner.mjs');
        let source = readFileSync(runnerPath, 'utf8');
        for (const [name, value] of Object.entries({
          RUN_E_CORRECTIVE_PREDECESSOR: predecessorHead,
          RUN_E_CORRECTIVE_CHECKPOINT_SHA256: checkpointSha256,
        })) {
          const anchor = new RegExp(`const ${name} = '[^']*';`, 'g');
          expect(source.match(anchor)).toHaveLength(1);
          source = source.replace(anchor, `const ${name} = '${value}';`);
        }
        const runsAnchor = /const RUN_E_CORRECTIVE_CHECKPOINT_RUNS = -?\d+;/g;
        const blobsAnchor = /const RUN_E_CORRECTIVE_TEST_BLOBS = Object\.freeze\(\{[\s\S]*?\}\);/g;
        expect(source.match(runsAnchor)).toHaveLength(1);
        expect(source.match(blobsAnchor)).toHaveLength(1);
        source = source.replace(runsAnchor, `const RUN_E_CORRECTIVE_CHECKPOINT_RUNS = ${checkpointRuns};`)
          .replace(blobsAnchor, `const RUN_E_CORRECTIVE_TEST_BLOBS = Object.freeze(${JSON.stringify({ [settingsPath]: blob })});`);
        writeFileSync(runnerPath, source);
        const document = `${readFileSync(join(repo, scopePath), 'utf8')}${section('CORRECTIVE_CHECKPOINT', checkpoint)}`;
        write(scopePath, options.changeDocument?.(document) ?? document);
        write(settingsPath, options.settingsContents ?? correctedSettings);
        git('add', scopePath, settingsPath);
        if (options.extraChange) {
          write(options.extraChange.path, options.extraChange.contents);
          git('add', options.extraChange.path);
        }
        git('commit', '-qm', 'commit exact corrective candidate before final report');
        const headSha = git('rev-parse', 'HEAD');
        const pin: CorrectivePin = { headSha, predecessorHeadSha: predecessorHead, checkpointSha256, firstRun: checkpointRuns + 1 };
        const journal: CorrectiveJournal = {
          ...structuredClone(checkpoint), runs: checkpointRuns + 1,
          supervisors: [...checkpoint.supervisors, { pgid: Number.MAX_SAFE_INTEGER - checkpointRuns, active: false }],
          correctiveAdmission: pin,
        };
        fixture.final.head_sha = headSha;
        write(report, JSON.stringify(fixture.final));
        write(markdown, `${fixture.admissionMarkdown}\n# Corrective final result\nAll prior evidence and scope reasons retained.\n`);
        git('add', report, markdown);
        git('commit', '-qm', 'publish corrective results separately');
        write(journalPath, JSON.stringify(journal));
        return { ...fixture, journal, checkpoint, predecessorHead, pin, document };
      }

      function expectCorrectiveRejected(label: string): void {
        const before = readFileSync(join(repo, journalPath), 'utf8');
        const result = check();
        expect(result.status, label).toBe(1);
        expect(result.stderr, label).toContain('Run E');
        expect(readFileSync(join(repo, journalPath), 'utf8'), label).toBe(before);
      }

      it('certifies an empty-waiver corrective report with all three pins while preserving quiet original admission', () => {
        // Original fixtures do not bind the new corrective predecessor: its
        // missing-object probe must preserve the public clean-stderr contract.
        prepareE();
        expect(check()).toMatchObject({ status: 0, stderr: '' });
        recreateFixture();
        const fixture = prepareCorrective();
        expect(fixture.final.authorizations).toEqual([]);
        expect(git('rev-parse', 'HEAD^')).toBe(fixture.pin.headSha);
        expect(fixture.journal.budgetAuthorization).toEqual(fixture.checkpoint.budgetAuthorization);
        expect(fixture.journal.continuationAdmission).toEqual(fixture.checkpoint.continuationAdmission);
        expect(fixture.journal.correctiveAdmission).toEqual(fixture.pin);
        expect(check()).toMatchObject({ status: 0, stderr: '' });
        const capped = structuredClone(fixture.journal);
        capped.runs = 1600;
        capped.supervisors.push(...Array.from({ length: 1600 - capped.supervisors.length }, (_, index) => ({ pgid: Number.MAX_SAFE_INTEGER - checkpointRuns - 1 - index, active: false })));
        write(journalPath, JSON.stringify(capped));
        expect(check()).toMatchObject({ status: 0, stderr: '' });
      }, 20_000);

      it('rejects corrective report forgery across candidate blobs, checkpoints, prior pins, closure, and historical evidence', () => {
        const fixture = prepareCorrective();
        expect(check()).toMatchObject({ status: 0, stderr: '' });
        const journalChanges: Array<[string, (value: CorrectiveJournal) => void]> = [
          ['missing corrective pin', (value) => { delete value.correctiveAdmission; }],
          ['missing original pin', (value) => { Reflect.deleteProperty(value, 'budgetAuthorization'); }],
          ['missing continuation pin', (value) => { delete value.continuationAdmission; }],
          ['altered corrective checkpoint pin', (value) => { value.correctiveAdmission!.checkpointSha256 = '0'.repeat(64); }],
          ['altered old admission', (value) => { value.budgetAuthorization.headSha = fixture.predecessorHead; }],
          ['altered mutation prefix', (value) => { value.mutations[0]!.path = 'src/replacement.ts'; }],
          ['altered supervisor prefix', (value) => { value.supervisors[0]!.pgid -= 1; }],
          ['open mutation', (value) => { value.mutations.push({ path: settingsPath, state: 'applied' }); }],
          ['active supervisor', (value) => { value.supervisors[checkpointRuns]!.active = true; }],
          ['open dotenv', (value) => { value.dotenv.open = true; }],
          ['counter rollback', (value) => { value.runs = checkpointRuns; value.supervisors.pop(); }],
          ['cap exceeded', (value) => { value.runs = 1601; value.supervisors.push(...Array.from({ length: 1601 - value.supervisors.length }, (_, index) => ({ pgid: Number.MAX_SAFE_INTEGER - 1000 - index, active: false }))); }],
        ];
        for (const [label, change] of journalChanges) {
          const value = structuredClone(fixture.journal);
          change(value);
          write(journalPath, JSON.stringify(value));
          expectCorrectiveRejected(label);
        }
        write(journalPath, JSON.stringify(fixture.journal));
        const reportChanges: Array<[string, (value: Sidecar) => void]> = [
          ['old reported candidate', (value) => { value.head_sha = fixture.predecessorHead; }],
          ['changed original identity', (value) => { value.inventory[0]!.test = 'Replacement identity'; }],
          ['changed original finding', (value) => { value.findings[0]!.title = 'Replacement finding'; }],
          ['changed original exclusion', (value) => { value.inventory[2]!.reason = 'Replacement exclusion'; }],
          ['changed continuation scope reason', (value) => { value.inventory.find((row) => row.id === 'E-DISCOVERY-DELTA')!.reason = 'Unreviewed scope waiver'; }],
          ['risk waiver', (value) => { value.authorizations = [{ ...approval, finding_ids: ['E-P1'] }]; value.findings[0]!.disposition = 'accepted-risk'; value.findings[0]!.authorization = approval.id; }],
        ];
        for (const [label, change] of reportChanges) {
          const value = structuredClone(fixture.final);
          change(value);
          value.counts = countsFor(value);
          write(report, JSON.stringify(value));
          expectCorrectiveRejected(label);
        }
        write(report, JSON.stringify(fixture.final));
        const finalMarkdown = readFileSync(join(repo, markdown), 'utf8');
        write(markdown, finalMarkdown.replace('Exact historical duties.', 'Rewritten historical duties.'));
        expectCorrectiveRejected('rewritten admission markdown');
        const variants: Array<{ label: string; options: Parameters<typeof prepareCorrective>[0] }> = [
          { label: 'missing committed checkpoint', options: { changeDocument: (document) => document.replace(/<!-- RUN_E_CORRECTIVE_CHECKPOINT_START -->[\s\S]*?<!-- RUN_E_CORRECTIVE_CHECKPOINT_END -->\n/, '') } },
          { label: 'altered committed checkpoint', options: { changeDocument: (document) => document.replace('"runs":126', '"runs":125') } },
          { label: 'wrong exact settings blob', options: { settingsContents: `${correctedSettings}// unreviewed addition\n` } },
          { label: 'extra corrective path', options: { extraChange: { path: 'src/thing.ts', contents: 'export const thing = 3;\n' } } },
        ];
        for (const variant of variants) {
          recreateFixture();
          prepareCorrective(variant.options);
          expectCorrectiveRejected(variant.label);
        }
      }, 60_000);

      it('rejects renamed or stripped corrective reports and missing-report waivers without opening a third round', () => {
        for (const currentBranch of [branch, 'codex/renamed-corrective-report']) {
          recreateFixture();
          const fixture = prepareCorrective();
          expect(check()).toMatchObject({ status: 0, stderr: '' });
          git('branch', '-m', currentBranch);
          const runtimeIntake = JSON.stringify({ risk: 'normal' });
          write('.feature/intake.json', runtimeIntake);
          write(journalPath, JSON.stringify({ version: 1, round: 1, runs: 0, mutations: [], supervisors: [], dotenv: { open: false, files: [] } }));
          rmSync(join(repo, report));
          const missing = check();
          expect(missing.status, currentBranch).toBe(1);
          expect(missing.stderr).toContain('Run E corrective admission requires its report at');
          expect(missing.stdout).not.toContain('WAIVED');
          const match = missing.stderr.match(/requires its report at (\S+);/);
          expect(match?.[1]).toBeTruthy();
          const expectedReport = match![1]!;
          const forged = { ...structuredClone(fixture.final), branch: currentBranch, head_sha: fixture.originalHead,
            risk: 'normal', intake_sha256: sha256(runtimeIntake), round: 1 };
          write(expectedReport, JSON.stringify(forged));
          write(expectedReport.replace(/\.json$/, '.md'), '# Forged downgraded report\n');
          const downgraded = check();
          expect(downgraded.status).toBe(1);
          expect(downgraded.stderr).toContain('Run E corrective admission retains round 2');
          for (const text of ['third round authorized', 'no third round']) {
            write(expectedReport, JSON.stringify({ ...forged, round: 3, authorizations: [{ ...approval, text }] }));
            const third = check();
            expect(third.status, text).toBe(1);
            expect(third.stderr, text).toContain('Run E corrective admission retains round 2');
          }
          write(expectedReport, JSON.stringify({ ...forged, round: 2 }));
          expectCorrectiveRejected('round two cannot certify with stripped admissions');
        }
      }, 30_000);
    });

  });

  it('certifies Run E round 2 only with intact admission history and a closed capped launch journal', () => {
    const fixture = prepareE();
    expect(check()).toMatchObject({ status: 0, stderr: '' });
    const corrected = structuredClone(fixture.final);
    corrected.inventory[0] = { ...corrected.inventory[0], outcome: 'excluded', reason: scopeManifest.groups[0]!.reason };
    corrected.counts = countsFor(corrected);
    write(report, JSON.stringify(corrected));
    expect(check()).toMatchObject({ status: 0, stderr: '' });
    const checks: Array<{ name: string; mutate: (final: Sidecar, journal: Record<string, unknown>) => void }> = [
      { name: 'different measured head', mutate: (final) => { final.head_sha = fixture.historyCommit; } },
      { name: 'missing committed admission', mutate: (final, journal) => {
        final.head_sha = fixture.historyCommit;
        (journal.budgetAuthorization as Record<string, unknown>).headSha = fixture.historyCommit;
      } },
      { name: 'missing launch pin', mutate: (_final, journal) => { delete journal.budgetAuthorization; } },
      { name: 'wrong grant digest', mutate: (_final, journal) => { (journal.budgetAuthorization as Record<string, unknown>).sha256 = '0'.repeat(64); } },
      { name: 'enlarged cap', mutate: (_final, journal) => { (journal.budgetAuthorization as Record<string, unknown>).maxRuns = 1601; } },
      { name: 'retroactive first launch', mutate: (_final, journal) => { (journal.budgetAuthorization as Record<string, unknown>).firstRun = 2; } },
      { name: 'wrong journal round', mutate: (_final, journal) => { journal.round = 1; } },
      ...[0, '0', null].flatMap((runs) => [true, false].map((pinPresent) => ({
        name: `downgraded report with count ${String(runs)} and pin ${String(pinPresent)}`,
        mutate: (final: Sidecar, journal: Record<string, unknown>) => {
          final.round = 1;
          journal.runs = runs;
          if (!pinPresent) delete journal.budgetAuthorization;
        },
      }))),
      ...[-1, 0, 0.5, '2', null, 1601].map((runs) => ({ name: `invalid count ${String(runs)}`, mutate: (_final: Sidecar, journal: Record<string, unknown>) => { journal.runs = runs; } })),
      { name: 'open mutation', mutate: (_final, journal) => { journal.mutations = [{ path: 'src/thing.ts', state: 'applied' }]; } },
      { name: 'open dotenv', mutate: (_final, journal) => { journal.dotenv = { open: true }; } },
      { name: 'active supervisor', mutate: (_final, journal) => { journal.supervisors = [{ active: true, pgid: 999999 }]; } },
      { name: 'missing closure state', mutate: (_final, journal) => { delete journal.dotenv; } },
      { name: 'same-length identity replacement', mutate: (final) => { final.inventory[0]!.test = 'different case'; } },
      { name: 'same-length identity reordering', mutate: (final) => { [final.inventory[0], final.inventory[1]] = [final.inventory[1]!, final.inventory[0]!]; } },
      { name: 'rewritten exclusion', mutate: (final) => { final.inventory[2]!.reason = 'changed old reason'; } },
      { name: 'coverage waiver', mutate: (final) => { final.inventory[0]!.outcome = 'excluded'; } },
      { name: 'altered discovery correction reason', mutate: (final) => { final.inventory[0] = { ...final.inventory[0], outcome: 'excluded', reason: `${scopeManifest.groups[0]!.reason} Additional waiver.` }; } },
      { name: 'unapproved discovery correction ID', mutate: (final) => { final.inventory[3] = { ...final.inventory[3], outcome: 'excluded', reason: scopeManifest.groups[0]!.reason }; } },
      { name: 'measured result converted to exclusion', mutate: (final) => { final.inventory[1] = { ...final.inventory[1], outcome: 'excluded', reason: scopeManifest.groups[0]!.reason }; } },
      { name: 'unmeasured resolution', mutate: (final) => { final.inventory[0]!.reason = 'Original budget exhausted.'; } },
      { name: 'missing historical finding', mutate: (final) => { final.findings = []; } },
      { name: 'rewritten finding identity', mutate: (final) => { final.findings[0]!.title = 'Replacement finding'; } },
      { name: 'unexplained disposition', mutate: (final) => { delete final.findings[0]!.reason; } },
      { name: 'execution grant treated as risk waiver', mutate: (final) => { final.authorizations = [{ ...approval, finding_ids: ['E-P1'] }]; final.findings[0]!.disposition = 'accepted-risk'; final.findings[0]!.authorization = approval.id; } },
    ];
    for (const scenario of checks) {
      const final = structuredClone(fixture.final);
      const journal = structuredClone(fixture.journal);
      scenario.mutate(final, journal);
      final.counts = countsFor(final);
      write(report, JSON.stringify(final));
      write(journalPath, JSON.stringify(journal));
      const result = check();
      expect(result.status, scenario.name).toBe(1);
      expect(result.stderr, scenario.name).toContain('Run E round 2 requires');
    }
    write(report, JSON.stringify(fixture.final));
    write(journalPath, JSON.stringify({ ...fixture.journal, runs: 1600 }));
    expect(check()).toMatchObject({ status: 0, stderr: '' });
    const finalMarkdown = readFileSync(join(repo, markdown), 'utf8');
    const admissionMarkdown = git('show', `${fixture.final.head_sha}:${markdown}`);
    for (const forged of [
      '# Replacement evidence\n',
      finalMarkdown.replace('Exact historical duties.', 'Changed historical duties.'),
      finalMarkdown.replace(approval.text, 'Third round authorized'),
      `${admissionMarkdown.trimEnd()}# Final E result\n`,
    ]) {
      write(markdown, forged);
      expect(check().stderr).toContain('Run E round 2 requires');
    }
    write(markdown, finalMarkdown);
    const admittedIntake = readFileSync(join(repo, '.feature/intake.json'), 'utf8');
    const changedIntake = JSON.stringify({ ...JSON.parse(admittedIntake), extraAuthority: true });
    write('.feature/intake.json', changedIntake);
    write(report, JSON.stringify({ ...fixture.final, intake_sha256: sha256(changedIntake) }));
    expect(check().stderr).toContain('Run E round 2 requires');
    write('.feature/intake.json', admittedIntake);
    write(report, JSON.stringify(fixture.final));
    rmSync(join(repo, journalPath));
    expect(check().stderr).toContain('Run E round 2 requires');
    for (const scopeProof of [
      null,
      scopeDocument.replace('unchanged-mocked-case', 'unreviewed-group'),
      scopeDocument.replace('E0', 'E3'),
      scopeDocument.replace(scopeManifest.groups[0]!.reason, 'New unreviewed reason.'),
      `${scopeDocument}${scopeStart}\n`,
      `${scopeEnd}\n${scopeDocument.replace(scopeEnd, '')}`,
    ]) {
      rmSync(repo, { recursive: true, force: true });
      mkdirSync(repo, { recursive: true });
      const tampered = prepareE(scopeProof);
      const final = structuredClone(tampered.final);
      final.inventory[0] = { ...final.inventory[0], outcome: 'excluded', reason: scopeManifest.groups[0]!.reason };
      final.counts = countsFor(final);
      write(report, JSON.stringify(final));
      // A valid live document cannot replace absent or altered committed proof.
      write(scopePath, scopeDocument);
      const result = check();
      expect(result.status).toBe(1);
      expect(result.stderr).toContain('Run E round 2 requires');
    }
  }, 30_000); // Real git histories for admission-proof threats exceed Vitest's default 5 seconds.

  it('rejects Run E third and higher reports before generic authorization prose', () => {
    const { reportDir: ordinaryDir, sidecar } = seedRepo();
    const ordinary = structuredClone(sidecar);
    ordinary.round = 3;
    ordinary.findings = [{ id: 'RISK', severity: 'P2', title: 'Explicit ordinary risk', at: 'src/thing.ts:1', duty: 2, disposition: 'accepted-risk', authorization: 'ordinary-third' }];
    ordinary.authorizations = [{ id: 'ordinary-third', date: '2026-09-15', finding_ids: ['RISK'], text: 'third round authorized' }];
    ordinary.counts = countsFor(ordinary);
    write(`${ordinaryDir}/findings.json`, JSON.stringify(ordinary));
    expect(check()).toMatchObject({ status: 0, stderr: '' });
    for (const text of ['no third round', 'third round authorized', 'no third round; third round authorized']) {
      for (const round of [3, 4, 5]) {
        for (const identity of ['report branch', 'report grant', 'journal grant']) {
          const forged = structuredClone(ordinary);
          forged.round = round;
          forged.authorizations[0]!.text = text;
          if (identity === 'report branch') forged.branch = branch;
          if (identity === 'report grant') { forged.authorizations[0]!.id = approval.id; forged.findings[0]!.authorization = approval.id; }
          write(`${ordinaryDir}/findings.json`, JSON.stringify(forged));
          write(journalPath, JSON.stringify({ round, runs: 0, mutations: [], supervisors: [], dotenv: { open: false },
            ...(identity === 'journal grant' ? { budgetAuthorization: { id: approval.id } } : {}),
          }));
          const result = check();
          expect(result.status, `${identity}/${round}/${text}`).toBe(1);
          expect(result.stderr).toContain('Run E grants round 2 only');
        }
      }
    }
    // Genuine round 1 has no E execution pin or recorded round-2 journal.
    // Recreate only this test's disposable repository for its compatibility leg.
    rmSync(repo, { recursive: true, force: true });
    mkdirSync(repo, { recursive: true });
    seedRepo({ branch });
    expect(check()).toMatchObject({ status: 0, stderr: '' });
  });
});

describe('the CLI contract', () => {
  it('rejects --risk in feature mode: risk comes from the intake, never the caller', () => {
    const result = check('--risk', 'normal');
    expect(result.status).toBe(2);
    expect(result.stderr).toContain('standalone-only');
  });

  it('requires --issue and --head together in standalone mode', () => {
    expect(check('--mode', 'standalone', '--issue', '#123').status).toBe(2);
    expect(check('--mode', 'standalone', '--head', 'a'.repeat(40)).status).toBe(2);
  });

  it('rejects a short --head, so the run can never be pinned to an abbreviated SHA', () => {
    const result = check('--mode', 'standalone', '--issue', '#7', '--head', 'abc1234');
    expect(result.status).toBe(2);
    expect(result.stderr).toContain('40-character');
  });
});

describe('absence — the risk-scoped waiver', () => {
  // A bare repo with a commit and, optionally, a locked intake. The waiver
  // reads risk ONLY from `.feature/intake.json`, so these fixtures never
  // write a sidecar.
  function seedBareRepo(intake?: Record<string, unknown> | string): void {
    git('init', '-q', '-b', BRANCH);
    git('config', 'user.email', 'red-team@example.test');
    git('config', 'user.name', 'red team');
    write('a.txt', 'a\n');
    git('add', 'a.txt');
    git('commit', '-qm', 'base');
    if (typeof intake === 'string') write('.feature/intake.json', intake);
    else if (intake) write('.feature/intake.json', `${JSON.stringify(intake, null, 2)}\n`);
  }

  it('fails closed when no sidecar exists and no intake can supply a risk', () => {
    seedBareRepo();
    const result = check();
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('docs/reviews/red-team/');
    expect(result.stderr).toContain('absence is failure');
    expect(result.stderr).toContain('fails closed');
  });

  it('waives the sidecar when the signed-off intake declares risk normal', () => {
    seedBareRepo({ risk: 'normal' });
    const result = check();
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('WAIVED');
    expect(result.stdout).toContain('no red-team sidecar at docs/reviews/red-team/');
  });

  it('waives equally from the Claude lane `classification` spelling', () => {
    seedBareRepo({ classification: 'normal' });
    const result = check();
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('WAIVED');
  });

  it('requires the sidecar when the intake declares risk high', () => {
    seedBareRepo({ risk: 'high' });
    const result = check();
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('high-risk feature-lane run requires');
    expect(result.stderr).toContain('absence is failure');
  });

  it('requires the sidecar for a Claude lane `classification: high` intake', () => {
    seedBareRepo({ classification: 'high' });
    expect(check().status).toBe(1);
  });

  it('fails closed on an unreadable intake rather than waiving', () => {
    seedBareRepo('{not json');
    const result = check();
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('not valid JSON');
    expect(result.stderr).toContain('fails closed');
  });

  it('fails closed on an intake that declares no risk at all', () => {
    seedBareRepo({ goal: 'something' });
    const result = check();
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('neither `risk` nor `classification`');
  });

  // The remedy differs by mode, so the message must too: a feature run is
  // missing a required artifact, a standalone run may simply have been given
  // the wrong --issue/--head.
  it('names the standalone remedy rather than the feature-lane rule', () => {
    git('init', '-q', '-b', BRANCH);
    git('config', 'user.email', 'red-team@example.test');
    git('config', 'user.name', 'red team');
    write('a.txt', 'a\n');
    git('add', 'a.txt');
    git('commit', '-qm', 'base');
    const result = check('--mode', 'standalone', '--issue', '#5', '--head', git('rev-parse', 'HEAD'));
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('--issue/--head do not name the run');
    expect(result.stderr).not.toContain('feature-lane run requires');
  });
});

describe('a clean run', () => {
  it('passes a CLEAR sidecar whose only later commit is its own report', () => {
    seedRepo();
    const result = check();
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('status CLEAR');
  });
});

describe('strict schema', () => {
  it('rejects an unknown top-level field', () => {
    const { reportDir } = seedRepo();
    rewriteSidecar(reportDir, (sidecar) => {
      (sidecar as unknown as Record<string, unknown>).notes = 'extra';
    });
    const result = check();
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("unknown field 'notes'");
  });

  it('rejects a duplicate inventory row id', () => {
    const { reportDir } = seedRepo();
    rewriteSidecar(reportDir, (sidecar) => {
      sidecar.inventory.push({ ...KILLED_ROW });
      sidecar.counts = countsFor(sidecar);
    });
    const result = check();
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('duplicates');
  });

  // #1184 raised the cap from 2 to 3, but ONLY for a round the owner granted in
  // writing. All three directions are pinned, because the whole value of the
  // exception is its condition: an UNAUTHORIZED round 3 must still be refused, or
  // the cap has merely moved rather than acquired a gate.
  it('rejects an UNAUTHORIZED third round', () => {
    const { reportDir } = seedRepo();
    rewriteSidecar(reportDir, (sidecar) => {
      sidecar.round = 3;
    });
    expect(check().stderr).toContain('requires an authorizations entry');
  });

  it('accepts a third round the sidecar records an owner authorization for', () => {
    const { reportDir } = seedRepo();
    rewriteSidecar(reportDir, (sidecar) => {
      sidecar.round = 3;
      sidecar.authorizations.push({
        id: 'AUTH-THIRD-ROUND',
        date: '2026-09-08',
        finding_ids: sidecar.findings.map((finding) => String(finding.id)),
        text: 'owner 2026-09-08: third round authorized, journal reset by owner',
      });
    });
    const result = check();
    expect(result.stderr).not.toContain('round must be');
    expect(result.stderr).not.toContain('requires an authorizations entry');
  });

  it('rejects a fourth round even when an authorization is present', () => {
    const { reportDir } = seedRepo();
    rewriteSidecar(reportDir, (sidecar) => {
      sidecar.round = 4;
      sidecar.authorizations.push({
        id: 'AUTH-THIRD-ROUND',
        date: '2026-09-08',
        finding_ids: sidecar.findings.map((finding) => String(finding.id)),
        text: 'owner 2026-09-08: third round authorized, journal reset by owner',
      });
    });
    expect(check().stderr).toContain('round must be 1, 2, or an authorized 3');
  });

  it('requires an excluded row to record why it is out of scope', () => {
    const { reportDir } = seedRepo();
    rewriteSidecar(reportDir, (sidecar) => {
      sidecar.inventory.push({ id: 'M2', test: 'e2e', file: 'e2e/a.spec.ts', outcome: 'excluded' });
      sidecar.counts = countsFor(sidecar);
    });
    expect(check().stderr).toContain('must record a reason');
  });
});

describe('recomputation — the summary is never trusted', () => {
  it('fails when a count disagrees with the rows', () => {
    const { reportDir } = seedRepo();
    rewriteSidecar(reportDir, (sidecar) => {
      sidecar.counts.killed = 7;
    });
    const result = check();
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('counts.killed claims 7, recomputed 1');
  });

  // The exact shape round 3 named: a report claiming CLEAR while its own
  // inventory holds a confirmed survivor.
  it('recomputes OPEN_P0 from a confirmed survivor that the file calls CLEAR', () => {
    const { reportDir } = seedRepo();
    rewriteSidecar(reportDir, (sidecar) => {
      sidecar.inventory.push({
        id: 'M2',
        test: 'holds the gate',
        file: 'src/lib/thing/__tests__/thing.test.ts',
        outcome: 'survived-confirmed-P0',
        finding_id: 'F1',
      });
      sidecar.findings.push({
        id: 'F1',
        severity: 'P0',
        title: 'deleting the gate keeps every test green',
        at: 'src/lib/thing.ts:12',
        duty: 1,
        disposition: 'open',
        arbiter_reasoning: 'the mutated branch executes in this test and changes its observable result',
      });
      sidecar.counts = countsFor(sidecar);
    });
    const result = check();
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('status claims CLEAR, recomputed OPEN_P0');
  });

  it('forces INCOMPLETE_BUDGET when any in-scope candidate was skipped', () => {
    const { reportDir } = seedRepo();
    rewriteSidecar(reportDir, (sidecar) => {
      sidecar.inventory.push({
        id: 'M2',
        test: 'the 31st candidate',
        file: 'src/lib/thing/__tests__/other.test.ts',
        outcome: 'skipped-budget',
      });
      sidecar.counts = countsFor(sidecar);
      sidecar.status = 'INCOMPLETE_BUDGET';
    });
    const result = check();
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('status is INCOMPLETE_BUDGET');
    expect(result.stderr).not.toContain('status claims');
  });

  it('separates the two inconclusive classes: oracle forces ORACLE, infra forces INFRA', () => {
    const { reportDir } = seedRepo();
    rewriteSidecar(reportDir, (sidecar) => {
      sidecar.inventory.push({
        id: 'M2',
        test: 'a non-compiling mutation',
        file: 'src/lib/thing/__tests__/thing.test.ts',
        outcome: 'inconclusive',
        inconclusive_class: 'oracle',
        reason: 'the mutation did not typecheck',
      });
      sidecar.counts = countsFor(sidecar);
      sidecar.status = 'INCOMPLETE_ORACLE';
    });
    expect(check().stderr).toContain('status is INCOMPLETE_ORACLE');

    rewriteSidecar(reportDir, (sidecar) => {
      sidecar.inventory[1] = {
        ...(sidecar.inventory[1] as Record<string, unknown>),
        inconclusive_class: 'infra',
        reason: 'the covering suite needs a live database that is not provisioned',
      };
      sidecar.status = 'INCOMPLETE_INFRA';
    });
    expect(check().stderr).toContain('status is INCOMPLETE_INFRA');
  });

  // Round 4's finding: a production-only diff must never produce "nothing to
  // check, therefore CLEAR".
  it('never reports CLEAR from an empty inventory', () => {
    const { reportDir } = seedRepo();
    rewriteSidecar(reportDir, (sidecar) => {
      sidecar.inventory = [];
      sidecar.counts = countsFor(sidecar);
    });
    const result = check();
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('recomputed INCOMPLETE_ORACLE');
  });

  it('requires the arbiter reasoning behind every confirmed survivor', () => {
    const { reportDir } = seedRepo();
    rewriteSidecar(reportDir, (sidecar) => {
      sidecar.inventory.push({
        id: 'M2',
        test: 'holds the gate',
        file: 'src/lib/thing/__tests__/thing.test.ts',
        outcome: 'survived-confirmed-P0',
        finding_id: 'F1',
      });
      sidecar.findings.push({
        id: 'F1',
        severity: 'P0',
        title: 'survivor',
        at: 'src/lib/thing.ts:12',
        duty: 1,
        disposition: 'fixed',
      });
      sidecar.counts = countsFor(sidecar);
    });
    expect(check().stderr).toContain("arbiter's recorded reasoning");
  });
});

describe('run binding and the contract', () => {
  it('fails when the sidecar claims a run_id the checkout does not derive', () => {
    const { reportDir } = seedRepo();
    rewriteSidecar(reportDir, (sidecar) => {
      sidecar.run_id = 'feature-somebody-elses-run-abc123';
    });
    const result = check();
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('does not match the derived');
  });

  // The intake is gitignored in the real repo, so `git diff` cannot see an
  // amendment. Only the recorded hash can.
  it('fails when the intake was amended after the run', () => {
    seedRepo();
    write('.feature/intake.json', `${JSON.stringify({ risk: 'normal', extra: 1 }, null, 2)}\n`);
    const result = check();
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('amended intake voids the evidence');
  });

  it('normalizes the Claude lane `classification` into the canonical risk', () => {
    seedRepo({ intake: { classification: 'high' } });
    const result = check();
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("sidecar risk 'normal' does not match the derived 'high'");
  });

  it('reads the Codex lane `risk` field directly', () => {
    seedRepo({ intake: { risk: 'high' }, patch: (sidecar) => { sidecar.risk = 'high'; } });
    expect(check().status).toBe(0);
  });

  it('fails when the recorded merge-base is not what fork_sha recomputes to', () => {
    const { reportDir } = seedRepo();
    rewriteSidecar(reportDir, (sidecar) => {
      sidecar.merge_base_sha = '0'.repeat(40);
    });
    expect(check().stderr).toContain('does not match the recomputed');
  });
});

describe('high-risk adjudication', () => {
  const highRisk = { intake: { risk: 'high' } as Record<string, unknown> };

  it('blocks an open P1 on a high-risk run', () => {
    seedRepo({
      ...highRisk,
      patch: (sidecar) => {
        sidecar.risk = 'high';
        sidecar.findings.push({
          id: 'F1',
          severity: 'P1',
          title: 'an order assertion with no ordering contract',
          at: 'src/lib/thing/__tests__/thing.test.ts:40',
          duty: 2,
          disposition: 'open',
        });
        sidecar.status = 'OPEN_P1';
      },
    });
    const result = check();
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('cannot ship an open P1');
  });

  it('accepts a P1 whose accepted-risk reference resolves to an authorization naming it', () => {
    seedRepo({
      ...highRisk,
      patch: (sidecar) => {
        sidecar.risk = 'high';
        sidecar.findings.push({
          id: 'F1',
          severity: 'P1',
          title: 'an order assertion with no ordering contract',
          at: 'src/lib/thing/__tests__/thing.test.ts:40',
          duty: 2,
          disposition: 'accepted-risk',
          authorization: 'A1',
        });
        sidecar.authorizations.push({
          id: 'A1',
          date: '2026-08-27',
          finding_ids: ['F1'],
          text: 'Accepted: the ordering is stable in practice and a contract lands in #999.',
        });
      },
    });
    expect(check().status).toBe(0);
  });

  it('rejects an accepted-risk reference that resolves to nothing', () => {
    seedRepo({
      ...highRisk,
      patch: (sidecar) => {
        sidecar.risk = 'high';
        sidecar.findings.push({
          id: 'F1',
          severity: 'P1',
          title: 'unproven',
          at: 'src/a.ts:1',
          duty: 2,
          disposition: 'accepted-risk',
          authorization: 'A9',
        });
      },
    });
    const result = check();
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("authorization 'A9' is not in the authorizations array");
  });

  it('rejects an authorization that does not name the finding citing it', () => {
    seedRepo({
      ...highRisk,
      patch: (sidecar) => {
        sidecar.risk = 'high';
        sidecar.findings.push({
          id: 'F1',
          severity: 'P1',
          title: 'unproven',
          at: 'src/a.ts:1',
          duty: 2,
          disposition: 'accepted-risk',
          authorization: 'A1',
        });
        sidecar.findings.push({
          id: 'F2',
          severity: 'P2',
          title: 'other',
          at: 'src/a.ts:2',
          duty: 2,
          disposition: 'open',
        });
        sidecar.authorizations.push({
          id: 'A1',
          date: '2026-08-27',
          finding_ids: ['F2'],
          text: 'Accepted F2 only.',
        });
      },
    });
    expect(check().stderr).toContain('does not name this finding');
  });
});

describe('staleness and the restored tree', () => {
  it('fails when any commit outside the run\'s two artifacts lands after the run', () => {
    seedRepo();
    write('src/thing.ts', 'export const thing = 3;\n');
    git('add', 'src/thing.ts');
    git('commit', '-qm', 'later work');
    const result = check();
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('evidence is stale');
  });

  // Round 4's narrowing: excluding all of docs/reviews/** would let an
  // unrelated review artifact land without invalidating the report.
  it('still fails for an unrelated docs/reviews change', () => {
    seedRepo();
    write('docs/reviews/other/report.md', 'unrelated\n');
    git('add', 'docs/reviews/other/report.md');
    git('commit', '-qm', 'unrelated review');
    expect(check().stderr).toContain('evidence is stale');
  });

  it('fails on a tracked modification left in the worktree — an unrestored mutation', () => {
    seedRepo();
    write('src/thing.ts', 'export const thing = 999;\n');
    const result = check();
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('may not have been restored');
  });

  // feat/1013 deviation D10. `makeGit` trimmed the WHOLE porcelain output, so
  // the first line lost the leading space of its ` M ` status field and
  // `line.slice(3)` returned a path one character short. The exclusion for the
  // report's own two files compares exact paths, so it could never match line
  // 1 — the checker failed on the very artifact it had just written. Only the
  // FIRST line is affected, which is why a second modification hid it.
  it('excludes the report\'s own file when it is the FIRST porcelain line', () => {
    const { reportDir } = seedRepo();
    write(`${reportDir}/findings.md`, '# Red-team findings\n\nStatus: CLEAR\n\nappended\n');
    const result = check();
    expect(result.status).toBe(0);
    expect(result.stderr).not.toContain('may not have been restored');
  });
});

describe('the classes git cannot see', () => {
  // Dotenv files are gitignored, so a stranded scrubbed copy is invisible to
  // porcelain. The checker globs for the backup explicitly.
  it('fails while a dotenv backup is still on disk', () => {
    seedRepo();
    write('.env.local.red-team-backup', 'SECRET=1\n');
    const result = check();
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('dotenv backup(s) still present');
  });

  it('fails while the journal reports an open dotenv swap', () => {
    seedRepo();
    write('.feature/red-team-journal.json', JSON.stringify({
      version: 1, runs: 0, mutations: [], dotenv: { open: true, files: [] }, supervisors: [],
    }));
    expect(check().stderr).toContain('dotenv swap is still open');
  });

  it('fails while the journal reports an unrestored mutation', () => {
    seedRepo();
    write('.feature/red-team-journal.json', JSON.stringify({
      version: 1,
      runs: 1,
      mutations: [{ path: 'src/thing.ts', state: 'applied' }],
      dotenv: { open: false, files: [] },
      supervisors: [],
    }));
    expect(check().stderr).toContain("journaled as 'applied'");
  });

  it('fails while a supervisor process group is still journaled active', () => {
    seedRepo();
    write('.feature/red-team-journal.json', JSON.stringify({
      version: 1,
      runs: 1,
      mutations: [],
      dotenv: { open: false, files: [] },
      supervisors: [{ pid: 4242, pgid: 4242, active: true }],
    }));
    expect(check().stderr).toContain('still journaled active');
  });
});

describe('standalone mode', () => {
  const standaloneArgs = (issue: string, extra: string[] = []) =>
    ({ forkSha: _forkSha, headSha }: { forkSha: string; headSha: string }) =>
      ['--mode', 'standalone', '--issue', issue, '--head', headSha, ...extra];

  // Round 8's finding: the checker must derive the expected path from inputs it
  // is handed, never from the run_id stored inside the file it is validating.
  it('derives its path from --issue and --head on a detached HEAD, and accepts branch null', () => {
    const seeded = seedRepo({
      mode: 'standalone',
      detached: true,
      intake: null,
      checkerArgs: standaloneArgs('#4242', ['--risk', 'normal']),
    });
    const result = check(
      '--mode', 'standalone', '--issue', '#4242', '--head', seeded.sidecar.head_sha, '--risk', 'normal',
    );
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('standalone run');
    expect(seeded.sidecar.branch).toBeNull();
  });

  // One contract, no required-plus-default contradiction: --risk is optional
  // and an unstated standalone run is adjudicated as HIGH.
  it('defaults --risk to high, so an unstated standalone run is adjudicated as high risk', () => {
    const seeded = seedRepo({
      mode: 'standalone',
      detached: true,
      intake: null,
      checkerArgs: standaloneArgs('#77'),
    });
    const result = check('--mode', 'standalone', '--issue', '#77', '--head', seeded.sidecar.head_sha);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("does not match the derived 'high'");
  });

  it('rejects a --head that is not the head the sidecar recorded', () => {
    const seeded = seedRepo({
      mode: 'standalone',
      detached: true,
      intake: null,
      checkerArgs: standaloneArgs('#88', ['--risk', 'normal']),
    });
    expect(seeded.sidecar.head_sha).toMatch(/^[0-9a-f]{40}$/);
    const result = check(
      '--mode', 'standalone', '--issue', '#88', '--head', 'b'.repeat(40), '--risk', 'normal',
    );
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('no red-team sidecar at');
  });
});

// feat/1013 deviation D11. Six mutants on that branch provably preserved
// behaviour — deleting a guard the caller already enforces. The only label
// available was `inconclusive` (class `oracle`), which forces
// INCOMPLETE_ORACLE and can never be resolved, so the run took the `reviewed`
// transition over a standing objection. `equivalent` is a claim about the
// MUTANT; `inconclusive` stays a claim about the ORACLE, and still blocks.
describe('the equivalent outcome', () => {
  const EQUIVALENT_ROW = {
    id: 'M2',
    test: 'holds the resolver precedence',
    file: 'src/lib/thing/__tests__/thing.test.ts',
    outcome: 'equivalent',
    reason:
      'the deleted guard is dominated by the caller check three lines above; '
      + 'both branches return the same value for every reachable input',
  };

  it('does not block — a proven-equivalent mutant still reaches CLEAR', () => {
    const { reportDir } = seedRepo();
    rewriteSidecar(reportDir, (sidecar) => {
      sidecar.inventory.push({ ...EQUIVALENT_ROW });
      sidecar.counts = countsFor(sidecar);
    });
    const result = check();
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('status CLEAR');
  });

  it('rejects an equivalent row that records no proof', () => {
    const { reportDir } = seedRepo();
    rewriteSidecar(reportDir, (sidecar) => {
      sidecar.inventory.push({
        id: EQUIVALENT_ROW.id,
        test: EQUIVALENT_ROW.test,
        file: EQUIVALENT_ROW.file,
        outcome: 'equivalent',
      });
      sidecar.counts = countsFor(sidecar);
    });
    const result = check();
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('must record the proof that behaviour is preserved');
  });

  it('rejects an equivalent row that also references a finding', () => {
    const { reportDir } = seedRepo();
    rewriteSidecar(reportDir, (sidecar) => {
      sidecar.inventory.push({ ...EQUIVALENT_ROW, finding_id: 'F1' });
      sidecar.counts = countsFor(sidecar);
    });
    const result = check();
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('may not reference a finding');
  });

  // The separation is the whole point: adding `equivalent` must not soften the
  // label it was carved out of.
  it('leaves inconclusive/oracle blocking exactly as before', () => {
    const { reportDir } = seedRepo();
    rewriteSidecar(reportDir, (sidecar) => {
      sidecar.inventory.push({
        id: 'M3',
        test: 'holds the resolver precedence',
        file: 'src/lib/thing/__tests__/thing.test.ts',
        outcome: 'inconclusive',
        inconclusive_class: 'oracle',
        reason: 'the mutated module did not compile',
      });
      sidecar.counts = countsFor(sidecar);
      sidecar.status = 'INCOMPLETE_ORACLE';
    });
    const result = check();
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('INCOMPLETE_ORACLE');
  });

  // Back-compat, and its bound. A sidecar written before this member exists
  // omits the key; that reads as zero. No other count gets the same latitude.
  it('reads an ABSENT equivalent count as zero', () => {
    const { reportDir } = seedRepo();
    rewriteSidecar(reportDir, (sidecar) => {
      delete sidecar.counts.equivalent;
    });
    expect(check().status).toBe(0);
  });

  it('still catches a WRONG equivalent count', () => {
    const { reportDir } = seedRepo();
    rewriteSidecar(reportDir, (sidecar) => {
      sidecar.counts.equivalent = 2;
    });
    const result = check();
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('counts.equivalent claims 2, recomputed 0');
  });

  it('keeps an absent killed count a mismatch — the latitude is equivalent-only', () => {
    const { reportDir } = seedRepo();
    rewriteSidecar(reportDir, (sidecar) => {
      delete sidecar.counts.killed;
    });
    const result = check();
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('counts.killed');
  });
});
