import fc from 'fast-check';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { LlmCircuitBreaker, llmCircuitBreaker, type Admission } from '../circuit-breaker';
import type { LLMProviderId } from '../types';

const captureMessage = vi.fn();
vi.mock('@sentry/node', () => ({
  captureMessage: (...args: unknown[]) => captureMessage(...args),
}));

/** A transient error: error-classifier.ts treats name 'TimeoutError' as transient. */
function transientError(): Error {
  const err = new Error('timed out');
  err.name = 'TimeoutError';
  return err;
}

/** A non-transient error: a plain Error is not classified as transient. */
function nonTransientError(): Error {
  return new Error('nope');
}

/** A mutable clock so the state machine is driven deterministically. */
function fixedClock(start = 0): { now: () => number; advance: (ms: number) => void } {
  let current = start;
  return {
    now: () => current,
    advance: (ms: number) => {
      current += ms;
    },
  };
}

const OPENAI: LLMProviderId = 'openai';

type Outcome = 'success' | 'transient' | 'nonTransient';

/** Record an outcome against an already-minted admission token. */
function record(breaker: LlmCircuitBreaker, admission: Admission, outcome: Outcome): void {
  if (outcome === 'success') breaker.recordAttempt(admission);
  else if (outcome === 'transient') breaker.recordAttempt(admission, transientError());
  else breaker.recordAttempt(admission, nonTransientError());
}

/**
 * A full caller round-trip: consult the breaker, and (only if admitted) record
 * the outcome under the token the attempt was admitted with — exactly what
 * run-task.ts's attemptProvider does. Returns the admission (null if blocked).
 */
function attempt(breaker: LlmCircuitBreaker, provider: LLMProviderId, outcome: Outcome): Admission | null {
  const admission = breaker.shouldAttempt(provider);
  if (admission === null) return null;
  record(breaker, admission, outcome);
  return admission;
}

/** Trip a provider open via 5 consecutive transient failures, each admitted first. */
function tripOpen(breaker: LlmCircuitBreaker, provider: LLMProviderId): void {
  for (let i = 0; i < 5; i++) attempt(breaker, provider, 'transient');
}

beforeEach(() => {
  captureMessage.mockClear();
});

