import { describe, it, expect, vi, beforeEach } from 'vitest';
import { withCostGuard, type CostGuardedResult } from '../cost-guard';
import { reserveCost, finalizeCost, releaseCost } from '../tracker';
import {
  acquireConcurrencySlot,
  releaseConcurrencySlot,
} from '../concurrency-guard';

vi.mock('../tracker', () => ({
  reserveCost: vi.fn(),
  finalizeCost: vi.fn(),
  releaseCost: vi.fn(),
  CostLimitExceededError: class CostLimitExceededError extends Error {
    constructor(public readonly businessId: string) {
      super(`Daily cost limit exceeded for business ${businessId}`);
      this.name = 'CostLimitExceededError';
    }
  },
}));

vi.mock('../concurrency-guard', () => ({
  acquireConcurrencySlot: vi.fn(),
  releaseConcurrencySlot: vi.fn(),
  ConcurrencyLimitExceededError: class ConcurrencyLimitExceededError extends Error {
    constructor(public readonly businessId: string) {
      super(`Concurrency limit exceeded for business ${businessId}`);
      this.name = 'ConcurrencyLimitExceededError';
    }
  },
}));

describe('withCostGuard', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(reserveCost).mockResolvedValue('2026-05-03');
    vi.mocked(acquireConcurrencySlot).mockResolvedValue(undefined);
    vi.mocked(finalizeCost).mockResolvedValue(undefined);
    vi.mocked(releaseCost).mockResolvedValue(undefined);
    vi.mocked(releaseConcurrencySlot).mockResolvedValue(undefined);
  });

  const baseOpts = {
    businessId: 'biz-001',
    subscriptionTier: 'copilot',
  } as const;

  function makeGuardedResult<T>(value: T, actualCostCents: number): Promise<CostGuardedResult<T>> {
    return Promise.resolve({ value, actualCostCents });
  }

  // ── 1. Happy path WITH concurrency ───────────────────────────────────
  it('happy path with concurrency: reserve → slot → fn → finalize → release-slot (releaseCost never called)', async () => {
    const result = await withCostGuard(baseOpts, () => makeGuardedResult('hello', 10));

    expect(result).toBe('hello');
    expect(reserveCost).toHaveBeenCalledExactlyOnceWith('biz-001', 'copilot');
    expect(acquireConcurrencySlot).toHaveBeenCalledExactlyOnceWith('biz-001');
    expect(finalizeCost).toHaveBeenCalledExactlyOnceWith('biz-001', 10, '2026-05-03');
    expect(releaseConcurrencySlot).toHaveBeenCalledExactlyOnceWith('biz-001');
    expect(releaseCost).not.toHaveBeenCalled();
  });

  // ── 2. Happy path WITHOUT concurrency ────────────────────────────────
  it('happy path without concurrency: reserve → fn → finalize; slot functions never called', async () => {
    const result = await withCostGuard(
      { ...baseOpts, withConcurrency: false },
      () => makeGuardedResult('hello', 10),
    );

    expect(result).toBe('hello');
    expect(reserveCost).toHaveBeenCalledExactlyOnceWith('biz-001', 'copilot');
    expect(acquireConcurrencySlot).not.toHaveBeenCalled();
    expect(finalizeCost).toHaveBeenCalledExactlyOnceWith('biz-001', 10, '2026-05-03');
    expect(releaseConcurrencySlot).not.toHaveBeenCalled();
    expect(releaseCost).not.toHaveBeenCalled();
  });

  // ── 3. reserveCost throws ────────────────────────────────────────────
  it('reserveCost throws → fn not invoked, slot not acquired, error propagates', async () => {
    const reserveErr = new Error('rate limit');
    vi.mocked(reserveCost).mockRejectedValue(reserveErr);

    const fn = vi.fn().mockResolvedValue({ value: 'x', actualCostCents: 1 } as CostGuardedResult<string>);

    await expect(withCostGuard(baseOpts, fn)).rejects.toThrow(reserveErr);
    expect(fn).not.toHaveBeenCalled();
    expect(acquireConcurrencySlot).not.toHaveBeenCalled();
    expect(finalizeCost).not.toHaveBeenCalled();
    expect(releaseCost).not.toHaveBeenCalled();
    expect(releaseConcurrencySlot).not.toHaveBeenCalled();
  });

  // ── 4. acquireConcurrencySlot throws ─────────────────────────────────
  it('acquireConcurrencySlot throws → releaseCost called, fn not invoked, original error propagates', async () => {
    const slotErr = new Error('concurrency full');
    vi.mocked(acquireConcurrencySlot).mockRejectedValue(slotErr);

    const fn = vi.fn();

    await expect(withCostGuard(baseOpts, fn)).rejects.toThrow(slotErr);
    expect(fn).not.toHaveBeenCalled();
    expect(releaseCost).toHaveBeenCalledExactlyOnceWith('biz-001', '2026-05-03');
    expect(releaseConcurrencySlot).not.toHaveBeenCalled();
  });

  // ── 5. fn throws ─────────────────────────────────────────────────────
  it('fn throws → both releaseConcurrencySlot and releaseCost called, original error propagates', async () => {
    const fnErr = new Error('fn boom');

    await expect(
      withCostGuard(baseOpts, () => Promise.reject(fnErr)),
    ).rejects.toThrow(fnErr);

    expect(releaseConcurrencySlot).toHaveBeenCalledExactlyOnceWith('biz-001');
    expect(releaseCost).toHaveBeenCalledExactlyOnceWith('biz-001', '2026-05-03');
    expect(finalizeCost).not.toHaveBeenCalled();
  });

  // ── 6. finalizeCost throws (default propagate) ───────────────────────
  it('finalizeCost throws (default propagate) → releaseCost NOT called, releaseConcurrencySlot called, finalize error propagates', async () => {
    const finalizeErr = new Error('redis flake');
    vi.mocked(finalizeCost).mockRejectedValue(finalizeErr);

    await expect(
      withCostGuard(baseOpts, () => makeGuardedResult('ok', 10)),
    ).rejects.toThrow(finalizeErr);

    expect(releaseConcurrencySlot).toHaveBeenCalledExactlyOnceWith('biz-001');
    expect(releaseCost).not.toHaveBeenCalled();
  });

  // ── 7. finalizeCost throws + log-and-return-value ────────────────────
  it('finalizeCost throws + onFinalizeError: log-and-return-value → returns value, no releaseCost, releases slot', async () => {
    const finalizeErr = new Error('redis flake');
    vi.mocked(finalizeCost).mockRejectedValue(finalizeErr);
    const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    const result = await withCostGuard(
      { ...baseOpts, onFinalizeError: 'log-and-return-value' },
      () => makeGuardedResult('preserved', 10),
    );

    expect(result).toBe('preserved');
    expect(releaseConcurrencySlot).toHaveBeenCalledExactlyOnceWith('biz-001');
    expect(releaseCost).not.toHaveBeenCalled();
    expect(consoleSpy).toHaveBeenCalledWith('[cost-guard] finalizeCost failed:', finalizeErr);

    consoleSpy.mockRestore();
  });

  // ── 8. releaseConcurrencySlot rejects on success-path cleanup ────────
  it('releaseConcurrencySlot rejects on success-path cleanup → logged, does NOT throw, value still returned', async () => {
    const cleanupErr = new Error('slot cleanup fail');
    vi.mocked(releaseConcurrencySlot).mockRejectedValue(cleanupErr);
    const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    const result = await withCostGuard(baseOpts, () => makeGuardedResult('hello', 10));

    expect(result).toBe('hello');
    expect(consoleSpy).toHaveBeenCalledWith('[cost-guard] Failed to release concurrency slot:', cleanupErr);

    consoleSpy.mockRestore();
  });

  // ── 9. releaseConcurrencySlot rejects after fn throws ────────────────
  it('releaseConcurrencySlot rejects after fn throws → logged, does NOT throw, original fn error still propagates', async () => {
    const fnErr = new Error('fn boom');
    const cleanupErr = new Error('slot cleanup fail');
    vi.mocked(releaseConcurrencySlot).mockRejectedValue(cleanupErr);
    const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    await expect(
      withCostGuard(baseOpts, () => Promise.reject(fnErr)),
    ).rejects.toThrow(fnErr);

    expect(releaseCost).toHaveBeenCalled(); // because finalized is false
    expect(consoleSpy).toHaveBeenCalledWith('[cost-guard] Failed to release concurrency slot:', cleanupErr);

    consoleSpy.mockRestore();
  });

  // ── 10. releaseConcurrencySlot rejects after finalizeCost throws ─────
  it('releaseConcurrencySlot rejects after finalizeCost throws → logged, does NOT throw, original finalize error still propagates', async () => {
    const finalizeErr = new Error('redis flake');
    const cleanupErr = new Error('slot cleanup fail');
    vi.mocked(finalizeCost).mockRejectedValue(finalizeErr);
    vi.mocked(releaseConcurrencySlot).mockRejectedValue(cleanupErr);
    const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    await expect(
      withCostGuard(baseOpts, () => makeGuardedResult('ok', 10)),
    ).rejects.toThrow(finalizeErr);

    expect(releaseCost).not.toHaveBeenCalled(); // finalized is true on finalize error
    expect(consoleSpy).toHaveBeenCalledWith('[cost-guard] Failed to release concurrency slot:', cleanupErr);

    consoleSpy.mockRestore();
  });

  // ── 11. releaseCost rejects after acquireConcurrencySlot throws ──────
  it('releaseCost rejects after acquireConcurrencySlot throws → logged, does NOT throw, original slot error still propagates', async () => {
    const slotErr = new Error('concurrency full');
    const releaseErr = new Error('release cost fail');
    vi.mocked(acquireConcurrencySlot).mockRejectedValue(slotErr);
    vi.mocked(releaseCost).mockRejectedValue(releaseErr);
    const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    await expect(withCostGuard(baseOpts, () => makeGuardedResult('ok', 10))).rejects.toThrow(slotErr);

    expect(consoleSpy).toHaveBeenCalledWith('[cost-guard] Failed to release cost reservation:', releaseErr);

    consoleSpy.mockRestore();
  });

  // ── 12. releaseCost rejects after fn throws ──────────────────────────
  it('releaseCost rejects after fn throws → logged, does NOT throw, original fn error still propagates', async () => {
    const fnErr = new Error('fn boom');
    const releaseErr = new Error('release cost fail');
    vi.mocked(releaseCost).mockRejectedValue(releaseErr);
    const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    await expect(
      withCostGuard(baseOpts, () => Promise.reject(fnErr)),
    ).rejects.toThrow(fnErr);

    expect(consoleSpy).toHaveBeenCalledWith('[cost-guard] Failed to release cost reservation:', releaseErr);

    consoleSpy.mockRestore();
  });

  // ── 13. Both cleanups reject after fn throws ─────────────────────────
  it('both cleanups reject after fn throws → both logged, original fn error still propagates, no rejection masks another', async () => {
    const fnErr = new Error('fn boom');
    const slotReleaseErr = new Error('slot cleanup fail');
    const costReleaseErr = new Error('cost release fail');
    vi.mocked(releaseConcurrencySlot).mockRejectedValue(slotReleaseErr);
    vi.mocked(releaseCost).mockRejectedValue(costReleaseErr);
    const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    await expect(
      withCostGuard(baseOpts, () => Promise.reject(fnErr)),
    ).rejects.toThrow(fnErr);

    expect(consoleSpy).toHaveBeenCalledWith('[cost-guard] Failed to release concurrency slot:', slotReleaseErr);
    expect(consoleSpy).toHaveBeenCalledWith('[cost-guard] Failed to release cost reservation:', costReleaseErr);

    consoleSpy.mockRestore();
  });

  // ── 14. Larger actualCostCents passes through ────────────────────────
  it('actualCostCents larger than typical → finalize called with the supplied value', async () => {
    await withCostGuard(baseOpts, () => makeGuardedResult('hello', 25));
    expect(finalizeCost).toHaveBeenCalledExactlyOnceWith('biz-001', 25, '2026-05-03');
  });

  // ── 15. Smaller actualCostCents passes through ───────────────────────
  it('actualCostCents smaller than typical → finalize called with the supplied value', async () => {
    await withCostGuard(baseOpts, () => makeGuardedResult('hello', 5));
    expect(finalizeCost).toHaveBeenCalledExactlyOnceWith('biz-001', 5, '2026-05-03');
  });

  // ── 16. fn throws + withConcurrency: false ───────────────────────────
  it('fn throws + withConcurrency: false → releaseConcurrencySlot NEVER called', async () => {
    const fnErr = new Error('fn boom');

    await expect(
      withCostGuard(
        { ...baseOpts, withConcurrency: false },
        () => Promise.reject(fnErr),
      ),
    ).rejects.toThrow(fnErr);

    expect(acquireConcurrencySlot).not.toHaveBeenCalled();
    expect(releaseConcurrencySlot).not.toHaveBeenCalled();
    expect(releaseCost).toHaveBeenCalledExactlyOnceWith('biz-001', '2026-05-03');
  });

  // ── 17. actualCostCents = 0 boundary ─────────────────────────────────
  it('actualCostCents = 0 → finalize called with 0 (cancels reservation)', async () => {
    await withCostGuard(baseOpts, () => makeGuardedResult('hello', 0));
    expect(finalizeCost).toHaveBeenCalledExactlyOnceWith('biz-001', 0, '2026-05-03');
    expect(releaseCost).not.toHaveBeenCalled();
  });

  // ── 18-21. Invalid actualCostCents validation (M1) ───────────────────
  // Each case must reach the validation throw BEFORE finalizeCost runs and
  // BEFORE `finalized` is set, so the finally block calls releaseCost and
  // returns the reservation. Otherwise an invalid cost would leak the 15¢
  // reservation until the 24h Redis TTL.

  it('actualCostCents = NaN → throws TypeError, releaseCost called, finalize NOT called', async () => {
    await expect(
      withCostGuard(baseOpts, () => makeGuardedResult('hello', NaN)),
    ).rejects.toThrow(TypeError);

    expect(finalizeCost).not.toHaveBeenCalled();
    expect(releaseCost).toHaveBeenCalledExactlyOnceWith('biz-001', '2026-05-03');
    expect(releaseConcurrencySlot).toHaveBeenCalledExactlyOnceWith('biz-001');
  });

  it('actualCostCents = Infinity → throws TypeError, reservation released', async () => {
    await expect(
      withCostGuard(baseOpts, () => makeGuardedResult('hello', Infinity)),
    ).rejects.toThrow(TypeError);

    expect(finalizeCost).not.toHaveBeenCalled();
    expect(releaseCost).toHaveBeenCalledExactlyOnceWith('biz-001', '2026-05-03');
  });

  it('actualCostCents = 1.5 (fractional) → throws TypeError, reservation released', async () => {
    await expect(
      withCostGuard(baseOpts, () => makeGuardedResult('hello', 1.5)),
    ).rejects.toThrow(TypeError);

    expect(finalizeCost).not.toHaveBeenCalled();
    expect(releaseCost).toHaveBeenCalledExactlyOnceWith('biz-001', '2026-05-03');
  });

  it('actualCostCents = -1 (negative) → throws TypeError, reservation released', async () => {
    await expect(
      withCostGuard(baseOpts, () => makeGuardedResult('hello', -1)),
    ).rejects.toThrow(TypeError);

    expect(finalizeCost).not.toHaveBeenCalled();
    expect(releaseCost).toHaveBeenCalledExactlyOnceWith('biz-001', '2026-05-03');
  });

  // ── 22-23. Boundary validation (L6) ──────────────────────────────────
  // Empty businessId would build collision-prone Redis keys; empty tier
  // would produce an invalid limit lookup. Both surface immediately.

  it('businessId = "" → throws TypeError, no reserveCost call', async () => {
    await expect(
      withCostGuard(
        { businessId: '', subscriptionTier: 'copilot' },
        () => makeGuardedResult('hello', 10),
      ),
    ).rejects.toThrow(TypeError);

    expect(reserveCost).not.toHaveBeenCalled();
  });

  it('subscriptionTier = "" → throws TypeError, no reserveCost call', async () => {
    await expect(
      withCostGuard(
        { businessId: 'biz-001', subscriptionTier: '' as 'copilot' },
        () => makeGuardedResult('hello', 10),
      ),
    ).rejects.toThrow(TypeError);

    expect(reserveCost).not.toHaveBeenCalled();
  });
});
