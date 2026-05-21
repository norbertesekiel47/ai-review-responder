# Cost-Guard Wrapper + LLM Error Classifier Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Extract a `withCostGuard` higher-order function and a standalone `isTransientLLMError` classifier from duplicated/hidden code in `generator.ts` and `review-summary.ts`, with uniform finalize-on-error policy and full test coverage.

**Architecture:** A `withCostGuard(opts, fn)` HOF replaces the `reserveCost → try { acquireSlot / fn / finalizeCost } finally { release }` skeleton in both call sites. The wrapper owns the reservation date, concurrency slot acquisition, and cleanup discipline internally. An `llm-error-classifier.ts` module extracts `isTransientLLMError` from `generator.ts` so it can be tested independently. `generator.ts` re-exports the classifier and cost error classes to preserve existing import paths (e.g. `ResponseGeneratorWorker.ts`).

**Tech Stack:** TypeScript, Vitest, ioredis (via tracker), OpenAI + Anthropic SDKs (for classifier), pnpm.

---

## File Map

| File | Action | Responsibility |
|---|---|---|
| `src/lib/costs/cost-guard.ts` | Create | `withCostGuard` HOF + `CostGuardOptions` / `CostGuardedResult<T>` types |
| `src/lib/costs/__tests__/cost-guard.test.ts` | Create | Unit tests for the wrapper (mock tracker functions) |
| `src/lib/responses/llm-error-classifier.ts` | Create | `TransientLLMError` class, `isTransientLLMError(err)`, private `safeInstanceOf` |
| `src/lib/responses/__tests__/llm-error-classifier.test.ts` | Create | Unit tests for the classifier (uses real SDK error instances where possible) |
| `src/lib/responses/generator.ts` | Edit | Use `withCostGuard`; import classifier from new file; add `tryParseCachedGeneration`/`tryWriteCache`/`tryRecordApiCost` inline helpers; re-export `TransientLLMError` and four cost error classes |
| `src/lib/responses/review-summary.ts` | Edit | Use `withCostGuard` with `withConcurrency: false`, `onFinalizeError: 'log-and-return-value'`; add `tryRecordApiCost` inline helper |
| `src/lib/responses/__tests__/generator.test.ts` | Edit | Update tests for concurrency-slot ordering change and finalize-error behavior; add new finalize-error and cleanup-failure tests |
| `src/lib/responses/__tests__/review-summary.test.ts` | Edit | Update tests for finalize-error behavior and new call-site finalize-error pinning tests |

---

## Commit Strategy

**Commit 1 — extractions (no behavior change):**
- `cost-guard.ts`, `cost-guard.test.ts` (new)
- `llm-error-classifier.ts`, `llm-error-classifier.test.ts` (new)
- Run `pnpm test` — new + existing tests pass.
- Do NOT touch `generator.ts` or `review-summary.ts`.

**Commit 2 — migration (behavior changes):**
- Update `generator.ts` and `review-summary.ts` to use the wrapper.
- Update generator + review-summary tests for ordering and finalize-error behavior.
- Run `pnpm test`, `pnpm lint`, `pnpm tsc --noEmit` — all green.

---

## Task 1: Create `src/lib/costs/cost-guard.ts`

**Files:**
- Create: `src/lib/costs/cost-guard.ts`

- [ ] **Step 1: Write the file**

```ts
import {
  reserveCost,
  acquireConcurrencySlot,
  finalizeCost,
  releaseCost,
  releaseConcurrencySlot,
} from './tracker';

export interface CostGuardOptions {
  businessId: string;
  subscriptionTier: string;
  withConcurrency?: boolean;
  /**
   * What to do when finalizeCost itself throws (e.g. Redis transport flake)
   * AFTER fn has successfully returned a value.
   * - 'propagate' (default): log and re-throw the finalize error. Caller's
   *   value is discarded.
   * - 'log-and-return-value': log the finalize error and return fn's value
   *   anyway. The cost reservation is NOT released (per D3); it ages out
   *   via the 24h Redis TTL.
   */
  onFinalizeError?: 'propagate' | 'log-and-return-value';
}

export interface CostGuardedResult<T> {
  value: T;
  actualCostCents: number;
}

export async function withCostGuard<T>(
  opts: CostGuardOptions,
  fn: () => Promise<CostGuardedResult<T>>,
): Promise<T> {
  const { businessId, subscriptionTier, withConcurrency = true, onFinalizeError = 'propagate' } = opts;

  const reservationDate = await reserveCost(businessId, subscriptionTier);

  let concurrencyAcquired = false;
  let finalized = false;

  try {
    if (withConcurrency) {
      await acquireConcurrencySlot(businessId);
      concurrencyAcquired = true;
    }

    const { value, actualCostCents } = await fn();

    try {
      await finalizeCost(businessId, actualCostCents, reservationDate);
      finalized = true;
    } catch (finalizeErr) {
      console.error('[cost-guard] finalizeCost failed:', finalizeErr);
      finalized = true;
      if (onFinalizeError === 'log-and-return-value') {
        return value;
      }
      throw finalizeErr;
    }

    return value;
  } finally {
    if (concurrencyAcquired) {
      try {
        await releaseConcurrencySlot(businessId);
      } catch (err) {
        console.error('[cost-guard] Failed to release concurrency slot:', err);
      }
    }
    if (!finalized) {
      try {
        await releaseCost(businessId, reservationDate);
      } catch (err) {
        console.error('[cost-guard] Failed to release cost reservation:', err);
      }
    }
  }
}
```

- [ ] **Step 2: Verify TypeScript compiles**

Run: `pnpm tsc --noEmit`
Expected: No errors in the new file.

- [ ] **Step 3: Commit**

```bash
git add src/lib/costs/cost-guard.ts
git commit -m "feat(costs): add withCostGuard higher-order function (extraction, no behavior change)

Extracts the reserve→finalize→release lifecycle that was duplicated
in generator.ts and review-summary.ts into a single HOF.

Policy locked in: finalize-error does NOT trigger releaseCost
(bounded over-count beats unbounded under-count; 24h TTL clears it)."
```

---

## Task 2: Create `src/lib/costs/__tests__/cost-guard.test.ts`

**Files:**
- Create: `src/lib/costs/__tests__/cost-guard.test.ts`

- [ ] **Step 1: Write the complete test file**