describe('LlmCircuitBreaker', () => {
  it('opens after exactly 5 consecutive transient failures', () => {
    const clock = fixedClock();
    const breaker = new LlmCircuitBreaker({ now: clock.now, enabled: true });

    for (let i = 0; i < 4; i++) {
      attempt(breaker, OPENAI, 'transient');
      expect(breaker.shouldAttempt(OPENAI)).not.toBeNull();
    }
    attempt(breaker, OPENAI, 'transient');
    expect(breaker.shouldAttempt(OPENAI)).toBeNull();
  });

  it('a success resets the consecutive-failure counter', () => {
    const clock = fixedClock();
    const breaker = new LlmCircuitBreaker({ now: clock.now, enabled: true });

    for (let i = 0; i < 4; i++) attempt(breaker, OPENAI, 'transient');
    attempt(breaker, OPENAI, 'success');
    expect(breaker.shouldAttempt(OPENAI)).not.toBeNull();

    for (let i = 0; i < 4; i++) attempt(breaker, OPENAI, 'transient');
    expect(breaker.shouldAttempt(OPENAI)).not.toBeNull();
  });

  it('ignores non-transient failures while closed', () => {
    const clock = fixedClock();
    const breaker = new LlmCircuitBreaker({ now: clock.now, enabled: true });

    for (let i = 0; i < 5; i++) attempt(breaker, OPENAI, 'nonTransient');
    expect(breaker.shouldAttempt(OPENAI)).not.toBeNull();
  });

  it('transitions open→half_open after the cooldown and admits the probe', () => {
    const clock = fixedClock();
    const breaker = new LlmCircuitBreaker({ now: clock.now, enabled: true });

    tripOpen(breaker, OPENAI);
    expect(breaker.shouldAttempt(OPENAI)).toBeNull();

    clock.advance(30_000);
    expect(breaker.shouldAttempt(OPENAI)).not.toBeNull(); // probe admitted
  });

  it('closes on a successful half_open probe', () => {
    const clock = fixedClock();
    const breaker = new LlmCircuitBreaker({ now: clock.now, enabled: true });

    tripOpen(breaker, OPENAI);
    clock.advance(30_000);
    const probe = breaker.shouldAttempt(OPENAI);
    expect(probe).not.toBeNull();

    breaker.recordAttempt(probe!); // probe success
    expect(breaker.shouldAttempt(OPENAI)).not.toBeNull();
  });

  it('re-opens on a transient half_open probe failure', () => {
    const clock = fixedClock();
    const breaker = new LlmCircuitBreaker({ now: clock.now, enabled: true });

    tripOpen(breaker, OPENAI);
    clock.advance(30_000);
    const probe = breaker.shouldAttempt(OPENAI); // probe
    expect(probe).not.toBeNull();

    breaker.recordAttempt(probe!, transientError()); // probe fails
    expect(breaker.shouldAttempt(OPENAI)).toBeNull(); // re-open, still cooling down

    clock.advance(30_000);
    expect(breaker.shouldAttempt(OPENAI)).not.toBeNull(); // next cooldown elapsed
  });

  it('closes when a half_open probe returns a non-transient error (provider reachable)', () => {
    const clock = fixedClock();
    const breaker = new LlmCircuitBreaker({ now: clock.now, enabled: true });

    tripOpen(breaker, OPENAI);
    clock.advance(30_000);
    const probe = breaker.shouldAttempt(OPENAI); // probe
    expect(probe).not.toBeNull();

    breaker.recordAttempt(probe!, nonTransientError()); // reachable
    expect(breaker.shouldAttempt(OPENAI)).not.toBeNull(); // closed
  });

  it('admits exactly one probe under back-to-back half_open calls', () => {
    const clock = fixedClock();
    const breaker = new LlmCircuitBreaker({ now: clock.now, enabled: true });

    tripOpen(breaker, OPENAI);
    clock.advance(30_000);

    const first = breaker.shouldAttempt(OPENAI);
    const second = breaker.shouldAttempt(OPENAI);
    expect(first).not.toBeNull();
    expect(second).toBeNull();
  });

  it('emits exactly one warning on closed→open and none for skipped calls', () => {
    const clock = fixedClock();
    const breaker = new LlmCircuitBreaker({ now: clock.now, enabled: true });

    tripOpen(breaker, OPENAI);
    expect(captureMessage).toHaveBeenCalledTimes(1);
    expect(captureMessage.mock.calls[0]?.[1]).toMatchObject({ level: 'warning' });

    breaker.shouldAttempt(OPENAI); // open, skipped — no new alert
    expect(captureMessage).toHaveBeenCalledTimes(1);
  });

  it('isolates provider state (tripping openai leaves anthropic closed)', () => {
    const clock = fixedClock();
    const breaker = new LlmCircuitBreaker({ now: clock.now, enabled: true });

    tripOpen(breaker, 'openai');
    expect(breaker.shouldAttempt('openai')).toBeNull();
    expect(breaker.shouldAttempt('anthropic')).not.toBeNull();
  });

  it('exposes a module singleton', () => {
    expect(llmCircuitBreaker).toBeInstanceOf(LlmCircuitBreaker);
  });

  // ── FIX 1 regression: admission-token / epoch correlation ────────────────
  // The breaker is a shared singleton with ~9 concurrent LLM jobs. An outcome
  // from an attempt admitted under a PRIOR state must not mutate a breaker that
  // has since transitioned. Classic failure: a slow pre-trip success closing
  // the breaker DURING its 30s cooldown, re-flooding a just-tripped provider.
  it('a stale pre-trip success does not close the breaker during cooldown', async () => {
    const clock = fixedClock();
    const breaker = new LlmCircuitBreaker({ now: clock.now, enabled: true });

    // Attempt A is admitted while the breaker is closed…
    const admissionA = breaker.shouldAttempt(OPENAI);
    expect(admissionA).not.toBeNull();

    // …its provider call is still in flight (resolves later).
    const slowSuccess = Promise.resolve().then(() => admissionA!);

    // Meanwhile 5 other concurrent attempts fail transiently and trip the breaker.
    for (let i = 0; i < 5; i++) {
      const other = breaker.shouldAttempt(OPENAI);
      expect(other).not.toBeNull();
      breaker.recordAttempt(other!, transientError());
    }
    expect(breaker.shouldAttempt(OPENAI)).toBeNull(); // open, cooling down

    // A finally resolves — but under a stale epoch, so it must be ignored.
    const staleToken = await slowSuccess;
    breaker.recordAttempt(staleToken); // stale success
    expect(breaker.shouldAttempt(OPENAI)).toBeNull(); // STILL open

    // And the cooldown clock was untouched: only after a full window does a probe admit.
    clock.advance(30_000);
    expect(breaker.shouldAttempt(OPENAI)).not.toBeNull();
  });

  it('a stale-epoch probe outcome cannot re-close a re-opened breaker', () => {
    const clock = fixedClock();
    const breaker = new LlmCircuitBreaker({ now: clock.now, enabled: true });

    tripOpen(breaker, OPENAI);
    clock.advance(30_000);
    const probe = breaker.shouldAttempt(OPENAI); // half_open, epoch F
    expect(probe).not.toBeNull();

    breaker.recordAttempt(probe!, transientError()); // epoch-F transient → reopen (epoch F+1)
    expect(breaker.shouldAttempt(OPENAI)).toBeNull();

    // The SAME (now stale) probe token resolving again as success must not close it.
    breaker.recordAttempt(probe!); // stale success
    expect(breaker.shouldAttempt(OPENAI)).toBeNull(); // still open
  });

  // ── FIX 2 regression: clear state when disabled ──────────────────────────
  it('clears provider state when disabled so a disable→enable toggle cannot resurrect it', () => {
    const clock = fixedClock();
    // enabledOverride undefined → live per-call read of LLM_CIRCUIT_BREAKER_ENABLED.
    const breaker = new LlmCircuitBreaker({ now: clock.now });

    // Enabled (default ON): trip open, admit a probe, but leave it UNRESOLVED —
    // a stuck half_open + probeInFlight state.
    tripOpen(breaker, OPENAI);
    clock.advance(30_000);
    expect(breaker.shouldAttempt(OPENAI)).not.toBeNull(); // probe claimed, unresolved
    expect(breaker.inspect(OPENAI)?.state).toBe('half_open');

    // Disable mid-process: shouldAttempt must clear state and still admit (bypass).
    process.env.LLM_CIRCUIT_BREAKER_ENABLED = 'false';
    expect(breaker.shouldAttempt(OPENAI)).not.toBeNull();
    expect(breaker.inspect(OPENAI)).toBeUndefined(); // state cleared

    // Re-enable: the provider starts fresh (closed), NOT stuck half_open.
    delete process.env.LLM_CIRCUIT_BREAKER_ENABLED;
    expect(breaker.shouldAttempt(OPENAI)).not.toBeNull();
    expect(breaker.inspect(OPENAI)?.state).toBe('closed');
  });
});

