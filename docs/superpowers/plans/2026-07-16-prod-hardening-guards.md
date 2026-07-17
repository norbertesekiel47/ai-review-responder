# Production Hardening Guards Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Land the seven low-blast-radius production guards (P1, P2, P3, P5, P6, P7, P10) from the pre-production review: crash-proof the zernio failed-hook, bound the Supabase admin client, retry transient guardrail-regen failures, add EventEmitter error listeners, set Fastify ingress limits, close two health-alert blind spots, and let the dashboard degrade per-widget.

**Architecture:** Each fix is an isolated guard following an existing in-repo template (publisher failed-hook wrap, cleanup-poller timeout, primary-path transient re-throw, health-alert check shape). No schema changes, no new env vars, one small new module (`worker/emitter-errors.ts`).

**Tech Stack:** TypeScript strict, Vitest, BullMQ, Fastify, Postgres.js, @supabase/supabase-js, Sentry.

**Spec:** `docs/superpowers/specs/2026-07-16-prod-hardening-guards-design.md`

**Worktree:** `/Users/norbertesekiel/Developer/startups/RepWorth-worktrees/fix-prod-hardening-guards` — ALL paths below are relative to this root. Never edit the parent checkout.

**Conventions that apply to every task:**
- Run tests with `pnpm vitest run <path>` from the worktree root.
- Commit after each task with the message given in its final step (append the standard `Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>` trailer).
- Match surrounding comment density; comments explain "why", never "what".

---

### Task 1: P1 — Crash-proof `handleIngestFailed`

**Files:**
- Modify: `worker/jobs/zernio/ingest-failed-hook.ts`
- Test: `worker/jobs/zernio/__tests__/ingest-failed-hook.test.ts` (extend)

The hook is wired as a bare `'failed'` listener (`worker/index.ts:172`); any throw becomes an unhandled rejection and the crash-net treats non-DB errors as fatal. Mirror the sibling pattern in `worker/jobs/publisher/failed-hook.ts:168-198` (`handlePublisherFailed` + `capturePublisherFailedHookCrash`): track the outbox handle in a small state object, wrap the whole body, capture to Sentry, best-effort `markOutboxFailed`, never re-throw.

- [ ] **Step 1: Write the failing tests**

Append to the existing `describe` block in `worker/jobs/zernio/__tests__/ingest-failed-hook.test.ts` (the file already mocks `sql`, `markOutboxFailed`, `extractOutboxHandle`, and `@sentry/node` — reuse those mocks; import `* as Sentry from '@sentry/node'` to assert on the mocked `captureException`):

```ts
describe('last-resort crash guard', () => {
  it('resolves without rejecting when the review_exceptions INSERT throws, captures to Sentry, and best-effort fails the outbox row', async () => {
    // First sql call (the INSERT inside handleReviewNotFound) rejects.
    mockSql.mockImplementationOnce(() => Promise.reject(new Error('pgbouncer down')));
    const job = makeJob();
    await expect(
      handleIngestFailed(mockSql, job, new ZernioIngestReviewNotFoundError('biz-1', 'acct-1', 'loc-1', 'rev-abc', 1, 0)),
    ).resolves.toBeUndefined();
    expect(vi.mocked(Sentry.captureException)).toHaveBeenCalledWith(
      expect.any(Error),
      expect.objectContaining({ tags: { worker: 'ingest_zernio_review', kind: 'on_failed_handler_crash' } }),
    );
    // Best-effort terminal close so the row doesn't sit in `dispatched` limbo.
    expect(mockMarkOutboxFailed).toHaveBeenCalledWith(
      mockSql, 'outbox-1', expect.stringContaining('on_failed_crash'), 1,
    );
  });

  it('resolves without rejecting even when the best-effort markOutboxFailed also throws', async () => {
    mockSql.mockImplementationOnce(() => Promise.reject(new Error('insert failed')));
    mockMarkOutboxFailed.mockRejectedValueOnce(new Error('mark failed too'));
    await expect(
      handleIngestFailed(mockSql, makeJob(), new ZernioIngestReviewNotFoundError('biz-1', 'acct-1', 'loc-1', 'rev-abc', 1, 0)),
    ).resolves.toBeUndefined();
  });
});
```

Adjust the `ZernioIngestReviewNotFoundError` constructor args to match its actual signature in `ZernioReviewIngestWorker.ts` (read it first); the existing tests in this file construct it already — copy their call shape.

- [ ] **Step 2: Run tests to verify the new ones fail**

Run: `pnpm vitest run worker/jobs/zernio/__tests__/ingest-failed-hook.test.ts`
Expected: the two new tests FAIL (the first with an unhandled rejection / rejected promise), all pre-existing tests PASS.

- [ ] **Step 3: Implement the wrap**

In `worker/jobs/zernio/ingest-failed-hook.ts`, rename the current body of `handleIngestFailed` to a private `dispatchIngestExhaustion` and add the guard (mirrors `failed-hook.ts:168-198`):

