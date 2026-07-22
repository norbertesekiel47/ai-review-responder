import { describe, expect, it } from 'vitest';

import {
  parseArgs,
  assertBranchTargets,
  classifyArm,
  collapseArmOutcome,
  runWithDeadline,
  evaluateRun,
  DIFFERENTIAL_DEADLINE_MS,
  type DeadlineResult,
  type RunArms,
} from '../../health-bundle-differential';

// These cover ONLY the pure helpers — not the live-DB path (fresh-client arms,
// pg_stat_activity sampling, terminate-all). The safety gate itself is covered by
// scripts/ci/__tests__/staging-guard.test.ts; here we assert the differential WIRES
// assertEphemeralBranchTarget. Mirrors scripts/ci/__tests__/wedge-repro.test.ts.

const BRANCH_URL = 'postgresql://postgres.brref0000000001:pw@aws-0-us-east-1.pooler.supabase.com:6543/postgres';
const BRANCH_REF = 'brref0000000001';

describe('parseArgs', () => {
  const base = ['node', 'health-bundle-differential.ts'];

  it('parses the required flags and defaults iterations to 6', () => {
    const cfg = parseArgs([...base, '--branch-pool-url', BRANCH_URL, '--confirm-branch', BRANCH_REF]);
    expect(cfg.branchPoolUrl).toBe(BRANCH_URL);
    expect(cfg.confirmBranchRef).toBe(BRANCH_REF);
    expect(cfg.iterations).toBe(6);
    expect(cfg.observerUrl).toBe(BRANCH_URL);
    expect(cfg.observerIsSeparate).toBe(false);
  });

  it('accepts --flag=value form', () => {
    const cfg = parseArgs([...base, `--branch-pool-url=${BRANCH_URL}`, `--confirm-branch=${BRANCH_REF}`]);
    expect(cfg.branchPoolUrl).toBe(BRANCH_URL);
    expect(cfg.confirmBranchRef).toBe(BRANCH_REF);
  });

  it('uses --observer-url when provided and flags it separate', () => {
    const observer = 'postgresql://postgres.brref0000000001:pw@db.brref0000000001.supabase.co:5432/postgres';
    const cfg = parseArgs([...base, '--branch-pool-url', BRANCH_URL, '--confirm-branch', BRANCH_REF, '--observer-url', observer]);
    expect(cfg.observerUrl).toBe(observer);
    expect(cfg.observerIsSeparate).toBe(true);
  });

  it('requires --branch-pool-url', () => {
    expect(() => parseArgs([...base, '--confirm-branch', BRANCH_REF])).toThrow(/--branch-pool-url is required/);
  });

  it('requires --confirm-branch', () => {
    expect(() => parseArgs([...base, '--branch-pool-url', BRANCH_URL])).toThrow(/--confirm-branch is required/);
  });

  it.each(['0', '-1', '1.5', 'abc'])('rejects non-positive-integer iterations (%s)', (bad) => {
    expect(() =>
      parseArgs([...base, '--branch-pool-url', BRANCH_URL, '--confirm-branch', BRANCH_REF, '--iterations', bad]),
    ).toThrow(/--iterations must be a positive integer/);
  });

  it('accepts a positive integer for iterations', () => {
    const cfg = parseArgs([...base, '--branch-pool-url', BRANCH_URL, '--confirm-branch', BRANCH_REF, '--iterations', '3']);
    expect(cfg.iterations).toBe(3);
  });
});

describe('assertBranchTargets (wires assertEphemeralBranchTarget)', () => {
  const cfg = (overrides: Partial<Parameters<typeof assertBranchTargets>[0]> = {}) => ({
    branchPoolUrl: BRANCH_URL,
    observerUrl: BRANCH_URL,
    observerIsSeparate: false,
    confirmBranchRef: BRANCH_REF,
    iterations: 6,
    ...overrides,
  });

  it('accepts a distinct branch ref that matches the target', () => {
    expect(() => assertBranchTargets(cfg())).not.toThrow();
  });

  it('rejects an empty --confirm-branch', () => {
    expect(() => assertBranchTargets(cfg({ confirmBranchRef: '' }))).toThrow(/REFUSING TO RUN/);
  });

  it('rejects a --confirm-branch that does not match the target', () => {
    expect(() => assertBranchTargets(cfg({ confirmBranchRef: 'someotherref0001' }))).toThrow(/REFUSING TO RUN/);
  });

  it('rejects the production project ref via the denylist', () => {
    const prodUrl = 'postgresql://postgres.udeyaqnvpojbwgoaxwdg:pw@aws-0.pooler.supabase.com:6543/postgres';
    expect(() => assertBranchTargets(cfg({ branchPoolUrl: prodUrl, observerUrl: prodUrl, confirmBranchRef: 'udeyaqnvpojbwgoaxwdg' }))).toThrow(
      /PRODUCTION project ref/,
    );
  });

  it('guards the observer URL too, not just the branch pool URL', () => {
    const prodObserver = 'postgresql://postgres.udeyaqnvpojbwgoaxwdg:pw@db.udeyaqnvpojbwgoaxwdg.supabase.co:5432/postgres';
    expect(() => assertBranchTargets(cfg({ observerUrl: prodObserver }))).toThrow(/PRODUCTION project ref/);
  });
});

