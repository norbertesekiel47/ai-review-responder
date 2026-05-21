# Worker Index Failure Extraction (Group A, PR #1) — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Extract three concerns out of `worker/index.ts` (607 → ~320 lines): Sentry init/scrubber, the `ingestZernioReviewWorker.on('failed')` hook, and the `publisherWorker.on('failed')` hook. Apply the new CLAUDE.md invariant *"Entry points orchestrate; modules own failure behavior"* — every error-handling branch ≥30 lines lives behind a named module interface with focused tests.

**Architecture:** Three new files (`worker/sentry.ts`, `worker/jobs/zernio/ingest-failed-hook.ts`, `worker/jobs/publisher/failed-hook.ts`) plus two new test files. `worker/index.ts` becomes pure registration + lifecycle (Worker constructors, breadcrumb wiring, Fastify boot, signal handlers). Behavior preservation: every Sentry tag, error message, log prefix, and DB write is byte-equal pre/post — pure code-motion + glue change.

**Tech Stack:** TypeScript, BullMQ, Fastify, Sentry (`@sentry/node`), PostgreSQL (Postgres.js), Vitest, pnpm.

**Branch:** `refactor/worker-index-failure-extraction` off `main`.

**Source spec:** `docs/superpowers/specs/2026-05-05-entry-point-modularization-design.md` § "PR #1 — `worker/index.ts`".

---

## File Map

| File | Action | Responsibility |
|---|---|---|
| `worker/sentry.ts` | **Create** | Sentry init + recursive `scrubObject` helper + `export { Sentry }` |
| `worker/jobs/zernio/ingest-failed-hook.ts` | **Create** | `handleIngestFailed` orchestrator + private branch helpers for the three typed errors + generic fall-through |
| `worker/jobs/zernio/__tests__/ingest-failed-hook.test.ts` | **Create** | Branch tests for all four ingest exhaustion paths |
| `worker/jobs/publisher/failed-hook.ts` | **Create** | `handlePublisherFailed` orchestrator + private branch helpers for the four error types + last-resort handler-crash branch |
| `worker/jobs/publisher/__tests__/failed-hook.test.ts` | **Create** | Branch tests for verification-indeterminate, bare-transient defensive, transient-with-context (success + fallback-failed), unknown-exhausted, last-resort crash |
| `worker/index.ts` | Modify | Drop the inline Sentry block (lines 1–37). Replace inline `*.on('failed', ...)` callbacks with imports. Top-of-file `import * as Sentry from '@sentry/node'` becomes `import { Sentry } from './sentry'`. |

**No file deletions. No package additions. No env var changes.**

---

## Pre-flight — branch + tooling sanity

- [ ] **Step 1: Verify clean main**

```bash
git status
git log --oneline -3
```

Expected: working tree clean (other than `.claude/CLAUDE.md` if still uncommitted from spec session — leave it alone, it's the user's invariant change). Branch is `main`.

- [ ] **Step 2: Create the work branch**

```bash
git checkout -b refactor/worker-index-failure-extraction
```

- [ ] **Step 3: Confirm tests run from a known-good baseline**

```bash
pnpm test -- worker/jobs/zernio/__tests__/ZernioReviewIngestWorker.test.ts worker/jobs/publisher/__tests__/publisher-error-handlers.test.ts
```

Expected: PASS. If these don't pass on `main`, stop and ask the user — the failure isn't caused by this refactor and the green/red signal will be unreliable.

---

## Task 1: Extract Sentry to `worker/sentry.ts`

Lowest-risk warmup. No new tests (the scrubber is pure and trivial; see spec Test-seam rule).

**Files:**
- Create: `worker/sentry.ts`
- Modify: `worker/index.ts:1-37` (remove block) and `worker/index.ts:1-2` (new imports)

- [ ] **Step 1: Create `worker/sentry.ts` with the existing block, verbatim**

Write the file. Content is byte-copied from `worker/index.ts:1-37`, with the import-order comment refreshed to match the new file's role. **Do not change any logic.**

```typescript
import * as Sentry from '@sentry/node';

/** Recursively scrub sensitive keys from any object */
function scrubObject(obj: Record<string, unknown>): void {
  const sensitiveKeys = /key|secret|token|password|authorization/i;
  for (const key of Object.keys(obj)) {
    if (sensitiveKeys.test(key)) {
      obj[key] = '[REDACTED]';
    } else if (Array.isArray(obj[key])) {
      for (const item of obj[key] as unknown[]) {
        if (item && typeof item === 'object') {
          scrubObject(item as Record<string, unknown>);
        }
      }
    } else if (obj[key] && typeof obj[key] === 'object') {
      scrubObject(obj[key] as Record<string, unknown>);
    }
  }
}

Sentry.init({
  dsn: process.env.SENTRY_DSN,
  tracesSampleRate: 0.1,
  environment: process.env.NODE_ENV ?? 'development',
  beforeSend(event) {
    if (event.extra) scrubObject(event.extra as Record<string, unknown>);
    if (event.request?.headers) scrubObject(event.request.headers as Record<string, unknown>);
    if (event.request?.data && typeof event.request.data === 'object') {
      scrubObject(event.request.data as Record<string, unknown>);
    }
    return event;
  },
});

export { Sentry };
```

- [ ] **Step 2: Update `worker/index.ts` to import from the new file**

Replace the entire block at `worker/index.ts:1-37` with two import lines:

```typescript
import './env'; // Must be first — loads .env.local before other modules read process.env
import { Sentry } from './sentry';
```

Then **verify there is no remaining `import * as Sentry from '@sentry/node'`** anywhere in `worker/index.ts`. Use Grep:

```bash
# In your editor or via the Grep tool — must return zero matches in worker/index.ts
grep -n "from '@sentry/node'" worker/index.ts
```

If a stray import survives, future contributors might bypass the configured scrubber. Fix it now.

- [ ] **Step 3: Type-check**

```bash
pnpm tsc --noEmit
```

Expected: clean exit (no TS errors).

- [ ] **Step 4: Run all worker tests to confirm no regression**

```bash
pnpm test -- worker/
```

Expected: all worker tests pass. None should reference `worker/sentry.ts` directly yet.

- [ ] **Step 5: Smoke-test the worker boots**

```bash
MOCK_EXTERNAL_APIS=true pnpm worker
```

Expected: process starts, prints `[worker] Feature flags: ...`, prints `Worker service running on port 3001`. Send `Ctrl+C` to shut down. Verify shutdown is clean (`Shutting down worker...` line appears, exit code 0).

If Sentry.init silently failed (e.g. missing DSN), the worker still starts — `@sentry/node` no-ops without a DSN. That's expected; the smoke test is checking module-load order, not Sentry traffic.

- [ ] **Step 6: Commit**

```bash
git add worker/sentry.ts worker/index.ts
git commit -m "refactor(worker): extract Sentry init to worker/sentry.ts"
```

---

## Task 2: Test red — ingest failed-hook `handleReviewNotFound` branch

TDD red: write the test for the first branch. The function under test does not exist yet, so the test fails on import.

**Files:**
- Create: `worker/jobs/zernio/__tests__/ingest-failed-hook.test.ts`

- [ ] **Step 1: Write the test file with the first branch test**