```ts
export async function handleIngestFailed(
  sql: Sql,
  job: Job<IngestZernioReviewPayload> | undefined,
  err: unknown,
): Promise<void> {
  // Top-level guard: this runs as a bare Worker 'failed' listener, so any
  // throw here becomes an unhandled rejection — which the crash-net treats
  // as fatal for non-transient-DB errors. One review's failure bookkeeping
  // must never take down all queues. Mirrors handlePublisherFailed.
  const state: { outboxId?: string; outboxAttempt?: number } = {};
  try {
    if (!job) return;
    if (job.attemptsMade < (job.opts.attempts ?? 5)) return; // not yet exhausted

    const handle = extractOutboxHandle(job.data, job.id!);
    state.outboxId = handle.outboxId;
    state.outboxAttempt = handle.attempt;
    await dispatchIngestExhaustion(sql, job, err, state.outboxId, state.outboxAttempt);
  } catch (handlerErr) {
    await captureIngestFailedHookCrash(sql, state, handlerErr);
  }
}

async function dispatchIngestExhaustion(
  sql: Sql,
  job: Job<IngestZernioReviewPayload>,
  err: unknown,
  outboxId: string,
  outboxAttempt: number | undefined,
): Promise<void> {
  if (err instanceof ZernioIngestReviewNotFoundError) {
    await handleReviewNotFound(sql, err, outboxId, outboxAttempt);
    return;
  }
  if (err instanceof ZernioIngestPaginationCapExhaustedError) {
    await handlePaginationCapExhausted(sql, err, outboxId, outboxAttempt);
    return;
  }
  if (err instanceof ZernioIngestUnparseableLocationError) {
    await handleUnparseableLocation(sql, err, outboxId, outboxAttempt);
    return;
  }
  // Anything else: bare markOutboxFailed (existing behavior).
  const reason = err instanceof Error ? err.message : String(err);
  await markOutboxFailed(sql, outboxId, reason, outboxAttempt);
}

async function captureIngestFailedHookCrash(
  sql: Sql,
  state: { outboxId?: string; outboxAttempt?: number },
  handlerErr: unknown,
): Promise<void> {
  // This IS the last-resort catch — nothing in here may throw. (Hardened vs
  // the publisher template, which leaves the Sentry call unguarded.)
  try {
    console.error('[ingestZernioReviewWorker.on(failed)] handler crashed:', handlerErr);
    Sentry.captureException(handlerErr, {
      tags: { worker: 'ingest_zernio_review', kind: 'on_failed_handler_crash' },
    });
  } catch {
    // Swallow: even a Sentry/logging failure must not re-throw here.
  }
  if (!state.outboxId) return;
  const reason = handlerErr instanceof Error ? handlerErr.message : String(handlerErr);
  await markOutboxFailed(sql, state.outboxId, `on_failed_crash: ${reason}`, state.outboxAttempt).catch((markErr) => {
    console.error('[ingestZernioReviewWorker.on(failed)] best-effort markOutboxFailed failed:', markErr);
  });
}
```

Keep the existing JSDoc on `handleIngestFailed`. The `job.data`/`job.id!` reads and the three per-error handlers are unchanged.

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm vitest run worker/jobs/zernio/__tests__/ingest-failed-hook.test.ts`
Expected: ALL tests PASS (new + pre-existing).

- [ ] **Step 5: Commit**

```bash
git add worker/jobs/zernio/ingest-failed-hook.ts worker/jobs/zernio/__tests__/ingest-failed-hook.test.ts
git commit -m "fix(worker): crash-proof zernio ingest failed-hook (P1)"
```

---

### Task 2: P2 — Bound the Supabase admin/storage client

**Files:**
- Modify: `src/lib/db/server.ts:63-70`
- Test: Create `src/lib/db/__tests__/supabase-fetch-timeout.test.ts`

- [ ] **Step 1: Write the failing test**

The client is created at module scope, so test the exported fetch wrapper directly. Create `src/lib/db/__tests__/supabase-fetch-timeout.test.ts`:

```ts
import { describe, it, expect, vi } from 'vitest';

vi.mock('postgres', () => ({ default: vi.fn(() => Object.assign(vi.fn(), { json: vi.fn() })) }));

import { boundedSupabaseFetch, SUPABASE_FETCH_TIMEOUT_MS } from '../server';

describe('boundedSupabaseFetch', () => {
  it('attaches a timeout signal when the caller passes none', async () => {
    const inner = vi.fn().mockResolvedValue(new Response('ok'));
    vi.stubGlobal('fetch', inner);
    await boundedSupabaseFetch('https://example.test/auth/v1/admin', { method: 'POST' });
    const init = inner.mock.calls[0][1] as RequestInit;
    expect(init.signal).toBeInstanceOf(AbortSignal);
    vi.unstubAllGlobals();
  });

  it('rejects within the bound instead of hanging forever', async () => {
    vi.stubGlobal('fetch', (input: RequestInfo | URL, init?: RequestInit) =>
      new Promise((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => reject(init.signal!.reason));
      }));
    vi.useFakeTimers();
    const pending = boundedSupabaseFetch('https://example.test/storage/v1/object', {});
    const assertion = expect(pending).rejects.toMatchObject({ name: 'TimeoutError' });
    await vi.advanceTimersByTimeAsync(SUPABASE_FETCH_TIMEOUT_MS + 1);
    await assertion;
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });
});
```

Note: `AbortSignal.timeout` uses real timers in some Node versions even under fake timers; if the second test is flaky, replace it with a real-timer variant using a small injected timeout — but first try as written. The `postgres` mock prevents the module-scope Postgres.js client from needing `DATABASE_POOL_URL`; if the module still requires `SUPABASE_URL`/`SUPABASE_SERVICE_KEY` at import, set them via `vi.stubEnv` before the import (use a dynamic `await import` inside the test file after stubbing).

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run src/lib/db/__tests__/supabase-fetch-timeout.test.ts`
Expected: FAIL — `boundedSupabaseFetch` is not exported.

