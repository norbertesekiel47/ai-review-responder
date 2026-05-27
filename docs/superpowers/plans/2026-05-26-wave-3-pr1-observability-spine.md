# Wave 3 PR 1 — Observability Spine Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship the launch-critical observability spine — JSON structured logging with `AsyncLocalStorage` request/job context, web + worker health endpoints, enriched admin queue visibility, an analytics-taxonomy audit wired into CI, and on-call runbooks — without changing any worker behavior.

**Architecture:** A new `AsyncLocalStorage`-backed log-context module (`src/lib/shared/log-context.ts`) holds per-request/per-job IDs. The existing `createWorkerLogger(prefix, correlationId)` API is preserved but its body is rewritten to emit one JSON object per line, merging the current context at emit time. A thin `withJobLogContext` wrapper binds job-data IDs at the BullMQ `Worker` registration layer in `worker/index.ts`, so every existing `logger.*` call site automatically gains context with zero handler edits. Health is a dependency-light JSON route on both surfaces. Queue visibility extends the already-existing `/api/admin/jobs` route. A taxonomy audit reconciles `src/lib/analytics/events.ts` against `docs/analytics/events.md` and fails CI on drift.

**Tech Stack:** TypeScript (strict), Node `node:async_hooks`, Fastify (worker), Next.js 16 App Router route handlers, Vitest, BullMQ, GitHub Actions.

---

## Scope decisions baked into this plan (flag if you disagree)

1. **Queue visibility = enrichment.** `/api/admin/jobs` already returns per-queue `waiting/active/delayed/failed` and the admin page renders them. This plan adds `completed` + `paused` to the same `getJobCounts` call (no extra Redis round-trips) and two cells to the page. No Bull Board, no new page.
2. **Context binding via wrapper, job paths only.** `withJobLogContext` wraps the four highest-value BullMQ handlers (response generation, notification, publisher, Zernio ingest) at registration. Background pollers (`OutboxPoller`, `AnalyticsDispatchPoller`) are **deferred to a later PR** — they are loops, not the "critical worker paths" the spec's launch gate names, and wrapping their internal poll bodies is a separate, riskier edit.
3. **No new analytics event in PR1.** `admin_queue_viewed` is documented in the spec but not emitted here (emitting it needs an allowlist entry + a migration CHECK-constraint change). PR1 only re-documents the existing 10 events in the new typed format so the audit passes.
4. **AAL2 on the queue page is a documented follow-up.** The existing `/admin/jobs` route gates on `requireRole('admin')` only; this plan keeps that and notes AAL2 as a follow-up to avoid an out-of-scope auth change.

---

## File Structure

| File | Responsibility | Create / Modify |
|---|---|---|
| `src/lib/shared/log-context.ts` | `AsyncLocalStorage` context store + helpers | Create |
| `src/lib/shared/__tests__/log-context.test.ts` | Context module tests | Create |
| `src/lib/shared/logger.ts` | JSON logger; preserves `createWorkerLogger` API | Modify (full rewrite) |
| `src/lib/shared/__tests__/logger.test.ts` | Logger JSON-shape tests | Modify (full rewrite) |
| `worker/job-log-context.ts` | `withJobLogContext` wrapper + `extractJobLogContext` | Create |
| `worker/__tests__/job-log-context.test.ts` | Wrapper + propagation tests | Create |
| `worker/index.ts` | Apply wrapper to 4 queues; enrich worker health | Modify |
| `worker/jobs/ResponseGeneratorWorker.ts` | `mergeLogContext` for `outbox_id` + `account_id` | Modify |
| `src/app/api/health/route.ts` | Web health endpoint | Create |
| `src/app/api/health/__tests__/route.test.ts` | Health route test | Create |
| `src/app/api/admin/jobs/route.ts` | Add `completed` + `paused` counts | Modify |
| `src/app/admin/jobs/page.tsx` | Render `completed` + `paused` cells | Modify |
| `docs/analytics/events.md` | Rewrite into typed taxonomy | Modify (full rewrite) |
| `scripts/ci/analytics-events-audit.ts` | Code↔docs event drift audit | Create |
| `scripts/ci/__tests__/analytics-events-audit.test.ts` | Audit pure-function tests | Create |
| `package.json` | Add `ci:analytics-events` script | Modify |
| `.github/workflows/ci.yml` | Wire audit into `lint` job | Modify |
| `docs/runbooks/observability.md` | Severity ladder, synthetic checks, triage | Create |
| `docs/runbooks/oncall-3am.md` | What wakes the founder vs. waits | Create |
| `docs/runbooks/alert-tuning.md` | False-alert review process | Create |
| `.claude/CLAUDE.md` | Note structured logging + log-context invariant | Modify |

---

## Task 1: Log context module

**Files:**
- Create: `src/lib/shared/log-context.ts`
- Test: `src/lib/shared/__tests__/log-context.test.ts`

- [ ] **Step 1: Write the failing test**

Create `src/lib/shared/__tests__/log-context.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import {
  withLogContext,
  getLogContext,
  mergeLogContext,
  createRequestId,
} from '../log-context';

describe('log-context', () => {
  it('returns an empty context outside any scope', () => {
    expect(getLogContext()).toEqual({});
  });

  it('exposes bound IDs inside withLogContext', () => {
    const seen = withLogContext({ business_id: 'biz-1', review_id: 'rev-2' }, () => getLogContext());
    expect(seen.business_id).toBe('biz-1');
    expect(seen.review_id).toBe('rev-2');
  });

  it('does not leak context outside the scope', () => {
    withLogContext({ business_id: 'biz-1' }, () => undefined);
    expect(getLogContext()).toEqual({});
  });

  it('merges nested scopes, child wins on conflict', () => {
    const seen = withLogContext({ business_id: 'biz-1', account_id: 'acc-1' }, () =>
      withLogContext({ business_id: 'biz-2' }, () => getLogContext()),
    );
    expect(seen).toEqual({ business_id: 'biz-2', account_id: 'acc-1' });
  });

  it('mergeLogContext adds IDs to the current scope', () => {
    const seen = withLogContext({ business_id: 'biz-1' }, () => {
      mergeLogContext({ outbox_id: 'ob-9' });
      return getLogContext();
    });
    expect(seen).toEqual({ business_id: 'biz-1', outbox_id: 'ob-9' });
  });

  it('strips undefined / null / empty values when binding', () => {
    const seen = withLogContext(
      { business_id: 'biz-1', account_id: undefined, review_id: '' },
      () => getLogContext(),
    );
    expect(seen).toEqual({ business_id: 'biz-1' });
  });

  it('createRequestId returns unique non-empty strings', () => {
    const a = createRequestId();
    const b = createRequestId();
    expect(a).not.toBe(b);
    expect(a.length).toBeGreaterThan(0);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run src/lib/shared/__tests__/log-context.test.ts`