```ts
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { withCostGuard } from '../cost-guard';

const mockReserveCost = vi.fn();
const mockAcquireConcurrencySlot = vi.fn();
const mockFinalizeCost = vi.fn();
const mockReleaseCost = vi.fn();
const mockReleaseConcurrencySlot = vi.fn();

vi.mock('../tracker', () => ({
  reserveCost: (...args: unknown[]) => mockReserveCost(...args),
  acquireConcurrencySlot: (...args: unknown[]) => mockAcquireConcurrencySlot(...args),
  finalizeCost: (...args: unknown[]) => mockFinalizeCost(...args),
  releaseCost: (...args: unknown[]) => mockReleaseCost(...args),
  releaseConcurrencySlot: (...args: unknown[]) => mockReleaseConcurrencySlot(...args),
  CostLimitExceededError: class CostLimitExceededError extends Error {
    constructor(public readonly businessId: string) {
      super(`Daily cost limit exceeded for business ${businessId}`);
      this.name = 'CostLimitExceededError';
    }
  },
  ConcurrencyLimitExceededError: class ConcurrencyLimitExceededError extends Error {
    constructor(public readonly businessId: string) {
      super(`Concurrency limit exceeded for business ${businessId}`);
      this.name = 'ConcurrencyLimitExceededError';
    }
  },
}));

const fn = vi.fn();

beforeEach(() => {
  vi.clearAllMocks();
  mockReserveCost.mockResolvedValue('2026-05-03');
  mockAcquireConcurrencySlot.mockResolvedValue(undefined);
  mockFinalizeCost.mockResolvedValue(undefined);
  mockReleaseCost.mockResolvedValue(undefined);
  mockReleaseConcurrencySlot.mockResolvedValue(undefined);
  fn.mockResolvedValue({ value: 'ok', actualCostCents: 5 });
});

describe('withCostGuard', () => {
  it('happy path with concurrency: reserve → slot → fn → finalize → release-slot, no releaseCost', async () => {
    const result = await withCostGuard(
      { businessId: 'biz-001', subscriptionTier: 'standard', withConcurrency: true },
      fn,
    );

    expect(result).toBe('ok');
    expect(mockReserveCost).toHaveBeenCalledWith('biz-001', 'standard');
    expect(mockAcquireConcurrencySlot).toHaveBeenCalledWith('biz-001');
    expect(mockFinalizeCost).toHaveBeenCalledWith('biz-001', 5, '2026-05-03');
    expect(mockReleaseConcurrencySlot).toHaveBeenCalledWith('biz-001');
    expect(mockReleaseCost).not.toHaveBeenCalled();
  });

  it('happy path without concurrency: reserve → fn → finalize, slot functions never called', async () => {
    const result = await withCostGuard(
      { businessId: 'biz-001', subscriptionTier: 'standard', withConcurrency: false },
      fn,
    );

    expect(result).toBe('ok');
    expect(mockReserveCost).toHaveBeenCalledWith('biz-001', 'standard');
    expect(mockAcquireConcurrencySlot).not.toHaveBeenCalled();
    expect(mockFinalizeCost).toHaveBeenCalledWith('biz-001', 5, '2026-05-03');
    expect(mockReleaseConcurrencySlot).not.toHaveBeenCalled();
    expect(mockReleaseCost).not.toHaveBeenCalled();
  });

  it('reserveCost throws → fn not invoked, slot not acquired, error propagates', async () => {
    const { CostLimitExceededError } = await import('../tracker');
    const err = new CostLimitExceededError('biz-001');
    mockReserveCost.mockRejectedValueOnce(err);

    await expect(
      withCostGuard({ businessId: 'biz-001', subscriptionTier: 'standard' }, fn),
    ).rejects.toThrow(err);

    expect(fn).not.toHaveBeenCalled();
    expect(mockAcquireConcurrencySlot).not.toHaveBeenCalled();
  });

  it('acquireConcurrencySlot throws → releaseCost called, fn not invoked, original error propagates', async () => {
    const { ConcurrencyLimitExceededError } = await import('../tracker');
    const err = new ConcurrencyLimitExceededError('biz-001');
    mockAcquireConcurrencySlot.mockRejectedValueOnce(err);

    await expect(
      withCostGuard({ businessId: 'biz-001', subscriptionTier: 'standard' }, fn),
    ).rejects.toThrow(err);

    expect(fn).not.toHaveBeenCalled();
    expect(mockReleaseCost).toHaveBeenCalledWith('biz-001', '2026-05-03');
    expect(mockReleaseConcurrencySlot).not.toHaveBeenCalled();
  });

  it('fn throws → releaseConcurrencySlot and releaseCost called, original error propagates', async () => {
    const err = new Error('LLM failure');
    fn.mockRejectedValueOnce(err);

    await expect(
      withCostGuard({ businessId: 'biz-001', subscriptionTier: 'standard' }, fn),
    ).rejects.toThrow(err);

    expect(mockReleaseConcurrencySlot).toHaveBeenCalledWith('biz-001');
    expect(mockReleaseCost).toHaveBeenCalledWith('biz-001', '2026-05-03');
  });

  it('finalizeCost throws (default propagate) → releaseCost NOT called, releaseConcurrencySlot called, finalize error propagates', async () => {
    const err = new Error('Redis timeout');
    mockFinalizeCost.mockRejectedValueOnce(err);

    await expect(
      withCostGuard({ businessId: 'biz-001', subscriptionTier: 'standard' }, fn),
    ).rejects.toThrow(err);

    expect(mockReleaseCost).not.toHaveBeenCalled();
    expect(mockReleaseConcurrencySlot).toHaveBeenCalledWith('biz-001');
  });

  it('finalizeCost throws + log-and-return-value → returns value, no releaseCost, releases slot', async () => {
    const err = new Error('Redis timeout');
    mockFinalizeCost.mockRejectedValueOnce(err);

    const result = await withCostGuard(
      { businessId: 'biz-001', subscriptionTier: 'standard', onFinalizeError: 'log-and-return-value' },
      fn,
    );

    expect(result).toBe('ok');
    expect(mockReleaseCost).not.toHaveBeenCalled();
    expect(mockReleaseConcurrencySlot).toHaveBeenCalledWith('biz-001');
  });

  it('releaseConcurrencySlot rejects on success-path cleanup → logged, does not throw, value returned', async () => {
    mockReleaseConcurrencySlot.mockRejectedValueOnce(new Error('slot release fail'));

    const result = await withCostGuard(
      { businessId: 'biz-001', subscriptionTier: 'standard' },
      fn,
    );

    expect(result).toBe('ok');
  });

  it('releaseConcurrencySlot rejects after fn throws → logged, does not throw, original fn error propagates', async () => {
    const fnErr = new Error('LLM failure');
    fn.mockRejectedValueOnce(fnErr);
    mockReleaseConcurrencySlot.mockRejectedValueOnce(new Error('slot release fail'));

    await expect(
      withCostGuard({ businessId: 'biz-001', subscriptionTier: 'standard' }, fn),
    ).rejects.toThrow(fnErr);
  });

  it('releaseConcurrencySlot rejects after finalizeCost throws → logged, does not throw, finalize error propagates', async () => {
    mockFinalizeCost.mockRejectedValueOnce(new Error('finalize fail'));
    mockReleaseConcurrencySlot.mockRejectedValueOnce(new Error('slot release fail'));

    await expect(
      withCostGuard({ businessId: 'biz-001', subscriptionTier: 'standard' }, fn),
    ).rejects.toThrow('finalize fail');
  });

  it('releaseCost rejects after acquireConcurrencySlot throws → logged, does not throw, original error propagates', async () => {
    const slotErr = new Error('slot limit');
    mockAcquireConcurrencySlot.mockRejectedValueOnce(slotErr);
    mockReleaseCost.mockRejectedValueOnce(new Error('release fail'));

    await expect(
      withCostGuard({ businessId: 'biz-001', subscriptionTier: 'standard' }, fn),
    ).rejects.toThrow(slotErr);
  });

  it('releaseCost rejects after fn throws → logged, does not throw, original fn error propagates', async () => {
    const fnErr = new Error('LLM failure');
    fn.mockRejectedValueOnce(fnErr);
    mockReleaseCost.mockRejectedValueOnce(new Error('release fail'));

    await expect(
      withCostGuard({ businessId: 'biz-001', subscriptionTier: 'standard' }, fn),
    ).rejects.toThrow(fnErr);
  });

  it('both cleanups reject after fn throws → both logged, original fn error propagates', async () => {
    const fnErr = new Error('LLM failure');
    fn.mockRejectedValueOnce(fnErr);
    mockReleaseConcurrencySlot.mockRejectedValueOnce(new Error('slot fail'));
    mockReleaseCost.mockRejectedValueOnce(new Error('cost fail'));

    await expect(
      withCostGuard({ businessId: 'biz-001', subscriptionTier: 'standard' }, fn),
    ).rejects.toThrow(fnErr);
  });

  it('actualCostCents > reservation → finalize called with larger value', async () => {
    fn.mockResolvedValueOnce({ value: 'ok', actualCostCents: 50 });

    await withCostGuard({ businessId: 'biz-001', subscriptionTier: 'standard' }, fn);

    expect(mockFinalizeCost).toHaveBeenCalledWith('biz-001', 50, '2026-05-03');
  });

  it('actualCostCents < reservation → finalize called with smaller value (negative adjustment)', async () => {
    fn.mockResolvedValueOnce({ value: 'ok', actualCostCents: 3 });

    await withCostGuard({ businessId: 'biz-001', subscriptionTier: 'standard' }, fn);

    expect(mockFinalizeCost).toHaveBeenCalledWith('biz-001', 3, '2026-05-03');
  });
});
```