- [ ] **Step 3: Implement**

In `src/lib/db/server.ts`, replace lines 63-70 (the Supabase client block) with:

```ts
// ---------------------------------------------------------------------------
// Supabase server client — auth admin, storage, server-side reads
// Uses the service-role key. NEVER import in browser/client components.
// ---------------------------------------------------------------------------

/**
 * Every auth.admin.* / storage.* call is otherwise UNBOUNDED — supabase-js
 * exposes no per-call timeout, and a hung call from a worker job holds its
 * BullMQ slot forever (BullMQ auto-renews the lock). 10s matches the
 * CleanupAbandonedSignupsPoller's existing Promise.race bound. A caller-
 * provided signal still wins (composed via AbortSignal.any) so streaming/
 * cancellable calls keep their own semantics.
 */
export const SUPABASE_FETCH_TIMEOUT_MS = 10_000;

export function boundedSupabaseFetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  const timeoutSignal = AbortSignal.timeout(SUPABASE_FETCH_TIMEOUT_MS);
  const signal = init?.signal ? AbortSignal.any([init.signal, timeoutSignal]) : timeoutSignal;
  return fetch(input, { ...init, signal });
}

export const supabaseServer = createClient(
  process.env.SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_KEY!,
  { global: { fetch: boundedSupabaseFetch } },
);
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm vitest run src/lib/db/__tests__/supabase-fetch-timeout.test.ts`
Expected: PASS. Also run `pnpm vitest run worker/background/pollers/__tests__/CleanupAbandonedSignupsPoller.test.ts` — its own 10s race must still pass.

- [ ] **Step 5: Commit**

```bash
git add src/lib/db/server.ts src/lib/db/__tests__/supabase-fetch-timeout.test.ts
git commit -m "fix(db): bound supabase admin/storage client fetch at 10s (P2)"
```

---

### Task 3: P3 — Retry transient failures during the avoid-facts guardrail regen

**Files:**
- Modify: `worker/jobs/response-generation/generate-draft.ts` (inner catch ~`:248-258`, outer catch ~`:166-177`)
- Modify: `.claude/CLAUDE.md` (the anti-respend sentence in the cost-guard gotcha, ~line 173)
- Test: `worker/jobs/response-generation/__tests__/generate-draft.test.ts` (extend)

**Owner decision (spec §P3):** ALL THREE transient classes re-throw from the guardrail lane — `TransientLLMError`, `ConcurrencyLimitExceededError`, AND `CostInfraUnavailableError`. This deliberately overrides the previous anti-respend carve-out; the accepted trade-off is documented in the spec. Cost-cap errors keep their existing alert+terminal handling; violation-persists and generic errors stay terminal `guardrail_failed`.

Retry behavior note (for the code comment): on retry the primary generation hits the idempotent cache (the polluted first draft — the cache overwrite only happens after a successful regen), so the retry re-runs only the regen call. Each attempt burns one regen-budget slot; bounded by the `generate_response` queue's BullMQ attempts budget. **Do not hardcode the attempts number** in comments or the CLAUDE.md gotcha — a parallel workstream is changing it (3 → 5 for LLM-bound queues); phrase it as "the queue's attempts budget" (see the deviations log).

- [ ] **Step 1: Read the existing test harness**

Read `worker/jobs/response-generation/__tests__/generate-draft.test.ts` fully. It already exercises the guardrail path (avoid-facts violation → regenerate) and the primary-path transient re-throws. Reuse its mocks for `generateResponse`, business context fixtures, and error classes.

- [ ] **Step 2: Write the failing tests**

Add a describe block. The shape below is canonical — adapt fixture/mock names to the file's existing helpers:

```ts
describe('guardrail regen transient errors', () => {
  it.each([
    ['TransientLLMError', () => new TransientLLMError('openai 503')],
    ['CostInfraUnavailableError', () => new CostInfraUnavailableError('upstash down')],
    ['ConcurrencyLimitExceededError', () => new ConcurrencyLimitExceededError('slots full')],
  ])('re-throws %s from the regen call so BullMQ retries', async (_name, make) => {
    // First generateResponse call: violating draft. Second (regen): transient throw.
    mockGenerateResponse
      .mockResolvedValueOnce(violatingDraftResult)
      .mockRejectedValueOnce(make());
    await expect(runGenerateDraft(/* fixture args */)).rejects.toBeInstanceOf(make().constructor);
  });

  it('still returns terminal guardrail_failed when the regenerated draft violates again', async () => {
    mockGenerateResponse
      .mockResolvedValueOnce(violatingDraftResult)
      .mockResolvedValueOnce(violatingDraftResult);
    const outcome = await runGenerateDraft(/* fixture args */);
    expect(outcome).toMatchObject({ kind: 'failed', reason: expect.stringContaining('guardrail_failed') });
  });
});
```

