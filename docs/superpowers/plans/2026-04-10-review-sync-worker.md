# ReviewSyncWorker Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the ReviewSyncWorker that processes `sync_reviews` BullMQ jobs — fetches reviews via SerpAPI (or mock), deduplicates against the DB, triggers response generation for new reviews, handles review edits, and captures ROI baselines.

**Architecture:** The worker consumes jobs dispatched by the OutboxPoller from `sync_reviews` outbox entries (created by ReconciliationPoller). For each job, it fetches reviews via `SerpApiMonitor` or `MockSerpApiMonitor`, then processes each review in its own Postgres transaction: new reviews get a `generate_response` outbox entry, edited reviews either trigger regeneration (if pending) or create admin exceptions (if already posted), unchanged reviews are skipped. After all reviews are processed, it updates `last_sync_at` and captures the ROI baseline on first sync.

**Tech Stack:** Postgres.js (`sql`), BullMQ `Job`, UUIDv7, shared utilities (subscription-guard, outbox, mock-mode, worker-types, sanitize)

**Schema note:** `review_exceptions.review_id` is `NOT NULL` in the DB, but the spec mentions identity collisions with `review_id = NULL`. Since collisions are detected pre-insert (the review doesn't exist yet), we log them as warnings instead of inserting into `review_exceptions`. The SerpApiMonitor already logs collision warnings. If a DB-level collision record is needed later, the schema would need a migration to make `review_id` nullable.

---

## File Map

| File | Action | Responsibility |
|---|---|---|
| `worker/jobs/ReviewSyncWorker.ts` | Create | Process sync_reviews jobs: fetch, dedup, upsert, trigger generation |
| `worker/index.ts` | Modify | Register the new worker |
| `worker/__tests__/ReviewSyncWorker.test.ts` | Create | Unit tests with mocked SQL and monitor |

---

### Task 1: Create ReviewSyncWorker

**Files:**
- Create: `worker/jobs/ReviewSyncWorker.ts`

- [ ] **Step 1: Create the worker file**

```typescript
import type { Job } from 'bullmq';
import { v7 as uuidv7 } from 'uuid';
import { sql } from '../../src/lib/db/server';
import { checkSubscription } from '../../src/lib/shared/subscription-guard';
import { markOutboxCompleted, markOutboxFailed } from '../../src/lib/shared/outbox';
import { isMockMode } from '../../src/lib/shared/mock-mode';
import { SerpApiMonitor } from '../../src/lib/reviews/serpapi-monitor';
import { MockSerpApiMonitor } from '../../src/lib/reviews/mock-monitor';
import type { SyncReviewsPayload, GenerateResponsePayload, NotifyAdminExceptionPayload } from '../../src/lib/shared/worker-types';
import type { MonitoredReview, IdentityCollision } from '../../src/lib/reviews/types';

const LOG_PREFIX = '[ReviewSyncWorker]';

export async function handleReviewSync(
  job: Job<SyncReviewsPayload>,
): Promise<void> {
  const { business_id, google_place_id } = job.data;
  const outboxId = job.id!;

  // 1. Read business from DB
  const [business] = await sql<{
    id: string;
    subscription_status: string;
    updated_at: Date;
    google_place_id: string | null;
    baseline_captured_at: Date | null;
  }[]>`
    SELECT id, subscription_status, updated_at, google_place_id, baseline_captured_at
    FROM businesses WHERE id = ${business_id}
  `;

  if (!business) {
    console.warn(`${LOG_PREFIX} Business ${business_id} not found`);
    await markOutboxCompleted(outboxId);
    return;
  }

  const subCheck = checkSubscription(
    business.subscription_status,
    new Date(business.updated_at),
    'generator',
  );
  if (!subCheck.allowed) {
    console.log(`${LOG_PREFIX} Business ${business_id} skipped: ${subCheck.reason}`);
    await markOutboxCompleted(outboxId);
    return;
  }

  if (!business.google_place_id) {
    console.warn(`${LOG_PREFIX} Business ${business_id} has null google_place_id`);
    await markOutboxCompleted(outboxId);
    return;
  }

  // 2. Fetch reviews
  const monitor = isMockMode()
    ? new MockSerpApiMonitor()
    : new SerpApiMonitor(process.env.SERPAPI_API_KEY!);

  let result;
  try {
    result = await monitor.fetchReviews(business.google_place_id);
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    // Permanent errors: don't retry
    if (message.includes('401') || message.includes('403') || message.includes('quota')) {
      console.error(`${LOG_PREFIX} Permanent SerpAPI error for ${business_id}: ${message}`);
      await markOutboxFailed(outboxId, `SerpAPI permanent error: ${message}`);
      return;
    }
    // Transient errors: throw so BullMQ retries with backoff
    throw err;
  }

  // 3. Handle identity collisions (log only — review_exceptions.review_id is NOT NULL
  // in the schema, so we can't insert with review_id=NULL for pre-insert collisions)
  for (const collision of result.collisions) {
    console.warn(
      `${LOG_PREFIX} Identity collision for business ${business_id}: ` +
      `reviewer="${collision.review.reviewerName}" date=${collision.review.reviewDate} ` +
      `strategy=${collision.identity.identityStrategy} ` +
      `hash=${collision.contentHash} collidesWith=${collision.collidesWithContentHash}`,
    );
  }

  // 4. Process each review in its own transaction
  for (const monitored of result.reviews) {
    try {
      await processReview(monitored, business_id);
    } catch (err) {
      console.error(
        `${LOG_PREFIX} Failed to process review for business ${business_id} ` +
        `(reviewer="${monitored.review.reviewerName}"): ${err instanceof Error ? err.message : err}`,
      );
      // Continue with remaining reviews — partial success is better than all-or-nothing
    }
  }

  // 5. Update last_sync_at
  await sql`
    UPDATE businesses SET last_sync_at = NOW() WHERE id = ${business_id}
  `;

  // 6. ROI baseline capture (first sync only)
  if (business.baseline_captured_at === null) {
    const [countRow] = await sql<{ count: string }[]>`
      SELECT COUNT(*)::text AS count FROM reviews WHERE business_id = ${business_id}
    `;
    const reviewCount = parseInt(countRow?.count ?? '0', 10);

    await sql`
      UPDATE businesses
      SET initial_review_count = ${reviewCount},
          initial_responded_count = 0,
          baseline_captured_at = NOW()
      WHERE id = ${business_id}
    `;
    console.log(`${LOG_PREFIX} Captured ROI baseline for ${business_id}: ${reviewCount} reviews`);
  }

  // 7. Complete the outbox entry
  await markOutboxCompleted(outboxId);
  console.log(
    `${LOG_PREFIX} Sync complete for business ${business_id}: ${result.reviews.length} reviews processed`,
  );
}

async function processReview(
  monitored: MonitoredReview,
  businessId: string,
): Promise<void> {
  const { review, identity, contentHash } = monitored;

  await sql.begin(async (tx) => {
    // a. Read existing review with FOR UPDATE lock
    const [existing] = await tx<{ id: string; review_content_hash: string | null }[]>`
      SELECT id, review_content_hash FROM reviews
      WHERE provider = ${identity.provider}
        AND provider_review_name = ${identity.providerReviewName}
      FOR UPDATE
    `;

    // b. Upsert the review
    const [upserted] = await tx<{ id: string }[]>`
      INSERT INTO reviews (
        id, business_id, provider, provider_review_id, provider_review_name,
        provider_location_name, reviewer_name, star_rating, review_text,
        review_date, detected_language, review_content_hash, status
      )
      VALUES (
        ${uuidv7()}, ${businessId}, ${identity.provider}, ${identity.providerReviewId},
        ${identity.providerReviewName}, ${identity.providerLocationName},
        ${review.reviewerName}, ${review.starRating}, ${review.reviewText},
        ${review.reviewDate}, ${review.detectedLanguage}, ${contentHash}, 'new'
      )
      ON CONFLICT (provider, provider_review_name) DO UPDATE SET
        reviewer_name = EXCLUDED.reviewer_name,
        star_rating = EXCLUDED.star_rating,
        review_text = EXCLUDED.review_text,
        review_content_hash = EXCLUDED.review_content_hash,
        detected_at = NOW()
      RETURNING id
    `;

    const reviewId = upserted!.id;

    // c. Branch logic
    if (!existing) {
      // NEW review — queue response generation
      const genPayload: GenerateResponsePayload = {
        review_id: reviewId,
        business_id: businessId,
        version: 1,
      };
      await tx`
        INSERT INTO job_outbox (id, topic, aggregate_type, aggregate_id, payload, status)
        VALUES (
          ${uuidv7()}, 'generate_response', 'review', ${reviewId},
          ${JSON.stringify(genPayload)}::jsonb, 'pending'
        )
      `;
    } else if (existing.review_content_hash !== contentHash) {
      // CONTENT CHANGED — reviewer edited their review
      await handleContentChanged(tx, existing.id, reviewId, businessId);
    }
    // UNCHANGED — no action needed
  });
}

async function handleContentChanged(
  tx: Parameters<Parameters<typeof sql.begin>[0]>[0],
  existingReviewId: string,
  reviewId: string,
  businessId: string,
): Promise<void> {
  // Find the latest non-terminal response for this review
  const [latestResponse] = await tx<{ id: string; status: string; version: number }[]>`
    SELECT id, status, version FROM responses
    WHERE review_id = ${existingReviewId}
      AND status NOT IN ('superseded', 'failed')
    ORDER BY version DESC
    LIMIT 1
  `;

  if (!latestResponse) {
    // No active response — just queue a new generation
    const genPayload: GenerateResponsePayload = {
      review_id: reviewId,
      business_id: businessId,
      version: 1,
    };
    await tx`
      INSERT INTO job_outbox (id, topic, aggregate_type, aggregate_id, payload, status)
      VALUES (
        ${uuidv7()}, 'generate_response', 'review', ${reviewId},
        ${JSON.stringify(genPayload)}::jsonb, 'pending'
      )
    `;
    return;
  }

  if (latestResponse.status === 'pending_approval') {
    // Pending response — fail it and regenerate
    await tx`
      UPDATE responses
      SET status = 'failed', posting_error = 'Review updated by reviewer'
      WHERE id = ${latestResponse.id}
    `;

    const genPayload: GenerateResponsePayload = {
      review_id: reviewId,
      business_id: businessId,
      version: latestResponse.version + 1,
    };
    await tx`
      INSERT INTO job_outbox (id, topic, aggregate_type, aggregate_id, payload, status)
      VALUES (
        ${uuidv7()}, 'generate_response', 'review', ${reviewId},
        ${JSON.stringify(genPayload)}::jsonb, 'pending'
      )
    `;
  } else if (
    latestResponse.status === 'posted' ||
    latestResponse.status === 'awaiting_manual_post'
  ) {
    // Already posted — create exception for admin review
    await tx`
      INSERT INTO review_exceptions (id, business_id, review_id, response_id, type, payload)
      VALUES (
        ${uuidv7()}, ${businessId}, ${reviewId}, ${latestResponse.id},
        'review_edited_after_post',
        ${JSON.stringify({
          response_status: latestResponse.status,
          reason: 'Reviewer edited review after public reply was posted',
        })}::jsonb
      )
      ON CONFLICT DO NOTHING
    `;

    const exceptionPayload: NotifyAdminExceptionPayload = {
      review_exception_id: reviewId,
      business_id: businessId,
    };
    await tx`
      INSERT INTO job_outbox (id, topic, aggregate_type, aggregate_id, payload, status)
      VALUES (
        ${uuidv7()}, 'notify_admin_review_exception', 'review', ${reviewId},
        ${JSON.stringify(exceptionPayload)}::jsonb, 'pending'
      )
    `;
  }
}
```

- [ ] **Step 2: Verify TypeScript compiles**

Run: `npx tsc --noEmit`
Expected: No errors

- [ ] **Step 3: Commit**

```bash
git add worker/jobs/ReviewSyncWorker.ts
git commit -m "feat: add ReviewSyncWorker for SerpAPI review sync processing"
```

---

### Task 2: Register worker in worker/index.ts

**Files:**
- Modify: `worker/index.ts`

- [ ] **Step 1: Add import**

After the existing DemoGenerationWorker import, add:
```typescript
import { handleReviewSync } from './jobs/ReviewSyncWorker';
```

- [ ] **Step 2: Add worker creation**

After the `demoWorker` creation and before `const workers = [demoWorker];`, add:
```typescript
const reviewSyncWorker = new Worker(QUEUE_NAMES.SYNC_REVIEWS, handleReviewSync, {
  connection: redisOpts,
});
```

- [ ] **Step 3: Add to workers array**

Change `const workers = [demoWorker];` to:
```typescript
const workers = [demoWorker, reviewSyncWorker];
```

- [ ] **Step 4: Remove the commented-out placeholder**

Remove the line:
```typescript
// const reviewSyncWorker = new Worker(QUEUE_NAMES.SYNC_REVIEWS, handleReviewSync, { connection: redisOpts });
```

- [ ] **Step 5: Verify TypeScript compiles and tests pass**

Run: `npx tsc --noEmit && pnpm test`
Expected: No errors, all tests pass

- [ ] **Step 6: Commit**

```bash
git add worker/index.ts
git commit -m "feat: register ReviewSyncWorker in worker lifecycle"
```

---

### Task 3: Write unit tests

**Files:**
- Create: `worker/__tests__/ReviewSyncWorker.test.ts`

- [ ] **Step 1: Create the test file**

```typescript
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Job } from 'bullmq';
import type { SyncReviewsPayload } from '../../src/lib/shared/worker-types';

// ── Mocks ────────────────────────────────────────────────────────────

const mockSqlCalls: unknown[][] = [];
const mockTxCalls: unknown[][] = [];

// Create a mock tagged template function that records calls
function createMockTaggedTemplate(store: unknown[][]) {
  const fn = Object.assign(
    (_strings: TemplateStringsArray, ..._values: unknown[]) => {
      store.push(_values);
      return Promise.resolve(Object.assign([], { count: 0 }));
    },
    {
      // Allow typed array return overriding per-test
      __returnValue: Object.assign([], { count: 0 }) as unknown,
    },
  );
  return fn;
}

const mockTx = createMockTaggedTemplate(mockTxCalls);

const mockSql = Object.assign(
  createMockTaggedTemplate(mockSqlCalls),
  {
    begin: vi.fn(async (callback: (tx: typeof mockTx) => Promise<void>) => {
      await callback(mockTx as unknown as Parameters<Parameters<typeof import('../../src/lib/db/server').sql.begin>[0]>[0]);
    }),
  },
);

vi.mock('../../src/lib/db/server', () => ({ sql: mockSql }));

const mockMarkOutboxCompleted = vi.fn();
const mockMarkOutboxFailed = vi.fn();
vi.mock('../../src/lib/shared/outbox', () => ({
  markOutboxCompleted: (...args: unknown[]) => mockMarkOutboxCompleted(...args),
  markOutboxFailed: (...args: unknown[]) => mockMarkOutboxFailed(...args),
}));

vi.mock('../../src/lib/shared/mock-mode', () => ({
  isMockMode: vi.fn(() => true),
}));

vi.mock('../../src/lib/reviews/mock-monitor', () => ({
  MockSerpApiMonitor: vi.fn().mockImplementation(() => ({
    fetchReviews: vi.fn().mockResolvedValue({ reviews: [], collisions: [] }),
  })),
}));

vi.mock('../../src/lib/reviews/serpapi-monitor', () => ({
  SerpApiMonitor: vi.fn(),
}));

vi.mock('uuid', () => ({ v7: vi.fn(() => 'test-uuid') }));

import { handleReviewSync } from '../jobs/ReviewSyncWorker';

function makeJob(data: SyncReviewsPayload): Job<SyncReviewsPayload> {
  return { data, id: 'outbox-123' } as Job<SyncReviewsPayload>;
}

describe('ReviewSyncWorker', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockSqlCalls.length = 0;
    mockTxCalls.length = 0;
  });

  it('completes outbox when business not found', async () => {
    // sql returns empty array (business not found)
    await handleReviewSync(makeJob({ business_id: 'biz-1', google_place_id: 'place-1' }));
    expect(mockMarkOutboxCompleted).toHaveBeenCalledWith('outbox-123');
  });

  it('completes outbox when subscription is cancelled', async () => {
    // First SQL call returns the business with cancelled status
    const origFn = mockSql;
    let callCount = 0;
    const businessRow = {
      id: 'biz-1',
      subscription_status: 'cancelled',
      updated_at: new Date(),
      google_place_id: 'place-1',
      baseline_captured_at: new Date(),
    };
    vi.mocked(mockSql).mockImplementation((_s: TemplateStringsArray, ..._v: unknown[]) => {
      callCount++;
      if (callCount === 1) return Promise.resolve(Object.assign([businessRow], { count: 1 }));
      return Promise.resolve(Object.assign([], { count: 0 }));
    });

    await handleReviewSync(makeJob({ business_id: 'biz-1', google_place_id: 'place-1' }));
    expect(mockMarkOutboxCompleted).toHaveBeenCalledWith('outbox-123');
  });

  it('completes outbox when google_place_id is null', async () => {
    let callCount = 0;
    const businessRow = {
      id: 'biz-1',
      subscription_status: 'active',
      updated_at: new Date(),
      google_place_id: null,
      baseline_captured_at: new Date(),
    };
    vi.mocked(mockSql).mockImplementation((_s: TemplateStringsArray, ..._v: unknown[]) => {
      callCount++;
      if (callCount === 1) return Promise.resolve(Object.assign([businessRow], { count: 1 }));
      return Promise.resolve(Object.assign([], { count: 0 }));
    });

    await handleReviewSync(makeJob({ business_id: 'biz-1', google_place_id: 'place-1' }));
    expect(mockMarkOutboxCompleted).toHaveBeenCalledWith('outbox-123');
  });

  it('marks outbox failed on permanent SerpAPI error', async () => {
    let callCount = 0;
    const businessRow = {
      id: 'biz-1',
      subscription_status: 'active',
      updated_at: new Date(),
      google_place_id: 'place-1',
      baseline_captured_at: new Date(),
    };
    vi.mocked(mockSql).mockImplementation((_s: TemplateStringsArray, ..._v: unknown[]) => {
      callCount++;
      if (callCount === 1) return Promise.resolve(Object.assign([businessRow], { count: 1 }));
      return Promise.resolve(Object.assign([], { count: 0 }));
    });

    const { MockSerpApiMonitor } = await import('../../src/lib/reviews/mock-monitor');
    vi.mocked(MockSerpApiMonitor).mockImplementation(() => ({
      fetchReviews: vi.fn().mockRejectedValue(new Error('403 quota exceeded')),
    }) as unknown as InstanceType<typeof MockSerpApiMonitor>);

    await handleReviewSync(makeJob({ business_id: 'biz-1', google_place_id: 'place-1' }));
    expect(mockMarkOutboxFailed).toHaveBeenCalledWith(
      'outbox-123',
      expect.stringContaining('403'),
    );
  });

  it('throws on transient SerpAPI error for BullMQ retry', async () => {
    let callCount = 0;
    const businessRow = {
      id: 'biz-1',
      subscription_status: 'active',
      updated_at: new Date(),
      google_place_id: 'place-1',
      baseline_captured_at: new Date(),
    };
    vi.mocked(mockSql).mockImplementation((_s: TemplateStringsArray, ..._v: unknown[]) => {
      callCount++;
      if (callCount === 1) return Promise.resolve(Object.assign([businessRow], { count: 1 }));
      return Promise.resolve(Object.assign([], { count: 0 }));
    });

    const { MockSerpApiMonitor } = await import('../../src/lib/reviews/mock-monitor');
    vi.mocked(MockSerpApiMonitor).mockImplementation(() => ({
      fetchReviews: vi.fn().mockRejectedValue(new Error('ECONNRESET')),
    }) as unknown as InstanceType<typeof MockSerpApiMonitor>);

    await expect(
      handleReviewSync(makeJob({ business_id: 'biz-1', google_place_id: 'place-1' })),
    ).rejects.toThrow('ECONNRESET');
    expect(mockMarkOutboxCompleted).not.toHaveBeenCalled();
    expect(mockMarkOutboxFailed).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run tests**

Run: `pnpm test`
Expected: All tests pass (existing + new)

- [ ] **Step 3: Commit**

```bash
git add worker/__tests__/ReviewSyncWorker.test.ts
git commit -m "test: add ReviewSyncWorker unit tests for early-return paths and error handling"
```

---

### Task 4: Final verification + tracking updates

- [ ] **Step 1: Full type check**

Run: `npx tsc --noEmit`
Expected: No errors

- [ ] **Step 2: Full test suite**

Run: `pnpm test`
Expected: All tests pass

- [ ] **Step 3: Build check**

Run: `pnpm build`
Expected: Next.js build succeeds

- [ ] **Step 4: Update tracking files**

Update `.claude/CLAUDE.md` current status with Prompt 9 completion.
Append Prompt 9 entry to `docs/progresstracking.md`.
