import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

// Lives here, not beside the script, for the reason red-team-status.test.ts
// states: vitest's include roots do not cover .claude/**, so a colocated test
// would silently never run. The controller is exercised the way /queue-run
// invokes it — as a CLI.
//
// WHAT THIS PINS. queue-state.mjs owns the invariants an instruction-only
// skill cannot guarantee, and each was a Codex plan-review finding before it
// was code: the lease-based exclusive run lock (a PID cannot identify a
// session-shaped owner), the GLOBAL lock around the SHARED cross-run
// reservations file, traversal-proof run ids, run-prefixed branch names,
// reservation release only by controller attestation, and the advisory
// budget's refuse-don't-overshoot exit code.

const CLI = resolve(process.cwd(), '.claude/skills/queue-run/scripts/queue-state.mjs');

const GIT_FREE_ENV = Object.fromEntries(
  Object.entries(process.env).filter(([key]) => !key.startsWith('GIT_')),
) as NodeJS.ProcessEnv;

let home: string;
let repo: string;

function run(args: string[], cwd: string = repo) {
  return spawnSync('node', [CLI, ...args], {
    cwd,
    encoding: 'utf8',
    env: { ...GIT_FREE_ENV, QUEUE_RUN_HOME: home },
  });
}

function json(stdout: string): Record<string, unknown> {
  return JSON.parse(stdout.trim()) as Record<string, unknown>;
}

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'queue-state-home-'));
  repo = mkdtempSync(join(tmpdir(), 'queue-state-repo-'));
  spawnSync('git', ['init', '-b', 'main'], { cwd: repo, env: GIT_FREE_ENV });
});

afterEach(() => {
  rmSync(home, { recursive: true, force: true });
  rmSync(repo, { recursive: true, force: true });
});

function initAndLock(runId = 'run-1'): string {
  expect(run(['init', runId, '--ceiling', '1000']).status).toBe(0);
  const locked = run(['lock', runId]);
  expect(locked.status).toBe(0);
  return json(locked.stdout).token as string;
}

describe('run ids and init', () => {
  it('rejects traversal-shaped and malformed run ids', () => {
    for (const bad of ['../evil', 'a/b', '..', 'UPPER', '', '-lead']) {
      expect(run(['init', bad, '--ceiling', '10']).status).toBe(1);
    }
  });

  it('accepts a valid id once and refuses re-init', () => {
    expect(run(['init', 'run-1', '--ceiling', '10']).status).toBe(0);
    expect(run(['init', 'run-1', '--ceiling', '10']).status).toBe(1);
  });
});

describe('run lock', () => {
  it('is exclusive while the lease is live and reclaimable when expired', () => {
    expect(run(['init', 'run-1', '--ceiling', '10']).status).toBe(0);
    expect(run(['lock', 'run-1']).status).toBe(0);
    expect(run(['lock', 'run-1']).status).toBe(3); // held

    // lease 0 = immediately stale: the next acquire must reclaim, not block
    rmSync(join(home, 'run-1', 'run.lock'));
    expect(run(['lock', 'run-1', '--lease-seconds', '0']).status).toBe(0);
    expect(run(['lock', 'run-1']).status).toBe(0);
  });

  it('gates every mutating command on the token', () => {
    const token = initAndLock();
    expect(
      run(['transition', 'run-1', '--token', 'wrong', '--issue', 'i9', '--patch', '{}']).status,
    ).toBe(3);
    const good = run([
      'transition', 'run-1', '--token', token, '--issue', 'i9',
      '--patch', '{"status":"planned"}',
    ]);
    expect(good.status).toBe(0);
    const state = JSON.parse(readFileSync(join(home, 'run-1', 'state.json'), 'utf8'));
    expect(state.issues.i9.status).toBe('planned');
    const journal = readFileSync(join(home, 'run-1', 'journal.jsonl'), 'utf8');
    expect(journal).toContain('"kind":"transition"');
  });
});

