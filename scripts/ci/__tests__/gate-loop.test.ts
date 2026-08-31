import { spawnSync } from 'node:child_process';
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

// Pins the unattended gate-loop mechanics (speed lane build 3):
//
// 1. feature-state.sh incr-gate-round — the fail-round budget. Rounds 1-3
//    pass; the 4th REFUSES without an owner reason ("after 3 full gate-fail
//    rounds, stop patching", enforced instead of narrated, so an unattended
//    loop cannot thrash past its budget while nobody watches).
// 2. reset-gate-rounds — a green gate zeroes the counter so a NEW red streak
//    gets a fresh budget.
// 3. gate-summary.sh — the compact RED briefing a loop iteration consumes:
//    failing rows + log tails only, exit codes 0 (green) / 1 (red) / 2 (never
//    ran).

const STATE_SCRIPT = resolve(process.cwd(), 'scripts', 'feature-state.sh');
const SUMMARY_SCRIPT = resolve(process.cwd(), 'scripts', 'gate-summary.sh');

const GIT_FREE_ENV = Object.fromEntries(
  Object.entries(process.env).filter(([key]) => !key.startsWith('GIT_')),
) as NodeJS.ProcessEnv;

let repo: string;

function git(...args: string[]): void {
  const result = spawnSync('git', args, { cwd: repo, encoding: 'utf8', env: GIT_FREE_ENV });
  if (result.status !== 0) throw new Error(`git ${args.join(' ')} failed: ${result.stderr}`);
}

function run(script: string, ...args: string[]) {
  return spawnSync('bash', [script, ...args], { cwd: repo, encoding: 'utf8', env: GIT_FREE_ENV });
}

function state(): { gateFailRounds?: number } {
  return JSON.parse(readFileSync(join(repo, '.feature', 'state.json'), 'utf8'));
}

beforeEach(() => {
  repo = mkdtempSync(join(tmpdir(), 'gate-loop-'));
  git('init', '-q', '-b', 'feat-gate-loop-fixture');
  mkdirSync(join(repo, 'scripts'), { recursive: true });
  copyFileSync(STATE_SCRIPT, join(repo, 'scripts', 'feature-state.sh'));
  copyFileSync(SUMMARY_SCRIPT, join(repo, 'scripts', 'gate-summary.sh'));
});

afterEach(() => {
  rmSync(repo, { recursive: true, force: true });
});

describe('feature-state.sh gate-round budget', () => {
  it('passes rounds 1 through 3', () => {
    for (const round of [1, 2, 3]) {
      const result = run('scripts/feature-state.sh', 'incr-gate-round');
      expect(result.status, result.stdout + result.stderr).toBe(0);
      expect(state().gateFailRounds).toBe(round);
    }
  });

  it('REFUSES round 4 without an owner reason, writing nothing', () => {
    for (let i = 0; i < 3; i += 1) expect(run('scripts/feature-state.sh', 'incr-gate-round').status).toBe(0);
    const result = run('scripts/feature-state.sh', 'incr-gate-round');
    expect(result.status).toBe(1);
    expect(result.stdout).toContain('abort criteria');
    expect(state().gateFailRounds).toBe(3);
  });

  it('accepts round 4 with --reason', () => {
    for (let i = 0; i < 3; i += 1) expect(run('scripts/feature-state.sh', 'incr-gate-round').status).toBe(0);
    const result = run('scripts/feature-state.sh', 'incr-gate-round', '--reason', 'owner said continue');
    expect(result.status, result.stdout + result.stderr).toBe(0);
    expect(state().gateFailRounds).toBe(4);
  });

  it('reset-gate-rounds gives a new red streak a fresh budget', () => {
    for (let i = 0; i < 3; i += 1) expect(run('scripts/feature-state.sh', 'incr-gate-round').status).toBe(0);
    expect(run('scripts/feature-state.sh', 'reset-gate-rounds').status).toBe(0);
    expect(state().gateFailRounds).toBe(0);
    expect(run('scripts/feature-state.sh', 'incr-gate-round').status).toBe(0);
    expect(state().gateFailRounds).toBe(1);
  });
});

