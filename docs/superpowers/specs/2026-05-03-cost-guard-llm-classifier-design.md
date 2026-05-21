# Cost-Guard Wrapper + LLM Error Classifier — Design

**Date:** 2026-05-03
**Status:** Draft (pending implementation plan)
**Scope:** RepWorth `src/lib/responses/` and `src/lib/costs/`
**Origin:** Candidate #5 from the 2026-05-02 architecture survey (`/improve-codebase-architecture` run on `main`).

---

## 1. Motivation

`src/lib/responses/generator.ts` and `src/lib/responses/review-summary.ts` both implement the same cost-lifecycle skeleton:

```
reserveCost → try { LLM call → finalizeCost; finalized = true } finally { if (!finalized) releaseCost }
```

Two subtle problems with the duplication today:

1. **Divergent finalize-on-error policies.** When `finalizeCost` itself throws (Redis transport failure, etc.), `generator.ts` keeps `finalized = false` and the finally block calls `releaseCost`, whereas `review-summary.ts` sets `finalized = true` in the catch block to prevent double-refund. The two policies trade off opposite risks (under-counting vs. over-counting). One should win, applied uniformly.
2. **Implicit pairing.** The reserve→finalize/release contract is enforced only by the call site getting the try/finally right. A future third caller could easily skip a step and silently leak budget (bounded by the 24h Redis TTL, but real within the day).

Adjacent: `isTransientLLMError` lives inside `generator.ts` and is not independently testable without instantiating the generator's full module. Not duplicated, but not separable either.

Both refactors fall in the same files and share a test plan, so they're treated as one piece of work.

## 2. Scope

In:
- Extract a `withCostGuard` higher-order function in `src/lib/costs/cost-guard.ts`.
- Extract `isTransientLLMError` + `TransientLLMError` to `src/lib/responses/llm-error-classifier.ts`.
- Migrate `runProductionMode` in `generator.ts` and `generateReviewSummary` in `review-summary.ts` to use the wrapper.
- Pick one finalize-on-error policy and apply it uniformly.

Out:
- The other five deepening candidates from the 2026-05-02 survey.
- Generalizing the wrapper to non-LLM cost-guarded operations (e.g. `sms-tracker.ts`). Defer until a third caller appears.
- Adding a "needs-reconciliation" audit row on finalize-error. Defer until a reconciliation worker exists to consume it.
- Refactoring the idempotent cache logic. Stays inline via `checkIdempotentCache` / `setCachedGeneration`.

## 3. Decisions

| # | Decision | Rationale |
|---|---|---|
| D1 | Wrapper covers cost reserve/finalize/release **and** concurrency slot acquire/release. Cache and audit stay outside. | Cost + concurrency are the matched resource-cleanup pair. Cache is an idempotency mechanism; audit is one-shot bookkeeping. Bundling either would push orthogonal complexity back into the wrapper. |
| D2 | Wrapper is a higher-order function (`withCostGuard(opts, fn)`), not a context-manager class. | Locks in correctness — callers cannot forget the try/finally, cannot release twice, cannot consume budget without finalizing. The class would be sugar over the same pattern that the wrapper exists to remove. |
| D3 | On finalize-error: log and **do not** call `releaseCost`. (Policy (ii) — bounded over-count beats unbounded under-count.) | Releasing after a partial-`finalizeCost` (Lua script ran but transport failed) under-counts real spend, which can let runaway flows blow past the global limit. Skipping release over-counts by at most one `PESSIMISTIC_ESTIMATE_CENTS` per failure, and the 24h Redis TTL clears it. Matches the comment already in `review-summary.ts:173`. |
| D4 | `generator.ts` re-exports `TransientLLMError` (from `llm-error-classifier.ts`) and the four cost error classes (`CostLimitExceededError`, `GlobalCostLimitExceededError`, `ConcurrencyLimitExceededError`, `RegenBudgetExceededError`, all from `costs/tracker.ts`). | Keeps `worker/jobs/ResponseGeneratorWorker.ts` (the only external consumer) on its existing import path. One fewer file to touch, one less merge-conflict surface. The cost error re-exports already exist in `generator.ts` today; this preserves them. |
| D5 | Land the wrapper + classifier with tests in commit 1 (no behavior change). Migrate the two call sites in commit 2. | Isolates the policy-change diff (D3) from the no-op extractions. Easier rollback if behavior drift surfaces. |
| D6 | Wrapper exposes `onFinalizeError: 'propagate' \| 'log-and-return-value'` (default `'propagate'`). `generator.ts` uses default; `review-summary.ts` opts into `'log-and-return-value'`. | The cost-lifecycle policy (D3) is rightly uniform — both call sites stop calling `releaseCost` after `finalizeCost` throws. But the **error-handling** policy is genuinely caller-specific: generator surfaces finalize errors as plain `Error`s to the worker so its existing failure handling and observability apply (the error is *not* wrapped as `TransientLLMError` — that wrapping is reserved for LLM-provider transient failures inside `callLLMWithFallback`); summary is best-effort and shouldn't discard a successfully-generated value because Redis flaked on the post-LLM `INCRBY`. The knob captures this asymmetry without dragging it into the wrapper's success path. |