describe('classifyArm (4-way taxonomy)', () => {
  it('resolved before the deadline → fulfilled', () => {
    expect(classifyArm({ status: 'resolved', value: undefined }, false)).toBe('fulfilled');
  });

  it('a check threw → rejected (regardless of signature)', () => {
    expect(classifyArm({ status: 'rejected', error: new Error('boom') }, true)).toBe('rejected');
  });

  it('deadline passed AND the ClientRead signature is corroborated → wedged', () => {
    expect(classifyArm({ status: 'timeout' }, true)).toBe('wedged');
  });

  it('deadline passed but NO signature → hung-unknown (a bare timeout is not a repro)', () => {
    expect(classifyArm({ status: 'timeout' }, false)).toBe('hung-unknown');
  });
});

describe('collapseArmOutcome', () => {
  it('any wedged iteration collapses to wedged', () => {
    expect(collapseArmOutcome(['fulfilled', 'wedged', 'fulfilled'])).toBe('wedged');
  });

  it('all-fulfilled collapses to fulfilled', () => {
    expect(collapseArmOutcome(['fulfilled', 'fulfilled'])).toBe('fulfilled');
  });

  it('rejected wins over hung-unknown and fulfilled but not wedged', () => {
    expect(collapseArmOutcome(['fulfilled', 'rejected', 'hung-unknown'])).toBe('rejected');
    expect(collapseArmOutcome(['wedged', 'rejected'])).toBe('wedged');
  });

  it('hung-unknown collapses to hung-unknown; empty is treated as hung-unknown', () => {
    expect(collapseArmOutcome(['fulfilled', 'hung-unknown'])).toBe('hung-unknown');
    expect(collapseArmOutcome([])).toBe('hung-unknown');
  });
});

describe('runWithDeadline (bounded-deadline wrapper)', () => {
  it('resolves fast → resolved marker with the value', async () => {
    const result = await runWithDeadline(Promise.resolve(42), 1_000);
    expect(result).toEqual({ status: 'resolved', value: 42 });
  });

  it('rejects fast → rejected marker carrying the error', async () => {
    const error = new Error('nope');
    const result = (await runWithDeadline(Promise.reject(error), 1_000)) as DeadlineResult<never>;
    expect(result.status).toBe('rejected');
    if (result.status === 'rejected') expect(result.error).toBe(error);
  });

  it('hangs past the deadline → timeout marker', async () => {
    const neverSettles = new Promise<number>(() => {});
    const result = await runWithDeadline(neverSettles, 20);
    expect(result).toEqual({ status: 'timeout' });
  });

  it('DIFFERENTIAL_DEADLINE_MS exceeds the 30s server statement_timeout', () => {
    expect(DIFFERENTIAL_DEADLINE_MS).toBeGreaterThan(30_000);
  });
});

describe('evaluateRun (expected-vs-actual exit gating)', () => {
  const arms = (overrides: Partial<RunArms> = {}): RunArms => ({
    'concurrent-max2': 'wedged',
    'sequential-max2': 'fulfilled',
    'concurrent-max6': 'fulfilled',
    ...overrides,
  });

  it('confirmed repro (concurrent-max2 wedged, cure arms clean) → exit 0', () => {
    const verdict = evaluateRun(arms(), false);
    expect(verdict.status).toBe('repro-confirmed');
    expect(verdict.exitCode).toBe(0);
  });

  it('concurrent-max2 fulfilled → inconclusive, exit 1 (NOT a cure regression)', () => {
    const verdict = evaluateRun(arms({ 'concurrent-max2': 'fulfilled' }), false);
    expect(verdict.status).toBe('inconclusive');
    expect(verdict.exitCode).toBe(1);
    expect(verdict.reasons.join(' ')).toMatch(/INCONCLUSIVE/);
  });

  it('concurrent-max2 hung-unknown → inconclusive, exit 1', () => {
    const verdict = evaluateRun(arms({ 'concurrent-max2': 'hung-unknown' }), false);
    expect(verdict.status).toBe('inconclusive');
    expect(verdict.exitCode).toBe(1);
  });

  it('a cure arm wedged → cure-regression, exit 1', () => {
    const verdict = evaluateRun(arms({ 'sequential-max2': 'wedged' }), false);
    expect(verdict.status).toBe('cure-regression');
    expect(verdict.exitCode).toBe(1);
  });

  it('concurrent-max6 (control) wedged → cure-regression, exit 1', () => {
    const verdict = evaluateRun(arms({ 'concurrent-max6': 'wedged' }), false);
    expect(verdict.status).toBe('cure-regression');
    expect(verdict.exitCode).toBe(1);
  });

  it('a residual that survived terminate-all → aborted-residual (most severe), exit 1', () => {
    const verdict = evaluateRun(arms({ 'sequential-max2': 'wedged' }), true);
    expect(verdict.status).toBe('aborted-residual');
    expect(verdict.exitCode).toBe(1);
  });
});
