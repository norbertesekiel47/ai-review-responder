import { spawnSync } from 'node:child_process';
import { cpSync, mkdtempSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

// Pins two review-log.mjs guarantees added in the 2026-08-29 skill hardening:
//
// 1. round-end REFUSES an empty round. Earlier runs (1008 among them) closed
//    rounds that left no transcript, so the live view and the published
//    snapshot showed a review that had no record.
// 2. triage ACCEPT appends the finding to the durable per-axis checklist
//    (docs/reviews/finding-checklists/<axis>.md) — the feedback loop that
//    stops every review from starting at zero knowledge.
//
// Exercised as a CLI in a scratch git repo, the way the workflow invokes it.

const SCRIPTS_SOURCE = resolve(process.cwd(), '.agents', 'skills', 'feature', 'scripts');

const GIT_FREE_ENV = Object.fromEntries(
  Object.entries(process.env).filter(([key]) => !key.startsWith('GIT_')),
) as NodeJS.ProcessEnv;

let repo: string;

function git(...args: string[]): void {
  const result = spawnSync('git', args, { cwd: repo, encoding: 'utf8', env: GIT_FREE_ENV });
  if (result.status !== 0) throw new Error(`git ${args.join(' ')} failed: ${result.stderr}`);
}

function reviewLog(...args: string[]) {
  return spawnSync(
    'node',
    [join(repo, '.agents', 'skills', 'feature', 'scripts', 'review-log.mjs'), ...args],
    { cwd: repo, encoding: 'utf8', env: GIT_FREE_ENV },
  );
}

beforeEach(() => {
  repo = mkdtempSync(join(tmpdir(), 'review-log-'));
  git('init', '-q', '-b', 'feat-review-log-fixture');
  cpSync(SCRIPTS_SOURCE, join(repo, '.agents', 'skills', 'feature', 'scripts'), {
    recursive: true,
  });
});

afterEach(() => {
  rmSync(repo, { recursive: true, force: true });
});

describe('review-log.mjs round-end', () => {
  it('refuses to close a round with no logged content', () => {
    expect(reviewLog('round-start', '--axis', 'spec-correctness').status).toBe(0);
    const result = reviewLog('round-end', '--verdict', 'APPROVED');
    expect(result.status).toBe(2);
    expect(result.stderr).toContain('no logged turns');
  });

  it('closes a round once a turn is logged', () => {
    expect(reviewLog('round-start', '--axis', 'spec-correctness').status).toBe(0);
    expect(reviewLog('say', '--text', 'Diff sent for review.').status).toBe(0);
    const result = reviewLog('round-end', '--verdict', 'APPROVED');
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain('closed: APPROVED');
  });
});

describe('review-log.mjs triage checklist', () => {
  const checklist = () =>
    join(repo, 'docs', 'reviews', 'finding-checklists', 'spec-correctness.md');

  function logFinding(id: string, title: string): void {
    expect(
      reviewLog(
        'finding', '--id', id, '--severity', 'high', '--title', title,
        '--at', 'worker/jobs/publisher/veto-window.ts:212',
      ).status,
    ).toBe(0);
  }

  beforeEach(() => {
    expect(reviewLog('round-start', '--axis', 'spec-correctness').status).toBe(0);
  });

  it('appends an ACCEPT to the per-axis checklist with title, location, and reason', () => {
    logFinding('F1', 'Veto window keys on sent_at');
    const result = reviewLog(
      'triage', '--id', 'F1', '--verdict', 'ACCEPT',
      '--reason', 'Reproduced: delivery lag opens a silent gap.',
    );
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain('finding-checklists/spec-correctness.md');
    const contents = readFileSync(checklist(), 'utf8');
    expect(contents).toContain('# Accepted findings — spec-correctness');
    expect(contents).toContain('[high] Veto window keys on sent_at (worker/jobs/publisher/veto-window.ts:212)');
    expect(contents).toContain('Reproduced: delivery lag opens a silent gap.');
    expect(contents).toContain('feat-review-log-fixture');
  });

  it('dedupes a title the checklist already carries', () => {
    logFinding('F1', 'Veto window keys on sent_at');
    expect(reviewLog('triage', '--id', 'F1', '--verdict', 'ACCEPT', '--reason', 'first').status).toBe(0);
    logFinding('F2', 'Veto window keys on sent_at');
    const result = reviewLog('triage', '--id', 'F2', '--verdict', 'ACCEPT', '--reason', 'second');
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('already lists');
    const lines = readFileSync(checklist(), 'utf8')
      .split('\n')
      .filter((line) => line.startsWith('- ['));
    expect(lines).toHaveLength(1);
  });

  it('writes nothing to the checklist on REJECT', () => {
    logFinding('F1', 'Speculative objection');
    expect(
      reviewLog('triage', '--id', 'F1', '--verdict', 'REJECT', '--reason', 'not reproducible').status,
    ).toBe(0);
    expect(existsSync(checklist())).toBe(false);
  });
});