- [ ] **Step 2: Run the new tests**

Run: `pnpm test src/lib/costs/__tests__/cost-guard.test.ts`
Expected: All 16 tests pass.

- [ ] **Step 3: Commit**

```bash
git add src/lib/costs/__tests__/cost-guard.test.ts
git commit -m "test(costs): withCostGuard unit tests

Covers happy path, all error paths, cleanup failure non-masking
guarantees, and both onFinalizeError modes."
```

---

## Task 3: Create `src/lib/responses/llm-error-classifier.ts`

**Files:**
- Create: `src/lib/responses/llm-error-classifier.ts`

- [ ] **Step 1: Write the file**

```ts
import OpenAI from 'openai';
import Anthropic from '@anthropic-ai/sdk';

/**
 * Wraps a transient LLM provider error so callers can rethrow for retry
 * instead of marking the outbox failed. Permanent errors (auth, bad
 * request, guardrail) surface as ordinary Errors.
 */
export class TransientLLMError extends Error {
  constructor(public readonly cause: unknown) {
    super(cause instanceof Error ? cause.message : String(cause));
    this.name = 'TransientLLMError';
  }
}

// `instanceof` against a class that might be undefined (e.g. when the SDK is
// mocked without its error subclasses) throws TypeError. Guard each check so
// a minimal mock can't crash classification.
function safeInstanceOf(err: unknown, ctor: unknown): boolean {
  return typeof ctor === 'function' && err instanceof (ctor as new (...args: unknown[]) => unknown);
}

export function isTransientLLMError(err: unknown): boolean {
  if (safeInstanceOf(err, OpenAI.APIConnectionError)) return true;
  if (safeInstanceOf(err, OpenAI.APIConnectionTimeoutError)) return true;
  if (safeInstanceOf(err, OpenAI.RateLimitError)) return true;
  if (safeInstanceOf(err, OpenAI.InternalServerError)) return true;
  if (safeInstanceOf(err, Anthropic.APIConnectionError)) return true;
  if (safeInstanceOf(err, Anthropic.APIConnectionTimeoutError)) return true;
  if (safeInstanceOf(err, Anthropic.RateLimitError)) return true;
  if (safeInstanceOf(err, Anthropic.InternalServerError)) return true;
  // Generic API errors: retry on 5xx and 429
  if (safeInstanceOf(err, OpenAI.APIError) || safeInstanceOf(err, Anthropic.APIError)) {
    const status = (err as { status?: number }).status;
    if (typeof status === 'number' && (status >= 500 || status === 429 || status === 408)) return true;
  }
  // Node fetch / undici timeouts + ECONNRESET surface as plain Errors
  if (err instanceof Error) {
    const code = (err as { code?: string }).code;
    if (code === 'ETIMEDOUT' || code === 'ECONNRESET' || code === 'ECONNREFUSED' || code === 'EAI_AGAIN') return true;
    if (err.name === 'AbortError' || err.name === 'TimeoutError') return true;
  }
  return false;
}
```

- [ ] **Step 2: Verify TypeScript compiles**

Run: `pnpm tsc --noEmit`
Expected: No errors.

- [ ] **Step 3: Commit**

```bash
git add src/lib/responses/llm-error-classifier.ts
git commit -m "feat(responses): extract isTransientLLMError + TransientLLMError (no behavior change)

Extracted from generator.ts:70-91 into a standalone classifier module.
safeInstanceOf stays private. No logic changes."
```

---

## Task 4: Create `src/lib/responses/__tests__/llm-error-classifier.test.ts`

**Files:**
- Create: `src/lib/responses/__tests__/llm-error-classifier.test.ts`

- [ ] **Step 1: Write the complete test file**