## 4. Files

| File | Status | Purpose |
|---|---|---|
| `src/lib/costs/cost-guard.ts` | new | `withCostGuard` HOF + `CostGuardOptions` / `CostGuardedResult<T>` types |
| `src/lib/costs/__tests__/cost-guard.test.ts` | new | Unit tests for the wrapper |
| `src/lib/responses/llm-error-classifier.ts` | new | `isTransientLLMError`, `TransientLLMError`, `safeInstanceOf` (private) |
| `src/lib/responses/__tests__/llm-error-classifier.test.ts` | new | Unit tests for the classifier |
| `src/lib/responses/generator.ts` | edit | Use `withCostGuard`; import classifier from new file; re-export `TransientLLMError` and cost error classes for backward compatibility |
| `src/lib/responses/review-summary.ts` | edit | Use `withCostGuard` with `withConcurrency: false` |
| `worker/jobs/ResponseGeneratorWorker.ts` | unchanged | Continues to import `TransientLLMError` from `@/lib/responses/generator` (re-export preserves the path) |

## 5. Interfaces

### 5.1 `withCostGuard`

```ts
// src/lib/costs/cost-guard.ts

export interface CostGuardOptions {
  businessId: string;
  subscriptionTier: string;
  /** Acquire a per-business concurrency slot. Defaults to true. */
  withConcurrency?: boolean;
  /**
   * What to do when finalizeCost itself throws (e.g. Redis transport flake)
   * AFTER fn has successfully returned a value.
   * - 'propagate' (default): log and re-throw the finalize error. Caller's
   *   value is discarded.
   * - 'log-and-return-value': log the finalize error and return fn's value
   *   anyway. The cost reservation is NOT released (per D3); it ages out
   *   via the 24h Redis TTL.
   * Note: this knob ONLY affects the post-fn-success finalize-error path.
   * Errors from reserveCost, acquireConcurrencySlot, and fn itself always
   * propagate regardless.
   */
  onFinalizeError?: 'propagate' | 'log-and-return-value';
}

export interface CostGuardedResult<T> {
  value: T;
  /** Used for finalizeCost. Caller computes from token usage. */
  actualCostCents: number;
}

export async function withCostGuard<T>(
  opts: CostGuardOptions,
  fn: () => Promise<CostGuardedResult<T>>,
): Promise<T>;
```

**Sequence:**

