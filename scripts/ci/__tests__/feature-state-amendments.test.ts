import { spawnSync } from 'node:child_process';
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

// Pins the surface-amendment budget enforcement in feature-state.sh:
// feat-898 recorded "AMENDMENT 3 of 2" with the budget tracked only in prose.
// The 1st amendment passes; the 2nd and later REFUSE unless --reason records
// the owner's explicit sign-off, and every amendment lands in a durable log.

const SCRIPT_SOURCE = resolve(process.cwd(), 'scripts', 'feature-state.sh');

// git exports GIT_DIR and friends into test processes; inherited here they
// would retarget every git call at the CALLER's repository.
const GIT_FREE_ENV = Object.fromEntries(
  Object.entries(process.env).filter(([key]) => !key.startsWith('GIT_')),
) as NodeJS.ProcessEnv;

let repo: string;

function git(...args: string[]): void {
  const result = spawnSync('git', args, { cwd: repo, encoding: 'utf8', env: GIT_FREE_ENV });
  if (result.status !== 0) throw new Error(`git ${args.join(' ')} failed: ${result.stderr}`);
}

function featureState(...args: string[]) {
  return spawnSync('bash', ['scripts/feature-state.sh', ...args], {
    cwd: repo,
    encoding: 'utf8',
    env: GIT_FREE_ENV,
  });
}

function state(): {
  surfaceAmendments?: number;
  surfaceAmendmentLog?: Array<{ n: number; reason: string; at: string }>;
} {
  return JSON.parse(readFileSync(join(repo, '.feature', 'state.json'), 'utf8'));
}

beforeEach(() => {
  repo = mkdtempSync(join(tmpdir(), 'feature-state-'));
  git('init', '-q', '-b', 'feat-fixture');
  mkdirSync(join(repo, 'scripts'), { recursive: true });
  copyFileSync(SCRIPT_SOURCE, join(repo, 'scripts', 'feature-state.sh'));
});

afterEach(() => {
  rmSync(repo, { recursive: true, force: true });
});

describe('feature-state.sh incr-amendment', () => {
  it('auto-approves the 1st amendment and logs it', () => {
    const result = featureState('incr-amendment');
    expect(result.status, result.stderr + result.stdout).toBe(0);
    expect(state().surfaceAmendments).toBe(1);
    expect(state().surfaceAmendmentLog).toHaveLength(1);
    expect(state().surfaceAmendmentLog?.[0]?.reason).toContain('auto-approved');
  });

  it('REFUSES the 2nd amendment without an owner reason, writing nothing', () => {
    expect(featureState('incr-amendment').status).toBe(0);
    const result = featureState('incr-amendment');
    expect(result.status).toBe(1);
    expect(result.stdout).toContain('abort criteria');
    expect(state().surfaceAmendments).toBe(1);
  });

  it('accepts the 2nd amendment with --reason and records the reason', () => {
    expect(featureState('incr-amendment').status).toBe(0);
    const result = featureState('incr-amendment', '--reason', 'owner approved widening to schema-ready.ts');
    expect(result.status, result.stderr + result.stdout).toBe(0);
    expect(state().surfaceAmendments).toBe(2);
    expect(state().surfaceAmendmentLog?.[1]?.reason).toContain('owner approved');
  });

  it('rejects --reason with no value', () => {
    expect(featureState('incr-amendment', '--reason').status).toBe(1);
  });

  it('rejects an unknown flag', () => {
    expect(featureState('incr-amendment', '--force').status).toBe(1);
  });

  it('preserves existing state keys when incrementing', () => {
    expect(featureState('set-phase', 'worktree_ready').status).toBe(0);
    expect(featureState('incr-amendment').status).toBe(0);
    const current = state() as Record<string, unknown>;
    expect(current.phase).toBe('worktree_ready');
    expect(current.surfaceAmendments).toBe(1);
  });
});