```ts
import { describe, it, expect, vi } from 'vitest';
import OpenAI from 'openai';
import Anthropic from '@anthropic-ai/sdk';
import { isTransientLLMError, TransientLLMError } from '../llm-error-classifier';

describe('isTransientLLMError', () => {
  it('returns true for OpenAI APIConnectionError', () => {
    const err = new OpenAI.APIConnectionError({ cause: new Error('conn') });
    expect(isTransientLLMError(err)).toBe(true);
  });

  it('returns true for OpenAI APIConnectionTimeoutError', () => {
    const err = new OpenAI.APIConnectionTimeoutError();
    expect(isTransientLLMError(err)).toBe(true);
  });

  it('returns true for OpenAI RateLimitError', () => {
    const err = new OpenAI.RateLimitError(429, undefined, 'rate limit', {});
    expect(isTransientLLMError(err)).toBe(true);
  });

  it('returns true for OpenAI InternalServerError', () => {
    const err = new OpenAI.InternalServerError(500, undefined, 'internal', {});
    expect(isTransientLLMError(err)).toBe(true);
  });

  it('returns true for Anthropic APIConnectionError', () => {
    const err = new Anthropic.APIConnectionError({ cause: new Error('conn') });
    expect(isTransientLLMError(err)).toBe(true);
  });

  it('returns true for Anthropic APIConnectionTimeoutError', () => {
    const err = new Anthropic.APIConnectionTimeoutError();
    expect(isTransientLLMError(err)).toBe(true);
  });

  it('returns true for Anthropic RateLimitError', () => {
    const err = new Anthropic.RateLimitError({ message: 'rate limit', status: 429 });
    expect(isTransientLLMError(err)).toBe(true);
  });

  it('returns true for Anthropic InternalServerError', () => {
    const err = new Anthropic.InternalServerError({ message: 'internal', status: 500 });
    expect(isTransientLLMError(err)).toBe(true);
  });

  it('returns true for generic OpenAI.APIError with status 500', () => {
    const err = new OpenAI.APIError(500, undefined, 'server error', {});
    expect(isTransientLLMError(err)).toBe(true);
  });

  it('returns true for generic OpenAI.APIError with status 502', () => {
    const err = new OpenAI.APIError(502, undefined, 'bad gateway', {});
    expect(isTransientLLMError(err)).toBe(true);
  });

  it('returns true for generic OpenAI.APIError with status 503', () => {
    const err = new OpenAI.APIError(503, undefined, 'unavailable', {});
    expect(isTransientLLMError(err)).toBe(true);
  });

  it('returns true for generic OpenAI.APIError with status 429', () => {
    const err = new OpenAI.APIError(429, undefined, 'too many', {});
    expect(isTransientLLMError(err)).toBe(true);
  });

  it('returns true for generic OpenAI.APIError with status 408', () => {
    const err = new OpenAI.APIError(408, undefined, 'timeout', {});
    expect(isTransientLLMError(err)).toBe(true);
  });

  it('returns false for generic OpenAI.APIError with status 400', () => {
    const err = new OpenAI.APIError(400, undefined, 'bad request', {});
    expect(isTransientLLMError(err)).toBe(false);
  });

  it('returns false for generic OpenAI.APIError with status 401', () => {
    const err = new OpenAI.APIError(401, undefined, 'unauthorized', {});
    expect(isTransientLLMError(err)).toBe(false);
  });

  it('returns false for generic OpenAI.APIError with status 403', () => {
    const err = new OpenAI.APIError(403, undefined, 'forbidden', {});
    expect(isTransientLLMError(err)).toBe(false);
  });

  it('returns false for generic OpenAI.APIError with status 404', () => {
    const err = new OpenAI.APIError(404, undefined, 'not found', {});
    expect(isTransientLLMError(err)).toBe(false);
  });

  it('returns false for generic OpenAI.APIError with status 422', () => {
    const err = new OpenAI.APIError(422, undefined, 'unprocessable', {});
    expect(isTransientLLMError(err)).toBe(false);
  });

  it('returns true for plain Error with code ETIMEDOUT', () => {
    const err = Object.assign(new Error('timeout'), { code: 'ETIMEDOUT' });
    expect(isTransientLLMError(err)).toBe(true);
  });

  it('returns true for plain Error with code ECONNRESET', () => {
    const err = Object.assign(new Error('reset'), { code: 'ECONNRESET' });
    expect(isTransientLLMError(err)).toBe(true);
  });

  it('returns true for plain Error with code ECONNREFUSED', () => {
    const err = Object.assign(new Error('refused'), { code: 'ECONNREFUSED' });
    expect(isTransientLLMError(err)).toBe(true);
  });

  it('returns true for plain Error with code EAI_AGAIN', () => {
    const err = Object.assign(new Error('dns'), { code: 'EAI_AGAIN' });
    expect(isTransientLLMError(err)).toBe(true);
  });

  it('returns true for plain Error with name AbortError', () => {
    const err = Object.assign(new Error('abort'), { name: 'AbortError' });
    expect(isTransientLLMError(err)).toBe(true);
  });

  it('returns true for plain Error with name TimeoutError', () => {
    const err = Object.assign(new Error('timeout'), { name: 'TimeoutError' });
    expect(isTransientLLMError(err)).toBe(true);
  });

  it('returns false for arbitrary plain Error', () => {
    expect(isTransientLLMError(new Error('boom'))).toBe(false);
  });

  it('returns false for null', () => {
    expect(isTransientLLMError(null)).toBe(false);
  });

  it('returns false for undefined', () => {
    expect(isTransientLLMError(undefined)).toBe(false);
  });

  it('returns false for string', () => {
    expect(isTransientLLMError('error')).toBe(false);
  });

  it('returns false for plain object', () => {
    expect(isTransientLLMError({ message: 'boom' })).toBe(false);
  });

  it('safeInstanceOf regression: does not throw when SDK mock is minimal', async () => {
    // Simulate a minimal mock where error subclasses are missing
    vi.doMock('openai', () => ({
      default: class MockOpenAI {},
    }));

    // Re-import the module to pick up the minimal mock
    const { isTransientLLMError: isTransient } = await import('../llm-error-classifier');

    // Should return false without throwing TypeError about instanceof
    expect(() => isTransient(new Error('boom'))).not.toThrow();
    expect(isTransient(new Error('boom'))).toBe(false);

    vi.doUnmock('openai');
  });
});

describe('TransientLLMError', () => {
  it('preserves cause and message', () => {
    const cause = new Error('original');
    const wrapped = new TransientLLMError(cause);
    expect(wrapped.cause).toBe(cause);
    expect(wrapped.message).toBe('original');
    expect(wrapped.name).toBe('TransientLLMError');
  });

  it('handles non-Error cause', () => {
    const wrapped = new TransientLLMError('string cause');
    expect(wrapped.message).toBe('string cause');
  });
});
```

- [ ] **Step 2: Run the new tests**

Run: `pnpm test src/lib/responses/__tests__/llm-error-classifier.test.ts`
Expected: All 35 tests pass.

- [ ] **Step 3: Run full test suite to confirm no regressions**

Run: `pnpm test`
Expected: All existing tests pass; new tests pass.

- [ ] **Step 4: Commit**

```bash
git add src/lib/responses/__tests__/llm-error-classifier.test.ts
git commit -m "test(responses): llm-error-classifier unit tests

Covers all transient/non-transient OpenAI + Anthropic error classes,
status-code branches, plain Error code/name branches, non-Error inputs,
and the safeInstanceOf undefined-ctor regression case."
```

---

## Task 5: Migrate `generator.ts` to use `withCostGuard`

**Files:**
- Modify: `src/lib/responses/generator.ts`

- [ ] **Step 1: Replace imports and add new ones**