1. `reserveCost(businessId, subscriptionTier)`. If it throws (`CostLimitExceededError` / `GlobalCostLimitExceededError`), propagate without invoking `fn` and without entering the finally block (no cleanup needed — nothing acquired).
2. Enter the main `try` block. If `withConcurrency !== false`, `acquireConcurrencySlot(businessId)` and set `concurrencyAcquired = true`. If acquire throws, the finally block runs (`releaseCost` because `finalized` is false; concurrency cleanup skipped because the flag is still false), then the original error propagates.
3. Invoke `fn()`. If it throws, the finally block runs (releases slot if acquired, releases cost) and the original error propagates.
4. `finalizeCost(businessId, actualCostCents, reservationDate)`. **Always set `finalized = true` immediately**, both on success and inside the catch:
   - On success: `finalized = true`, return `value` after the finally runs.
   - On failure: log `[cost-guard] finalizeCost failed: …`, set `finalized = true` (suppresses `releaseCost` in the finally per D3), then branch on `onFinalizeError`:
     - `'propagate'` (default) — re-throw the finalize error. Finally runs, releasing the slot if acquired; the finalize error propagates to the caller.
     - `'log-and-return-value'` — do NOT re-throw. Finally runs, releasing the slot if acquired; the wrapper returns `value`. The fn-supplied value is preserved even though the cost-counter adjustment failed.
5. **Finally block (always runs):**
   - If `concurrencyAcquired`: `releaseConcurrencySlot(businessId)` wrapped in try/catch — failures logged, never thrown, never mask the primary error.
   - If `!finalized`: `releaseCost(businessId, reservationDate)` wrapped in try/catch — same logging discipline, same non-masking guarantee.

The wrapper propagates errors by default. The only exception is the post-`fn`-success finalize-error case when `onFinalizeError: 'log-and-return-value'` is set — there, the value survives the finalize failure. Errors from reserve, slot acquire, and `fn` itself always propagate.

**Encapsulation:** The reservation date returned by `reserveCost` is held in the wrapper's closure and never exposed to callers. Today, every call site has to thread that string through to `finalizeCost` / `releaseCost`. After the migration they don't see it.