```typescript
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Job } from 'bullmq';
import type { IngestZernioReviewPayload } from '../../../../src/lib/shared/worker-types';

const { sqlReturnQueue, mockSql, mockMarkOutboxFailed } = vi.hoisted(() => {
  const sqlReturnQueue: unknown[] = [];
  const mockSql: any = vi.fn((_s: TemplateStringsArray, ..._v: unknown[]) => {
    const result = sqlReturnQueue.shift() ?? Object.assign([], { count: 0 });
    return Promise.resolve(result);
  });
  return { sqlReturnQueue, mockSql, mockMarkOutboxFailed: vi.fn() };
});

vi.mock('../../../../src/lib/db/server', () => ({ sql: mockSql, jsonb: (v: unknown) => v }));
vi.mock('../../../../src/lib/shared/outbox', () => ({
  markOutboxFailed: mockMarkOutboxFailed,
  extractOutboxHandle: (d: any, fallback: string) => ({
    outboxId: (d && typeof d.outbox_id === 'string') ? d.outbox_id : fallback,
    attempt: (d && typeof d.outbox_attempt === 'number') ? d.outbox_attempt : undefined,
  }),
}));
vi.mock('@sentry/node', () => ({ captureMessage: vi.fn(), captureException: vi.fn() }));

import { handleIngestFailed } from '../ingest-failed-hook';
import { ZernioIngestReviewNotFoundError } from '../ZernioReviewIngestWorker';

function makeJob(
  overrides: Partial<IngestZernioReviewPayload> = {},
  attemptsMade = 5,
  maxAttempts = 5,
): Job<IngestZernioReviewPayload> {
  return {
    id: 'job-1',
    data: {
      business_id: 'biz-1',
      zernio_account_id: 'acct-1',
      zernio_location_id: 'loc-1',
      zernio_review_id: 'rev-abc',
      outbox_id: 'outbox-1',
      outbox_attempt: 1,
      ...overrides,
    },
    attemptsMade,
    opts: { attempts: maxAttempts },
  } as unknown as Job<IngestZernioReviewPayload>;
}

beforeEach(() => {
  vi.resetAllMocks();
  sqlReturnQueue.length = 0;
});

describe('handleIngestFailed', () => {
  describe('ZernioIngestReviewNotFoundError', () => {
    it('inserts review_exception with type zernio_review_not_found and marks outbox failed', async () => {
      const err = new ZernioIngestReviewNotFoundError({
        businessId: 'biz-1',
        zernioReviewId: 'rev-abc',
        zernioAccountId: 'acct-1',
        zernioLocationId: 'loc-1',
        pagesWalked: 2,
        reviewsSeen: 78,
      });

      await handleIngestFailed(makeJob(), err);

      expect(mockSql).toHaveBeenCalledTimes(1);
      const sqlCallArgs = mockSql.mock.calls[0];
      const stringPart = (sqlCallArgs[0] as TemplateStringsArray).join('?');
      expect(stringPart).toContain('INSERT INTO review_exceptions');
      expect(stringPart).toContain("'zernio_review_not_found'");
      expect(stringPart).toContain('ON CONFLICT (business_id, type, (payload->>\'provider_review_id\'))');

      expect(mockMarkOutboxFailed).toHaveBeenCalledWith(
        'outbox-1',
        'zernio_review_not_found_after_retries',
        1,
      );
    });

    it('does not call sql when attemptsMade < max attempts (still retrying)', async () => {
      const err = new ZernioIngestReviewNotFoundError({
        businessId: 'biz-1',
        zernioReviewId: 'rev-abc',
        zernioAccountId: 'acct-1',
        zernioLocationId: 'loc-1',
        pagesWalked: 1,
        reviewsSeen: 25,
      });

      await handleIngestFailed(makeJob({}, 2, 5), err);

      expect(mockSql).not.toHaveBeenCalled();
      expect(mockMarkOutboxFailed).not.toHaveBeenCalled();
    });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
pnpm test -- worker/jobs/zernio/__tests__/ingest-failed-hook.test.ts
```