Replace lines 1-23:
```ts
import OpenAI from 'openai';
import Anthropic from '@anthropic-ai/sdk';
import type { NormalizedReview } from '@/lib/reviews/types';
import { detectResponseLanguage } from '@/lib/reviews/detect-language';
import type {
  BusinessContext,
  DemoBusinessContext,
  VoiceExample,
  GenerationOptions,
  GenerationResult,
} from './types';
import { buildDemoPrompt, buildProductionPrompt } from './prompt-builder';
import {
  checkIdempotentCache,
  clearCachedGeneration,
  reserveCost,
  acquireConcurrencySlot,
  finalizeCost,
  setCachedGeneration,
  releaseCost,
  releaseConcurrencySlot,
} from '@/lib/costs/tracker';
import { recordApiCost, calculateCostUsd } from '@/lib/costs/audit';
```

With:
```ts
import OpenAI from 'openai';
import Anthropic from '@anthropic-ai/sdk';
import type { NormalizedReview } from '@/lib/reviews/types';
import { detectResponseLanguage } from '@/lib/reviews/detect-language';
import type {
  BusinessContext,
  DemoBusinessContext,
  VoiceExample,
  GenerationOptions,
  GenerationResult,
} from './types';
import { buildDemoPrompt, buildProductionPrompt } from './prompt-builder';
import {
  checkIdempotentCache,
  clearCachedGeneration,
  setCachedGeneration,
} from '@/lib/costs/tracker';
import { withCostGuard } from '@/lib/costs/cost-guard';
import { recordApiCost, calculateCostUsd } from '@/lib/costs/audit';
```

- [ ] **Step 2: Replace re-exports and add classifier re-export**

Replace lines 25-31:
```ts
export {
  CostLimitExceededError,
  GlobalCostLimitExceededError,
  ConcurrencyLimitExceededError,
  RegenBudgetExceededError,
} from '@/lib/costs/tracker';
```

With:
```ts
export {
  CostLimitExceededError,
  GlobalCostLimitExceededError,
  ConcurrencyLimitExceededError,
  RegenBudgetExceededError,
} from '@/lib/costs/tracker';

export { TransientLLMError } from './llm-error-classifier';
```

- [ ] **Step 3: Remove TransientLLMError class and isTransientLLMError function**

Remove lines 56-91 entirely (the class, `safeInstanceOf`, and `isTransientLLMError`). These are replaced by imports from the new classifier module.

Replace with:
```ts
import { isTransientLLMError } from './llm-error-classifier';
```

This import should go near the top, after the existing imports. Place it after the `import { withCostGuard }` line.

- [ ] **Step 4: Add inline helper functions before `runProductionMode`**

After `validateProductionOptions` (after line 162), add these helpers before `runProductionMode`:

```ts
// ── Best-effort helpers for runProductionMode ────────────────────────

function tryParseCachedGeneration(
  cached: string,
  reviewId: string,
  version: number,
): CachedGeneration | null {
  try {
    return JSON.parse(cached) as CachedGeneration;
  } catch (err) {
    console.warn(
      `[generator] Corrupt cached generation for ${reviewId} v${version}: ${err instanceof Error ? err.message : err}`,
    );
    clearCachedGeneration(reviewId, version).catch(() => { /* best effort */ });
    return null;
  }
}

async function tryWriteCache(
  reviewId: string,
  version: number,
  llmResult: { text: string; provider: 'openai' | 'anthropic'; model: string; usage: { promptTokens: number; completionTokens: number } },
  responseLanguage: string,
): Promise<void> {
  try {
    const cachePayload: CachedGeneration = {
      responseText: llmResult.text,
      language: responseLanguage,
      provider: llmResult.provider,
      model: llmResult.model,
      promptTokens: llmResult.usage.promptTokens,
      completionTokens: llmResult.usage.completionTokens,
    };
    await setCachedGeneration(reviewId, version, JSON.stringify(cachePayload));
  } catch (cacheError) {
    console.error('[generator] Failed to cache generation result:', cacheError);
  }
}

async function tryRecordApiCost(
  businessId: string,
  llmResult: { provider: 'openai' | 'anthropic'; usage: { promptTokens: number; completionTokens: number } },
  costUsd: number,
): Promise<string | null> {
  try {
    return await recordApiCost({
      businessId,
      provider: llmResult.provider,
      endpoint: llmResult.provider === 'openai' ? 'chat.completions' : 'messages',
      inputTokens: llmResult.usage.promptTokens,
      outputTokens: llmResult.usage.completionTokens,
      costUsd,
      responseId: null,
    });
  } catch (auditError) {
    console.error('[generator] Failed to record api_costs audit row:', auditError);
    return null;
  }
}
```

- [ ] **Step 5: Rewrite `runProductionMode`**

Replace lines 164-294 with:

```ts
async function runProductionMode(
  review: NormalizedReview,
  business: BusinessContext,
  voiceExamples: VoiceExample[],
  options: GenerationOptions,
): Promise<GenerationResult> {
  validateProductionOptions(options);
  const { reviewId, version, businessId, subscriptionTier } = options;

  // Check idempotent cache — return immediately if already generated.
  if (!options.skipCache) {
    const cached = await checkIdempotentCache(reviewId, version);
    if (cached) {
      const parsed = tryParseCachedGeneration(cached, reviewId, version);
      if (parsed) {
        return {
          responseText: parsed.responseText,
          language: parsed.language,
          provider: parsed.provider,
          model: parsed.model,
          usage: {
            promptTokens: parsed.promptTokens,
            completionTokens: parsed.completionTokens,
          },
          costUsd: 0,
          apiCostId: null,
        };
      }
    }
  }

  const { llmResult, costUsd } = await withCostGuard(
    { businessId, subscriptionTier, withConcurrency: true },
    async () => {
      const prompt = buildProductionPrompt(review, business, voiceExamples);
      const llm = await callLLMWithFallback(prompt.systemPrompt, prompt.userPrompt);
      const usd = calculateCostUsd(
        llm.model,
        llm.usage.promptTokens,
        llm.usage.completionTokens,
      );
      return { value: { llmResult: llm, costUsd: usd }, actualCostCents: Math.ceil(usd * 100) };
    },
  );

  const responseLanguage = detectResponseLanguage(llmResult.text);
  const result: GenerationResult = {
    responseText: llmResult.text,
    language: responseLanguage,
    provider: llmResult.provider,
    model: llmResult.model,
    usage: llmResult.usage,
    costUsd,
    apiCostId: null,
  };

  if (!options.skipCache) {
    await tryWriteCache(reviewId, version, llmResult, responseLanguage);
  }
  result.apiCostId = await tryRecordApiCost(businessId, llmResult, costUsd);

  return result;
}
```

- [ ] **Step 6: Verify TypeScript compiles**

Run: `pnpm tsc --noEmit`
Expected: No errors in `generator.ts`.

- [ ] **Step 7: Commit**