If the file already has a violation-persists test, keep it and only add the three transient cases.

- [ ] **Step 3: Run tests to verify the new ones fail**

Run: `pnpm vitest run worker/jobs/response-generation/__tests__/generate-draft.test.ts`
Expected: the three transient cases FAIL (currently resolve to `{ kind: 'failed', reason: 'guardrail_failed: …' }`); everything else PASSES.

- [ ] **Step 4: Implement — inner catch**

In `applyAvoidFactsGuardrail` (`generate-draft.ts`, catch at ~`:248-258`), replace the catch body:

```ts
  } catch (err) {
    // Cost-cap (budget) exhaustion during the retry must propagate UNCHANGED so
    // the caller's cost-cap handler alerts + fails it (not wrap as a generic
    // guardrail failure).
    if (isCostCapError(err)) throw err;
    // Transient failures during the regen call propagate UNCHANGED so the outer
    // handler re-throws them for BullMQ retry — an OpenAI 503 here must not
    // silently drop a draft the owner paid for. On retry the primary call hits
    // the idempotent cache (polluted first draft), so only the regen re-runs;
    // each attempt burns one regen-budget slot, bounded by the queue's BullMQ
    // attempts budget.
    // (Owner decision 2026-07-16: includes CostInfraUnavailableError, replacing
    // the earlier anti-respend carve-out — see the prod-hardening-guards spec.)
    if (
      err instanceof TransientLLMError ||
      err instanceof CostInfraUnavailableError ||
      err instanceof ConcurrencyLimitExceededError
    ) {
      throw err;
    }
    // Retry failed or still violates — do NOT fall back to the violating draft.
    // Throw so the worker marks this as failed and creates a review exception.
    const message = err instanceof Error ? err.message : String(err);
    throw new Error(`Avoid-fact guardrail failed for review ${ids.reviewId}: ${message}`);
  }
```

(The three error classes are already imported at the top of the file for the primary path.)

- [ ] **Step 5: Implement — outer catch**

In `generateDraft`'s guardrail catch (~`:166-177`), insert the pass-through between the cost-cap branch and the terminal fallthrough:

```ts
    if (isCostCapError(err)) {
      logger.warn(`Cost limit exceeded for business ${businessId} during avoid-facts guardrail retry: ${err.message}`);
      alertCostCapExhausted(err, businessId, reviewId, version);
      return { kind: 'failed', reason: err.message };
    }
    if (
      err instanceof TransientLLMError ||
      err instanceof CostInfraUnavailableError ||
      err instanceof ConcurrencyLimitExceededError
    ) {
      logger.warn(`Transient failure during avoid-facts guardrail for review ${reviewId} (will retry): ${err.message}`);
      throw err;
    }
    const message = err instanceof Error ? err.message : String(err);
    logger.error(`Avoid-facts guardrail failed for review ${reviewId}: ${message}`);
    return { kind: 'failed', reason: `guardrail_failed: ${message}` };
```

Also update the block comment above this try (~`:149-154`, "Guardrail errors … must mark the outbox failed — not throw") to say transient regen failures now re-throw for retry while config-caused failures stay terminal.

- [ ] **Step 6: Update the CLAUDE.md gotcha**

In `.claude/CLAUDE.md`, find the parenthetical `(Edge case: a `CostInfraUnavailableError` raised during the avoid-facts guardrail RETRY stays terminal as `guardrail_failed` by design — anti-respend.)` and replace it with:

```
(The avoid-facts guardrail RETRY re-throws all three transient classes — `TransientLLMError`, `ConcurrencyLimitExceededError`, `CostInfraUnavailableError` — for BullMQ retry; on retry the primary hits the idempotent cache so only the regen re-runs. Owner-accepted trade-off 2026-07-16: a Redis outage during the guardrail can re-spend, bounded by the queue's BullMQ attempts budget.)
```

- [ ] **Step 7: Run tests to verify they pass**

Run: `pnpm vitest run worker/jobs/response-generation/`
Expected: ALL PASS (including `auto-approval.test.ts` etc. — the guardrail is on their path).

- [ ] **Step 8: Commit**

```bash
git add worker/jobs/response-generation/generate-draft.ts worker/jobs/response-generation/__tests__/generate-draft.test.ts .claude/CLAUDE.md
git commit -m "fix(worker): retry transient guardrail-regen failures instead of dropping drafts (P3)"
```

---

### Task 4: P5 — `'error'` listeners on Workers, Queues, and the probe Redis client

**Files:**
- Create: `worker/emitter-errors.ts`
- Modify: `worker/index.ts` (worker loop ~`:317-327`, probe client ~`:406-410`)
- Modify: `worker/queues.ts` (after the `queues` object)
- Test: Create `worker/__tests__/emitter-errors.test.ts`

- [ ] **Step 1: Write the failing test**

