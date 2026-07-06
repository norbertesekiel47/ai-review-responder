// Unit coverage for describeWithDb — the DB-gated `describe` wrapper and its
// 3-arg overload.
//
// vitest's `describe`/`describe.skip` are collection-time only (they throw if
// called inside a test) and its module exports are frozen (non-configurable in
// ESM, so they can't be spied or mocked). So we verify the wrapper by OBSERVING
// real behavior at collection time: register suites with explicit gates, let the
// enabled ones run their inner `it` (pushing a marker) and the disabled ones
// skip (marker never pushed), then assert the markers + the captured warn in a
// final suite that runs after them (suites run in registration order within a
// file). Every gate here is explicit (`enabled`) or env-controlled inline, so
// the file passes identically whether or not TEST_DATABASE_POOL_URL is set in
// the ambient env (skip-path vs run-path invocations).
import { describe, it, expect, vi } from 'vitest';
import { describeWithDb } from './describe-with-db';

const ranInner: string[] = [];
const warnLines: string[] = [];

// Capture the collection-time skip warn. Suppress the real write (we assert on
// the recorded lines instead); restored once all registrations below are done.
const stderrSpy = vi.spyOn(process.stderr, 'write');
stderrSpy.mockImplementation(((...args: unknown[]): boolean => {
  const chunk = args[0];
  if (typeof chunk === 'string') warnLines.push(chunk);
  return true;
}) as unknown as (typeof process.stderr)['write']);

// ── enabled:true → describe (run) → inner it executes ────────────────────────
describeWithDb('enabled=true → runs', { enabled: true }, () => {
  it('inner', () => {
    ranInner.push('enabled-true');
  });
});

// ── enabled:true + timeout → 3-arg TestOptions forwarded; still a valid,
//    running suite (proves the timeout branch produces a well-formed
//    describe(name, { timeout }, factory) call vitest accepts). Timing itself
//    is not asserted — the live integration-lifecycle suite exercises the 30s
//    window for real.
describeWithDb('enabled=true + timeout → runs', { enabled: true, timeout: 30_000 }, () => {
  it('inner', () => {
    ranInner.push('enabled-true-timeout');
  });
});

// ── enabled:false → describe.skip → inner it NEVER runs + warns (warn #1) ─────
describeWithDb('enabled=false → skips', { enabled: false }, () => {
  it('inner', () => {
    ranInner.push('enabled-false');
  });
});

// ── second skip → warn latched (no second warn) ──────────────────────────────
describeWithDb('enabled=false again → skips (warn latched)', { enabled: false }, () => {
  it('inner', () => {
    ranInner.push('enabled-false-2');
  });
});

// ── enabled:false + timeout → skip path forwards TestOptions without throwing ─
describeWithDb('enabled=false + timeout → skips', { enabled: false, timeout: 30_000 }, () => {
  it('inner', () => {
    ranInner.push('enabled-false-timeout');
  });
});

// ── 2-arg env fallback: control process.env deterministically around each call.
const savedEnv = process.env.TEST_DATABASE_POOL_URL;
delete process.env.TEST_DATABASE_POOL_URL;
describeWithDb('2-arg, env unset → skips', () => {
  it('inner', () => {
    ranInner.push('env-unset');
  });
});
process.env.TEST_DATABASE_POOL_URL = 'postgres://unit-test';
describeWithDb('2-arg, env set → runs', () => {
  it('inner', () => {
    ranInner.push('env-set');
  });
});
if (savedEnv === undefined) delete process.env.TEST_DATABASE_POOL_URL;
else process.env.TEST_DATABASE_POOL_URL = savedEnv;

stderrSpy.mockRestore();

// ── Assertions: registered last, so they run after every suite above ─────────
describe('describeWithDb — observed dispatch + warn-once', () => {
  it('runs enabled/env-set suites and skips disabled/env-unset suites', () => {
    expect(ranInner).toContain('enabled-true');
    expect(ranInner).toContain('enabled-true-timeout');
    expect(ranInner).toContain('env-set');
    expect(ranInner).not.toContain('enabled-false');
    expect(ranInner).not.toContain('enabled-false-2');
    expect(ranInner).not.toContain('enabled-false-timeout');
    expect(ranInner).not.toContain('env-unset');
  });

  it('warns exactly once across consecutive skips (per-file latch)', () => {
    const warns = warnLines.filter((line) => line.includes('TEST_DATABASE_POOL_URL unset'));
    expect(warns).toHaveLength(1);
  });
});