Expected: FAIL — cannot resolve `../log-context`.

- [ ] **Step 3: Write the implementation**

Create `src/lib/shared/log-context.ts`:

```ts
import { AsyncLocalStorage } from 'node:async_hooks';
import { randomUUID } from 'node:crypto';

/**
 * Per-request / per-job log context propagated via AsyncLocalStorage.
 * Every field is optional and only included in a log line when bound.
 */
export interface LogContext {
  request_id?: string;
  correlation_id?: string;
  account_id?: string;
  business_id?: string;
  review_id?: string;
  response_id?: string;
  worker_job_id?: string;
  outbox_id?: string;
}

const storage = new AsyncLocalStorage<LogContext>();

function stripEmpty(context: LogContext): LogContext {
  const out: LogContext = {};
  for (const [key, value] of Object.entries(context)) {
    if (value !== undefined && value !== null && value !== '') {
      (out as Record<string, unknown>)[key] = value;
    }
  }
  return out;
}

/** Run `fn` with `context` merged onto any enclosing context. Child keys win. */
export function withLogContext<T>(context: LogContext, fn: () => T): T {
  const merged = { ...(storage.getStore() ?? {}), ...stripEmpty(context) };
  return storage.run(merged, fn);
}

/** Returns the active context, or `{}` when called outside any scope. */
export function getLogContext(): LogContext {
  return storage.getStore() ?? {};
}

/** Adds IDs to the CURRENT scope (no-op when called outside a scope). */
export function mergeLogContext(context: LogContext): void {
  const current = storage.getStore();
  if (!current) return;
  Object.assign(current, stripEmpty(context));
}

export function createRequestId(): string {
  return randomUUID();
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm vitest run src/lib/shared/__tests__/log-context.test.ts`
Expected: PASS (7 tests).

- [ ] **Step 5: Commit**

```bash
git add src/lib/shared/log-context.ts src/lib/shared/__tests__/log-context.test.ts
git commit -m "feat(observability): add AsyncLocalStorage log context module"
```

---

## Task 2: Structured JSON logger

**Files:**
- Modify: `src/lib/shared/logger.ts` (full rewrite, same public API)
- Test: `src/lib/shared/__tests__/logger.test.ts` (full rewrite)

> The existing `logger.test.ts` asserts plain-prefix `console` calls and WILL break. Per the skill, update the test first, then the implementation.

- [ ] **Step 1: Rewrite the test to assert JSON shape**

Replace the entire contents of `src/lib/shared/__tests__/logger.test.ts` with:

```ts
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createWorkerLogger } from '../logger';
import { withLogContext } from '../log-context';

function lastLine(spy: ReturnType<typeof vi.spyOn>): Record<string, unknown> {
  const call = spy.mock.calls.at(-1);
  if (!call) throw new Error('console was not called');
  return JSON.parse(call[0] as string) as Record<string, unknown>;
}

describe('createWorkerLogger (JSON)', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('emits one parseable JSON object with required base fields', () => {
    const spy = vi.spyOn(console, 'log').mockImplementation(() => {});
    createWorkerLogger('[ResponseGeneratorWorker]').log('processing review');
    const rec = lastLine(spy);
    expect(rec.level).toBe('info');
    expect(rec.service).toBe('worker');
    expect(rec.logger).toBe('ResponseGeneratorWorker');
    expect(rec.message).toBe('processing review');
    expect(typeof rec.timestamp).toBe('string');
    expect(() => new Date(rec.timestamp as string).toISOString()).not.toThrow();
  });

  it('includes correlation_id passed to the factory', () => {
    const spy = vi.spyOn(console, 'log').mockImplementation(() => {});
    createWorkerLogger('[W]', 'corr-abc').log('hi');
    expect(lastLine(spy).correlation_id).toBe('corr-abc');
  });

  it('merges bound context IDs from withLogContext', () => {
    const spy = vi.spyOn(console, 'log').mockImplementation(() => {});
    withLogContext({ business_id: 'biz-7', review_id: 'rev-3' }, () => {
      createWorkerLogger('[W]').log('working');
    });
    const rec = lastLine(spy);
    expect(rec.business_id).toBe('biz-7');
    expect(rec.review_id).toBe('rev-3');
  });

  it('maps warn() to level warn on console.warn', () => {
    const spy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    createWorkerLogger('[W]').warn('careful');
    expect(lastLine(spy).level).toBe('warn');
  });

  it('maps error() to level error on console.error', () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    createWorkerLogger('[W]').error('broke');
    expect(lastLine(spy).level).toBe('error');
  });

  it('serializes Error arguments into error_name / error_message', () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    createWorkerLogger('[W]').error('failed to post', new Error('boom'));
    const rec = lastLine(spy);
    expect(rec.message).toBe('failed to post');
    expect(rec.error_name).toBe('Error');
    expect(rec.error_message).toBe('boom');
  });

  it('drops blocked keys from object args under data', () => {
    const spy = vi.spyOn(console, 'log').mockImplementation(() => {});
    createWorkerLogger('[W]').log('ctx', { reviewId: 'r1', access_token: 'SECRET', count: 3 });
    const data = lastLine(spy).data as Record<string, unknown>;
    expect(data.reviewId).toBe('r1');
    expect(data.count).toBe(3);
    expect(data.access_token).toBeUndefined();
  });

  it('joins multiple string args into message', () => {
    const spy = vi.spyOn(console, 'log').mockImplementation(() => {});
    createWorkerLogger('[W]').log('review', 'abc-123');
    expect(lastLine(spy).message).toBe('review abc-123');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run src/lib/shared/__tests__/logger.test.ts`