// Property tests (fast-check): the house style for invariant-level coverage.
describe('LlmCircuitBreaker invariants', () => {
  const anyOutcome = fc.constantFrom<Outcome>('success', 'transient', 'nonTransient');

  it('with enabled:false, shouldAttempt is always non-null and clears state', () => {
    fc.assert(
      fc.property(fc.array(anyOutcome), (outcomes) => {
        const breaker = new LlmCircuitBreaker({ now: () => 0, enabled: false });
        for (const outcome of outcomes) attempt(breaker, OPENAI, outcome);
        expect(breaker.shouldAttempt(OPENAI)).not.toBeNull();
        // Disabled bypass always leaves no tracked state behind.
        expect(breaker.inspect(OPENAI)).toBeUndefined();
      }),
    );
  });

  it('fewer than 5 consecutive transient failures never opens', () => {
    fc.assert(
      fc.property(fc.integer({ min: 0, max: 4 }), (count) => {
        const breaker = new LlmCircuitBreaker({ now: () => 0, enabled: true });
        for (let i = 0; i < count; i++) attempt(breaker, OPENAI, 'transient');
        expect(breaker.shouldAttempt(OPENAI)).not.toBeNull();
      }),
    );
  });

  it('a success inside a failure run keeps it closed unless ≥5 consecutive transients follow', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 0, max: 4 }),
        fc.integer({ min: 0, max: 4 }),
        (before, after) => {
          const breaker = new LlmCircuitBreaker({ now: () => 0, enabled: true });
          for (let i = 0; i < before; i++) attempt(breaker, OPENAI, 'transient');
          attempt(breaker, OPENAI, 'success'); // success resets
          for (let i = 0; i < after; i++) attempt(breaker, OPENAI, 'transient');
          expect(breaker.shouldAttempt(OPENAI)).not.toBeNull();
        },
      ),
    );
  });

  it('purely non-transient (closed-state) outcomes leave shouldAttempt non-null', () => {
    fc.assert(
      fc.property(fc.array(fc.constant('nonTransient' as const)), (outcomes) => {
        const breaker = new LlmCircuitBreaker({ now: () => 0, enabled: true });
        for (const outcome of outcomes) attempt(breaker, OPENAI, outcome);
        expect(breaker.shouldAttempt(OPENAI)).not.toBeNull();
      }),
    );
  });

  it('same-epoch closed-state failures accumulate correctly toward the threshold', () => {
    // All admissions minted while closed share one epoch; the Nth transient trips
    // iff N ≥ 5, regardless of admitting every token up front (concurrent fan-out).
    fc.assert(
      fc.property(fc.integer({ min: 1, max: 12 }), (count) => {
        const breaker = new LlmCircuitBreaker({ now: () => 0, enabled: true });
        const tokens: Admission[] = [];
        for (let i = 0; i < count; i++) {
          const a = breaker.shouldAttempt(OPENAI);
          if (a !== null) tokens.push(a);
        }
        // Resolve every admitted token as transient, in admission order.
        for (const token of tokens) breaker.recordAttempt(token, transientError());
        const shouldBeOpen = tokens.length >= 5;
        expect(breaker.shouldAttempt(OPENAI) === null).toBe(shouldBeOpen);
      }),
    );
  });

  it('while open and cooling, shouldAttempt stays null despite interleaved stale-epoch outcomes', () => {
    fc.assert(
      fc.property(fc.array(anyOutcome, { minLength: 1 }), (outcomes) => {
        const clock = fixedClock();
        const breaker = new LlmCircuitBreaker({ now: clock.now, enabled: true });
        tripOpen(breaker, OPENAI);
        const currentEpoch = breaker.inspect(OPENAI)!.epoch;

        for (const outcome of outcomes) {
          // A guaranteed-stale token (epoch below the current one).
          const stale: Admission = { provider: OPENAI, epoch: currentEpoch - 1 };
          record(breaker, stale, outcome);
          expect(breaker.shouldAttempt(OPENAI)).toBeNull(); // still open, still cooling
        }
      }),
    );
  });

  it('applying a stale-epoch outcome never changes breaker state', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 0, max: 8 }),
        anyOutcome,
        fc.integer({ min: 1, max: 5 }),
        (transientsBeforeSnapshot, staleOutcome, epochDelta) => {
          const clock = fixedClock();
          const breaker = new LlmCircuitBreaker({ now: clock.now, enabled: true });
          for (let i = 0; i < transientsBeforeSnapshot; i++) attempt(breaker, OPENAI, 'transient');

          const before = breaker.inspect(OPENAI);
          const currentEpoch = before?.epoch ?? 0;
          const stale: Admission = { provider: OPENAI, epoch: currentEpoch - epochDelta };
          record(breaker, stale, staleOutcome);

          expect(breaker.inspect(OPENAI)).toEqual(before);
        },
      ),
    );
  });

  it('at most one probe is admitted per open cycle', () => {
    fc.assert(
      fc.property(fc.integer({ min: 1, max: 6 }), (probeCalls) => {
        const clock = fixedClock();
        const breaker = new LlmCircuitBreaker({ now: clock.now, enabled: true });
        tripOpen(breaker, OPENAI);
        clock.advance(30_000);

        let admitted = 0;
        for (let i = 0; i < probeCalls; i++) {
          if (breaker.shouldAttempt(OPENAI) !== null) admitted++;
        }
        expect(admitted).toBe(1);
      }),
    );
  });
});

afterEach(() => {
  delete process.env.LLM_CIRCUIT_BREAKER_ENABLED;
  llmCircuitBreaker.reset();
});
