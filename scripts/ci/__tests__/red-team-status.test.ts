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
  const result = spawnSync('node', [CHECKER, ...args], {
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
  intake?: Record<string, unknown> | null;
  patch?: (sidecar: Sidecar) => void;
  mode?: string;
  detached?: boolean;
  checkerArgs?: (shas: { forkSha: string; headSha: string }) => string[];
} = {}): { reportDir: string; sidecar: Sidecar } {
  git('init', '-q', '-b', BRANCH);
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
    branch: options.detached ? null : BRANCH,
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

  it('rejects a round beyond the two-round cap', () => {
    const { reportDir } = seedRepo();
    rewriteSidecar(reportDir, (sidecar) => {
      sidecar.round = 3;
    });
    expect(check().stderr).toContain('round must be 1 or 2');
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