describe('gate-summary.sh', () => {
  function writeGateStatus(passed: boolean, checks: Array<{ name: string; result: string }>): void {
    mkdirSync(join(repo, '.feature', 'logs'), { recursive: true });
    writeFileSync(
      join(repo, '.feature', 'gate-status.json'),
      JSON.stringify({ passed, mode: 'full', timestamp: Math.floor(Date.now() / 1000), checks }),
    );
  }

  it('exits 2 when no gate has run', () => {
    const result = run('scripts/gate-summary.sh');
    expect(result.status).toBe(2);
    expect(result.stdout).toContain('no gate has run');
  });

  it('exits 0 and reports GREEN on a passed gate', () => {
    writeGateStatus(true, [{ name: 'lint', result: 'PASS' }]);
    const result = run('scripts/gate-summary.sh');
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('GATE: GREEN');
  });

  it('exits 1 and prints only the failing rows with their log tails', () => {
    writeGateStatus(false, [
      { name: 'lint', result: 'PASS' },
      { name: 'test', result: 'FAIL' },
      { name: 'tenant-scope', result: 'FAIL' },
    ]);
    writeFileSync(join(repo, '.feature', 'logs', 'test.log'), 'many lines\nFAIL src/foo.test.ts > breaks\n');
    const result = run('scripts/gate-summary.sh');
    expect(result.status).toBe(1);
    expect(result.stdout).toContain('2 failing row(s)');
    expect(result.stdout).toContain('=== test ===');
    expect(result.stdout).toContain('FAIL src/foo.test.ts > breaks');
    expect(result.stdout).toContain('=== tenant-scope ===');
    expect(result.stdout).toContain('(no log at .feature/logs/tenant-scope.log)');
    expect(result.stdout).not.toContain('=== lint ===');
  });

  it('caps each log tail at --lines N', () => {
    writeGateStatus(false, [{ name: 'test', result: 'FAIL' }]);
    const lines = Array.from({ length: 40 }, (_, index) => `line-${index + 1}`).join('\n');
    writeFileSync(join(repo, '.feature', 'logs', 'test.log'), `${lines}\n`);
    const result = run('scripts/gate-summary.sh', '--lines', '5');
    expect(result.status).toBe(1);
    expect(result.stdout).toContain('line-40');
    expect(result.stdout).not.toContain('line-35\n');
  });

  // Speed lane build 5: the loop alternates full and fast runs, which write to
  // two different files on purpose (a fast green must never reach the Stop
  // hook). The briefing has to describe the run that JUST happened, so it
  // picks by the recorded timestamp, never by argument order or file mtime.
  function writeFastStatus(
    passed: boolean,
    checks: Array<{ name: string; result: string }>,
    timestamp: number,
  ): void {
    mkdirSync(join(repo, '.feature', 'logs'), { recursive: true });
    writeFileSync(
      join(repo, '.feature', 'gate-fast.json'),
      JSON.stringify({ passed, mode: 'fast', timestamp, checks }),
    );
  }

  it('reports the fast result when it is the newer of the two', () => {
    writeGateStatus(false, [{ name: 'test', result: 'FAIL' }]);
    writeFastStatus(true, [{ name: 'test', result: 'PASS' }], Math.floor(Date.now() / 1000) + 30);
    const result = run('scripts/gate-summary.sh');
    expect(result.status, result.stdout + result.stderr).toBe(0);
    expect(result.stdout).toContain('mode fast');
    expect(result.stdout).toContain('proves the fix, not the branch');
  });

  it('reports the full result when the fast one is older', () => {
    writeFastStatus(true, [{ name: 'test', result: 'PASS' }], Math.floor(Date.now() / 1000) - 600);
    writeGateStatus(false, [{ name: 'lint', result: 'FAIL' }]);
    const result = run('scripts/gate-summary.sh');
    expect(result.status).toBe(1);
    expect(result.stdout).toContain('mode full');
    expect(result.stdout).toContain('=== lint ===');
  });

  it('never tells the loop a fast green is enough', () => {
    writeFastStatus(true, [{ name: 'test', result: 'PASS' }], Math.floor(Date.now() / 1000));
    const result = run('scripts/gate-summary.sh');
    expect(result.stdout).toContain('run the full gate before review');
  });
});

// Speed lane build 5, lever B: a verification-only round exists to confirm the
// round-1 fixes did not break what round 1 approved. When the fixes moved
// nothing the artifact contracts on, that round re-reads unchanged prose at
// full cost. The decision is mechanical so it is never a judgement call.
describe('feature-state.sh plan-contract hash', () => {
  const PLAN = 'plan.md';

  function writeIntake(surface: string[], tests: string[]): void {
    mkdirSync(join(repo, '.feature'), { recursive: true });
    writeFileSync(
      join(repo, '.feature', 'intake.json'),
      JSON.stringify({ allowed_edit_surface: surface, tests_to_add: tests }),
    );
  }

  function writePlan(body: string): void {
    writeFileSync(join(repo, PLAN), body);
  }

  beforeEach(() => {
    writeIntake(['src/lib/a.ts', 'src/lib/b.ts'], ['holds the veto window']);
    writePlan('# Plan\n\n## T1 gate constant\n\n## T2 veto window\n');
  });

  it('reads UNCHANGED when nothing moved', () => {
    expect(run('scripts/feature-state.sh', 'record-contract', PLAN).status).toBe(0);
    const result = run('scripts/feature-state.sh', 'contract-changed', PLAN);
    expect(result.status, result.stdout + result.stderr).toBe(0);
    expect(result.stdout).toContain('UNCHANGED');
  });

  it('reads UNCHANGED for a prose-only plan edit', () => {
    run('scripts/feature-state.sh', 'record-contract', PLAN);
    writePlan('# Plan\n\nNew prose that changes no structure.\n\n## T1 gate constant\n\n## T2 veto window\n');
    expect(run('scripts/feature-state.sh', 'contract-changed', PLAN).stdout).toContain('UNCHANGED');
  });

  it('reads CHANGED when a tracer heading appears', () => {
    run('scripts/feature-state.sh', 'record-contract', PLAN);
    writePlan('# Plan\n\n## T1 gate constant\n\n## T2 veto window\n\n## T3 judge precondition\n');
    expect(run('scripts/feature-state.sh', 'contract-changed', PLAN).stdout).toContain('CHANGED');
  });

  it('reads CHANGED when allowed_edit_surface widens', () => {
    run('scripts/feature-state.sh', 'record-contract', PLAN);
    writeIntake(['src/lib/a.ts', 'src/lib/b.ts', 'src/lib/c.ts'], ['holds the veto window']);
    expect(run('scripts/feature-state.sh', 'contract-changed', PLAN).stdout).toContain('CHANGED');
  });

  it('reads CHANGED when a promised test title changes', () => {
    run('scripts/feature-state.sh', 'record-contract', PLAN);
    writeIntake(['src/lib/a.ts', 'src/lib/b.ts'], ['holds the veto window', 'refuses a stale hash']);
    expect(run('scripts/feature-state.sh', 'contract-changed', PLAN).stdout).toContain('CHANGED');
  });

  it('reads CHANGED with no snapshot, so the failure direction is "review it"', () => {
    const result = run('scripts/feature-state.sh', 'contract-changed', PLAN);
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('CHANGED');
    expect(result.stdout).toContain('no contract recorded');
  });
});
