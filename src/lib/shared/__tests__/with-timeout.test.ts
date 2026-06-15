import { describe, it, expect, vi, afterEach } from 'vitest';
import { withTimeout, TimeoutError } from '../with-timeout';

describe('withTimeout', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('resolves with the work value when it settles before the deadline', async () => {
    await expect(withTimeout(Promise.resolve('ok'), 1_000)).resolves.toBe('ok');
  });

  it('propagates the work rejection unchanged when it rejects before the deadline', async () => {
    const boom = new Error('boom');
    await expect(withTimeout(Promise.reject(boom), 1_000)).rejects.toBe(boom);
  });

  it('rejects with a labelled TimeoutError when work overruns the deadline', async () => {
    vi.useFakeTimers();
    let caught: unknown;
    const p = withTimeout(new Promise(() => {}), 5_000, 'redis ping').catch((e) => {
      caught = e;
    });
    await vi.advanceTimersByTimeAsync(5_001);
    await p;

    expect(caught).toBeInstanceOf(TimeoutError);
    expect((caught as Error).message).toBe('redis ping timed out after 5000ms');
  });
});