**Internal state:** the wrapper uses two local flags: `concurrencyAcquired` (matches today's pattern in `generator.ts`) and `finalized` (gates the conditional `releaseCost` in the finally block). Both flags live entirely inside the wrapper — call sites never see them.

### 5.2 `llm-error-classifier`

```ts
// src/lib/responses/llm-error-classifier.ts

export class TransientLLMError extends Error {
  constructor(public readonly cause: unknown) {
    super(cause instanceof Error ? cause.message : String(cause));
    this.name = 'TransientLLMError';
  }
}

export function isTransientLLMError(err: unknown): boolean;
```

`safeInstanceOf` stays private. The classifier is pure — no Redis, no logging, no side effects. Same logic as today's implementation in `generator.ts:70-91`; this is an extraction, not a rewrite.

## 6. Migration shape

### 6.1 `generator.ts` — `runProductionMode`

```ts
async function runProductionMode(
  review: NormalizedReview,
  business: BusinessContext,
  voiceExamples: VoiceExample[],
  options: GenerationOptions,
): Promise<GenerationResult> {
  validateProductionOptions(options);
  const { reviewId, version, businessId, subscriptionTier } = options;

  // Cache check stays outside the wrapper — short-circuit before reserving.
  if (!options.skipCache) {
    const cached = await checkIdempotentCache(reviewId, version);
    if (cached) {
      const parsed = tryParseCachedGeneration(cached, reviewId, version);
      if (parsed) return parsed;
    }
  }

  const { llmResult, costUsd } = await withCostGuard(
    { businessId, subscriptionTier, withConcurrency: true },
    async () => {
      const prompt = buildProductionPrompt(review, business, voiceExamples);
      const llm = await callLLMWithFallback(prompt.systemPrompt, prompt.userPrompt);
      const usd = calculateCostUsd(llm.model, llm.usage.promptTokens, llm.usage.completionTokens);
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

`tryParseCachedGeneration`, `tryWriteCache`, `tryRecordApiCost` are small inline helpers in the same file — each wraps the existing best-effort try/catch from the current implementation. They are not a new abstraction; they're a way to keep `runProductionMode` flat.

The two-flag finally block (`concurrencyAcquired`, `finalized`) and the `if (!finalized) await releaseCost(...)` cleanup disappear entirely — owned by the wrapper.

**Concurrency window narrows.** Today the slot is held until *after* `setCachedGeneration` and `recordApiCost` — both happen inside the same `try` whose `finally` releases the slot (see current `generator.ts:276-285`). Under the new shape, the wrapper releases the slot the moment `finalize` returns; `tryWriteCache` and `tryRecordApiCost` then run *outside* the wrapper without holding the slot. This is intentional and arguably better — cache writes and audit inserts shouldn't block another generation for the same business — but it's a real behavior change. Listed in §8.

### 6.2 `review-summary.ts` — `generateReviewSummary`

```ts
export async function generateReviewSummary(
  reviews: ReviewForSummary[],
  businessId: string,
  subscriptionTier: string = 'standard',
): Promise<SummaryResult | null> {
  if (reviews.length === 0) return null;
  if (isMockMode()) return { summaryText: MOCK_SUMMARY, provider: 'mock', costUsd: 0 };

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
        const usd = calculateCostUsd(llm.model, llm.usage.promptTokens, llm.usage.completionTokens);
        return { value: { llm, costUsd: usd }, actualCostCents: Math.ceil(usd * 100) };
      },
    );
  } catch (err) {
    console.warn('[review-summary] Generation failed, returning null:', err instanceof Error ? err.message : err);
    return null;
  }

  await tryRecordApiCost(businessId, result.llm, result.costUsd, 'review-summary');

  return {
    summaryText: result.llm.text,
    provider: result.llm.provider,
    costUsd: result.costUsd,
  };
}
```

The outer try/catch handles cost-limit rejections and LLM failures — both still result in `null`. The new `onFinalizeError: 'log-and-return-value'` knob preserves today's behavior on the finalize-error path: a Redis flake during the post-LLM `INCRBY` no longer discards a successfully-generated summary. Net result: behavior is identical to today's `review-summary.ts`, just expressed through the wrapper instead of a hand-written try/finally.

## 7. Tests

### 7.1 `cost-guard.test.ts` (new)

Mock the five tracker functions: `reserveCost`, `acquireConcurrencySlot`, `finalizeCost`, `releaseCost`, `releaseConcurrencySlot`.

Required cases:
- Happy path with concurrency: reserve → slot → fn → finalize → release-slot. `releaseCost` never called.
- Happy path without concurrency: reserve → fn → finalize. Slot functions never called.
- `reserveCost` throws → `fn` not invoked, slot not acquired, error propagates.
- `acquireConcurrencySlot` throws → `releaseCost` called, `fn` not invoked, original `ConcurrencyLimitExceededError` propagates.
- `fn` throws → both `releaseConcurrencySlot` and `releaseCost` called, original error propagates.
- `finalizeCost` throws (default `onFinalizeError: 'propagate'`) → `releaseCost` **NOT** called, `releaseConcurrencySlot` called, finalize error propagates.
- `finalizeCost` throws + `onFinalizeError: 'log-and-return-value'` → log emitted, `releaseCost` **NOT** called, `releaseConcurrencySlot` called, wrapper returns `value` without throwing.
- **Cleanup failure cases (new — required to lock in the non-masking guarantee):**
  - `releaseConcurrencySlot` rejects on success-path cleanup → logged, does not throw, the wrapper still returns `value`.
  - `releaseConcurrencySlot` rejects after `fn` throws → logged, does not throw, the original `fn` error still propagates (cleanup failure does not mask it).
  - `releaseConcurrencySlot` rejects after `finalizeCost` throws → logged, does not throw, the original finalize error still propagates.
  - `releaseCost` rejects after `acquireConcurrencySlot` throws → logged, does not throw, the original `ConcurrencyLimitExceededError` still propagates.
  - `releaseCost` rejects after `fn` throws → logged, does not throw, the original `fn` error still propagates.
  - Both cleanups (`releaseConcurrencySlot` + `releaseCost`) reject after `fn` throws → both logged, original `fn` error still propagates, no rejection masks another.
- `actualCostCents` greater than reservation → finalize called with the larger value, no special handling.
- `actualCostCents` less than reservation → finalize called with the smaller value (negative adjustment).

### 7.2 `llm-error-classifier.test.ts` (new)

Most cases use real instances of the SDK error classes — no mocking needed for them. The `safeInstanceOf` regression case is the exception (see last bullet).

Required cases:
- Each transient OpenAI subclass: `APIConnectionError`, `APIConnectionTimeoutError`, `RateLimitError`, `InternalServerError` → true.
- Each transient Anthropic subclass: same four → true.
- Generic `OpenAI.APIError` / `Anthropic.APIError` with status 500, 502, 503, 429, 408 → true.
- Generic `APIError` with status 400, 401, 403, 404, 422 → false.
- Plain `Error` with `code: 'ETIMEDOUT' | 'ECONNRESET' | 'ECONNREFUSED' | 'EAI_AGAIN'` → true.
- `Error` with `name: 'AbortError' | 'TimeoutError'` → true.
- Arbitrary `Error` → false.
- Non-Error inputs (`null`, `undefined`, string, plain object) → false.
- **`safeInstanceOf` undefined-ctor regression** (the original bug that motivated `safeInstanceOf`): `safeInstanceOf` is a private helper and should stay private. Test it indirectly by using `vi.mock('openai', ...)` (or equivalent) to load a stubbed `openai` module whose error subclasses are missing — i.e. the SDK shape a minimal test mock might present. Then call `isTransientLLMError(new Error('boom'))` and assert it returns `false` rather than throwing `TypeError: Right-hand side of instanceof is not callable`. The test asserts the contract (no crash) without exporting the helper.

### 7.3 Existing tests

`generator.ts` and `review-summary.ts` tests should largely pass unchanged. The wrapper calls the same five tracker functions, and the per-function call counts and arguments are preserved on the happy path.

Two ordering changes that may surface in existing tests:

- **Concurrency-slot release timing.** Today's `generator.ts` releases the slot after `setCachedGeneration` and `recordApiCost` (per current `generator.ts:276-285`). The wrapper releases it earlier, before `tryWriteCache` and `tryRecordApiCost` (see §6.1 "Concurrency window narrows"). Any test that asserts slot release happens *after* cache or audit will fail and must be updated to reflect the new (intentional) ordering.
- **Finalize-error path.** Tests covering the case where `finalizeCost` throws will need updates per §7.4 below.

### 7.4 Call-site finalize-error tests (new — pin the chosen behavior)

The wrapper's own tests (§7.1) prove that the wrapper does the right thing on finalize-error. The intentional behavior change lives at the *call sites*, so we pin it there too.

For `generator.ts` (`runProductionMode`):
- `finalizeCost` rejects → no `releaseCost` call observed; `releaseConcurrencySlot` *is* observed; `runProductionMode` rejects with the original finalize error; `setCachedGeneration` and `recordApiCost` are *not* called (post-finalize bookkeeping is skipped because the wrapper threw before returning).
- `finalizeCost` rejects with a transient-shaped Redis/network error → propagates as a plain `Error` (the original finalize error). It is **not** wrapped as `TransientLLMError` — that wrapping is reserved for LLM-provider failures inside `callLLMWithFallback`. The worker's existing failure handling decides retry vs terminal behavior on the same path it uses for any other non-LLM error.

For `review-summary.ts` (`generateReviewSummary`) (uses `onFinalizeError: 'log-and-return-value'`):
- `finalizeCost` rejects → wrapper logs and returns the generated value; `releaseCost` is *not* called; `releaseConcurrencySlot` is not invoked (concurrency disabled for review-summary); `recordApiCost` *is* called (post-wrapper bookkeeping runs); function returns the `SummaryResult`. **Behavior matches today's `review-summary.ts`** — pinned by this test so a future change to `onFinalizeError` defaulting can't silently regress it.
- `reserveCost` rejects (cost limit) → outer try/catch returns `null`. Unchanged from today.
- LLM call inside `fn` rejects → outer try/catch returns `null`. Unchanged from today.

For both call sites:
- `releaseCost` rejecting during cleanup (after a `fn` failure) does not change the propagated error or mask it — same guarantee as the wrapper unit tests, exercised end-to-end through the call site.

## 8. Risks

1. **Behavior change in `generator.ts` finalize-error path** *(intentional, per D3).* Today, `generator.ts` calls `releaseCost` when `finalizeCost` throws (the `finalized` flag stays false; finally runs release). After the migration it skips the release. Net effect: under Redis flake during finalize, generator.ts under-counts less and over-counts more. Bounded by the 24h TTL. The wrapper still propagates the finalize error so the worker treats it as a failure (existing retry/terminal-fail behavior unchanged). **Action:** call this out in the migration commit message so reviewers don't read it as a regression.
2. **`review-summary.ts` finalize-error path preserved via knob.** The wrapper exposes `onFinalizeError: 'propagate' | 'log-and-return-value'` (default `'propagate'`). `review-summary.ts` opts into `'log-and-return-value'` so finalize-errors no longer discard the generated summary — same behavior as today's hand-written try/finally. `generator.ts` keeps the default ('propagate') because the worker layer needs to see finalize failures for retry / observability. **No behavior change for review-summary.** The cost is one extra option on the wrapper interface — judged worth it because the policy difference between callers is real (best-effort summary vs. critical-path generation).
3. **Concurrency window narrows in `generator.ts`** *(intentional).* Today the slot is held until after `setCachedGeneration` and `recordApiCost` (see current `generator.ts:276-285`); after the migration the wrapper releases it before those bookkeeping calls. This unblocks concurrent generations for the same business slightly earlier. Tests that assert on slot-release ordering relative to cache/audit will need updates (see §7.3).
4. **Re-export coupling.** `generator.ts` re-exports four error classes (cost limits + `TransientLLMError`). If a future refactor moves them again, the re-export hides the move from consumers — useful for now, mild tech debt later. Acceptable.
5. **Test mock contracts.** Existing tests that mock the tracker module by intercepting individual function calls will continue to work (the wrapper calls the same functions). Tests that mock by *replacing the module* with a stub of unknown shape might break — none observed in the survey, but worth checking during implementation.
6. **`review-summary.ts` log-line collapse.** Today the function emits two distinct log prefixes — `[review-summary] Cost reservation failed, skipping summary` for cost-limit rejections (line 153) and `[review-summary] Summary generation failed` for everything else (line 197). The migration in §6.2 collapses these into one outer `catch` with a single log line. Behavior (return `null` on either path) is unchanged; only log text differs. Keep both prefixes if log-grep tooling depends on them — trivial to retain via an `instanceof CostLimitExceededError` check in the catch.

## 9. Migration plan

Two commits on a single branch:

**Commit 1 — extractions (no behavior change):**
- Add `src/lib/costs/cost-guard.ts` and its tests.
- Add `src/lib/responses/llm-error-classifier.ts` and its tests.
- Run `pnpm test` — new tests pass, all existing tests pass.
- Do not touch `generator.ts` or `review-summary.ts` yet.

**Commit 2 — migration (intentional behavior changes):**
- Update `generator.ts`: use `withCostGuard` (default `onFinalizeError: 'propagate'`), import classifier from new file, re-export `TransientLLMError` and the four cost error classes from their new locations.
- Update `review-summary.ts`: use `withCostGuard` with `withConcurrency: false` and `onFinalizeError: 'log-and-return-value'`.
- Add the call-site finalize-error tests from §7.4.
- Run `pnpm test`, `pnpm lint`, `pnpm tsc --noEmit` — all green.
- Commit message body explicitly enumerates the two intentional behavior changes that survive (§8 risks 1 and 3): no-release-after-finalize-error in generator (D3); narrowed concurrency window in generator. `review-summary` behavior is unchanged thanks to the `onFinalizeError` knob.

Optional **Commit 3 — cleanup:**
- If the `tryParseCachedGeneration` / `tryWriteCache` / `tryRecordApiCost` inline helpers in `generator.ts` end up duplicated with `review-summary.ts`'s audit helper, consolidate. Skip if no duplication emerges.

Rollback: revert commit 2; commit 1 is a no-op extraction and can stay.

## 10. Open questions

None. Q1 (the `review-summary.ts` finalize-error path) was resolved on 2026-05-03 in favor of option (b) — adding the `onFinalizeError` knob. Spec updated throughout.