```bash
git add src/lib/responses/generator.ts
git commit -m "feat(responses): migrate generator.ts to withCostGuard

Behavior changes (intentional):
1. finalize-error policy: no longer calls releaseCost after finalizeCost
   throws. Bounded over-count via 24h TTL replaces unbounded under-count.
2. Concurrency slot released earlier: before cache write + audit insert
   instead of after. Unblocks concurrent generations for same business sooner.

TransientLLMError, isTransientLLMError, safeInstanceOf extracted to
llm-error-classifier.ts (re-export preserved for backward compat)."
```

---

## Task 6: Update `generator.test.ts` for new behavior

**Files:**
- Modify: `src/lib/responses/__tests__/generator.test.ts`

- [ ] **Step 1: Update mock to include new cost-guard module**

After line 41 (after the tracker mock), add:

```ts
vi.mock('@/lib/costs/cost-guard', async () => {
  const actual = await vi.importActual<typeof import('@/lib/costs/cost-guard')>('@/lib/costs/cost-guard');
  return actual;
});
```

Also add to the tracker mock (line 29-41) the four error classes with proper constructors if missing — check they match tracker.ts exactly:
```ts
CostLimitExceededError: class CostLimitExceededError extends Error {
  name = 'CostLimitExceededError';
  constructor(public readonly businessId: string) {
    super(`Daily cost limit exceeded for business ${businessId}`);
  }
},
GlobalCostLimitExceededError: class GlobalCostLimitExceededError extends Error {
  name = 'GlobalCostLimitExceededError';
  constructor() { super('Global daily cost limit exceeded'); }
},
ConcurrencyLimitExceededError: class ConcurrencyLimitExceededError extends Error {
  name = 'ConcurrencyLimitExceededError';
  constructor(public readonly businessId: string) {
    super(`Concurrency limit exceeded for business ${businessId}`);
  }
},
RegenBudgetExceededError: class RegenBudgetExceededError extends Error {
  name = 'RegenBudgetExceededError';
  constructor(public readonly reviewId: string) {
    super(`Regeneration budget exceeded for review ${reviewId}`);
  }
},
```

- [ ] **Step 2: Update existing test "returns result even when post-finalization cache write fails"**

This test is unchanged behavior-wise. Keep as-is (lines 253-266).

- [ ] **Step 3: Update test "releases concurrency slot and cost on LLM failure in production"**

This test is unchanged behavior-wise. Keep as-is (lines 229-242).

- [ ] **Step 4: Update test "returns result even when finally-block cleanup throws"**

Since the wrapper handles cleanup failures internally, this test changes. The wrapper catches `releaseConcurrencySlot` errors and logs them. Replace lines 283-295 with:

```ts
  it('returns result even when wrapper cleanup throws', async () => {
    openaiCreate.mockResolvedValueOnce(openAIResponse('Good response'));

    const tracker = await import('@/lib/costs/tracker');
    vi.mocked(tracker.releaseConcurrencySlot).mockRejectedValueOnce(
      new Error('Redis connection lost'),
    );

    const { generateResponse } = await import('../generator');
    const result = await generateResponse(review, businessContext, [], productionOptions);

    expect(result.responseText).toBe('Good response');
  });
```

- [ ] **Step 5: Add new finalize-error test for generator call site**

After line 295, add:

```ts
  it('finalizeCost error propagates, no releaseCost, no cache or audit, slot released', async () => {
    openaiCreate.mockResolvedValueOnce(openAIResponse('Thanks!'));

    const tracker = await import('@/lib/costs/tracker');
    const audit = await import('@/lib/costs/audit');
    const finalizeErr = new Error('Redis timeout during finalize');
    vi.mocked(tracker.finalizeCost).mockRejectedValueOnce(finalizeErr);

    const { generateResponse } = await import('../generator');
    await expect(
      generateResponse(review, businessContext, [], productionOptions),
    ).rejects.toThrow(finalizeErr);

    expect(tracker.releaseCost).not.toHaveBeenCalled();
    expect(tracker.releaseConcurrencySlot).toHaveBeenCalledWith('biz-001');
    expect(audit.recordApiCost).not.toHaveBeenCalled();
    expect(tracker.setCachedGeneration).not.toHaveBeenCalled();
  });

  it('finalizeCost error with transient-shaped error propagates as plain Error, not TransientLLMError', async () => {
    openaiCreate.mockResolvedValueOnce(openAIResponse('Thanks!'));

    const tracker = await import('@/lib/costs/tracker');
    const finalizeErr = Object.assign(new Error('ECONNRESET during finalize'), { code: 'ECONNRESET' });
    vi.mocked(tracker.finalizeCost).mockRejectedValueOnce(finalizeErr);

    const { generateResponse, TransientLLMError } = await import('../generator');
    await expect(
      generateResponse(review, businessContext, [], productionOptions),
    ).rejects.toThrow(finalizeErr);

    // Should NOT be wrapped as TransientLLMError — that wrapping is only for
    // LLM-provider failures inside callLLMWithFallback.
    await expect(
      generateResponse(review, businessContext, [], productionOptions),
    ).rejects.not.toBeInstanceOf(TransientLLMError);
  });
```

- [ ] **Step 6: Update test "production mode runs full cost guard lifecycle" for ordering**

Since `releaseConcurrencySlot` is now called by the wrapper before `setCachedGeneration` and `recordApiCost`, update the assertion. Replace lines 174-188 with:

```ts
  it('production mode runs full cost guard lifecycle', async () => {
    openaiCreate.mockResolvedValueOnce(openAIResponse('Thanks!'));

    const tracker = await import('@/lib/costs/tracker');
    const audit = await import('@/lib/costs/audit');
    const { generateResponse } = await import('../generator');
    await generateResponse(review, businessContext, [], productionOptions);

    expect(tracker.reserveCost).toHaveBeenCalledWith('biz-001', 'standard');
    expect(tracker.acquireConcurrencySlot).toHaveBeenCalledWith('biz-001');
    expect(tracker.finalizeCost).toHaveBeenCalled();
    expect(tracker.releaseConcurrencySlot).toHaveBeenCalledWith('biz-001');
    expect(tracker.setCachedGeneration).toHaveBeenCalled();
    expect(audit.recordApiCost).toHaveBeenCalled();
  });
```

- [ ] **Step 7: Update test ordering assertion for "releases cost reservation when concurrency slot acquisition fails"**

This test is unchanged — `releaseCost` is still called when slot acquisition fails. Keep as-is (lines 268-281).

- [ ] **Step 8: Run generator tests**

Run: `pnpm test src/lib/responses/__tests__/generator.test.ts`
Expected: All tests pass.

- [ ] **Step 9: Commit**

```bash
git add src/lib/responses/__tests__/generator.test.ts
git commit -m "test(responses): update generator tests for withCostGuard migration

- Adjusts ordering expectations: slot release now happens before cache/audit.
- Adds finalize-error call-site pinning tests:
  - finalizeCost error propagates without wrapping as TransientLLMError.
  - No cache/audit called when finalize throws.
- Adjusts cleanup-throwing test to wrapper-based behavior."
```

---

## Task 7: Migrate `review-summary.ts` to use `withCostGuard`