Expected: FAIL — current logger emits plain strings, not JSON (`JSON.parse` throws / fields undefined).

- [ ] **Step 3: Rewrite the logger implementation**

Replace the entire contents of `src/lib/shared/logger.ts` with:

```ts
import { sanitizeAnalyticsProperties } from '../analytics/events';
import { getLogContext } from './log-context';

export interface WorkerLogger {
  log: (...args: unknown[]) => void;
  warn: (...args: unknown[]) => void;
  error: (...args: unknown[]) => void;
}

type LogLevel = 'info' | 'warn' | 'error';

const CONTEXT_FIELDS = [
  'request_id',
  'correlation_id',
  'account_id',
  'business_id',
  'review_id',
  'response_id',
  'worker_job_id',
  'outbox_id',
] as const;

function serviceName(): string {
  return process.env.LOG_SERVICE ?? 'worker';
}

/** '[ResponseGeneratorWorker]' -> 'ResponseGeneratorWorker'. */
function normalizeLoggerName(prefix: string): string {
  return prefix.replace(/^\[/, '').replace(/\]$/, '').trim();
}

function serializeError(err: Error): Record<string, unknown> {
  const out: Record<string, unknown> = {
    error_name: err.name,
    error_message: err.message,
  };
  // Stacks only in non-production: they can be large and occasionally echo input.
  if (process.env.NODE_ENV !== 'production' && err.stack) {
    out.error_stack = err.stack;
  }
  return out;
}

function emit(level: LogLevel, prefix: string, correlationId: string | undefined, args: unknown[]): void {
  const context = getLogContext();
  const record: Record<string, unknown> = {
    timestamp: new Date().toISOString(),
    level,
    service: serviceName(),
    logger: normalizeLoggerName(prefix),
    message: '',
  };

  for (const field of CONTEXT_FIELDS) {
    const value = context[field];
    if (value !== undefined) record[field] = value;
  }
  if (correlationId && record.correlation_id === undefined) {
    record.correlation_id = correlationId;
  }

  const messageParts: string[] = [];
  let data: Record<string, unknown> | undefined;

  for (const arg of args) {
    if (typeof arg === 'string') {
      messageParts.push(arg);
    } else if (typeof arg === 'number' || typeof arg === 'boolean') {
      messageParts.push(String(arg));
    } else if (arg instanceof Error) {
      Object.assign(record, serializeError(arg));
    } else if (arg && typeof arg === 'object') {
      const sanitized = sanitizeAnalyticsProperties(arg as Record<string, unknown>);
      data = { ...(data ?? {}), ...sanitized };
    }
  }

  record.message = messageParts.join(' ');
  if (data && Object.keys(data).length > 0) record.data = data;

  const line = JSON.stringify(record);
  if (level === 'error') console.error(line);
  else if (level === 'warn') console.warn(line);
  else console.log(line);
}

/**
 * Creates a JSON structured logger for workers. The public API is unchanged:
 * `createWorkerLogger(prefix, correlationId)`. The prefix becomes `logger`,
 * `correlationId` is merged with any AsyncLocalStorage log context, and each
 * call emits one JSON object per line.
 *
 * Never pass raw review text, response text, approval/OAuth tokens, API keys,
 * passwords, MFA codes, or provider request payloads — object args are passed
 * through the analytics blocked-key sanitizer, but strings are logged verbatim.
 */
export function createWorkerLogger(prefix: string, correlationId?: string): WorkerLogger {
  return {
    log: (...args: unknown[]) => emit('info', prefix, correlationId, args),
    warn: (...args: unknown[]) => emit('warn', prefix, correlationId, args),
    error: (...args: unknown[]) => emit('error', prefix, correlationId, args),
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm vitest run src/lib/shared/__tests__/logger.test.ts`
Expected: PASS (8 tests).

- [ ] **Step 5: Verify no other logger test broke and typecheck holds**

Run: `pnpm vitest run src/lib/shared/__tests__/ && pnpm typecheck`
Expected: PASS. (`createWorkerLogger` signature is unchanged, so call sites still compile.)

- [ ] **Step 6: Commit**

```bash
git add src/lib/shared/logger.ts src/lib/shared/__tests__/logger.test.ts
git commit -m "feat(observability): emit structured JSON logs with context merge"
```

---

## Task 3: Bind log context on critical worker job paths

**Files:**
- Create: `worker/job-log-context.ts`
- Test: `worker/__tests__/job-log-context.test.ts`
- Modify: `worker/index.ts`
- Modify: `worker/jobs/ResponseGeneratorWorker.ts`

- [ ] **Step 1: Write the failing test**

Create `worker/__tests__/job-log-context.test.ts`:

```ts
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Job } from 'bullmq';
import { withJobLogContext, extractJobLogContext } from '../job-log-context';
import { createWorkerLogger } from '../../src/lib/shared/logger';

function fakeJob(data: Record<string, unknown>, id = 'job-1'): Job {
  return { id, data } as unknown as Job;
}

describe('job log context', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('extracts known IDs and assigns a request_id', () => {
    const ctx = extractJobLogContext(fakeJob({ business_id: 'biz-7', review_id: 'rev-3' }));
    expect(ctx.business_id).toBe('biz-7');
    expect(ctx.review_id).toBe('rev-3');
    expect(ctx.worker_job_id).toBe('job-1');
    expect(typeof ctx.request_id).toBe('string');
  });

  it('ignores non-string id fields', () => {
    const ctx = extractJobLogContext(fakeJob({ business_id: 123 as unknown as string }));
    expect(ctx.business_id).toBeUndefined();
  });

  it('propagates bound IDs into logger output inside the wrapped handler', async () => {
    const spy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const wrapped = withJobLogContext(async () => {
      createWorkerLogger('[ResponseGeneratorWorker]').log('working');
    });
    await wrapped(fakeJob({ correlation_id: 'corr-9', business_id: 'biz-7', review_id: 'rev-3' }));
    const rec = JSON.parse(spy.mock.calls.at(-1)![0] as string) as Record<string, unknown>;
    expect(rec.correlation_id).toBe('corr-9');
    expect(rec.business_id).toBe('biz-7');
    expect(rec.review_id).toBe('rev-3');
    expect(rec.worker_job_id).toBe('job-1');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run worker/__tests__/job-log-context.test.ts`
Expected: FAIL — cannot resolve `../job-log-context`.

- [ ] **Step 3: Write the wrapper**

Create `worker/job-log-context.ts`:

```ts
import type { Job } from 'bullmq';
import {
  withLogContext,
  createRequestId,
  type LogContext,
} from '../src/lib/shared/log-context';

function asId(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

/**
 * Reads the common tenant/correlation IDs that BullMQ payloads carry. Fields
 * absent on a given queue's payload are simply omitted. account_id is rarely on
 * the payload — handlers can add it via mergeLogContext once resolved from the DB.
 */
export function extractJobLogContext(job: Job): LogContext {
  const data = (job.data ?? {}) as Record<string, unknown>;
  return {
    request_id: createRequestId(),
    worker_job_id: asId(job.id),
    correlation_id: asId(data.correlation_id),
    account_id: asId(data.account_id),
    business_id: asId(data.business_id),
    review_id: asId(data.review_id),
    response_id: asId(data.response_id),
  };
}

/**
 * Wraps a BullMQ processor so every log line emitted while it runs carries the
 * job's context IDs. Apply at registration in worker/index.ts; handler code is
 * untouched.
 */
export function withJobLogContext<T>(
  handler: (job: Job<T>) => Promise<void>,
): (job: Job<T>) => Promise<void> {
  return (job: Job<T>) => withLogContext(extractJobLogContext(job as Job), () => handler(job));
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm vitest run worker/__tests__/job-log-context.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: Apply the wrapper to the four high-value queues in `worker/index.ts`**

Add the import after the existing queues import (near `worker/index.ts:8`):

```ts
import { withJobLogContext } from './job-log-context';
```

Then wrap each of these four handler registrations. Make these exact edits:

`worker/index.ts:105-109` — Zernio ingest:
```ts
const ingestZernioReviewWorker = new Worker<IngestZernioReviewPayload>(
  QUEUE_NAMES.INGEST_ZERNIO_REVIEW,
  withJobLogContext(handleZernioReviewIngest),
  workerOpts,
);
```

`worker/index.ts:121` — response generation:
```ts
const responseGenWorker = new Worker(QUEUE_NAMES.GENERATE_RESPONSE, withJobLogContext(handleResponseGeneration), workerOpts);
```

`worker/index.ts:123` — notification:
```ts
const notificationWorker = new Worker(QUEUE_NAMES.SEND_NOTIFICATION, withJobLogContext(handleSendNotification), workerOpts);
```

`worker/index.ts:125` — publisher:
```ts
const publisherWorker = new Worker(QUEUE_NAMES.PUBLISH_RESPONSE, withJobLogContext(handlePublishResponse), workerOpts);
```

> Leave `publisherWorker.on('failed', handlePublisherFailed)` and `ingestZernioReviewWorker.on('failed', handleIngestFailed)` unchanged — failure hooks are separate listeners, not processors.

- [ ] **Step 6: Enrich context with `outbox_id` and `account_id` in ResponseGeneratorWorker**

In `worker/jobs/ResponseGeneratorWorker.ts`, add `mergeLogContext` to the existing log-context import at line 25... actually it imports from logger; add a separate import after line 28:

```ts
import { mergeLogContext } from '../../src/lib/shared/log-context';
```

After `worker/jobs/ResponseGeneratorWorker.ts:39` (the `extractOutboxHandle` line), add:

```ts
  mergeLogContext({ outbox_id: outboxId });
```

After the business row is confirmed (immediately after `worker/jobs/ResponseGeneratorWorker.ts:89`, the closing `}` of the `if (!business)` block), add:

```ts
  mergeLogContext({ account_id: business.account_id });
```

- [ ] **Step 7: Verify typecheck + targeted tests pass**

Run: `pnpm typecheck && pnpm vitest run worker/__tests__/job-log-context.test.ts`
Expected: PASS. The wrapper's `Job<T>` generic infers from each handler, so no registration loses its payload typing.

- [ ] **Step 8: Commit**

```bash
git add worker/job-log-context.ts worker/__tests__/job-log-context.test.ts worker/index.ts worker/jobs/ResponseGeneratorWorker.ts
git commit -m "feat(observability): bind log context on critical worker job paths"
```

---

## Task 4: Web health route

**Files:**
- Create: `src/app/api/health/route.ts`
- Test: `src/app/api/health/__tests__/route.test.ts`

- [ ] **Step 1: Write the failing test**

Create `src/app/api/health/__tests__/route.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { GET } from '../route';

