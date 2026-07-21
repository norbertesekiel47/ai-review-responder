import fc from 'fast-check';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { LlmCircuitBreaker, llmCircuitBreaker } from '../circuit-breaker';
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

beforeEach(() => {
  captureMessage.mockClear();
});

describe('LlmCircuitBreaker', () => {
  it('opens after exactly 5 consecutive transient failures', () => {
    const clock = fixedClock();
    const breaker = new LlmCircuitBreaker({ now: clock.now, enabled: true });

    for (let i = 0; i < 4; i++) {
      breaker.recordOutcome(OPENAI, transientError());
      expect(breaker.shouldAttempt(OPENAI)).toBe(true);
    }
    breaker.recordOutcome(OPENAI, transientError());
    expect(breaker.shouldAttempt(OPENAI)).toBe(false);
  });

  it('a success resets the consecutive-failure counter', () => {
    const clock = fixedClock();
    const breaker = new LlmCircuitBreaker({ now: clock.now, enabled: true });

    for (let i = 0; i < 4; i++) breaker.recordOutcome(OPENAI, transientError());
    breaker.recordOutcome(OPENAI); // success
    expect(breaker.shouldAttempt(OPENAI)).toBe(true);

    for (let i = 0; i < 4; i++) breaker.recordOutcome(OPENAI, transientError());
    expect(breaker.shouldAttempt(OPENAI)).toBe(true);
  });

  it('ignores non-transient failures while closed', () => {
    const clock = fixedClock();
    const breaker = new LlmCircuitBreaker({ now: clock.now, enabled: true });

    for (let i = 0; i < 5; i++) breaker.recordOutcome(OPENAI, nonTransientError());
    expect(breaker.shouldAttempt(OPENAI)).toBe(true);
  });

  it('transitions open→half_open after the cooldown and admits the probe', () => {
    const clock = fixedClock();
    const breaker = new LlmCircuitBreaker({ now: clock.now, enabled: true });

    for (let i = 0; i < 5; i++) breaker.recordOutcome(OPENAI, transientError());
    expect(breaker.shouldAttempt(OPENAI)).toBe(false);

    clock.advance(30_000);
    expect(breaker.shouldAttempt(OPENAI)).toBe(true); // probe admitted
  });

  it('closes on a successful half_open probe', () => {
    const clock = fixedClock();
    const breaker = new LlmCircuitBreaker({ now: clock.now, enabled: true });

    for (let i = 0; i < 5; i++) breaker.recordOutcome(OPENAI, transientError());
    clock.advance(30_000);
    expect(breaker.shouldAttempt(OPENAI)).toBe(true);

    breaker.recordOutcome(OPENAI); // probe success
    expect(breaker.shouldAttempt(OPENAI)).toBe(true);
  });

  it('re-opens on a transient half_open probe failure', () => {
    const clock = fixedClock();
    const breaker = new LlmCircuitBreaker({ now: clock.now, enabled: true });

    for (let i = 0; i < 5; i++) breaker.recordOutcome(OPENAI, transientError());
    clock.advance(30_000);
    expect(breaker.shouldAttempt(OPENAI)).toBe(true); // probe

    breaker.recordOutcome(OPENAI, transientError()); // probe fails
    expect(breaker.shouldAttempt(OPENAI)).toBe(false); // re-open, still cooling down

    clock.advance(30_000);
    expect(breaker.shouldAttempt(OPENAI)).toBe(true); // next cooldown elapsed
  });

  it('closes when a half_open probe returns a non-transient error (provider reachable)', () => {
    const clock = fixedClock();
    const breaker = new LlmCircuitBreaker({ now: clock.now, enabled: true });

    for (let i = 0; i < 5; i++) breaker.recordOutcome(OPENAI, transientError());
    clock.advance(30_000);
    expect(breaker.shouldAttempt(OPENAI)).toBe(true); // probe

    breaker.recordOutcome(OPENAI, nonTransientError()); // reachable
    expect(breaker.shouldAttempt(OPENAI)).toBe(true); // closed
  });

  it('admits exactly one probe under back-to-back half_open calls', () => {
    const clock = fixedClock();
    const breaker = new LlmCircuitBreaker({ now: clock.now, enabled: true });

    for (let i = 0; i < 5; i++) breaker.recordOutcome(OPENAI, transientError());
    clock.advance(30_000);

    const first = breaker.shouldAttempt(OPENAI);
    const second = breaker.shouldAttempt(OPENAI);
    expect([first, second]).toEqual([true, false]);
  });

  it('emits exactly one warning on closed→open and none for skipped calls', () => {
    const clock = fixedClock();
    const breaker = new LlmCircuitBreaker({ now: clock.now, enabled: true });

    for (let i = 0; i < 5; i++) breaker.recordOutcome(OPENAI, transientError());
    expect(captureMessage).toHaveBeenCalledTimes(1);
    expect(captureMessage.mock.calls[0]?.[1]).toMatchObject({ level: 'warning' });

    breaker.shouldAttempt(OPENAI); // open, skipped — no new alert
    expect(captureMessage).toHaveBeenCalledTimes(1);
  });

  it('isolates provider state (tripping openai leaves anthropic closed)', () => {
    const clock = fixedClock();
    const breaker = new LlmCircuitBreaker({ now: clock.now, enabled: true });

    for (let i = 0; i < 5; i++) breaker.recordOutcome('openai', transientError());
    expect(breaker.shouldAttempt('openai')).toBe(false);
    expect(breaker.shouldAttempt('anthropic')).toBe(true);
  });

  it('exposes a module singleton', () => {
    expect(llmCircuitBreaker).toBeInstanceOf(LlmCircuitBreaker);
  });
});