Create `worker/__tests__/emitter-errors.test.ts` (check whether `worker/__tests__/` exists; if worker tests live elsewhere — e.g. colocated `__tests__` dirs per subfolder — follow that layout; `worker/config/__tests__/` style is fine too):

```ts
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { EventEmitter } from 'node:events';

const { mockCaptureMessage } = vi.hoisted(() => ({ mockCaptureMessage: vi.fn() }));
vi.mock('@sentry/node', () => ({ captureMessage: mockCaptureMessage }));

import { attachEmitterErrorLogger } from '../emitter-errors';

describe('attachEmitterErrorLogger', () => {
  beforeEach(() => vi.clearAllMocks());

  it('consumes error events without throwing and captures a Sentry warning', () => {
    const emitter = new EventEmitter();
    attachEmitterErrorLogger(emitter, 'queue:generate_response');
    // Without a listener this emit would throw (unhandled 'error' event).
    expect(() => emitter.emit('error', new Error('redis blip'))).not.toThrow();
    expect(mockCaptureMessage).toHaveBeenCalledWith(
      'worker_emitter_error',
      expect.objectContaining({
        level: 'warning',
        tags: expect.objectContaining({ source: 'queue:generate_response' }),
      }),
    );
  });

  it('never throws even if Sentry capture itself throws', () => {
    mockCaptureMessage.mockImplementationOnce(() => { throw new Error('sentry down'); });
    const emitter = new EventEmitter();
    attachEmitterErrorLogger(emitter, 'probe_redis');
    expect(() => emitter.emit('error', new Error('boom'))).not.toThrow();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run worker/__tests__/emitter-errors.test.ts`
Expected: FAIL — module does not exist.

- [ ] **Step 3: Implement the helper**

Create `worker/emitter-errors.ts`:

```ts
// Non-fatal 'error' sink for BullMQ Workers/Queues and raw ioredis clients.
// An EventEmitter 'error' with no listener becomes uncaughtException, which
// is ALWAYS fatal (worker/index.ts crash-net) — so a transient Railway Redis
// blip would restart the whole worker. Route these through structured logging
// + a Sentry warning instead; BullMQ reconnects on its own.
import * as Sentry from '@sentry/node';
import { createWorkerLogger } from '../src/lib/shared/logger';

const logger = createWorkerLogger('emitter-error');

interface ErrorEmitting {
  on(event: 'error', listener: (err: Error) => void): unknown;
}

export function attachEmitterErrorLogger(emitter: ErrorEmitting, source: string): void {
  emitter.on('error', (err: Error) => {
    // An error listener must never throw — that WOULD be an uncaughtException.
    try {
      logger.warn(`${source} emitted error: ${err.message}`);
      Sentry.captureMessage('worker_emitter_error', {
        level: 'warning',
        tags: { subsystem: 'worker_emitter', source },
        extra: { message: err.message, stack: err.stack },
      });
    } catch {
      // Swallow: last-resort sink.
    }
  });
}
```

Check `createWorkerLogger`'s exact signature in `src/lib/shared/logger.ts` first (prefix + optional correlationId) and adapt the call if needed.

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm vitest run worker/__tests__/emitter-errors.test.ts`
Expected: PASS.

- [ ] **Step 5: Wire it up**

In `worker/index.ts`, extend the existing Sentry-breadcrumb loop over `workers` (~`:317-327`):

```ts
for (const [queueName, worker] of Object.entries(workersByQueue)) {
  attachEmitterErrorLogger(worker, `worker:${queueName}`);
}
```

(Keep the existing breadcrumb loop; add this as a sibling loop or fold both into one — one loop over `Object.entries(workersByQueue)` is cleaner since it also gives the name.)

In the readiness probe block (~`:406-410`), attach at creation:

```ts
  const getQueueProbeRedis = (): Redis => {
    if (!queueProbeRedis) {
      queueProbeRedis = new Redis(getRedisOptions());
      attachEmitterErrorLogger(queueProbeRedis, 'probe_redis');
    }
    return queueProbeRedis;
  };
```

In `worker/queues.ts`, after the `queues` object literal (line ~74):

```ts
// Queues emit 'error' on Redis connection failures; without a listener that
// escalates to a fatal uncaughtException. See worker/emitter-errors.ts.
for (const queue of Object.values(queues)) {
  attachEmitterErrorLogger(queue, `queue:${queue.name}`);
}
```

with `import { attachEmitterErrorLogger } from './emitter-errors';` at the top. NOTE: `queues.ts` is imported by tests and by `OutboxPoller` — the helper must stay side-effect-light (it is: one listener per queue, no I/O at import).

- [ ] **Step 6: Verify worker boots + full worker tests**

Run: `pnpm vitest run worker/ && pnpm typecheck`
Expected: PASS. (The worker boot path is not unit-bootable locally without Redis; typecheck + tests are the gate here, staging smoke covers boot.)

- [ ] **Step 7: Commit**

```bash
git add worker/emitter-errors.ts worker/__tests__/emitter-errors.test.ts worker/index.ts worker/queues.ts
git commit -m "fix(worker): non-fatal error listeners on BullMQ workers/queues and probe redis (P5)"
```

---

### Task 5: P6 — Fastify ingress timeouts and body limit

**Files:**
- Modify: `worker/index.ts:138` (Fastify creation)
- Test: Create `worker/config/__tests__/fastify-options.test.ts` and extract options to `worker/config/fastify-options.ts`

- [ ] **Step 1: Write the failing test**

Create `worker/config/__tests__/fastify-options.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { buildFastifyOptions } from '../fastify-options';