describe('GET /api/health', () => {
  it('returns 200 with ok status for the web service', async () => {
    const res = await GET();
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.status).toBe('ok');
    expect(body.service).toBe('web');
    expect(typeof body.timestamp).toBe('string');
    expect(() => new Date(body.timestamp as string).toISOString()).not.toThrow();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run src/app/api/health/__tests__/route.test.ts`
Expected: FAIL — cannot resolve `../route`.

- [ ] **Step 3: Write the route**

Create `src/app/api/health/route.ts`:

```ts
import { NextResponse } from 'next/server';

// Dependency-light by contract: no DB, LLM, Stripe, Zernio, or PostHog calls.
// Used by external synthetic checks; must stay fast and side-effect free.
export const dynamic = 'force-dynamic';

export async function GET(): Promise<NextResponse> {
  return NextResponse.json({
    status: 'ok',
    service: 'web',
    timestamp: new Date().toISOString(),
    commit: process.env.VERCEL_GIT_COMMIT_SHA ?? null,
  });
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm vitest run src/app/api/health/__tests__/route.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/app/api/health/route.ts src/app/api/health/__tests__/route.test.ts
git commit -m "feat(observability): add Next.js /api/health route"
```

---

## Task 5: Enrich worker health response

**Files:**
- Modify: `worker/index.ts`

- [ ] **Step 1: Edit the health handler**

Replace `worker/index.ts:241-245`:

```ts
  // Health check
  app.get('/api/health', async () => ({
    status: 'ok',
    timestamp: new Date().toISOString(),
  }));
```

with:

```ts
  // Health check — dependency-light (no DB / queue / external calls).
  // Used by external synthetic checks; do not add blocking dependency probes here.
  app.get('/api/health', async () => ({
    status: 'ok',
    service: 'worker',
    timestamp: new Date().toISOString(),
    uptime_seconds: Math.round(process.uptime()),
  }));
```

- [ ] **Step 2: Verify build compiles the worker entry**

Run: `pnpm typecheck`
Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add worker/index.ts
git commit -m "feat(observability): tag worker health with service + uptime"
```

---

## Task 6: Enrich admin queue visibility

**Files:**
- Modify: `src/app/api/admin/jobs/route.ts`
- Modify: `src/app/admin/jobs/page.tsx`

> This route already returns per-queue `waiting/active/delayed/failed` and is admin-gated (`requireRole('admin')`) and read-only. We add `completed` + `paused` to the same `getJobCounts` call (zero extra Redis round-trips). AAL2 gating is a documented follow-up, not part of this PR.

- [ ] **Step 1: Add `completed` + `paused` to the queue counts**

In `src/app/api/admin/jobs/route.ts:115`, replace:

```ts
            const jobCounts = await queue.getJobCounts('waiting', 'active', 'delayed', 'failed');
```

with:

```ts
            const jobCounts = await queue.getJobCounts(
              'waiting',
              'active',
              'delayed',
              'failed',
              'completed',
              'paused',
            );
```

- [ ] **Step 2: Render the two new cells on the admin page**

In `src/app/admin/jobs/page.tsx`, change the grid container at line 157 from:

```tsx
                  <div className="grid grid-cols-4 gap-2 text-center text-xs">
```

to:

```tsx
                  <div className="grid grid-cols-6 gap-2 text-center text-xs">
```

Then, immediately after the closing `</div>` of the `failed` cell (after `src/app/admin/jobs/page.tsx:181`), add two cells:

```tsx
                    <div>
                      <p className="font-medium text-green-500">completed</p>
                      <p className="mt-0.5 text-base font-bold text-green-700">
                        {counts['completed'] ?? 0}
                      </p>
                    </div>
                    <div>
                      <p className="font-medium text-gray-400">paused</p>
                      <p className="mt-0.5 text-base font-bold text-gray-600">
                        {counts['paused'] ?? 0}
                      </p>
                    </div>
```

- [ ] **Step 3: Verify typecheck + build**

Run: `pnpm typecheck`
Expected: PASS. (No unit test is added here — exercising this route requires a live BullMQ/Redis mock disproportionate to a 2-line count change; it is covered by `pnpm build` and manual admin verification.)

- [ ] **Step 4: Commit**

```bash
git add src/app/api/admin/jobs/route.ts src/app/admin/jobs/page.tsx
git commit -m "feat(observability): show completed + paused counts in admin queue view"
```

---

## Task 7: Analytics taxonomy + drift audit (wired into CI)

**Files:**
- Modify: `docs/analytics/events.md` (rewrite into typed taxonomy)
- Create: `scripts/ci/analytics-events-audit.ts`
- Test: `scripts/ci/__tests__/analytics-events-audit.test.ts`
- Modify: `package.json`
- Modify: `.github/workflows/ci.yml`

- [ ] **Step 1: Write the failing audit test**

Create `scripts/ci/__tests__/analytics-events-audit.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { auditAnalyticsEvents } from '../analytics-events-audit';

const liveDoc = (name: string) => `### \`${name}\`\n- **Status:** live\n`;

describe('auditAnalyticsEvents', () => {
  it('passes when code and live docs match', () => {
    const doc = liveDoc('signup_started') + liveDoc('email_verified');
    expect(auditAnalyticsEvents(['signup_started', 'email_verified'], doc)).toEqual([]);
  });

  it('flags a code event missing from the docs', () => {
    const doc = liveDoc('signup_started');
    expect(auditAnalyticsEvents(['signup_started', 'email_verified'], doc)).toEqual([
      { event: 'email_verified', reason: 'event in code allowlist is undocumented' },
    ]);
  });

  it('flags a documented live event missing from code', () => {
    const doc = liveDoc('signup_started') + liveDoc('ghost_event');
    expect(auditAnalyticsEvents(['signup_started'], doc)).toEqual([
      { event: 'ghost_event', reason: 'documented live event missing from code allowlist' },
    ]);
  });

  it('does not require planned or external_only doc events to exist in code', () => {
    const doc =
      liveDoc('signup_started') +
      `### \`finance_rollup_completed\`\n- **Status:** planned\n` +
      `### \`stripe_invoice_paid\`\n- **Status:** external_only\n`;
    expect(auditAnalyticsEvents(['signup_started'], doc)).toEqual([]);
  });

  it('treats a heading with no Status line as live', () => {
    const doc = `### \`signup_started\`\nsome prose\n`;
    expect(auditAnalyticsEvents([], doc)).toEqual([
      { event: 'signup_started', reason: 'documented live event missing from code allowlist' },
    ]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run scripts/ci/__tests__/analytics-events-audit.test.ts`
Expected: FAIL — cannot resolve `../analytics-events-audit`.

- [ ] **Step 3: Write the audit script**

Create `scripts/ci/analytics-events-audit.ts`:

```ts
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { ANALYTICS_EVENT_NAMES } from '../../src/lib/analytics/events';

export interface AnalyticsAuditFinding {
  event: string;
  reason: string;
}

const DOC_PATH = 'docs/analytics/events.md';

/** Parse `### \`event_name\`` headings and their `**Status:**` line. */
export function parseDocumentedEvents(docText: string): Map<string, string> {
  const documented = new Map<string, string>();
  const blocks = docText.split(/^###\s+/m).slice(1);
  for (const block of blocks) {
    const nameMatch = /^`([a-z0-9_]+)`/.exec(block.trim());
    if (!nameMatch) continue;
    const statusMatch = /\*\*Status:\*\*\s*([a-z_]+)/i.exec(block);
    documented.set(nameMatch[1]!, (statusMatch?.[1] ?? 'live').toLowerCase());
  }
  return documented;
}

export function auditAnalyticsEvents(
  codeEvents: readonly string[],
  docText: string,
): AnalyticsAuditFinding[] {
  const documented = parseDocumentedEvents(docText);
  const findings: AnalyticsAuditFinding[] = [];

  for (const event of codeEvents) {
    if (!documented.has(event)) {
      findings.push({ event, reason: 'event in code allowlist is undocumented' });
    }
  }
  for (const [event, status] of documented) {
    if (status === 'live' && !codeEvents.includes(event)) {
      findings.push({ event, reason: 'documented live event missing from code allowlist' });
    }
  }
  return findings;
}

async function main(): Promise<void> {
  const docText = await readFile(DOC_PATH, 'utf8');
  const findings = auditAnalyticsEvents(ANALYTICS_EVENT_NAMES, docText);

  if (findings.length > 0) {
    console.error('analytics-events-audit: failed');
    for (const finding of findings) {
      console.error(`${finding.event}: ${finding.reason}`);
    }
    process.exit(1);
  }
  console.log('analytics-events-audit: passed');
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  main().catch((err) => {
    console.error('analytics-events-audit: fatal error');
    console.error(err);
    process.exit(1);
  });
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm vitest run scripts/ci/__tests__/analytics-events-audit.test.ts`
Expected: PASS (5 tests).

- [ ] **Step 5: Rewrite `docs/analytics/events.md` into the typed taxonomy**

Replace the entire contents of `docs/analytics/events.md` with:

```markdown
# Analytics Events

RepWorth does not use `posthog-js` and Next.js routes do not call PostHog
directly. Client and Vercel-owned events are written to `analytics_events`;
the Railway `AnalyticsDispatchPoller` ships them to PostHog.

This file is the canonical event taxonomy. The CI audit
(`pnpm ci:analytics-events`, `scripts/ci/analytics-events-audit.ts`) fails the
build if a code allowlist event (`ANALYTICS_EVENT_NAMES` in
`src/lib/analytics/events.ts`) is undocumented here, or if an event documented
as `live` is missing from the code allowlist.

**Status values:** `live` (emitted today), `planned` (designed, not yet
emitted), `external_only` (delivered by an external system, never in the code
allowlist).

**Privacy rule (applies to every event):** never include review text, response
text, raw approval tokens, Zernio tokens, MFA codes, provider secrets, or raw
CSV content.

## Event Catalog

### `signup_started`
- **Status:** live
- **Description:** Visitor began the signup flow.
- **Owner:** first-party enqueue route (`src/app/api/analytics/enqueue/route.ts`)
- **Source:** browser intent → `/api/analytics/enqueue`
- **Distinct ID:** anonymous ID
- **Event key:** `signup_started:<anonymous_id>:<client_event_id>`
- **Required properties:** none
- **Optional properties:** `client_event_id` (string)
- **Privacy notes:** anonymous ID only; no PII.

### `email_verified`
- **Status:** live
- **Description:** User confirmed their email via OTP.
- **Owner:** verify-OTP route
- **Source:** server-side after OTP confirmation (durable; not client-postable)
- **Distinct ID:** account ID
- **Event key:** `email_verified:<user_id>`
- **Required properties:** none
- **Optional properties:** none
- **Privacy notes:** IDs only.

### `sample_demo_started`
- **Status:** live
- **Description:** Visitor started the sample-data demo.
- **Owner:** first-party enqueue route
- **Source:** browser intent → `/api/analytics/enqueue`
- **Distinct ID:** anonymous ID or account ID
- **Event key:** `sample_demo_started:<id>:<client_event_id>`
- **Required properties:** none
- **Optional properties:** `client_event_id` (string)
- **Privacy notes:** IDs only.

### `sample_demo_to_signup`
- **Status:** live
- **Description:** Visitor converted from the demo into signup.
- **Owner:** first-party enqueue route
- **Source:** browser intent → `/api/analytics/enqueue`
- **Distinct ID:** anonymous ID or account ID
- **Event key:** `sample_demo_to_signup:<id>:<client_event_id>`
- **Required properties:** none
- **Optional properties:** `client_event_id` (string)
- **Privacy notes:** IDs only.

### `gbp_connect_started`
- **Status:** live
- **Description:** Owner started connecting a Google Business Profile location.
- **Owner:** first-party enqueue route
- **Source:** browser intent → `/api/analytics/enqueue`
- **Distinct ID:** account ID
- **Event key:** `gbp_connect_started:<business_id>:<client_event_id>`
- **Required properties:** none
- **Optional properties:** `client_event_id` (string)
- **Privacy notes:** IDs only.

### `gbp_connect_failed`
- **Status:** live
- **Description:** A GBP connect attempt failed at a known stage.
- **Owner:** connect UI/API
- **Source:** browser/API intent → `/api/analytics/enqueue`
- **Distinct ID:** account ID
- **Event key:** `gbp_connect_failed:<business_id>:<stage>:<client_event_id>`
- **Required properties:** `stage` (string)
- **Optional properties:** `client_event_id` (string)
- **Privacy notes:** stage is a fixed enum label; no PII.

### `gbp_connected`
- **Status:** live
- **Description:** A GBP location finished connecting.
- **Owner:** Zernio finalize / select-location transaction
- **Source:** server-side, in the connect transaction (durable; not client-postable)
- **Distinct ID:** account ID
- **Event key:** `gbp_connected:<business_id>`
- **Required properties:** none
- **Optional properties:** none
- **Privacy notes:** IDs only.

### `first_review_ingested`
- **Status:** live
- **Description:** First review ever ingested for an account.
- **Owner:** Zernio ingest worker
- **Source:** worker-side after ingest commit (durable; not client-postable)
- **Distinct ID:** account ID
- **Event key:** `first_review_ingested:<account_id>`
- **Required properties:** none
- **Optional properties:** none
- **Privacy notes:** IDs only; no review content.

### `first_response_drafted`
- **Status:** live
- **Description:** First AI response drafted for an account.
- **Owner:** response generator worker
- **Source:** worker-side after draft commit (durable; not client-postable)
- **Distinct ID:** account ID
- **Event key:** `first_response_drafted:<account_id>`
- **Required properties:** none
- **Optional properties:** none
- **Privacy notes:** IDs only; no response content.

### `activation_completed`
- **Status:** live
- **Description:** Account reached activation (first response posted).
- **Owner:** publisher worker
- **Source:** worker-side on posted transition (durable; not client-postable)
- **Distinct ID:** account ID
- **Event key:** existing Step 1 activation key
- **Required properties:** none
- **Optional properties:** none
- **Privacy notes:** IDs only.
```

- [ ] **Step 6: Add the npm script**

In `package.json`, add this line to `scripts` immediately after the `ci:rls-audit` entry (after `package.json:21`):

```json
    "ci:analytics-events": "tsx scripts/ci/analytics-events-audit.ts",
```

- [ ] **Step 7: Run the audit against the real docs**

Run: `pnpm ci:analytics-events`
Expected: `analytics-events-audit: passed` (the rewritten `events.md` documents exactly the 10 events in `ANALYTICS_EVENT_NAMES`).

- [ ] **Step 8: Wire the audit into CI**

In `.github/workflows/ci.yml`, in the `lint` job, add a step after the existing `Run tenant scope audit` step:

```yaml
      - name: Run analytics events audit
        run: pnpm ci:analytics-events
```

- [ ] **Step 9: Commit**

```bash
git add docs/analytics/events.md scripts/ci/analytics-events-audit.ts scripts/ci/__tests__/analytics-events-audit.test.ts package.json .github/workflows/ci.yml
git commit -m "feat(observability): typed analytics taxonomy + CI drift audit"
```

---

## Task 8: On-call runbooks

**Files:**
- Create: `docs/runbooks/observability.md`
- Create: `docs/runbooks/oncall-3am.md`
- Create: `docs/runbooks/alert-tuning.md`

- [ ] **Step 1: Create `docs/runbooks/observability.md`**

```markdown
# Observability Runbook

How RepWorth is observed and how to triage the common failure shapes. RepWorth
is a solo-founder operation: this runbook optimizes for "what do I look at, in
what order" — not for a team rotation.

## Severity ladder

| Severity | Definition | Response |
|---|---|---|
| P0 | Customer data loss risk, billing incorrectness, auth/tenant-isolation breach, or total outage (web or worker down). | Drop everything, page-worthy at any hour. |
| P1 | Core flow degraded: review ingest stalled, responses not generating, notifications not sending, Stripe webhooks backing up. | Same-day; out-of-hours if trending worse. |
| P2 | Non-blocking: elevated LLM fallback rate, moderation spike, single queue lag within SLA, cosmetic errors. | Next business morning. |

## Signals

- **Structured logs** — every worker log line is one JSON object with
  `timestamp/level/service/logger/message` plus context IDs
  (`request_id`, `correlation_id`, `account_id`, `business_id`, `review_id`,
  `response_id`, `worker_job_id`, `outbox_id`). Filter by any ID to follow one
  unit of work.
- **Sentry** — exceptions + breadcrumbs (worker job lifecycle).
- **Health endpoints** — web `GET /api/health`, worker `GET /api/health`.
- **Admin queue view** — `/admin/jobs`: outbox summary + per-queue
  waiting/active/delayed/failed/completed/paused.

## Synthetic check list (configure as external gates)

- Web `GET /api/health` → 200, `service: "web"`.
- Worker `GET /api/health` → 200, `service: "worker"`.
- Login path.
- Signup path.
- One representative webhook path (Stripe ingress).

## Triage playbooks

### Queue lag
1. `/admin/jobs` — which queue has rising `waiting` / `delayed`?
2. Confirm worker is up (worker `/api/health`).
3. Check Sentry for repeated failures on that queue's handler.
4. Filter logs by `worker_job_id` / `correlation_id` for a stuck unit.

### LLM fallback-rate spike
1. Confirm OpenAI is the failing provider (logs on `ResponseGeneratorWorker`).
2. Check provider status; the Anthropic fallback should be carrying traffic.
3. If both degraded, expect generation backlog — comms, do not force-post.

### Moderation spike (Wave 3 later PR)
1. `/admin/flagged` volume + reasons.
2. Distinguish a real bad-output pattern from a false-positive rule.
3. Tune thresholds via the alert-tuning runbook; never auto-approve.

### Stripe webhook lag
1. `/admin/jobs` outbox + Stripe ingress errors in Sentry.
2. Verify signature/secret config; check reconcile pollers are running.
```

- [ ] **Step 2: Create `docs/runbooks/oncall-3am.md`**

```markdown
# On-Call: The 3 A.M. Test

What is worth waking up for, and what waits until morning.

## Wake up (P0)
- Web or worker `/api/health` failing repeatedly.
- Stripe webhooks failing → billing state diverging.
- Any tenant-isolation / auth breach signal.
- Outbox `failed` climbing fast (durable work being lost).

## Wait until morning (P1/P2)
- A single queue lagging but draining.
- Elevated LLM fallback rate while responses still generate (fallback works).
- Moderation false-positive spike (drafts are held, not mis-sent — safe by design).
- Cosmetic Sentry noise.

## First five minutes
1. Both `/api/health` endpoints.
2. `/admin/jobs`: outbox `failed` + `pending`, per-queue depth.
3. Sentry: newest unresolved issue.
4. Pick one failing unit; filter logs by its `correlation_id`.
5. Decide severity using `observability.md`, then act or defer.

## Guardrails
- Never bypass the approval step to "unblock" posting.
- Never disable moderation to clear a flagged backlog.
- Prefer pausing a queue over deleting jobs.
```

- [ ] **Step 3: Create `docs/runbooks/alert-tuning.md`**

```markdown
# Alert Tuning

Keep alerts trustworthy: a noisy alert is a disabled alert.

## Target
- No more than ~5 false alerts per week.
- Every P0/P1 alert maps to a triage playbook in `observability.md`.

## Weekly false-alert review
1. List every alert that fired in the last 7 days.
2. Tag each: actionable / false / duplicate.
3. For each false alert: raise threshold, add a debounce window, or delete it.
4. For each missed real incident: add or tighten an alert.

## Candidate alerts (configure in Sentry / log vendor as external gates)
- Worker or web health failing (P0).
- Outbox `failed` rate / count threshold (P1).
- LLM fallback rate over a rolling window (P2 → P1 if sustained).
- Moderation flag rate spike (P2).
- Stripe webhook error rate (P1).

## Tuning principles
- Alert on symptoms users feel, not on every error line.
- Prefer rate/duration thresholds over single-event triggers.
- Each alert names its runbook section.
```

- [ ] **Step 4: Commit**

```bash
git add docs/runbooks/observability.md docs/runbooks/oncall-3am.md docs/runbooks/alert-tuning.md
git commit -m "docs(observability): add on-call, observability, and alert-tuning runbooks"
```

---

## Task 9: Living-docs update + full verification

**Files:**
- Modify: `.claude/CLAUDE.md`

- [ ] **Step 1: Add a structured-logging note to project context**

In `.claude/CLAUDE.md`, under the `## Tech stack (non-obvious choices)` section, add a bullet after the Analytics bullet:

```markdown
- **Structured logging (Wave 3, PR 1).** `createWorkerLogger(prefix,
  correlationId)` emits one JSON object per line (`src/lib/shared/logger.ts`).
  Per-request/job IDs propagate via `AsyncLocalStorage`
  (`src/lib/shared/log-context.ts`); `worker/job-log-context.ts`
  (`withJobLogContext`) binds job-data IDs at BullMQ registration in
  `worker/index.ts`. Never log raw review/response text, tokens, secrets, or
  MFA codes — object args pass through the analytics blocked-key sanitizer,
  but string args are logged verbatim. Background pollers are not yet
  context-bound (later PR).
```

- [ ] **Step 2: Run the full PR-1 test surface**

Run:
```bash
pnpm vitest run \
  src/lib/shared/__tests__/log-context.test.ts \
  src/lib/shared/__tests__/logger.test.ts \
  worker/__tests__/job-log-context.test.ts \
  src/app/api/health/__tests__/route.test.ts \
  scripts/ci/__tests__/analytics-events-audit.test.ts
```
Expected: all suites PASS.

- [ ] **Step 3: Run the guards + full quality gate**

Run: `pnpm ci:analytics-events && pnpm lint && pnpm typecheck && pnpm test && pnpm build`
Expected: audit passes, lint/typecheck clean, full unit suite green, Next.js build succeeds.

> If `pnpm test` surfaces a pre-existing failing suite unrelated to PR 1, note it and confirm it fails on a clean `main` checkout before treating it as a regression.

- [ ] **Step 4: Commit**

```bash
git add .claude/CLAUDE.md
git commit -m "docs(observability): note structured logging + log-context invariant"
```

---

## Self-Review

**1. Spec coverage (Sub-Spec 07 design + acceptance criteria):**

| Spec item | Task |
|---|---|
| Structured JSON logger, fields, blocked-key redaction, error serialization | Task 2 |
| `createWorkerLogger` API preserved | Task 2 (signature unchanged) |
| Log context module (`withLogContext/getLogContext/mergeLogContext/createRequestId`) | Task 1 |
| Context bound on critical worker paths + propagation test | Task 3 |
| Next.js `GET /api/health` + focused test | Task 4 |
| Worker health `service: "worker"` | Task 5 |
| Admin queue visibility, read-only | Task 6 (enrich existing) |
| Analytics taxonomy expanded to typed entries | Task 7 (Step 5) |
| Analytics audit runnable locally + wired to CI | Task 7 |
| Runbooks: observability, on-call, alert tuning | Task 8 |

**Deliberately deferred (stated in Scope decisions, tracked for later PRs):** poller context binding; `admin_queue_viewed` event; AAL2 on the queue page; the optional call-site string-literal scan in the audit; the no-raw-`console` lint gate. All are explicitly out of the spec's launch gate for this slice.

**2. Placeholder scan:** No "TBD/implement later/add error handling" steps; every code step contains full code; every command lists expected output.

**3. Type consistency:** `LogContext` field names are identical across `log-context.ts`, `logger.ts` (`CONTEXT_FIELDS`), and `job-log-context.ts`. `WorkerLogger` and `createWorkerLogger(prefix, correlationId)` are unchanged, so existing call sites compile. `auditAnalyticsEvents(codeEvents, docText)` and `AnalyticsAuditFinding{event, reason}` match between script and test.
</content>
</invoke>