// Property tests (fast-check): the house style for invariant-level coverage.
describe('LlmCircuitBreaker invariants', () => {
  type Outcome = 'success' | 'transient' | 'nonTransient';
  const anyOutcome = fc.constantFrom<Outcome>('success', 'transient', 'nonTransient');

  function feed(breaker: LlmCircuitBreaker, provider: LLMProviderId, outcome: Outcome): void {
    if (outcome === 'success') breaker.recordOutcome(provider);
    else if (outcome === 'transient') breaker.recordOutcome(provider, transientError());
    else breaker.recordOutcome(provider, nonTransientError());
  }

  it('with enabled:false, shouldAttempt is always true for any outcome sequence', () => {
    fc.assert(
      fc.property(fc.array(anyOutcome), (outcomes) => {
        const breaker = new LlmCircuitBreaker({ now: () => 0, enabled: false });
        for (const outcome of outcomes) feed(breaker, OPENAI, outcome);
        expect(breaker.shouldAttempt(OPENAI)).toBe(true);
      }),
    );
  });

  it('fewer than 5 consecutive transient failures never opens', () => {
    fc.assert(
      fc.property(fc.integer({ min: 0, max: 4 }), (count) => {
        const breaker = new LlmCircuitBreaker({ now: () => 0, enabled: true });
        for (let i = 0; i < count; i++) breaker.recordOutcome(OPENAI, transientError());
        expect(breaker.shouldAttempt(OPENAI)).toBe(true);
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
          for (let i = 0; i < before; i++) breaker.recordOutcome(OPENAI, transientError());
          breaker.recordOutcome(OPENAI); // success resets
          for (let i = 0; i < after; i++) breaker.recordOutcome(OPENAI, transientError());
          expect(breaker.shouldAttempt(OPENAI)).toBe(true);
        },
      ),
    );
  });

  it('purely non-transient (closed-state) outcomes leave shouldAttempt true', () => {
    fc.assert(
      fc.property(fc.array(fc.constant('nonTransient' as const)), (outcomes) => {
        const breaker = new LlmCircuitBreaker({ now: () => 0, enabled: true });
        for (const outcome of outcomes) feed(breaker, OPENAI, outcome);
        expect(breaker.shouldAttempt(OPENAI)).toBe(true);
      }),
    );
  });
});

afterEach(() => {
  llmCircuitBreaker.reset();
});