describe('buildFastifyOptions', () => {
  it('bounds slow-loris and oversized-body ingress', () => {
    const opts = buildFastifyOptions('production');
    expect(opts.requestTimeout).toBe(30_000);
    expect(opts.keepAliveTimeout).toBe(60_000);
    expect(opts.connectionTimeout).toBe(10_000);
    expect(opts.bodyLimit).toBe(5 * 1024 * 1024);
    expect(opts.logger).toEqual({ level: 'warn' });
  });

  it('keeps info logging outside production', () => {
    expect(buildFastifyOptions('development').logger).toEqual({ level: 'info' });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run worker/config/__tests__/fastify-options.test.ts`
Expected: FAIL — module does not exist.

- [ ] **Step 3: Implement**

Create `worker/config/fastify-options.ts`:

```ts
import type { FastifyServerOptions } from 'fastify';

/**
 * Ingress server limits. Fastify's defaults leave requestTimeout at 0
 * (disabled) and no explicit body cap — a slow-loris or slow-body client
 * could exhaust the single Railway worker's connections and block
 * Stripe/Zernio webhooks. Values are owner-selected (prod-hardening spec):
 * 30s request / 60s keep-alive / 10s connect, 5 MB body (headroom for batch
 * Zernio payloads; webhooks are otherwise small).
 */
export function buildFastifyOptions(nodeEnv: string | undefined): FastifyServerOptions {
  return {
    logger: { level: nodeEnv === 'production' ? 'warn' : 'info' },
    requestTimeout: 30_000,
    keepAliveTimeout: 60_000,
    connectionTimeout: 10_000,
    bodyLimit: 5 * 1024 * 1024,
  };
}
```

In `worker/index.ts:138` replace the creation line:

```ts
export const app = Fastify(buildFastifyOptions(process.env.NODE_ENV));
```

with `import { buildFastifyOptions } from './config/fastify-options';` added to the imports.

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm vitest run worker/config/ && pnpm typecheck`
Expected: PASS. Also run any ingress route tests (`pnpm vitest run worker/ingress/`) — they build the app via the harness and must still pass.

- [ ] **Step 5: Commit**

```bash
git add worker/config/fastify-options.ts worker/config/__tests__/fastify-options.test.ts worker/index.ts
git commit -m "fix(worker): bound fastify ingress timeouts and body size (P6)"
```

---

### Task 6: P7 — Health-alert blind spots

**Files:**
- Modify: `worker/background/pollers/health-alert/checks.ts`
- Test: `worker/background/pollers/health-alert/__tests__/checks.test.ts` (extend)

- [ ] **Step 1: Write the failing tests**

Extend `checks.test.ts` (it already has a `mockSql` + config mock harness — reuse):

```ts
describe('checkFailedOutboxByTopic — generate_response coverage', () => {
  it('raises a finding for terminal generate_response failures', async () => {
    queueSqlResult([{ topic: 'generate_response', count: 2 }]);
    const findings = await checkFailedOutboxByTopic(mockSqlClient, cfg);
    expect(findings).toHaveLength(1);
    expect(findings[0].key).toBe('outbox_failed:generate_response');
  });
});

describe('checkFailedInboundEvents', () => {
  it('raises one finding per failing source', async () => {
    queueSqlResult([{ source: 'stripe', count: 3 }, { source: 'zernio', count: 1 }]);
    const findings = await checkFailedInboundEvents(mockSqlClient, cfg);
    expect(findings).toHaveLength(2);
    expect(findings[0]).toMatchObject({
      key: 'inbound_events_failed:stripe',
      level: 'error',
    });
  });

  it('returns nothing when counts are within threshold', async () => {
    queueSqlResult([]);
    expect(await checkFailedInboundEvents(mockSqlClient, cfg)).toEqual([]);
  });
});
```

Adapt `queueSqlResult`/`mockSqlClient`/`cfg` to the file's actual helper names. Also extend the existing `runHealthChecks` test to expect the new check's result included (the harness queues one result per check in order — add one more queued result).

For the `generate_response` coverage: the mock returns whatever rows are queued regardless of the SQL text, so ALSO add an SQL-text assertion if the harness captures query fragments (check how existing tests assert topic filtering; if they don't, the row-driven test above is the file's established level of rigor — match it).

- [ ] **Step 2: Run tests to verify the new ones fail**

Run: `pnpm vitest run worker/background/pollers/health-alert/__tests__/checks.test.ts`
Expected: `checkFailedInboundEvents` tests FAIL (not exported); runHealthChecks count test FAILS.

- [ ] **Step 3: Implement**

In `checks.ts`:

1. Widen the topic filter in `checkFailedOutboxByTopic` (line ~54) and its doc comment:

```ts
// Public-path outbox topics that exhausted all retries (status='failed') — a
// failed publish/notify is a customer-visible stall, and a terminal
// generate_response failure is a dropped paid draft. Not transient blips.
```
```ts
      AND topic IN (${QUEUE_NAMES.PUBLISH_RESPONSE}, ${QUEUE_NAMES.SEND_NOTIFICATION}, ${QUEUE_NAMES.GENERATE_RESPONSE})
```

2. Add the new check after `checkZeroDeliveryNotifications`:

```ts
// Inbound webhook events that failed processing. Provider-side retries
// (Stripe retries ~3 days) mask these — by the time the provider gives up,
// the bug has been silent for days. Grouped by source so one noisy provider
// doesn't hide another. Uses the partial index idx_ie_status
// (WHERE status != 'processed').
export async function checkFailedInboundEvents(sql: postgres.Sql, cfg: HealthAlertConfig): Promise<HealthFinding[]> {
  const rows = await sql<{ source: string; count: number }[]>`
    SELECT source, COUNT(*)::int AS count
    FROM inbound_events
    WHERE status = 'failed'
      AND received_at > NOW() - make_interval(secs => ${cfg.failedWindowS})
    GROUP BY source
  `;
  return rows
    .filter((r) => r.count > cfg.failedThreshold)
    .map((r) => ({
      key: `inbound_events_failed:${r.source}`,
      level: 'error' as const,
      title: `${r.count} inbound ${r.source} event(s) failed processing in the last ${cfg.failedWindowS}s`,
      detail: { source: r.source, count: r.count, window_s: cfg.failedWindowS },
    }));
}
```

3. Add `checkFailedInboundEvents(sql, cfg)` to the `Promise.all` in `runHealthChecks`.

Reuses `failedWindowS`/`failedThreshold` — no new env vars. Update the file-top comment's table list to include `inbound_events`.

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm vitest run worker/background/pollers/health-alert/`
Expected: ALL PASS.

- [ ] **Step 5: Commit**

```bash
git add worker/background/pollers/health-alert/checks.ts worker/background/pollers/health-alert/__tests__/checks.test.ts
git commit -m "fix(worker): alert on terminal generate_response and failed inbound events (P7)"
```

---

### Task 7: P10 — Dashboard degrades per-widget instead of hard-failing

**Files:**
- Modify: `src/lib/dashboard/service.ts:67-81` (the 13-query `Promise.all`) and the destructure consumers
- Test: Create `src/lib/dashboard/__tests__/service.degradation.test.ts`

**Scope note:** only the 13-query batch in `getActiveDashboardData` changes. `getAggregateDashboardData` calls `getActiveDashboardData` per location, so it inherits the degradation; its own top-level queries and `fetchReputationRows` stay as-is (route catch remains the backstop). Owner decision: ONLY the business lookup stays fatal (`BusinessNotFoundError` semantics preserved); the other 12 degrade.

- [ ] **Step 1: Read the existing service test harness**

Read `src/lib/dashboard/__tests__/service.feed-projection.test.ts` (or `scope.test.ts`) to see how `sql` is mocked for `getActiveDashboardData` — the mock resolves queries in call order. Reuse that harness style.

- [ ] **Step 2: Write the failing tests**

Create `src/lib/dashboard/__tests__/service.degradation.test.ts`, following the harness pattern from Step 1:

```ts
describe('getActiveDashboardData degradation', () => {
  it('still returns dashboard data when an auxiliary query rejects, reporting the failure', async () => {
    // Queue all 13 results in order; make rankingRows (index 4) reject.
    queueResults({ rejectAt: 4, reason: new Error('ranking_snapshots timeout') });
    const data = await getActiveDashboardData(mockSql, 'biz-1');
    expect(data).toBeTruthy();                       // no throw
    expect(data.rankings /* adapt to real field */).toEqual(expect.anything()); // empty fallback shape
    expect(mockReportCaughtError).toHaveBeenCalledWith(
      'dashboard/service',
      expect.any(Error),
      expect.objectContaining({ widget: 'rankingRows', degraded: true }),
    );
  });

  it('still throws BusinessNotFoundError semantics when the business query rejects', async () => {
    queueResults({ rejectAt: 0, reason: new Error('pg down') });
    await expect(getActiveDashboardData(mockSql, 'biz-1')).rejects.toThrow('pg down');
  });

  it('renders identically to today when everything succeeds', async () => {
    queueResults({});
    await expect(getActiveDashboardData(mockSql, 'biz-1')).resolves.toBeTruthy();
  });
});
```

Mock `@/lib/shared/report-caught-error` for `mockReportCaughtError`. Adapt `queueResults` to the real harness (each queued value corresponds to one `sql` call in source order; `readPendingMarker` is a Redis read — check how existing tests mock `@/lib/zernio/connect-state`).

- [ ] **Step 3: Run tests to verify they fail**

Run: `pnpm vitest run src/lib/dashboard/__tests__/service.degradation.test.ts`
Expected: first test FAILS (whole call rejects on the auxiliary failure).

- [ ] **Step 4: Implement**

In `src/lib/dashboard/service.ts`:

1. Import `reportCaughtError` from `@/lib/shared/report-caught-error`.
2. Add two helpers near `BusinessNotFoundError`:

```ts
/**
 * Per-widget degradation (prod-hardening spec P10): one auxiliary widget
 * query failing must not 500 the whole dashboard. The failure is reported
 * (never silent) and the widget renders its empty state. Only the business
 * lookup stays fatal — a dashboard for a missing business is meaningless.
 */
function widgetOrFallback<T>(
  result: PromiseSettledResult<T>,
  fallback: T,
  widget: string,
  businessId: string,
): T {
  if (result.status === 'fulfilled') return result.value;
  reportCaughtError('dashboard/service', result.reason, { businessId, widget, degraded: true });
  return fallback;
}

function requireFulfilled<T>(result: PromiseSettledResult<T>): T {
  if (result.status === 'rejected') throw result.reason;
  return result.value;
}
```

3. Change `await Promise.all([...])` to `await Promise.allSettled([...])` (the 13 queries themselves are untouched) and rework the destructure:

```ts
  const [
    businessSettled,
    totalReviewSettled,
    totalRespondedSettled,
    velocitySettled,
    rankingSettled,
    recentReviewSettled,
    monthlyBriefSettled,
    weeklyBriefSettled,
    zernioConnectionSettled,
    queuedReconnectSettled,
    unresolvedIncidentSettled,
    ratingBreakdownSettled,
    pendingSettled,
  ] = await Promise.allSettled([ /* …the existing 13 queries, unchanged… */ ]);

  const businessRows = requireFulfilled(businessSettled);
  const totalReviewRows = widgetOrFallback(totalReviewSettled, [], 'totalReviewRows', businessId);
  const totalRespondedRows = widgetOrFallback(totalRespondedSettled, [], 'totalRespondedRows', businessId);
  const velocityRows = widgetOrFallback(velocitySettled, [], 'velocityRows', businessId);
  const rankingRows = widgetOrFallback(rankingSettled, [], 'rankingRows', businessId);
  const recentReviewRows = widgetOrFallback(recentReviewSettled, [], 'recentReviewRows', businessId);
  const monthlyBriefRows = widgetOrFallback(monthlyBriefSettled, [], 'monthlyBriefRows', businessId);
  const weeklyBriefRows = widgetOrFallback(weeklyBriefSettled, [], 'weeklyBriefRows', businessId);
  const zernioConnectionRows = widgetOrFallback(zernioConnectionSettled, [], 'zernioConnectionRows', businessId);
  const queuedReconnectRows = widgetOrFallback(queuedReconnectSettled, [], 'queuedReconnectRows', businessId);
  const unresolvedIncidentRows = widgetOrFallback(unresolvedIncidentSettled, [], 'unresolvedIncidentRows', businessId);
  const ratingBreakdownRows = widgetOrFallback(ratingBreakdownSettled, [], 'ratingBreakdownRows', businessId);
  const pendingRaw = widgetOrFallback(pendingSettled, null, 'pendingRaw', businessId);
```

TypeScript note: `Promise.allSettled` over the tuple keeps per-element types, so each `widgetOrFallback` call infers `T` from its settled result; the empty-array fallbacks need `as` only if inference complains — prefer typing the fallback (`[] as DashboardRankingRow[]`) over widening. `pendingRaw`'s fallback must match `readPendingMarker`'s return type (check it — likely `string | null`).

Everything downstream (`business = businessRows[0]`, `buildActiveDashboardResponse({...})`) is unchanged.

- [ ] **Step 5: Run tests to verify they pass**

Run: `pnpm vitest run src/lib/dashboard/ && pnpm typecheck`
Expected: ALL PASS (including all pre-existing dashboard tests — the happy path must be behavior-identical).

- [ ] **Step 6: Commit**

```bash
git add src/lib/dashboard/service.ts src/lib/dashboard/__tests__/service.degradation.test.ts
git commit -m "fix(dashboard): degrade per-widget instead of 500ing the whole dashboard (P10)"
```

---

### Task 8: Full verify gate

**Files:** none (verification only)

- [ ] **Step 1: Run the full gate from the worktree root**

```bash
pnpm lint && pnpm typecheck && pnpm test
pnpm ci:static-policy && pnpm ci:analytics-events
pnpm ci:tenant-scope && pnpm ci:rls-audit
pnpm build
```

Expected: every command exits 0. The new `inbound_events` health query is intentionally cross-tenant (worker-internal, admin alerting) — if `ci:tenant-scope` flags it, add it to the audit's allowlist the same way the existing health-alert queries are listed (inspect `scripts/ci/` for how `checks.ts` queries are currently allowlisted, and follow that mechanism; do NOT weaken the audit).

- [ ] **Step 2: Fix anything red, re-run until green, commit fixes**

Each fix commit uses `fix(hardening): <what>` style.

---

## Out of scope (follow-up branch, decisions already locked)

- P4: `owner_unreachable` distinct outcome + health-alert escalation.
- P8: short per-call Stripe timeouts under the tier-change locks (minimal fix only).
- P9: explicit BullMQ concurrency + in-process LLM circuit breaker.