Expected: FAIL with `Cannot find module '../ingest-failed-hook'` (the file doesn't exist).

---

## Task 3: Green — implement `ingest-failed-hook.ts` with `handleReviewNotFound`

Move the `ZernioIngestReviewNotFoundError` branch (`worker/index.ts:166-187`) verbatim into the new module. Add the orchestrator and the `attemptsMade < attempts` early return.

**Files:**
- Create: `worker/jobs/zernio/ingest-failed-hook.ts`

- [ ] **Step 1: Write the module**

```typescript
import type { Job } from 'bullmq';
import { v7 as uuidv7 } from 'uuid';
import { sql, jsonb } from '../../../src/lib/db/server';
import { extractOutboxHandle, markOutboxFailed } from '../../../src/lib/shared/outbox';
import {
  ZernioIngestReviewNotFoundError,
} from './ZernioReviewIngestWorker';
import type { IngestZernioReviewPayload } from '../../../src/lib/shared/worker-types';

/**
 * Final-attempt exhaustion handler for ZernioReviewIngestWorker. Typed errors
 * from the worker (ZernioIngestReviewNotFoundError, ZernioIngestPaginationCapExhaustedError,
 * ZernioIngestUnparseableLocationError) escalate to review_exceptions after BullMQ retries
 * are exhausted; the admin notify is deliberately skipped for review_not_found (high-volume
 * during Zernio outages would spam admin email; ops watches the table).
 */
export async function handleIngestFailed(
  job: Job<IngestZernioReviewPayload> | undefined,
  err: unknown,
): Promise<void> {
  if (!job) return;
  if (job.attemptsMade < (job.opts.attempts ?? 5)) return; // not yet exhausted

  const { outboxId, attempt: outboxAttempt } = extractOutboxHandle(job.data, job.id!);

  if (err instanceof ZernioIngestReviewNotFoundError) {
    await handleReviewNotFound(err, outboxId, outboxAttempt);
    return;
  }

  // Anything else: bare markOutboxFailed (existing behavior).
  const reason = err instanceof Error ? err.message : String(err);
  await markOutboxFailed(outboxId, reason, outboxAttempt);
}

async function handleReviewNotFound(
  err: ZernioIngestReviewNotFoundError,
  outboxId: string,
  outboxAttempt: number | undefined,
): Promise<void> {
  await sql`
    INSERT INTO review_exceptions (id, business_id, type, status, payload)
    VALUES (
      ${uuidv7()}, ${err.businessId}, 'zernio_review_not_found', 'open',
      ${jsonb({
        provider: 'zernio',
        provider_review_id: err.zernioReviewId,
        zernio_account_id: err.zernioAccountId,
        zernio_location_id: err.zernioLocationId,
        pages_walked: err.pagesWalked,
        reviews_seen: err.reviewsSeen,
        retries_exhausted_at: new Date().toISOString(),
      })}
    )
    ON CONFLICT (business_id, type, (payload->>'provider_review_id'))
      WHERE status = 'open' AND review_id IS NULL
    DO NOTHING
  `;
  await markOutboxFailed(outboxId, 'zernio_review_not_found_after_retries', outboxAttempt);
}
```

- [ ] **Step 2: Run test to verify it passes**

```bash
pnpm test -- worker/jobs/zernio/__tests__/ingest-failed-hook.test.ts
```

Expected: PASS, both `it()` blocks green.

- [ ] **Step 3: Commit**

```bash
git add worker/jobs/zernio/ingest-failed-hook.ts worker/jobs/zernio/__tests__/ingest-failed-hook.test.ts
git commit -m "refactor(worker): extract ingest review-not-found branch to ingest-failed-hook"
```

---

## Task 4: Red+Green — `handlePaginationCapExhausted` branch

**Files:**
- Modify: `worker/jobs/zernio/__tests__/ingest-failed-hook.test.ts` (add new `describe`)
- Modify: `worker/jobs/zernio/ingest-failed-hook.ts` (add branch)

- [ ] **Step 1: Add test describe block at the bottom of the test file (above the closing brace of the outer `describe('handleIngestFailed')`)**

Add this code block — it goes inside the outer `describe('handleIngestFailed', () => { ... })` after the existing `ZernioIngestReviewNotFoundError` describe.

```typescript
  describe('ZernioIngestPaginationCapExhaustedError', () => {
    it('inserts cap-exhausted exception, captures Sentry warning, marks outbox failed', async () => {
      const Sentry = await import('@sentry/node');
      const { ZernioIngestPaginationCapExhaustedError } = await import('../ZernioReviewIngestWorker');

      // Constructor takes positional args: (businessId, zernioAccountId, zernioLocationId, zernioReviewId, cap, reviewsSeen).
      const err = new ZernioIngestPaginationCapExhaustedError(
        'biz-1', 'acct-1', 'loc-1', 'rev-abc', 4, 200,
      );

      await handleIngestFailed(makeJob(), err);

      const stringPart = (mockSql.mock.calls[0]![0] as TemplateStringsArray).join('?');
      expect(stringPart).toContain("'zernio_pagination_cap_exhausted'");

      expect(Sentry.captureMessage).toHaveBeenCalledWith(
        'zernio_pagination_cap_exhausted',
        expect.objectContaining({
          level: 'warning',
          tags: expect.objectContaining({
            worker: 'ingest_zernio_review',
            kind: 'pagination_cap_exhausted',
          }),
          extra: expect.objectContaining({
            business_id: 'biz-1',
            cap: 4,
            reviews_seen: 200,
          }),
        }),
      );

      expect(mockMarkOutboxFailed).toHaveBeenCalledWith(
        'outbox-1',
        'zernio_pagination_cap_exhausted',
        1,
      );
    });
  });
```

- [ ] **Step 2: Run test — it fails**

```bash
pnpm test -- worker/jobs/zernio/__tests__/ingest-failed-hook.test.ts
```

Expected: FAIL — the new branch isn't dispatched yet.

- [ ] **Step 3: Add the branch to `handleIngestFailed`**

In `worker/jobs/zernio/ingest-failed-hook.ts`:

1. Add to the imports from `./ZernioReviewIngestWorker`:

```typescript
import {
  ZernioIngestReviewNotFoundError,
  ZernioIngestPaginationCapExhaustedError,
} from './ZernioReviewIngestWorker';
```

2. Add `import * as Sentry from '@sentry/node';` to the import block.

3. Insert the branch into `handleIngestFailed` after the `handleReviewNotFound` dispatch and before the generic fall-through:

```typescript
  if (err instanceof ZernioIngestPaginationCapExhaustedError) {
    await handlePaginationCapExhausted(err, outboxId, outboxAttempt);
    return;
  }
```

4. Add the helper at file scope (below `handleReviewNotFound`):

```typescript
async function handlePaginationCapExhausted(
  err: ZernioIngestPaginationCapExhaustedError,
  outboxId: string,
  outboxAttempt: number | undefined,
): Promise<void> {
  await sql`
    INSERT INTO review_exceptions (id, business_id, type, status, payload)
    VALUES (
      ${uuidv7()}, ${err.businessId}, 'zernio_pagination_cap_exhausted', 'open',
      ${jsonb({
        provider: 'zernio',
        provider_review_id: err.zernioReviewId,
        zernio_account_id: err.zernioAccountId,
        zernio_location_id: err.zernioLocationId,
        cap: err.cap,
        // pages_walked == cap in the cap-exhausted branch (we walked
        // every page allowed); included alongside cap so ops can compare
        // payloads across exception types without special-casing.
        pages_walked: err.cap,
        reviews_seen: err.reviewsSeen,
        retries_exhausted_at: new Date().toISOString(),
      })}
    )
    ON CONFLICT (business_id, type, (payload->>'provider_review_id'))
      WHERE status = 'open' AND review_id IS NULL
    DO NOTHING
  `;
  // Trend-only Sentry signal — admin notify is intentionally skipped
  // (potential high-volume), but ops needs visibility on cap-exhaustion
  // rate so the cap can be tuned via ZERNIO_INGEST_MAX_PAGES.
  Sentry.captureMessage('zernio_pagination_cap_exhausted', {
    level: 'warning',
    tags: {
      worker: 'ingest_zernio_review',
      kind: 'pagination_cap_exhausted',
    },
    extra: {
      business_id: err.businessId,
      zernio_account_id: err.zernioAccountId,
      zernio_location_id: err.zernioLocationId,
      zernio_review_id: err.zernioReviewId,
      cap: err.cap,
      reviews_seen: err.reviewsSeen,
    },
  });
  await markOutboxFailed(outboxId, 'zernio_pagination_cap_exhausted', outboxAttempt);
}
```

- [ ] **Step 4: Run test — it passes**

```bash
pnpm test -- worker/jobs/zernio/__tests__/ingest-failed-hook.test.ts
```

Expected: PASS, all blocks green.

- [ ] **Step 5: Commit**

```bash
git add worker/jobs/zernio/ingest-failed-hook.ts worker/jobs/zernio/__tests__/ingest-failed-hook.test.ts
git commit -m "refactor(worker): extract ingest pagination-cap branch to ingest-failed-hook"
```

---

## Task 5: Red+Green — `handleUnparseableLocation` branch

This branch is the only one that emits a `notify_admin_review_exception` outbox row (and only when the exception INSERT returned a row).

**Files:**
- Modify: `worker/jobs/zernio/__tests__/ingest-failed-hook.test.ts`
- Modify: `worker/jobs/zernio/ingest-failed-hook.ts`

- [ ] **Step 1: Add test describe block (inside outer `describe('handleIngestFailed')`)**

```typescript
  describe('ZernioIngestUnparseableLocationError', () => {
    it('inserts exception, enqueues admin notify, marks outbox failed', async () => {
      const { ZernioIngestUnparseableLocationError } = await import('../ZernioReviewIngestWorker');

      // First sql call: INSERT review_exceptions … RETURNING id (yields a row).
      // Second sql call: INSERT job_outbox notify_admin_review_exception.
      sqlReturnQueue.push(Object.assign([{ id: 'exc-1' }], { count: 1 }));
      sqlReturnQueue.push(Object.assign([], { count: 1 }));

      // Constructor takes positional args: (businessId, zernioAccountId, zernioLocationId, zernioReviewId, reviewName).
      const err = new ZernioIngestUnparseableLocationError(
        'biz-1', 'acct-1', 'loc-1', 'rev-abc', 'malformed/review/name',
      );

      await handleIngestFailed(makeJob(), err);

      expect(mockSql).toHaveBeenCalledTimes(2);
      const firstSql = (mockSql.mock.calls[0]![0] as TemplateStringsArray).join('?');
      expect(firstSql).toContain("'zernio_unparseable_review_name'");

      const secondSql = (mockSql.mock.calls[1]![0] as TemplateStringsArray).join('?');
      expect(secondSql).toContain('INSERT INTO job_outbox');
      expect(secondSql).toContain("'notify_admin_review_exception'");

      expect(mockMarkOutboxFailed).toHaveBeenCalledWith(
        'outbox-1',
        'zernio_unparseable_review_name',
        1,
      );
    });

    it('skips admin notify when exception INSERT was deduped (no row returned)', async () => {
      const { ZernioIngestUnparseableLocationError } = await import('../ZernioReviewIngestWorker');

      // INSERT review_exceptions returned 0 rows (existing open exception suppressed via ON CONFLICT).
      sqlReturnQueue.push(Object.assign([], { count: 0 }));

      const err = new ZernioIngestUnparseableLocationError(
        'biz-1', 'acct-1', 'loc-1', 'rev-abc', 'malformed/review/name',
      );

      await handleIngestFailed(makeJob(), err);

      expect(mockSql).toHaveBeenCalledTimes(1);
      expect(mockMarkOutboxFailed).toHaveBeenCalledWith(
        'outbox-1',
        'zernio_unparseable_review_name',
        1,
      );
    });
  });
```

- [ ] **Step 2: Run test — it fails**

```bash
pnpm test -- worker/jobs/zernio/__tests__/ingest-failed-hook.test.ts
```

Expected: FAIL — the unparseable branch isn't dispatched yet.

- [ ] **Step 3: Add the branch and helper**

1. Extend the import:

```typescript
import {
  ZernioIngestReviewNotFoundError,
  ZernioIngestPaginationCapExhaustedError,
  ZernioIngestUnparseableLocationError,
} from './ZernioReviewIngestWorker';
```

2. Add to `handleIngestFailed` after the cap-exhausted dispatch:

```typescript
  if (err instanceof ZernioIngestUnparseableLocationError) {
    await handleUnparseableLocation(err, outboxId, outboxAttempt);
    return;
  }
```

3. Add helper at file scope:

```typescript
async function handleUnparseableLocation(
  err: ZernioIngestUnparseableLocationError,
  outboxId: string,
  outboxAttempt: number | undefined,
): Promise<void> {
  const [exception] = await sql<{ id: string }[]>`
    INSERT INTO review_exceptions (id, business_id, type, status, payload)
    VALUES (
      ${uuidv7()}, ${err.businessId}, 'zernio_unparseable_review_name', 'open',
      ${jsonb({
        provider: 'zernio',
        provider_review_id: err.zernioReviewId,
        zernio_account_id: err.zernioAccountId,
        zernio_location_id: err.zernioLocationId,
        review_name_truncated: err.reviewName.slice(0, 500),
        retries_exhausted_at: new Date().toISOString(),
      })}
    )
    ON CONFLICT (business_id, type, (payload->>'provider_review_id'))
      WHERE status = 'open' AND review_id IS NULL
    DO NOTHING
    RETURNING id
  `;

  if (exception) {
    // Unparseable shape DOES warrant admin notify — signals contract change.
    await sql`
      INSERT INTO job_outbox (id, topic, aggregate_type, aggregate_id, payload, attempts, max_attempts)
      VALUES (
        ${uuidv7()}, 'notify_admin_review_exception', 'business',
        ${err.businessId},
        ${jsonb({ review_exception_id: exception.id, business_id: err.businessId })},
        0, 5
      )
    `;
  }
  await markOutboxFailed(outboxId, 'zernio_unparseable_review_name', outboxAttempt);
}
```

- [ ] **Step 4: Run tests — they pass**

```bash
pnpm test -- worker/jobs/zernio/__tests__/ingest-failed-hook.test.ts
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add worker/jobs/zernio/ingest-failed-hook.ts worker/jobs/zernio/__tests__/ingest-failed-hook.test.ts
git commit -m "refactor(worker): extract ingest unparseable-location branch to ingest-failed-hook"
```

---

## Task 6: Red+Green — generic fall-through branch

The fall-through is already in `handleIngestFailed` from Task 3, but it has no test. Add one for completeness.

**Files:**
- Modify: `worker/jobs/zernio/__tests__/ingest-failed-hook.test.ts`

- [ ] **Step 1: Add test describe block**

```typescript
  describe('generic fall-through', () => {
    it('marks outbox failed with the error message for unknown error types', async () => {
      const err = new Error('something unexpected blew up');

      await handleIngestFailed(makeJob(), err);

      expect(mockSql).not.toHaveBeenCalled();
      expect(mockMarkOutboxFailed).toHaveBeenCalledWith(
        'outbox-1',
        'something unexpected blew up',
        1,
      );
    });

    it('stringifies non-Error throwables', async () => {
      await handleIngestFailed(makeJob(), 'plain string error');

      expect(mockMarkOutboxFailed).toHaveBeenCalledWith(
        'outbox-1',
        'plain string error',
        1,
      );
    });

    it('returns without action when job is undefined', async () => {
      await handleIngestFailed(undefined, new Error('whatever'));
      expect(mockSql).not.toHaveBeenCalled();
      expect(mockMarkOutboxFailed).not.toHaveBeenCalled();
    });
  });
```

- [ ] **Step 2: Run tests**

```bash
pnpm test -- worker/jobs/zernio/__tests__/ingest-failed-hook.test.ts
```

Expected: PASS — fall-through is already implemented.

- [ ] **Step 3: Commit**

```bash
git add worker/jobs/zernio/__tests__/ingest-failed-hook.test.ts
git commit -m "test(worker): add fall-through coverage for ingest-failed-hook"
```

---

## Task 7: Wire `handleIngestFailed` into `worker/index.ts`

Replace the inline ~117 lines (`worker/index.ts:160-277`) with a one-line import + delegation.

**Files:**
- Modify: `worker/index.ts`

- [ ] **Step 1: Update imports**

In the import block at the top of `worker/index.ts`, find the existing import from `./jobs/zernio/ZernioReviewIngestWorker` and **leave it unchanged** (it still re-exports the error classes so the new module can import them).

Add this new import (group it with the other `./jobs/...` imports):

```typescript
import { handleIngestFailed } from './jobs/zernio/ingest-failed-hook';
```

- [ ] **Step 2: Replace the inline `.on('failed', ...)` block**

Delete the entire body at `worker/index.ts:160-277` (the `ingestZernioReviewWorker.on('failed', async (job, err) => { ... });` block). Replace it with a single line:

```typescript
ingestZernioReviewWorker.on('failed', handleIngestFailed);
```

After the edit, verify with Grep that no orphan `ZernioIngestReviewNotFoundError`, `ZernioIngestPaginationCapExhaustedError`, `ZernioIngestUnparseableLocationError`, or `extractOutboxHandle` references remain in `worker/index.ts` that aren't tied to the publisher hook (which still has its own block).

```bash
grep -n "ZernioIngest\(ReviewNotFound\|PaginationCap\|Unparseable\)" worker/index.ts
# Expected: no matches.

grep -n "extractOutboxHandle" worker/index.ts
# Expected: still appears in the publisher hook (lines ~302-303). That's fine.
```

If the publisher hook's `extractOutboxHandle` import has become the only user of the symbol in `worker/index.ts`, the existing import from `'../src/lib/shared/outbox'` stays for now — Task 11 will revisit imports after the publisher hook also moves out.

- [ ] **Step 3: Type-check**

```bash
pnpm tsc --noEmit
```

Expected: clean exit.

- [ ] **Step 4: Run all worker tests**

```bash
pnpm test -- worker/
```

Expected: all green. Notably the existing `ZernioReviewIngestWorker.test.ts` continues to pass (those tests cover the worker's throw path, not the failed-hook).

- [ ] **Step 5: Smoke-test the worker**

```bash
MOCK_EXTERNAL_APIS=true pnpm worker
```

Expected: clean boot, all 16 BullMQ workers + 10 background loops initialize, `Worker service running on port 3001`. `Ctrl+C` → clean shutdown.

- [ ] **Step 6: Commit**

```bash
git add worker/index.ts
git commit -m "refactor(worker): wire handleIngestFailed into worker/index.ts"
```

---

## Task 8: Test red — publisher failed-hook `handleVerificationIndeterminate` branch

Now the publisher hook. Same TDD pattern. Start with the verification-indeterminate branch — it's the most DB-heavy (sql.begin transaction).

**Files:**
- Create: `worker/jobs/publisher/__tests__/failed-hook.test.ts`

- [ ] **Step 1: Write the test file**

```typescript
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Job } from 'bullmq';

const {
  txReturnQueue, mockSql, mockTx,
  mockMarkOutboxFailed, mockMarkOutboxCompleted,
  mockApplyTransientExhaustionFallback,
} = vi.hoisted(() => {
  const txReturnQueue: unknown[] = [];

  const mockTx: any = vi.fn((_s: TemplateStringsArray, ..._v: unknown[]) => {
    const result = txReturnQueue.shift() ?? Object.assign([], { count: 0 });
    return Promise.resolve(result);
  });

  const mockSql: any = vi.fn((_s: TemplateStringsArray, ..._v: unknown[]) => {
    const result = txReturnQueue.shift() ?? Object.assign([], { count: 0 });
    return Promise.resolve(result);
  });
  mockSql.begin = vi.fn(async (cb: (tx: any) => Promise<any>) => cb(mockTx));

  return {
    txReturnQueue,
    mockSql,
    mockTx,
    mockMarkOutboxFailed: vi.fn(),
    mockMarkOutboxCompleted: vi.fn(),
    mockApplyTransientExhaustionFallback: vi.fn(),
  };
});

vi.mock('../../../../src/lib/db/server', () => ({ sql: mockSql, jsonb: (v: unknown) => v }));
vi.mock('../../../../src/lib/shared/outbox', () => ({
  markOutboxFailed: mockMarkOutboxFailed,
  markOutboxCompleted: mockMarkOutboxCompleted,
  extractOutboxHandle: (d: any, fallback: string) => ({
    outboxId: (d && typeof d.outbox_id === 'string') ? d.outbox_id : fallback,
    attempt: (d && typeof d.outbox_attempt === 'number') ? d.outbox_attempt : undefined,
  }),
}));
vi.mock('../../../../src/lib/publishing/zernio-publisher', () => ({
  applyTransientExhaustionFallback: mockApplyTransientExhaustionFallback,
}));
vi.mock('@sentry/node', () => ({
  captureException: vi.fn(),
  captureMessage: vi.fn(),
}));

import { handlePublisherFailed } from '../failed-hook';
import { ZernioReplyVerificationIndeterminateError, PublisherTransientWithContext } from '../publisher-error-handlers';
import { ZernioTransientError } from '../../../../src/lib/zernio/errors';
import type { PublishResponsePayload } from '../../../../src/lib/shared/worker-types';

function makeJob(
  overrides: Partial<PublishResponsePayload> = {},
  attemptsMade = 1,
  maxAttempts = 1,
): Job<PublishResponsePayload> {
  return {
    id: 'job-pub-1',
    data: {
      response_id: 'resp-1',
      business_id: 'biz-1',
      review_id: 'rev-1',
      correlation_id: 'corr-1',
      outbox_id: 'outbox-1',
      outbox_attempt: 1,
      ...overrides,
    },
    attemptsMade,
    opts: { attempts: maxAttempts },
  } as unknown as Job<PublishResponsePayload>;
}

beforeEach(() => {
  vi.resetAllMocks();
  txReturnQueue.length = 0;
  // Re-wire sql.begin since vi.resetAllMocks clears its implementation
  mockSql.begin.mockImplementation(async (cb: (tx: any) => Promise<any>) => cb(mockTx));
});

describe('handlePublisherFailed', () => {
  describe('ZernioReplyVerificationIndeterminateError', () => {
    it('runs the full terminal sequence: UPDATE responses, INSERT review_exception, INSERT outbox, markOutboxCompleted', async () => {
      // tx call 1: UPDATE responses RETURNING 1 → 1 row.
      txReturnQueue.push(Object.assign([{ '?column?': 1 }], { count: 1 }));
      // tx call 2: INSERT review_exceptions RETURNING id → 1 row.
      txReturnQueue.push(Object.assign([{ id: 'exc-1' }], { count: 1 }));
      // tx call 3: INSERT job_outbox notify_admin_review_exception.
      txReturnQueue.push(Object.assign([], { count: 1 }));

      const err = new ZernioReplyVerificationIndeterminateError({
        response_id: 'resp-1',
        business_id: 'biz-1',
        review_id: 'rev-1',
        account_id: 'acct-1',
        location_id: 'loc-1',
        zernio_review_id: 'zrv-1',
        reason: 'verifier_unknown_error',
        underlying_error: 'connection refused',
      });

      await handlePublisherFailed(makeJob(), err);

      expect(mockSql.begin).toHaveBeenCalledTimes(1);
      expect(mockTx).toHaveBeenCalledTimes(3);

      const firstCallSql = (mockTx.mock.calls[0]![0] as TemplateStringsArray).join('?');
      expect(firstCallSql).toContain('UPDATE responses');
      expect(firstCallSql).toContain("status = 'failed'");
      expect(firstCallSql).toContain("posting_error = 'zernio_reply_verification_indeterminate'");

      const secondCallSql = (mockTx.mock.calls[1]![0] as TemplateStringsArray).join('?');
      expect(secondCallSql).toContain('INSERT INTO review_exceptions');
      expect(secondCallSql).toContain("'zernio_reply_verification_indeterminate'");

      const thirdCallSql = (mockTx.mock.calls[2]![0] as TemplateStringsArray).join('?');
      expect(thirdCallSql).toContain("'notify_admin_review_exception'");

      expect(mockMarkOutboxCompleted).toHaveBeenCalledWith('outbox-1', 1);
      expect(mockMarkOutboxFailed).not.toHaveBeenCalled();
    });

    it('skips review_exception INSERT and outbox enqueue when UPDATE responses returned 0 rows (already terminal)', async () => {
      // tx call 1: UPDATE responses → 0 rows.
      txReturnQueue.push(Object.assign([], { count: 0 }));

      const err = new ZernioReplyVerificationIndeterminateError({
        response_id: 'resp-1',
        business_id: 'biz-1',
        review_id: 'rev-1',
        account_id: 'acct-1',
        location_id: 'loc-1',
        zernio_review_id: 'zrv-1',
        reason: 'review_not_found_after_pagination',
      });

      await handlePublisherFailed(makeJob(), err);

      expect(mockTx).toHaveBeenCalledTimes(1); // only the UPDATE
      expect(mockMarkOutboxCompleted).toHaveBeenCalledWith('outbox-1', 1);
    });
  });
});
```

- [ ] **Step 2: Run test — fail**

```bash
pnpm test -- worker/jobs/publisher/__tests__/failed-hook.test.ts
```

Expected: FAIL with `Cannot find module '../failed-hook'`.

---

## Task 9: Green — implement `failed-hook.ts` with `handleVerificationIndeterminate`

**Files:**
- Create: `worker/jobs/publisher/failed-hook.ts`

- [ ] **Step 1: Write the module skeleton + first branch**

```typescript
import type { Job } from 'bullmq';
import { v7 as uuidv7 } from 'uuid';
import * as Sentry from '@sentry/node';
import { sql, jsonb } from '../../../src/lib/db/server';
import {
  extractOutboxHandle,
  markOutboxFailed,
  markOutboxCompleted,
} from '../../../src/lib/shared/outbox';
import { applyTransientExhaustionFallback } from '../../../src/lib/publishing/zernio-publisher';
import { ZernioTransientError } from '../../../src/lib/zernio/errors';
import {
  PublisherTransientWithContext,
  ZernioReplyVerificationIndeterminateError,
} from './publisher-error-handlers';
import type { PublishResponsePayload } from '../../../src/lib/shared/worker-types';

/**
 * Final-attempt exhaustion handler for ResponsePublisherWorker. BullMQ retries
 * transient errors automatically; only the LAST failure (attemptsMade ===
 * opts.attempts) reaches this branch as exhaustion. For ZernioTransientError
 * at exhaustion we run the graceful-degradation fallback (disconnect + park
 * the response + notify owner). For any other unhandled error we just close
 * the outbox row so it doesn't sit in `dispatched` forever.
 */
export async function handlePublisherFailed(
  job: Job<PublishResponsePayload> | undefined,
  err: unknown,
): Promise<void> {
  // Top-level guard: any throw in extractOutboxHandle, markOutboxFailed, or
  // applyTransientExhaustionFallback bubbles into an unhandled promise
  // rejection that could crash the process. Wrap the whole body so we
  // log + Sentry-capture and never leave the outbox row in `dispatched`
  // limbo silently.
  let outboxId: string | undefined;
  let outboxAttempt: number | undefined;
  try {
    if (!job) return;
    if (job.attemptsMade < (job.opts.attempts ?? 1)) return; // not yet exhausted
    const handle = extractOutboxHandle(job.data, job.id!);
    outboxId = handle.outboxId;
    outboxAttempt = handle.attempt;

    if (err instanceof ZernioReplyVerificationIndeterminateError) {
      await handleVerificationIndeterminate(err, outboxId, outboxAttempt);
      return;
    }

    // Non-transient unhandled error: just close the outbox row.
    const reason = err instanceof Error ? err.message : String(err);
    await markOutboxFailed(outboxId, reason, outboxAttempt);
  } catch (handlerErr) {
    // Last-resort: even the markOutboxFailed call (or extractOutboxHandle,
    // or anything else above) threw. Capture loudly so the row stuck in
    // `dispatched` is observable in Sentry, and attempt one more
    // best-effort markOutboxFailed in case the original throw was upstream.
    console.error('[publisherWorker.on(failed)] handler crashed:', handlerErr);
    Sentry.captureException(handlerErr, {
      tags: { worker: 'publisher', kind: 'on_failed_handler_crash' },
    });
    if (outboxId) {
      const reason = handlerErr instanceof Error ? handlerErr.message : String(handlerErr);
      await markOutboxFailed(outboxId, `on_failed_crash: ${reason}`, outboxAttempt).catch(
        (markErr) => {
          console.error('[publisherWorker.on(failed)] best-effort markOutboxFailed failed:', markErr);
        },
      );
    }
  }
}

async function handleVerificationIndeterminate(
  err: ZernioReplyVerificationIndeterminateError,
  outboxId: string,
  outboxAttempt: number | undefined,
): Promise<void> {
  await sql.begin(async (tx) => {
    const updated = await tx`
      UPDATE responses
      SET status = 'failed',
          posting_error = 'zernio_reply_verification_indeterminate',
          updated_at = NOW()
      WHERE id = ${err.meta.response_id}
        AND business_id = ${err.meta.business_id}
        AND status IN ('approved', 'edited', 'awaiting_owner_connect')
      RETURNING 1
    `;
    if (updated.count === 0) return;

    const [exception] = await tx<{ id: string }[]>`
      INSERT INTO review_exceptions (
        id, business_id, review_id, response_id, type, payload
      ) VALUES (
        ${uuidv7()}, ${err.meta.business_id}, ${err.meta.review_id},
        ${err.meta.response_id}, 'zernio_reply_verification_indeterminate',
        ${jsonb({
          reason: err.meta.reason,
          zernio_account_id: err.meta.account_id,
          zernio_location_id: err.meta.location_id,
          zernio_review_id: err.meta.zernio_review_id,
          pages_walked: err.meta.pages_walked,
          reviews_seen: err.meta.reviews_seen,
          underlying_error: err.meta.underlying_error,
          retries_exhausted_at: new Date().toISOString(),
        })}
      )
      ON CONFLICT (review_id, type) WHERE status = 'open'
      DO UPDATE SET payload = review_exceptions.payload
      RETURNING id
    `;

    if (exception) {
      await tx`
        INSERT INTO job_outbox (
          id, topic, aggregate_type, aggregate_id, payload, attempts, max_attempts
        ) VALUES (
          ${uuidv7()}, 'notify_admin_review_exception', 'review',
          ${err.meta.review_id},
          ${jsonb({ review_exception_id: exception.id, business_id: err.meta.business_id })},
          0, 5
        )
      `;
    }
  });
  await markOutboxCompleted(outboxId, outboxAttempt);
}
```

- [ ] **Step 2: Run test — pass**

```bash
pnpm test -- worker/jobs/publisher/__tests__/failed-hook.test.ts
```

Expected: PASS, both `it()` blocks green.

- [ ] **Step 3: Commit**

```bash
git add worker/jobs/publisher/failed-hook.ts worker/jobs/publisher/__tests__/failed-hook.test.ts
git commit -m "refactor(worker): extract publisher verification-indeterminate branch to failed-hook"
```

---

## Task 10: Red+Green — `handleBareTransient` defensive branch

The bare `ZernioTransientError` (without `PublisherTransientWithContext` wrap) is the **untested-today** branch the spec specifically calls out. It logs to console.error, captures Sentry with kind `unwrapped_transient`, and marks outbox failed with a `unwrapped_transient_no_context: ${reason}` reason.

**Files:**
- Modify: `worker/jobs/publisher/__tests__/failed-hook.test.ts`
- Modify: `worker/jobs/publisher/failed-hook.ts`

- [ ] **Step 1: Add test describe block (inside outer `describe('handlePublisherFailed')`)**

```typescript
  describe('bare ZernioTransientError (defensive — missing PublisherTransientWithContext wrap)', () => {
    it('captures Sentry with kind unwrapped_transient and marks outbox failed with prefix', async () => {
      const Sentry = await import('@sentry/node');
      const consoleErrSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

      const err = new ZernioTransientError('http_5xx', { httpStatus: 503 });

      await handlePublisherFailed(makeJob(), err);

      expect(consoleErrSpy).toHaveBeenCalledWith(
        expect.stringContaining('bare ZernioTransientError reached failed-hook'),
      );
      expect(Sentry.captureException).toHaveBeenCalledWith(
        err,
        expect.objectContaining({
          tags: { worker: 'publisher', kind: 'unwrapped_transient' },
          level: 'error',
          extra: expect.objectContaining({ response_id: 'resp-1', business_id: 'biz-1' }),
        }),
      );
      expect(mockMarkOutboxFailed).toHaveBeenCalledWith(
        'outbox-1',
        expect.stringMatching(/^unwrapped_transient_no_context: /),
        1,
      );

      consoleErrSpy.mockRestore();
    });
  });
```

- [ ] **Step 2: Run test — fail**

```bash
pnpm test -- worker/jobs/publisher/__tests__/failed-hook.test.ts
```

Expected: FAIL — branch not yet implemented.

- [ ] **Step 3: Add the branch to `handlePublisherFailed`**

Insert after the `ZernioReplyVerificationIndeterminateError` dispatch and before the generic fall-through:

```typescript
    if (err instanceof ZernioTransientError) {
      // Unwrap PublisherTransientWithContext for the pinned disconnect.
      // Bare ZernioTransientError without context is now a CODE BUG —
      // every publisher path wraps transient throws (postReply, lookup,
      // 409 verifier). Surface loudly via Sentry rather than silently
      // disconnecting every active connection (the previous safety-net
      // fallback was deleted because it was unsafe with multi-connection
      // businesses).
      if (!(err instanceof PublisherTransientWithContext)) {
        console.error('[publisherWorker] bare ZernioTransientError reached failed-hook — missing PublisherTransientWithContext wrap upstream');
        Sentry.captureException(err, {
          tags: { worker: 'publisher', kind: 'unwrapped_transient' },
          level: 'error',
          extra: { response_id: job.data.response_id, business_id: job.data.business_id },
        });
        // Still close the outbox so the row doesn't stay dispatched.
        const reason = err instanceof Error ? err.message : String(err);
        await markOutboxFailed(outboxId, `unwrapped_transient_no_context: ${reason}`, outboxAttempt);
        return;
      }
      // PublisherTransientWithContext branch falls through to Task 11.
    }
```

(The fall-through-after-PublisherTransientWithContext leaves a temporary "this branch is unfinished" state — Task 11 lands the with-context handling. That's intentional TDD; for now the bare branch above is exhaustive enough that the test passes.)

- [ ] **Step 4: Run tests — pass**

```bash
pnpm test -- worker/jobs/publisher/__tests__/failed-hook.test.ts
```

Expected: PASS, three `it()` blocks green.

- [ ] **Step 5: Commit**

```bash
git add worker/jobs/publisher/failed-hook.ts worker/jobs/publisher/__tests__/failed-hook.test.ts
git commit -m "refactor(worker): extract publisher bare-transient defensive branch to failed-hook"
```

---

## Task 11: Red+Green — `handleTransientWithContext` (success + fallback-failed)

**Files:**
- Modify: `worker/jobs/publisher/__tests__/failed-hook.test.ts`
- Modify: `worker/jobs/publisher/failed-hook.ts`

- [ ] **Step 1: Add two test cases**

```typescript
  describe('PublisherTransientWithContext (success path)', () => {
    it('calls applyTransientExhaustionFallback with attempt context, marks outbox failed', async () => {
      mockApplyTransientExhaustionFallback.mockResolvedValueOnce(undefined);

      const inner = new ZernioTransientError('timeout', { httpStatus: 504 });
      const wrapped = new PublisherTransientWithContext(inner, {
        response_id: 'resp-1',
        business_id: 'biz-1',
        account_id: 'acct-X',
        location_id: 'loc-Y',
      });

      await handlePublisherFailed(makeJob(), wrapped);

      expect(mockApplyTransientExhaustionFallback).toHaveBeenCalledWith({
        response_id: 'resp-1',
        business_id: 'biz-1',
        correlation_id: 'corr-1',
        account_id: 'acct-X',
        location_id: 'loc-Y',
      });
      expect(mockMarkOutboxFailed).toHaveBeenCalledWith(
        'outbox-1',
        'zernio_transient_max_attempts',
        1,
      );
    });
  });

  describe('PublisherTransientWithContext (fallback throws)', () => {
    it('captures Sentry, marks outbox failed with fallback_failed prefix', async () => {
      const Sentry = await import('@sentry/node');
      const consoleErrSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
      const fallbackErr = new Error('disconnect call exploded');
      mockApplyTransientExhaustionFallback.mockRejectedValueOnce(fallbackErr);

      const inner = new ZernioTransientError('timeout', { httpStatus: 504 });
      const wrapped = new PublisherTransientWithContext(inner, {
        response_id: 'resp-1',
        business_id: 'biz-1',
        account_id: 'acct-X',
        location_id: 'loc-Y',
      });

      await handlePublisherFailed(makeJob(), wrapped);

      expect(Sentry.captureException).toHaveBeenCalledWith(
        fallbackErr,
        expect.objectContaining({
          tags: { worker: 'publisher', kind: 'transient_exhaustion_fallback' },
        }),
      );
      expect(mockMarkOutboxFailed).toHaveBeenCalledWith(
        'outbox-1',
        'zernio_transient_max_attempts_fallback_failed: disconnect call exploded',
        1,
      );

      consoleErrSpy.mockRestore();
    });
  });
```

- [ ] **Step 2: Run tests — fail**

Expected: FAIL — `applyTransientExhaustionFallback` is never called yet (the code falls through after the bare-transient guard).

- [ ] **Step 3: Replace the temporary fall-through with the with-context branch**

In `handlePublisherFailed`, find the `if (err instanceof ZernioTransientError) { ... }` block from Task 10. After the inner `if (!(err instanceof PublisherTransientWithContext))` early-return, replace the `// PublisherTransientWithContext branch falls through to Task 11.` comment with this body:

```typescript
      const ctx = err.attemptContext;
      try {
        await applyTransientExhaustionFallback({
          response_id: ctx.response_id,
          business_id: ctx.business_id,
          correlation_id: job.data.correlation_id,
          account_id: ctx.account_id,
          location_id: ctx.location_id,
        });
        await markOutboxFailed(outboxId, 'zernio_transient_max_attempts', outboxAttempt);
      } catch (fallbackErr) {
        // Fallback itself failed — surface the reason so ops can see it,
        // and still close the outbox so the row doesn't stay `dispatched`.
        const reason = fallbackErr instanceof Error ? fallbackErr.message : String(fallbackErr);
        console.error(`[publisherWorker] transient-exhaustion fallback failed: ${reason}`);
        Sentry.captureException(fallbackErr, {
          tags: { worker: 'publisher', kind: 'transient_exhaustion_fallback' },
        });
        await markOutboxFailed(
          outboxId,
          `zernio_transient_max_attempts_fallback_failed: ${reason}`,
          outboxAttempt,
        );
      }
      return;
```

(The trailing `return;` is critical — without it the generic `markOutboxFailed` fall-through at the bottom would re-run.)

- [ ] **Step 4: Run tests — pass**

```bash
pnpm test -- worker/jobs/publisher/__tests__/failed-hook.test.ts
```

Expected: PASS, five `it()` blocks green.

- [ ] **Step 5: Commit**

```bash
git add worker/jobs/publisher/failed-hook.ts worker/jobs/publisher/__tests__/failed-hook.test.ts
git commit -m "refactor(worker): extract publisher transient-with-context branch to failed-hook"
```

---

## Task 12: Red+Green — generic `handleUnknownExhausted` + last-resort handler-crash

**Files:**
- Modify: `worker/jobs/publisher/__tests__/failed-hook.test.ts`

- [ ] **Step 1: Add tests for the generic fall-through and the last-resort crash branch**

```typescript
  describe('generic fall-through', () => {
    it('marks outbox failed with the error message for unknown error types', async () => {
      const err = new Error('something else broke');
      await handlePublisherFailed(makeJob(), err);

      expect(mockSql.begin).not.toHaveBeenCalled();
      expect(mockMarkOutboxFailed).toHaveBeenCalledWith(
        'outbox-1',
        'something else broke',
        1,
      );
    });

    it('does not act when attemptsMade < max attempts', async () => {
      const err = new Error('transient retry not exhausted');
      await handlePublisherFailed(makeJob({}, 0, 5), err);

      expect(mockMarkOutboxFailed).not.toHaveBeenCalled();
      expect(mockMarkOutboxCompleted).not.toHaveBeenCalled();
    });

    it('returns silently when job is undefined', async () => {
      await handlePublisherFailed(undefined, new Error('whatever'));
      expect(mockMarkOutboxFailed).not.toHaveBeenCalled();
    });
  });

  describe('last-resort handler-crash', () => {
    it('captures Sentry with kind on_failed_handler_crash and best-effort marks outbox failed', async () => {
      const Sentry = await import('@sentry/node');
      const consoleErrSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

      // Force markOutboxFailed (called from the generic fall-through) to throw the FIRST time.
      // The catch block then re-attempts a best-effort call — we let the second succeed.
      mockMarkOutboxFailed
        .mockRejectedValueOnce(new Error('outbox write exploded'))
        .mockResolvedValueOnce(undefined);

      await handlePublisherFailed(makeJob(), new Error('initial'));

      expect(Sentry.captureException).toHaveBeenCalledWith(
        expect.any(Error),
        expect.objectContaining({
          tags: { worker: 'publisher', kind: 'on_failed_handler_crash' },
        }),
      );
      // Best-effort second call uses the on_failed_crash prefix.
      expect(mockMarkOutboxFailed).toHaveBeenLastCalledWith(
        'outbox-1',
        expect.stringMatching(/^on_failed_crash: /),
        1,
      );

      consoleErrSpy.mockRestore();
    });
  });
```

- [ ] **Step 2: Run tests — pass**

```bash
pnpm test -- worker/jobs/publisher/__tests__/failed-hook.test.ts
```

Expected: PASS — the generic fall-through and the last-resort branch are already in place from Task 9. All eight `it()` blocks green.

- [ ] **Step 3: Commit**

```bash
git add worker/jobs/publisher/__tests__/failed-hook.test.ts
git commit -m "test(worker): add fall-through + handler-crash coverage for publisher failed-hook"
```

---

## Task 13: Wire `handlePublisherFailed` into `worker/index.ts`

Replace the inline ~135 lines (`worker/index.ts:291-427`) with one line.

**Files:**
- Modify: `worker/index.ts`

- [ ] **Step 1: Update imports**

Add the new import (group with other `./jobs/publisher/...` imports):

```typescript
import { handlePublisherFailed } from './jobs/publisher/failed-hook';
```

The existing import block from `'./jobs/publisher/publisher-error-handlers'` that brings in `PublisherTransientWithContext` and `ZernioReplyVerificationIndeterminateError` is **no longer needed in `worker/index.ts`** — those symbols are now consumed only by the extracted `failed-hook.ts`. Remove them from the `worker/index.ts` import.

```bash
# After the edit, verify the publisher-error-handlers import is either gone
# or only re-exporting symbols still consumed by index.ts. Currently it brings
# in only PublisherTransientWithContext + ZernioReplyVerificationIndeterminateError;
# both move to failed-hook's consumer set.
grep -n "from './jobs/publisher/publisher-error-handlers'" worker/index.ts
# Expected: zero matches OR only re-export lines.
```

Similarly, the `import { applyTransientExhaustionFallback } from '../src/lib/publishing/zernio-publisher'` and `import { ZernioTransientError } from '../src/lib/zernio/errors'` lines in `worker/index.ts` should be **deleted** if they're only used by the now-extracted publisher hook. Verify with Grep before deleting:

```bash
grep -n "applyTransientExhaustionFallback\|ZernioTransientError" worker/index.ts
# Expected: zero matches after deletion.
```

- [ ] **Step 2: Replace the inline `.on('failed', ...)` block**

Delete the entire body at `worker/index.ts:291-427` (the `publisherWorker.on('failed', async (job, err) => { ... });` block). Replace it with a single line:

```typescript
publisherWorker.on('failed', handlePublisherFailed);
```

- [ ] **Step 3: Verify no orphan symbols remain**

```bash
grep -n "ZernioReplyVerificationIndeterminateError\|PublisherTransientWithContext" worker/index.ts
# Expected: zero matches.

grep -n "extractOutboxHandle\|markOutboxCompleted" worker/index.ts
# Expected: zero matches (both were used only by the now-extracted hooks).
# Update the import block at top of file to drop these symbols if they're
# the only ones imported from '../src/lib/shared/outbox'.

grep -n "from '../src/lib/shared/outbox'" worker/index.ts
# If this import statement is empty (no remaining symbols), DELETE the line.
```

The `markOutboxFailed` import also disappears from `worker/index.ts` if it was only used by the failed-hooks. Verify and delete its import line if unused.

- [ ] **Step 4: Verify the `uuidv7` and `jsonb` imports are likewise pruned if unused**

```bash
grep -n "uuidv7\|jsonb(" worker/index.ts
# Expected: zero matches if both hooks are fully extracted. If still present,
# they're used somewhere else in worker/index.ts that this refactor does not touch — leave them.
```

- [ ] **Step 5: Type-check**

```bash
pnpm tsc --noEmit
```

Expected: clean exit. If TS reports unused imports, delete them now.

- [ ] **Step 6: Run all worker tests**

```bash
pnpm test -- worker/
```

Expected: all green. The `publisher-error-handlers.test.ts` continues to pass — that test covers `verify409AndDispose`, `handlePublisherAuthErrorTerminal`, `handlePublisherPermanentErrorTerminal`, and the error-class shapes. The new `failed-hook.test.ts` covers the orchestration that used to live in `worker/index.ts`.

- [ ] **Step 7: Smoke-test the worker**

```bash
MOCK_EXTERNAL_APIS=true pnpm worker
```

Expected: clean boot. Watch for any dropped `import` causing a `TypeError: X is not a function` at runtime — TS won't catch a wrongly-removed import that's still referenced via dynamic property access. The smoke test catches it because the boot path touches every Worker constructor.

`Ctrl+C` → clean shutdown.

- [ ] **Step 8: Commit**

```bash
git add worker/index.ts
git commit -m "refactor(worker): wire handlePublisherFailed into worker/index.ts"
```

---

## Task 14: Final verification — line count, lint, full test suite

**Files:** none modified.

- [ ] **Step 1: Verify `worker/index.ts` is under the 380-line success-criteria target**

```bash
wc -l worker/index.ts
```

Expected: ≤ 380 lines (target ~320). If over, audit for inline code that should have been extracted; do not widen the target silently — the spec said missing the band reopens this plan.

- [ ] **Step 2: Run lint**

```bash
pnpm lint
```

Expected: clean. Fix any unused-import or unused-variable warnings introduced by the extraction.

- [ ] **Step 3: Run the full test suite**

```bash
pnpm test
```

Expected: full green. If E2E tests gate on `TEST_DATABASE_POOL_URL` being unset, those will skip — that's the existing project convention.

- [ ] **Step 4: Verify behavior preservation by diff-grepping for tag/message strings**

Each of these strings was present in the pre-refactor `worker/index.ts` and should still be reachable via the new modules. Run these greps across `worker/`:

```bash
grep -rn "zernio_review_not_found_after_retries\|zernio_pagination_cap_exhausted\|zernio_unparseable_review_name" worker/
# Expected: appears in worker/jobs/zernio/ingest-failed-hook.ts.

grep -rn "zernio_reply_verification_indeterminate\|unwrapped_transient_no_context\|zernio_transient_max_attempts\|on_failed_crash" worker/
# Expected: appears in worker/jobs/publisher/failed-hook.ts.

grep -rn "transient_exhaustion_fallback\|on_failed_handler_crash" worker/
# Expected: appears in worker/jobs/publisher/failed-hook.ts.
```

If any string is missing, the extraction silently dropped it — fix before continuing.

- [ ] **Step 5: Push the branch**

```bash
git push -u origin refactor/worker-index-failure-extraction
```

- [ ] **Step 6: Open the PR**

Use `gh pr create` (or your normal flow). Suggested title and body:

```
title: refactor(worker): extract failure-handler branches from worker/index.ts (#XX)

body:
## Summary
- Extract Sentry init + scrubber → `worker/sentry.ts`
- Extract `ingestZernioReviewWorker.on('failed')` → `worker/jobs/zernio/ingest-failed-hook.ts`
- Extract `publisherWorker.on('failed')` → `worker/jobs/publisher/failed-hook.ts`
- `worker/index.ts`: 607 → ~320 lines, now pure registration + lifecycle.

Applies the new `CLAUDE.md` invariant — *Entry points orchestrate; modules own failure behavior*. Pure code-motion + new tests at the seams; every Sentry tag, error message, and DB write is byte-equal pre/post.

Spec: `docs/superpowers/specs/2026-05-05-entry-point-modularization-design.md` § PR #1.

## Test plan
- [x] `pnpm test -- worker/` green
- [x] `pnpm test` (full suite) green
- [x] `pnpm lint` clean
- [x] `pnpm tsc --noEmit` clean
- [x] `MOCK_EXTERNAL_APIS=true pnpm worker` smoke: all 16 BullMQ workers + 10 background loops boot, Worker service running on port 3001, clean shutdown on SIGTERM
- [x] `wc -l worker/index.ts` ≤ 380
- [x] All tag/message strings preserved (verified via repo-wide grep — see Task 14 step 4)

## New tests
- `worker/jobs/zernio/__tests__/ingest-failed-hook.test.ts` — 4 branches, ~7 cases
- `worker/jobs/publisher/__tests__/failed-hook.test.ts` — 5 branches, ~8 cases

The `bare ZernioTransientError` defensive branch and the `on_failed_handler_crash` last-resort branch had **zero** direct test coverage before this PR.
```

---

## Self-review checklist (run before requesting review)

- [ ] Spec coverage — every numbered extraction (1A, 1B, 1C) in the spec maps to one or more tasks in this plan. ✓
- [ ] No placeholders — TBD/TODO/FIXME scan. (Run `grep -rni "tbd\|todo\|fixme" worker/sentry.ts worker/jobs/zernio/ingest-failed-hook.ts worker/jobs/publisher/failed-hook.ts` — expected: zero matches in the new files.)
- [ ] Type consistency — `handleIngestFailed` signature matches its caller in `worker/index.ts`; `handlePublisherFailed` signature matches its caller. Both accept `Job<X> | undefined` to mirror BullMQ's `'failed'` event type.
- [ ] Behavior preservation — every Sentry tag string, error message, and outbox reason was checked verbatim against pre-refactor `worker/index.ts:160-277` and `:291-427`.
- [ ] Imports cleaned — `worker/index.ts` no longer imports `uuidv7`, `jsonb`, `extractOutboxHandle`, `markOutboxCompleted`, `markOutboxFailed`, `applyTransientExhaustionFallback`, `ZernioTransientError`, or `PublisherTransientWithContext` (all moved to the extracted modules).

---

## What's NOT in this PR

- PR #2 (`select-location/route.ts`) and PR #3 (`callback/route.ts`) — separate plans, written after this PR merges.
- Group B refactors (`EngagementAlertWorker`, `OnboardingDripWorker`) — separate spec.
- Any internal renames or variable cleanups inside the extracted blocks. Pure code-motion only.
- Documentation updates to `docs/directory.md` — single-line update queued for the post-merge sweep, not gating this PR.