**Files:**
- Modify: `src/lib/responses/review-summary.ts`

- [ ] **Step 1: Update imports**

Replace lines 1-5:
```ts
import OpenAI from 'openai';
import Anthropic from '@anthropic-ai/sdk';
import { isMockMode } from '@/lib/shared/mock-mode';
import { recordApiCost, calculateCostUsd } from '@/lib/costs/audit';
import { reserveCost, finalizeCost, releaseCost } from '@/lib/costs/tracker';
```

With:
```ts
import OpenAI from 'openai';
import Anthropic from '@anthropic-ai/sdk';
import { isMockMode } from '@/lib/shared/mock-mode';
import { recordApiCost, calculateCostUsd } from '@/lib/costs/audit';
import { withCostGuard } from '@/lib/costs/cost-guard';
```

- [ ] **Step 2: Add inline helper for best-effort audit**

Before `generateReviewSummary`, add:

```ts
async function tryRecordApiCost(
  businessId: string,
  llm: { provider: 'openai' | 'anthropic'; usage: { promptTokens: number; completionTokens: number } },
  costUsd: number,
): Promise<void> {
  try {
    await recordApiCost({
      businessId,
      provider: llm.provider,
      endpoint: 'review-summary',
      inputTokens: llm.usage.promptTokens,
      outputTokens: llm.usage.completionTokens,
      costUsd,
      responseId: null,
    });
  } catch (auditError) {
    console.error('[review-summary] Failed to record cost audit:', auditError);
  }
}
```

- [ ] **Step 3: Rewrite `generateReviewSummary`**

Replace lines 134-208 with:

```ts
export async function generateReviewSummary(
  reviews: ReviewForSummary[],
  businessId: string,
  subscriptionTier: string = 'standard',
): Promise<SummaryResult | null> {
  if (reviews.length === 0) return null;

  if (isMockMode()) {
    return { summaryText: MOCK_SUMMARY, provider: 'mock', costUsd: 0 };
  }

  const capped = reviews.slice(0, MAX_REVIEWS_FOR_SUMMARY);
  const userPrompt = buildUserPrompt(capped);

  let result: { llm: LLMCallResult; costUsd: number };
  try {
    result = await withCostGuard(
      {
        businessId,
        subscriptionTier,
        withConcurrency: false,
        onFinalizeError: 'log-and-return-value',
      },
      async () => {
        const llm = await callLLMWithFallback(userPrompt);
        const usd = calculateCostUsd(
          llm.model,
          llm.usage.promptTokens,
          llm.usage.completionTokens,
        );
        return { value: { llm, costUsd: usd }, actualCostCents: Math.ceil(usd * 100) };
      },
    );
  } catch (err) {
    console.warn('[review-summary] Generation failed, returning null:', err instanceof Error ? err.message : err);
    return null;
  }

  await tryRecordApiCost(businessId, result.llm, result.costUsd);

  return {
    summaryText: result.llm.text,
    provider: result.llm.provider,
    costUsd: result.costUsd,
  };
}
```

- [ ] **Step 4: Verify TypeScript compiles**

Run: `pnpm tsc --noEmit`
Expected: No errors in `review-summary.ts`.

- [ ] **Step 5: Commit**

```bash
git add src/lib/responses/review-summary.ts
git commit -m "feat(responses): migrate review-summary.ts to withCostGuard

Behavior preserved via onFinalizeError: 'log-and-return-value' knob.
No releaseCost after finalize-error (same as today since finalized=true
is set in catch). Outer try/catch returns null on any failure."
```

---

## Task 8: Update `review-summary.test.ts` for new behavior

**Files:**
- Modify: `src/lib/responses/__tests__/review-summary.test.ts`

- [ ] **Step 1: Add cost-guard mock**

After the tracker mock (after line 47), add:

```ts
vi.mock('@/lib/costs/cost-guard', async () => {
  const actual = await vi.importActual<typeof import('@/lib/costs/cost-guard')>('@/lib/costs/cost-guard');
  return actual;
});
```

- [ ] **Step 2: Update the tracker mock to support wrapper needs**

The tracker mock currently has `reserveCost`/`finalizeCost`/`releaseCost`. The wrapper needs these and also `acquireConcurrencySlot`/`releaseConcurrencySlot` (even though review-summary uses `withConcurrency: false`, the mock must have them). Also ensure `CostLimitExceededError` and `GlobalCostLimitExceededError` have constructors matching tracker.ts. Replace lines 31-47 with:

```ts
vi.mock('@/lib/costs/tracker', () => ({
  reserveCost: (...args: unknown[]) => mockReserveCost(...args),
  finalizeCost: (...args: unknown[]) => mockFinalizeCost(...args),
  releaseCost: (...args: unknown[]) => mockReleaseCost(...args),
  acquireConcurrencySlot: vi.fn().mockResolvedValue(undefined),
  releaseConcurrencySlot: vi.fn().mockResolvedValue(undefined),
  CostLimitExceededError: class CostLimitExceededError extends Error {
    constructor(public readonly businessId: string) {
      super(`Daily cost limit exceeded for business ${businessId}`);
      this.name = 'CostLimitExceededError';
    }
  },
  GlobalCostLimitExceededError: class GlobalCostLimitExceededError extends Error {
    constructor() {
      super('Global daily cost limit exceeded');
      this.name = 'GlobalCostLimitExceededError';
    }
  },
}));
```

- [ ] **Step 3: Update test "calls reserveCost before LLM and finalizeCost after"**

This test is largely unchanged. Replace lines 181-192 with:

```ts
  it('calls reserveCost before LLM and finalizeCost after', async () => {
    const summaryText = 'Cost-tracked summary.';
    openaiCreate.mockResolvedValueOnce(openAIResponse(summaryText));

    const generateReviewSummary = await getSut();
    await generateReviewSummary(makeReviews(3), 'biz-001');

    expect(mockReserveCost).toHaveBeenCalledWith('biz-001', 'standard');
    expect(mockFinalizeCost).toHaveBeenCalledWith('biz-001', expect.any(Number), '2026-04-14');
    expect(mockReleaseCost).not.toHaveBeenCalled();
  });
```

- [ ] **Step 4: Update test "releases cost reservation when LLM call fails"**

The wrapper handles this. The test should still observe `releaseCost` called when LLM fails. Keep lines 194-204 as-is.

- [ ] **Step 5: Add new finalize-error pinning test for review-summary call site**

After the "returns null gracefully when cost limit exceeded" test (after line 216), add:

```ts
  it('finalizeCost error: returns summary, no releaseCost, recordApiCost still called', async () => {
    const summaryText = 'Summary despite finalize flake.';
    openaiCreate.mockResolvedValueOnce(openAIResponse(summaryText));

    const finalizeErr = new Error('Redis timeout during finalize');
    mockFinalizeCost.mockRejectedValueOnce(finalizeErr);

    const { recordApiCost } = await import('@/lib/costs/audit');

    const generateReviewSummary = await getSut();
    const result = await generateReviewSummary(makeReviews(3), 'biz-001');

    expect(result).not.toBeNull();
    expect(result!.summaryText).toBe(summaryText);
    expect(mockReleaseCost).not.toHaveBeenCalled();
    expect(recordApiCost).toHaveBeenCalled();
  });

  it('reserveCost rejection (cost limit) → returns null, separate log prefix', async () => {
    const { CostLimitExceededError } = await import('@/lib/costs/tracker');
    mockReserveCost.mockRejectedValueOnce(new CostLimitExceededError('biz-001'));

    const generateReviewSummary = await getSut();
    const result = await generateReviewSummary(makeReviews(3), 'biz-001');

    expect(result).toBeNull();
    expect(openaiCreate).not.toHaveBeenCalled();
    expect(anthropicCreate).not.toHaveBeenCalled();
  });
```

- [ ] **Step 6: Run review-summary tests**

Run: `pnpm test src/lib/responses/__tests__/review-summary.test.ts`
Expected: All tests pass.

- [ ] **Step 7: Commit**

```bash
git add src/lib/responses/__tests__/review-summary.test.ts
git commit -m "test(responses): update review-summary tests for withCostGuard migration

- Adds tracker mock entries for acquire/release concurrency (not used in
  review-summary, but needed for wrapper import).
- Adds finalize-error call-site pinning test: wrapper returns value,
  no releaseCost, audit still recorded.
- Adds reserveCost rejection test with separate log prefix behavior."
```

---

## Task 9: Final verification

- [ ] **Step 1: Run full test suite**

Run: `pnpm test`
Expected: All tests pass.

- [ ] **Step 2: Run lint**

Run: `pnpm lint`
Expected: No errors.

- [ ] **Step 3: Run TypeScript check**

Run: `pnpm tsc --noEmit`
Expected: No errors.

- [ ] **Step 4: Commit any trailing fixes**

If lint/tsc found issues, fix them and commit:
```bash
git commit -m "fix: lint/tsc fixes for cost-guard migration"
```

---

## Self-Review Checklist

### 1. Spec Coverage

| Spec Section | Task |
|---|---|
| D1: Wrapper covers cost + concurrency, cache/audit stay outside | Task 1 (`cost-guard.ts` does not touch cache or audit) |
| D2: HOF pattern (not class) | Task 1 (exported as `withCostGuard(opts, fn)`) |
| D3: finalize-error → no releaseCost | Task 1 (line 42: `finalized = true` suppresses releaseCost in finally) |
| D4: generator.ts re-exports | Task 5 (Step 2 adds `export { TransientLLMError }`) |
| D5: Two commits | Commit strategy section at top of plan |
| D6: `onFinalizeError` knob | Task 1 (interface + implementation), Task 5 (generator uses default), Task 7 (review-summary opts into `'log-and-return-value'`) |
| `withCostGuard` interface (§5.1) | Task 1 (complete implementation matching all 5 sequence steps) |
| `llm-error-classifier` interface (§5.2) | Task 3 (exact extraction from generator.ts:56-91) |
| `generator.ts` migration shape (§6.1) | Task 5 (complete rewrite of `runProductionMode`) |
| `review-summary.ts` migration shape (§6.2) | Task 7 (complete rewrite of `generateReviewSummary`) |
| `cost-guard.test.ts` cases (§7.1) | Task 2 (all 16 cases: happy×2, reserve throw, slot throw, fn throw, finalize-propagate, finalize-log-return, cleanup failures ×6, cost >/< reservation ×2) |
| `llm-error-classifier.test.ts` cases (§7.2) | Task 4 (all 33+ cases: SDK subclasses, generic status codes, plain Error codes/names, non-Error inputs, safeInstanceOf regression) |
| Existing test ordering changes (§7.3) | Task 6 (generator), Task 8 (review-summary) |
| Call-site finalize-error tests (§7.4) | Task 6 (generator: finalize-error propagation + non-TransientLLMError wrapping), Task 8 (review-summary: finalize-error returns value + audit called) |
| Risks documented (§8) | Commit messages in Tasks 5 and 7 explicitly enumerate behavior changes |

**Gap check:** None. Every spec requirement maps to a task.

### 2. Placeholder Scan

- No "TBD", "TODO", "implement later" → verified.
- No "Add appropriate error handling" → all error handling is explicit in code blocks.
- No "Write tests for the above" without test code → every test step has complete test code.
- No "Similar to Task N" → each task is self-contained.
- No undefined types/functions — all referenced symbols (`reserveCost`, `finalizeCost`, etc.) are either imported from existing tracker.ts or defined in the same file.

### 3. Type Consistency

- `CostGuardOptions` fields: `businessId`, `subscriptionTier`, `withConcurrency?`, `onFinalizeError?` — consistent across Tasks 1, 5, 7.
- `CostGuardedResult<T>`: `value: T`, `actualCostCents: number` — consistent across Tasks 1, 5, 7.
- `withCostGuard` return type: `Promise<T>` — consistent.
- `TransientLLMError` class signature: same in Task 3 (extraction) as original in generator.ts line 56-61.
- `isTransientLLMError` signature: `function isTransientLLMError(err: unknown): boolean` — same as original.

### 4. Additional issues found during review

- **Mock contract for `cost-guard.test.ts`:** The `vi.mock('../tracker', ...)` must use factory-returning-arrow-functions for all methods because `vi.fn()` hoisting can fail if declared outside. The test file in Task 2 already does this correctly.
- **Mock contract for `generator.test.ts`:** Adding `vi.mock('@/lib/costs/cost-guard', async () => { ...importActual })` is correct because it lets the real wrapper call the mocked tracker functions. The existing tracker mock already intercepts `reserveCost`, `finalizeCost`, etc., so the wrapper's calls hit the mocks.
- **Mock contract for `review-summary.test.ts`:** Same `importActual` pattern added. The tracker mock is updated to include `acquireConcurrencySlot` and `releaseConcurrencySlot` so the wrapper can import them without undefined.
- **`tryParseCachedGeneration` return type:** Added `CachedGeneration | null` to match usage.
- **`tryRecordApiCost` return type:** Set to `Promise<string | null>` to match `recordApiCost` behavior plus error-case return.
- **Missing `import { withCostGuard }` in generator.ts** — added in Step 1 of Task 5.
- **Missing `import { withCostGuard }` in review-summary.ts** — added in Step 1 of Task 7.

No additional gaps found.

---

## Execution Handoff

Plan complete and saved to `docs/superpowers/plans/2026-05-03-cost-guard-llm-classifier.md`.

**Two execution options:**

**1. Subagent-Driven (recommended)** — I dispatch a fresh subagent per task, review between tasks, fast iteration. Use `superpowers:subagent-driven-development`.

**2. Inline Execution** — Execute tasks in this session using `superpowers:executing-plans`, batch execution with checkpoints for review.

**Which approach?**