describe('branch validation', () => {
  it('requires the run-owned prefix and a well-formed ref', () => {
    initAndLock();
    expect(run(['validate-branch', 'run-1', 'queue/run-1/fix-879']).status).toBe(0);
    expect(run(['validate-branch', 'run-1', 'feat/other']).status).toBe(1);
    expect(run(['validate-branch', 'run-1', 'queue/run-1/has space']).status).toBe(1);
  });
});

describe('reservations', () => {
  it('refuses exact and directory-prefix overlaps in BOTH directions, across runs', () => {
    const token1 = initAndLock('run-1');
    expect(
      run([
        'reserve', 'run-1', '--token', token1, '--issue', 'i1',
        '--branch', 'queue/run-1/a', '--paths', 'src/lib/kpi,worker/jobs/judge/file.ts',
      ]).status,
    ).toBe(0);

    // a SECOND run against the same shared store: exact, child-of-held, parent-of-held
    const token2 = initAndLock('run-2');
    for (const paths of ['src/lib/kpi', 'src/lib/kpi/fragments.ts', 'worker/jobs']) {
      const refused = run([
        'reserve', 'run-2', '--token', token2, '--issue', 'i2',
        '--branch', 'queue/run-2/b', '--paths', paths,
      ]);
      expect(refused.status).toBe(2);
    }
    expect(
      run([
        'reserve', 'run-2', '--token', token2, '--issue', 'i2',
        '--branch', 'queue/run-2/b', '--paths', 'src/lib/dashboard',
      ]).status,
    ).toBe(0);
  });

  it('releases only with a verified attestation, and check-overlap then clears', () => {
    const token = initAndLock();
    run([
      'reserve', 'run-1', '--token', token, '--issue', 'i1',
      '--branch', 'queue/run-1/a', '--paths', 'src/lib/kpi',
    ]);
    expect(run(['check-overlap', '--paths', 'src/lib/kpi/x.ts']).status).toBe(2);
    expect(
      run(['release', '--run-id', 'run-1', '--token', token, '--branch', 'queue/run-1/a']).status,
    ).toBe(1); // no --verified
    expect(
      run([
        'release', '--run-id', 'run-1', '--token', token,
        '--branch', 'queue/run-1/a', '--verified', 'merged',
      ]).status,
    ).toBe(0);
    expect(run(['check-overlap', '--paths', 'src/lib/kpi/x.ts']).status).toBe(0);
  });

  it('never leaks the global lock on the refusal path', () => {
    const token = initAndLock();
    run([
      'reserve', 'run-1', '--token', token, '--issue', 'i1',
      '--branch', 'queue/run-1/a', '--paths', 'src/lib/kpi',
    ]);
    // exit(2) must release reservations.lock, or this second call blocks/exits 3
    expect(run(['check-overlap', '--paths', 'src/lib/kpi']).status).toBe(2);
    expect(run(['check-overlap', '--paths', 'docs']).status).toBe(0);
  });
});

describe('budget', () => {
  it('refuses a step whose estimate exceeds the remainder', () => {
    const token = initAndLock(); // ceiling 1000
    expect(run(['spend', 'run-1', '--token', token, '--add', '600']).status).toBe(0);
    expect(run(['budget', 'run-1', '--estimate', '500']).status).toBe(2);
    expect(run(['budget', 'run-1', '--estimate', '400']).status).toBe(0);
  });
});

describe('verify-repo', () => {
  it('accepts a matching origin and refuses a foreign one', () => {
    spawnSync('git', ['remote', 'add', 'origin', 'git@github.com:RepWorth/ai-review-responder.git'], {
      cwd: repo,
      env: GIT_FREE_ENV,
    });
    expect(run(['verify-repo', '--expect', 'RepWorth/ai-review-responder']).status).toBe(0);
    expect(run(['verify-repo', '--expect', 'SomeoneElse/other-repo']).status).toBe(1);
  });
});
