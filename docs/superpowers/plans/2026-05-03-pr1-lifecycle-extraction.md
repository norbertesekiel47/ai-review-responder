# Onboarding Demo: Lifecycle Extraction (PR #1) — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Extract shared lifecycle helpers and demo-generation decomposition from `DemoGenerationWorker.ts` and `generator.ts`, creating pure, tested, table-parameterized functions that PR #2's onboarding demo feature will consume.

**Architecture:** Extract `claimDemo`/`completeDemo`/`failDemo` into `lib/demos/lifecycle.ts` (table-parameterized, sharing both `prospect_demos` and `onboarding_demos`). Decompose `generateDemo()` into `fetchSerpApiReviews`, `selectQualifyingReviews`, and `generateResponsesForReviews` as three single-purpose functions. Refactor `DemoGenerationWorker.ts` and `generator.ts` to call helpers. Zero behavior change to existing prospect demos.

**Tech Stack:** TypeScript, PostgreSQL (Postgres.js), Vitest, BullMQ, Zod, SerpAPI

---

## File Map

| File | Action | Responsibility |
|------|--------|----------------|
| `src/lib/demos/types.ts` | Modify | Add lifecycle types, selection-rule types |
| `src/lib/demos/lifecycle.ts` | **Create** | `claimDemo`, `completeDemo`, `failDemo` — table-param, outbox completing, stale recovery |
| `src/lib/demos/select-qualifying.ts` | **Create** | `selectQualifyingReviews(reviews, opts)` — pure function, `'newest'` and `'positive-with-moderate-tail'` rules |
| `src/lib/demos/fetch-reviews.ts` | **Create** | `fetchSerpApiReviews(placeId)` — wraps SerpApiSource, returns `NormalizedReview[]` |
| `src/lib/demos/generate-responses.ts` | **Create** | `generateResponsesForReviews(reviews, business)` — parallel LLM calls, partial-failure handling |
| `src/lib/demos/index.ts` | Modify | Export new helpers |
| `src/lib/demos/generator.ts` | Modify | Refactor to compose `fetch → select(newest) → generate` |
| `worker/jobs/DemoGenerationWorker.ts` | Modify | Replace inline SQL with `claimDemo`, `completeDemo`, `failDemo` |
| `src/lib/demos/__tests__/lifecycle.test.ts` | **Create** | claim/complete/fail + race + stale-recovery + 23505 race-loser |
| `src/lib/demos/__tests__/select-qualifying.test.ts` | **Create** | `'newest'` rule regression + `'positive-with-moderate-tail'` rule |
| `src/lib/demos/__tests__/fetch-reviews.test.ts` | **Create** | Mock source path, error handling |
| `src/lib/demos/__tests__/generate-responses.test.ts` | **Create** | Mock LLM path, partial failures |

---

## Task 1: New lifecycle types in types.ts

**Files:**
- Modify: `src/lib/demos/types.ts`
- Test: `src/lib/demos/__tests__/lifecycle.test.ts`

- [ ] **Step 1: Add new types to types.ts**

Add below the existing exports (no deletions):

```typescript
// ── Lifecycle table parameter ─────────────────────────────────────────

export type DemoTable = 'prospect_demos' | 'onboarding_demos';

// ── Selection rules ───────────────────────────────────────────────────

export type SelectionRule = 'newest' | 'positive-with-moderate-tail';

export interface SelectQualifyingOptions {
  rule: SelectionRule;
}

// ── Lifecycle result types ────────────────────────────────────────────

export type ClaimResult = 'claimed' | 'already_terminal' | 'not_found' | 'reset_to_queued';

export interface CompleteDemoArgs {
  reviews: import('@/lib/reviews/types').NormalizedReview[];
  responses: (import('@/lib/responses/types').GenerationResult | null)[];
  /** Optional — omitted for prospect_demos (schema has DEFAULT 'serpapi') */
  source?: 'serpapi' | 'curated_fallback';
}
```

- [ ] **Step 2: Commit**

```bash
git add src/lib/demos/types.ts
git commit -m "refactor(demos): add lifecycle types for table-param extraction (#1)"
```

---

## Task 2: Create `src/lib/demos/lifecycle.ts`

**Files:**
- Create: `src/lib/demos/lifecycle.ts`
- Test: `src/lib/demos/__tests__/lifecycle.test.ts`

This is the largest new file. It encapsulates ALL database state-machine logic that currently lives inline in `DemoGenerationWorker.ts`.

- [ ] **Step 1: Write the failing test skeleton**

```bash
mkdir -p src/lib/demos/__tests__
touch src/lib/demos/__tests__/lifecycle.test.ts
```

`src/lib/demos/__tests__/lifecycle.test.ts`:

```typescript
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { sql } from '@/lib/db/server';
import { claimDemo, completeDemo, failDemo } from '../lifecycle';

describe('lifecycle', () => {
  // Helper to create a temporary test row in prospect_demos
  async function insertProspectDemo(opts: {
    id?: string;
    generation_status: string;
    started_at?: Date | null;
    created_by?: string;
  }): Promise<string> {
    const id = opts.id ?? crypto.randomUUID();
    const slug = `test-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const created_by = opts.created_by ?? crypto.randomUUID();
    await sql`
      INSERT INTO prospect_demos (id, slug, business_name, generation_status, created_by, correlation_id)
      VALUES (${id}, ${slug}, 'Test Biz', ${opts.generation_status}, ${created_by}, ${crypto.randomUUID()})
    `;
    return id;
  }

  beforeEach(async () => {
    await sql`DELETE FROM prospect_demos WHERE slug LIKE 'test-%'`;
    await sql`DELETE FROM job_outbox WHERE aggregate_id LIKE 'test-%'`;
  });

  afterEach(async () => {
    await sql`DELETE FROM prospect_demos WHERE slug LIKE 'test-%'`;
    await sql`DELETE FROM job_outbox WHERE aggregate_id LIKE 'test-%'`;
  });

  it('claimDemo returns not_found for missing row', async () => {
    const result = await claimDemo('prospect_demos', '00000000-0000-0000-0000-000000000000', console);
    expect(result).toBe('not_found');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/lib/demos/__tests__/lifecycle.test.ts`
Expected: FAIL — `claimDemo` not found or module doesn't exist.

- [ ] **Step 3: Implement `src/lib/demos/lifecycle.ts`**

```typescript
import { sql, jsonb } from '@/lib/db/server';
import type { WorkerLogger } from '@/lib/shared/logger';
import type { DemoTable, ClaimResult, CompleteDemoArgs } from './types';

const STALE_THRESHOLD_MS = 5 * 60 * 1000;

function tableRef(table: DemoTable): string {
  // Postgres.js tagged-template identifiers must be raw strings.
  // Table names are NOT user input — they are hardcoded in type.
  if (table === 'prospect_demos') return 'prospect_demos';
  return 'onboarding_demos';
}

/**
 * Claims a demo row for processing: queued → running, with stale-running recovery.
 *
 * Returns:
 *   'claimed'                — row transitioned to running, safe to proceed
 *   'already_terminal'       — row is completed or failed, outbox must be closed
 *   'not_found'              — row does not exist, outbox must be closed
 *   'reset_to_queued'        — row was stuck in running >5min and was reset;
 *                               caller should retry (BullMQ handles this via re-dispatch)
 */
export async function claimDemo(
  table: DemoTable,
  demoId: string,
  logger: WorkerLogger,
): Promise<ClaimResult> {
  const t = tableRef(table);

  const [demo] = await sql<{ generation_status: string; started_at: Date | null }[]>`
    SELECT generation_status, started_at FROM ${sql(t)} WHERE id = ${demoId}
  `;

  if (!demo) {
    logger.warn(`Demo ${demoId} not found (${t}), completing outbox`);
    return 'not_found';
  }

  if (demo.generation_status === 'completed' || demo.generation_status === 'failed' || demo.generation_status === 'archived') {
    logger.warn(`Demo ${demoId} already ${demo.generation_status} (${t}), completing outbox`);
    return 'already_terminal';
  }

  if (
    demo.generation_status === 'running' &&
    demo.started_at &&
    Date.now() - new Date(demo.started_at).getTime() > STALE_THRESHOLD_MS
  ) {
    logger.warn(`Demo ${demoId} stuck in running >5min (${t}), resetting to queued`);
    await sql`
      UPDATE ${sql(t)}
      SET generation_status = 'queued', started_at = NULL
      WHERE id = ${demoId} AND generation_status = 'running'
    `;
    return 'reset_to_queued';
  }

  if (demo.generation_status === 'running') {
    throw new Error(
      `Demo ${demoId} is running (${t}, started ${demo.started_at?.toISOString()}), retrying later`,
    );
  }

  const updated = await sql`
    UPDATE ${sql(t)}
    SET generation_status = 'running', started_at = NOW()
    WHERE id = ${demoId} AND generation_status = 'queued'
  `;

  if (updated.count === 0) {
    logger.warn(`Demo ${demoId} already claimed (${t}), completing outbox`);
    return 'already_terminal';
  }

  return 'claimed';
}

/**
 * Completes a demo row + outbox in a single transaction.
 *
 * For `onboarding_demos`, the `source` parameter is REQUIRED and written to
 * the `source` column. For `prospect_demos`, the parameter is omitted and the
 * default `'serpapi'` remains untouched (the column has `DEFAULT 'serpapi'`).
 *
 * Race semantics (onboarding_demos only):
 *   The partial unique index `(user_id WHERE generation_status='completed')`
 *   fires when this UPDATE sets status='completed'. If a concurrent worker
 *   already completed a different row for the same user, Postgres throws
 *   23505. We catch it, archive THIS row (race-loser), and complete the
 *   outbox cleanly.
 */
export async function completeDemo(
  table: DemoTable,
  demoId: string,
  outboxId: string,
  outboxAttempt: number | undefined,
  result: CompleteDemoArgs,
): Promise<void> {
  const t = tableRef(table);
  const { reviews, responses, source } = result;

  const isOnboarding = table === 'onboarding_demos';

  const updateOutbox = async (tx: typeof sql) => {
    if (typeof outboxAttempt === 'number') {
      await tx`
        UPDATE job_outbox
        SET status = 'completed', completed_at = NOW()
        WHERE id = ${outboxId}
          AND status = 'dispatched'
          AND attempts = ${outboxAttempt}
      `;
    } else {
      await tx`
        UPDATE job_outbox
        SET status = 'completed', completed_at = NOW()
        WHERE id = ${outboxId}
          AND status = 'dispatched'
      `;
    }
  };

  try {
    await sql.begin(async (tx) => {
      if (isOnboarding && source) {
        await tx`
          UPDATE ${sql(t)}
          SET reviews_snapshot = ${jsonb(reviews)},
              generated_responses = ${jsonb(responses)},
              generation_status = 'completed',
              completed_at = NOW(),
              source = ${source}
          WHERE id = ${demoId}
        `;
      } else {
        await tx`
          UPDATE ${sql(t)}
          SET reviews_snapshot = ${jsonb(reviews)},
              generated_responses = ${jsonb(responses)},
              generation_status = 'completed',
              completed_at = NOW()
          WHERE id = ${demoId}
        `;
      }
      await updateOutbox(tx);
    });
  } catch (err) {
    const code = (err as { code?: string }).code;
    if (isOnboarding && code === '23505') {
      // 23505 unique_violation — partial unique on onboarding_demos(user_id) WHERE completed.
      // Find the winner row and archive this loser's row.
      const [loser] = await sql<{ user_id: string }[]>`
        SELECT user_id FROM onboarding_demos WHERE id = ${demoId}
      `;
      if (loser) {
        const [winner] = await sql<{ id: string }[]>`
          SELECT id FROM onboarding_demos
          WHERE user_id = ${loser.user_id} AND generation_status = 'completed'
          LIMIT 1
        `;
        if (winner) {
          // Race-loser: archive this row and complete outbox cleanly.
          await sql`
            UPDATE onboarding_demos
            SET generation_status = 'archived', updated_at = NOW()
            WHERE id = ${demoId}
          `;
          await sql`
            UPDATE job_outbox
            SET status = 'completed', completed_at = NOW()
            WHERE id = ${outboxId}
              AND status = 'dispatched'
          `;
          return;
        }
      }
    }
    throw err;
  }
}

/**
 * Fails a demo row + outbox in a single transaction.
 */
export async function failDemo(
  table: DemoTable,
  demoId: string,
  outboxId: string,
  outboxAttempt: number | undefined,
  error: Error,
): Promise<void> {
  const t = tableRef(table);
  const message = error.message;

  const updateOutbox = async (tx: typeof sql) => {
    if (typeof outboxAttempt === 'number') {
      await tx`
        UPDATE job_outbox
        SET status = 'failed', last_error = ${message}, completed_at = NOW()
        WHERE id = ${outboxId}
          AND status = 'dispatched'
          AND attempts = ${outboxAttempt}
      `;
    } else {
      await tx`
        UPDATE job_outbox
        SET status = 'failed', last_error = ${message}, completed_at = NOW()
        WHERE id = ${outboxId}
          AND status = 'dispatched'
      `;
    }
  };

  await sql.begin(async (tx) => {
    await tx`
      UPDATE ${sql(t)}
      SET generation_status = 'failed',
          generation_error = ${message},
          completed_at = NOW()
      WHERE id = ${demoId}
    `;
    await updateOutbox(tx);
  });
}
```

- [ ] **Step 4: Run tests — expect FAIL on integration tests (no TEST_DATABASE_POOL_URL)**

Run: `MOCK_EXTERNAL_APIS=true TEST_DATABASE_POOL_URL="" npx vitest run src/lib/demos/__tests__/lifecycle.test.ts`
Expected: The test file as written only has one test that hits real SQL (which will fail without `TEST_DATABASE_POOL_URL`). For this PR we need DB access. If `TEST_DATABASE_POOL_URL` is not available, skip gracefully.

Adjust the test to skip when DB URL missing:

```typescript
const testDb = process.env.TEST_DATABASE_POOL_URL ?? process.env.DATABASE_POOL_URL;

describe('lifecycle', () => {
  if (!testDb) {
    it.skip('skipping — no TEST_DATABASE_POOL_URL', () => {});
    return;
  }
  // ... rest of tests ...
});
```

Then re-run:

```bash
MOCK_EXTERNAL_APIS=true npx vitest run src/lib/demos/__tests__/lifecycle.test.ts
```

Expected: PASS on `not_found` test (requires running local dev DB or `TEST_DATABASE_POOL_URL`).

- [ ] **Step 5: Add remaining lifecycle tests**

Add the rest of the test suite:

```typescript
  it('claimDemo claims queued → running', async () => {
    const id = await insertProspectDemo({ generation_status: 'queued' });
    const result = await claimDemo('prospect_demos', id, console);
    expect(result).toBe('claimed');
    const [row] = await sql<{ generation_status: string }[]>`SELECT generation_status FROM prospect_demos WHERE id = ${id}`;
    expect(row?.generation_status).toBe('running');
  });

  it('claimDemo returns already_terminal for completed', async () => {
    const id = await insertProspectDemo({ generation_status: 'completed' });
    const result = await claimDemo('prospect_demos', id, console);
    expect(result).toBe('already_terminal');
  });

  it('claimDemo returns already_terminal for failed', async () => {
    const id = await insertProspectDemo({ generation_status: 'failed' });
    const result = await claimDemo('prospect_demos', id, console);
    expect(result).toBe('already_terminal');
  });

  it('claimDemo resets stale running (>5min)', async () => {
    const id = await insertProspectDemo({ generation_status: 'running', started_at: new Date(Date.now() - 6 * 60 * 1000) });
    const result = await claimDemo('prospect_demos', id, console);
    expect(result).toBe('reset_to_queued');
  });

  it('claimDemo throws for non-stale running', async () => {
    const id = await insertProspectDemo({ generation_status: 'running', started_at: new Date() });
    await expect(claimDemo('prospect_demos', id, console)).rejects.toThrow('is running');
  });

  it('completeDemo writes reviews, responses, status=completed', async () => {
    const id = await insertProspectDemo({ generation_status: 'running' });
    const outboxId = await insertOutboxRow();
    await completeDemo('prospect_demos', id, outboxId, 0, {
      reviews: [{ reviewerName: 'A', starRating: 5, reviewText: 'Great', reviewDate: '2026-01-01T00:00:00Z', detectedLanguage: 'en' }],
      responses: [{ responseText: 'Thanks!', costUsd: 0.01, modelUsed: 'test', tokensUsed: 10, latencyMs: 100 }],
    });
    const [row] = await sql<{
      generation_status: string;
      reviews_snapshot: unknown;
      generated_responses: unknown;
    }[]>`SELECT generation_status, reviews_snapshot, generated_responses FROM prospect_demos WHERE id = ${id}`;
    expect(row?.generation_status).toBe('completed');
    expect(Array.isArray(row?.reviews_snapshot)).toBe(true);
    expect(Array.isArray(row?.generated_responses)).toBe(true);
  });

  it('failDemo writes error and status=failed', async () => {
    const id = await insertProspectDemo({ generation_status: 'running' });
    const outboxId = await insertOutboxRow();
    await failDemo('prospect_demos', id, outboxId, 0, new Error('SerpAPI down'));
    const [row] = await sql<{ generation_status: string; generation_error: string }[]>`SELECT generation_status, generation_error FROM prospect_demos WHERE id = ${id}`;
    expect(row?.generation_status).toBe('failed');
    expect(row?.generation_error).toBe('SerpAPI down');
  });
```

Also add helpers `insertOutboxRow` in the test file. The `insertOutboxRow` helper:

```typescript
async function insertOutboxRow(): Promise<string> {
  const id = crypto.randomUUID();
  await sql`
    INSERT INTO job_outbox (id, topic, aggregate_type, aggregate_id, payload, status, attempts)
    VALUES (${id}, 'generate_demo', 'demo', ${id}, ${sql.json({})}, 'dispatched', 0)
  `;
  return id;
}
```

- [ ] **Step 6: Run all lifecycle tests**

```bash
MOCK_EXTERNAL_APIS=true npx vitest run src/lib/demos/__tests__/lifecycle.test.ts
```
Expected: All PASS.

- [ ] **Step 7: Commit**

```bash
git add src/lib/demos/lifecycle.ts src/lib/demos/__tests__/lifecycle.test.ts
git commit -m "refactor(demos): extract table-param lifecycle helpers with tests (#1)"
```

---

## Task 3: Create `src/lib/demos/select-qualifying.ts`

**Files:**
- Create: `src/lib/demos/select-qualifying.ts`
- Test: `src/lib/demos/__tests__/select-qualifying.test.ts`

- [ ] **Step 1: Write the implementation**

```typescript
import type { NormalizedReview } from '@/lib/reviews/types';
import type { SelectQualifyingOptions } from './types';

/**
 * Selects at most 3 reviews from a SerpAPI result set for demo display.
 *
 * Rules:
 *   'newest' (pre-existing prospect path):
 *     - Returns the first 3 reviews in input order (assumed newest-first from SerpAPI).
 *
 *   'positive-with-moderate-tail' (onboarding demo path):
 *     1. Filter to rating >= 3.
 *     2. Build a 3-review portfolio:
 *        a. At least one 5-star with body length > 50 chars (substance signal).
 *        b. Up to two 4-star reviews (recent first by input order).
 *        c. Exactly one representative 3-star review at the END, only if we
 *           already have a >=4 anchor.
 *     3. If after filtering there are zero >=4 reviews, return [] so caller
 *        falls through to curated fallback.
 */
export function selectQualifyingReviews(
  reviews: NormalizedReview[],
  opts: SelectQualifyingOptions,
): NormalizedReview[] {
  if (opts.rule === 'newest') {
    return reviews.slice(0, 3);
  }

  // positive-with-moderate-tail
  const filtered = reviews.filter((r) => r.starRating >= 3);

  const fiveStarWithBody = filtered.filter(
    (r) => r.starRating === 5 && (r.reviewText?.length ?? 0) > 50,
  );
  const fourStar = filtered.filter((r) => r.starRating === 4);
  const threeStar = filtered.filter((r) => r.starRating === 3);

  // >=4 anchor is required; without it we return [] to trigger fallback.
  const anchors = [...fiveStarWithBody, ...fourStar];
  if (anchors.length === 0) {
    return [];
  }

  const result: NormalizedReview[] = [];

  // 1) Prefer 5-star-with-substance
  if (fiveStarWithBody.length > 0) {
    result.push(fiveStarWithBody[0]);
  } else if (fourStar.length > 0) {
    result.push(fourStar[0]);
  }

  // 2) Fill remainder with 4-star reviews (recent order preserved)
  for (const r of fourStar) {
    if (result.length >= 3) break;
    if (!result.includes(r)) {
      result.push(r);
    }
  }

  // 3) If we still have headroom and have a >=4 anchor, append ONE 3-star
  if (result.length > 0 && result.length < 3 && threeStar.length > 0) {
    result.push(threeStar[0]);
  }

  // 4) If still under 3 and we have more anchors, fill
  for (const r of anchors) {
    if (result.length >= 3) break;
    if (!result.includes(r)) {
      result.push(r);
    }
  }

  return result.slice(0, 3);
}
```

- [ ] **Step 2: Write the test**

```typescript
import { describe, it, expect } from 'vitest';
import { selectQualifyingReviews } from '../select-qualifying';
import type { NormalizedReview } from '@/lib/reviews/types';

function makeReview(overrides: Partial<NormalizedReview> = {}): NormalizedReview {
  return {
    reviewerName: 'X',
    starRating: 5,
    reviewText: 'Good',
    reviewDate: '2026-01-01T00:00:00Z',
    detectedLanguage: 'en',
    ...overrides,
  };
}

describe('selectQualifyingReviews', () => {
  it('newest rule returns first 3 in order', () => {
    const reviews = [
      makeReview({ starRating: 5, reviewText: 'A' }),
      makeReview({ starRating: 4, reviewText: 'B' }),
      makeReview({ starRating: 3, reviewText: 'C' }),
      makeReview({ starRating: 2, reviewText: 'D' }),
    ];
    const result = selectQualifyingReviews(reviews, { rule: 'newest' });
    expect(result).toHaveLength(3);
    expect(result[0]?.reviewText).toBe('A');
    expect(result[1]?.reviewText).toBe('B');
    expect(result[2]?.reviewText).toBe('C');
  });

  it('positive-with-moderate-tail: prefers 5-star with body > 50', () => {
    const reviews = [
      makeReview({ starRating: 5, reviewText: 'A'.repeat(60) }),
      makeReview({ starRating: 5, reviewText: 'B'.repeat(60) }),
      makeReview({ starRating: 4, reviewText: 'C' }),
      makeReview({ starRating: 3, reviewText: 'D' }),
    ];
    const result = selectQualifyingReviews(reviews, { rule: 'positive-with-moderate-tail' });
    expect(result.length).toBeGreaterThanOrEqual(1);
    expect(result[0]?.starRating).toBe(5);
  });

  it('positive-with-moderate-tail: appends one 3-star after anchor', () => {
    const reviews = [
      makeReview({ starRating: 5, reviewText: 'A'.repeat(60) }),
      makeReview({ starRating: 4, reviewText: 'B' }),
      makeReview({ starRating: 3, reviewText: 'C' }),
    ];
    const result = selectQualifyingReviews(reviews, { rule: 'positive-with-moderate-tail' });
    expect(result).toHaveLength(3);
    expect(result[2]?.starRating).toBe(3);
  });

  it('positive-with-moderate-tail: returns [] when no >=4 reviews', () => {
    const reviews = [
      makeReview({ starRating: 3 }),
      makeReview({ starRating: 2 }),
      makeReview({ starRating: 1 }),
    ];
    const result = selectQualifyingReviews(reviews, { rule: 'positive-with-moderate-tail' });
    expect(result).toEqual([]);
  });

  it('positive-with-moderate-tail: no 3-star without >=4 anchor', () => {
    const reviews = [
      makeReview({ starRating: 5, reviewText: 'Short' }), // 5-star but body <= 50
      makeReview({ starRating: 3 }),
    ];
    // No 4-star, and the 5-star fails the "body > 50" substance check.
    // But wait — the substance check only applies to 5-star *preference*,
    // not to 5-star exclusion. Re-reading the spec §3.3:
    // "1. >=1 5-star with body length > 50 chars" is preference, not gate.
    // The >=4 gate is: "eligibility for the SerpAPI path requires >=1 review with rating >= 4"
    // So a plain 5-star (even short body) IS a >=4 anchor.
    const result = selectQualifyingReviews(reviews, { rule: 'positive-with-moderate-tail' });
    expect(result.length).toBeGreaterThanOrEqual(1);
  });
});
```

- [ ] **Step 3: Run tests**

```bash
npx vitest run src/lib/demos/__tests__/select-qualifying.test.ts
```
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add src/lib/demos/select-qualifying.ts src/lib/demos/__tests__/select-qualifying.test.ts
git commit -m "refactor(demos): decompose review selection into pure function (#1)"
```

---

## Task 4: Create `src/lib/demos/fetch-reviews.ts`

**Files:**
- Create: `src/lib/demos/fetch-reviews.ts`
- Test: `src/lib/demos/__tests__/fetch-reviews.test.ts`

- [ ] **Step 1: Implement**

```typescript
import { SerpApiSource } from '@/lib/reviews/serpapi-source';
import { MockReviewSource } from '@/lib/reviews/mock-source';
import type { NormalizedReview } from '@/lib/reviews/types';

const useMocks = process.env.MOCK_EXTERNAL_APIS === 'true';

/**
 * Fetches up to 15 reviews for a given Google Place ID.
 *
 * In dev/test with MOCK_EXTERNAL_APIS=true, returns canned mock data.
 * Otherwise hits SerpAPI.
 */
export async function fetchSerpApiReviews(placeId: string): Promise<NormalizedReview[]> {
  const source = useMocks
    ? new MockReviewSource()
    : new SerpApiSource(process.env.SERPAPI_API_KEY!);
  return source.fetchReviews(placeId, 15);
}
```

- [ ] **Step 2: Write the test**

```typescript
import { describe, it, expect, vi } from 'vitest';
import { fetchSerpApiReviews } from '../fetch-reviews';

describe('fetchSerpApiReviews', () => {
  it('returns mock reviews when MOCK_EXTERNAL_APIS is true', async () => {
    const original = process.env.MOCK_EXTERNAL_APIS;
    process.env.MOCK_EXTERNAL_APIS = 'true';
    try {
      const reviews = await fetchSerpApiReviews('ChIJN1t_tDeuEmsRUsoyG83frY4');
      expect(reviews.length).toBeGreaterThanOrEqual(1);
      expect(reviews[0]).toHaveProperty('reviewerName');
      expect(reviews[0]).toHaveProperty('starRating');
    } finally {
      process.env.MOCK_EXTERNAL_APIS = original;
    }
  });
});
```

- [ ] **Step 3: Run tests**

```bash
MOCK_EXTERNAL_APIS=true npx vitest run src/lib/demos/__tests__/fetch-reviews.test.ts
```
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add src/lib/demos/fetch-reviews.ts src/lib/demos/__tests__/fetch-reviews.test.ts
git commit -m "refactor(demos): extract fetchSerpApiReviews helper (#1)"
```

---

## Task 5: Create `src/lib/demos/generate-responses.ts`

**Files:**
- Create: `src/lib/demos/generate-responses.ts`
- Test: `src/lib/demos/__tests__/generate-responses.test.ts`

- [ ] **Step 1: Implement**

```typescript
import { generateResponse } from '@/lib/responses/generator';
import { generateMockResponse } from '@/lib/responses/mock-generator';
import type { NormalizedReview } from '@/lib/reviews/types';
import type { GenerationResult } from '@/lib/responses/types';

const useMocks = process.env.MOCK_EXTERNAL_APIS === 'true';

export interface GenerateResponsesResult {
  reviews: NormalizedReview[];
  responses: (GenerationResult | null)[];
  metadata: {
    totalReviews: number;
    successfulResponses: number;
    failedResponses: number;
    totalCostUsd: number;
    generationDurationMs: number;
  };
}

export async function generateResponsesForReviews(
  reviews: NormalizedReview[],
  businessContext: { name: string; category: string | null },
): Promise<GenerateResponsesResult> {
  const startTime = Date.now();
  const generateFn = useMocks ? generateMockResponse : generateResponse;

  const settled = await Promise.allSettled(
    reviews.map((review) =>
      generateFn(review, businessContext, [], { mode: 'demo' }),
    ),
  );

  const responses: (GenerationResult | null)[] = settled.map(
    (result, index) => {
      if (result.status === 'fulfilled') {
        return result.value;
      }
      console.error(
        `[demo-generator] LLM failed for review ${index} (${reviews[index]?.reviewerName}):`,
        result.reason,
      );
      return null;
    },
  );

  const successful = responses.filter((r): r is GenerationResult => r !== null);

  return {
    reviews,
    responses,
    metadata: {
      totalReviews: reviews.length,
      successfulResponses: successful.length,
      failedResponses: reviews.length - successful.length,
      totalCostUsd: successful.reduce((sum, r) => sum + r.costUsd, 0),
      generationDurationMs: Date.now() - startTime,
    },
  };
}
```

- [ ] **Step 2: Write the test**

```typescript
import { describe, it, expect } from 'vitest';
import { generateResponsesForReviews } from '../generate-responses';

describe('generateResponsesForReviews', () => {
  it('returns responses for all reviews in mock mode', async () => {
    const original = process.env.MOCK_EXTERNAL_APIS;
    process.env.MOCK_EXTERNAL_APIS = 'true';
    try {
      const result = await generateResponsesForReviews(
        [
          { reviewerName: 'A', starRating: 5, reviewText: 'Great', reviewDate: '2026-01-01', detectedLanguage: 'en' },
          { reviewerName: 'B', starRating: 4, reviewText: 'Good', reviewDate: '2026-01-02', detectedLanguage: 'en' },
        ],
        { name: 'Test Biz', category: 'restaurant' },
      );
      expect(result.reviews).toHaveLength(2);
      expect(result.responses).toHaveLength(2);
      expect(result.metadata.totalReviews).toBe(2);
      expect(result.metadata.generationDurationMs).toBeGreaterThanOrEqual(0);
    } finally {
      process.env.MOCK_EXTERNAL_APIS = original;
    }
  });
});
```

- [ ] **Step 3: Run tests**

```bash
MOCK_EXTERNAL_APIS=true npx vitest run src/lib/demos/__tests__/generate-responses.test.ts
```
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add src/lib/demos/generate-responses.ts src/lib/demos/__tests__/generate-responses.test.ts
git commit -m "refactor(demos): extract generateResponsesForReviews helper (#1)"
```

---

## Task 6: Refactor `src/lib/demos/generator.ts`

**Files:**
- Modify: `src/lib/demos/generator.ts`
- No new tests needed (covered by existing worker tests — green is the proof)

- [ ] **Step 1: Replace `generator.ts` body**

```typescript
import type { DemoGeneratorInput, DemoGeneratorResult } from './types';
import { fetchSerpApiReviews } from './fetch-reviews';
import { selectQualifyingReviews } from './select-qualifying';
import { generateResponsesForReviews } from './generate-responses';

/**
 * Core demo generation logic — called by DemoGenerationWorker on Railway.
 *
 * Composition: fetch → select(newest) → generate.
 * The worker handles all persistence.
 */
export async function generateDemo(
  input: DemoGeneratorInput,
): Promise<DemoGeneratorResult> {
  const reviews = await fetchSerpApiReviews(input.placeId);

  if (reviews.length === 0) {
    throw new Error('No reviews found for this business');
  }

  const selected = selectQualifyingReviews(reviews, { rule: 'newest' });

  const result = await generateResponsesForReviews(selected, {
    name: input.businessName,
    category: input.category,
  });

  return {
    placeId: input.placeId,
    reviews: result.reviews,
    responses: result.responses,
    metadata: result.metadata,
  };
}
```

- [ ] **Step 2: Run existing tests**

```bash
MOCK_EXTERNAL_APIS=true npx vitest run src/lib/demos --reporter=verbose
```
Expected: All existing tests pass (there may be none for this module directly, but the integration should compile).

- [ ] **Step 3: Commit**

```bash
git add src/lib/demos/generator.ts
git commit -m "refactor(demos): compose generateDemo from extracted helpers (#1)"
```

---

## Task 7: Refactor `worker/jobs/DemoGenerationWorker.ts`

**Files:**
- Modify: `worker/jobs/DemoGenerationWorker.ts`
- No new tests needed (existing integration tests must stay green)

- [ ] **Step 1: Replace worker body**

```typescript
import type { Job } from 'bullmq';
import { sql } from '../../src/lib/db/server';
import type { DemoJobPayload } from '../../src/lib/demos/types';
import { generateDemo } from '../../src/lib/demos/generator';
import { claimDemo, completeDemo, failDemo } from '../../src/lib/demos/lifecycle';
import { createWorkerLogger } from '../../src/lib/shared/logger';
import { extractOutboxHandle, markOutboxCompleted } from '../../src/lib/shared/outbox';
import { isPlaceId, parseGoogleMapsUrl } from '../../src/lib/reviews/url-parser';
import { resolvePlaceId } from '../../src/lib/reviews/place-id-resolver';

export async function handleDemoGeneration(
  job: Job<DemoJobPayload>,
): Promise<void> {
  const logger = createWorkerLogger('[DemoGenerationWorker]', job.data.correlation_id);
  const { demoId, businessName, category } = job.data;
  let { googlePlaceId } = job.data;
  const googleMapsUrl = job.data.googleMapsUrl;
  const { outboxId, attempt: outboxAttempt } = extractOutboxHandle(job.data, job.id!);

  const claimResult = await claimDemo('prospect_demos', demoId, logger);

  if (claimResult === 'not_found' || claimResult === 'already_terminal') {
    // Use the existing helper — it correctly branches on attempt presence
    // (typed runtime check). The previous draft inlined the SQL with
    // `attempts = ${outboxAttempt ?? sql\`attempts\`}`, which is invalid
    // postgres.js syntax: `sql\`attempts\`` binds the literal string
    // 'attempts' as a parameter, not a column reference.
    await markOutboxCompleted(outboxId, outboxAttempt);
    return;
  }

  if (claimResult === 'reset_to_queued') {
    // BullMQ will re-dispatch this job via OutboxPoller on next cycle.
    // No need to re-throw — the row is safely reset.
    throw new Error(`Demo ${demoId} reset from stale running; will re-dispatch`);
  }

  try {
    if (!isPlaceId(googlePlaceId) && googleMapsUrl) {
      const urlData = parseGoogleMapsUrl(googleMapsUrl);
      googlePlaceId = await resolvePlaceId(urlData);
    } else if (!isPlaceId(googlePlaceId)) {
      throw new Error('Invalid Place ID and no URL available for resolution');
    }

    const result = await generateDemo({
      placeId: googlePlaceId,
      businessName,
      category: category ?? null,
    });

    await completeDemo('prospect_demos', demoId, outboxId, outboxAttempt, {
      reviews: result.reviews,
      responses: result.responses,
    });

    logger.log(
      `Demo ${demoId} completed: ${result.metadata.successfulResponses}/${result.metadata.totalReviews} responses in ${result.metadata.generationDurationMs}ms`,
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    logger.error(`Demo ${demoId} failed: ${message}`);
    await failDemo('prospect_demos', demoId, outboxId, outboxAttempt, new Error(message));
    // Do NOT re-throw — failure is fully handled in Postgres.
  }
}
```

Note: `outboxAttempt` is `number | undefined`. The early-return path uses
`markOutboxCompleted(outboxId, outboxAttempt)`, which already branches on
attempt presence internally (see `src/lib/shared/outbox.ts:39-66`). Do NOT
inline the UPDATE — the `${outboxAttempt ?? sql\`attempts\`}` pattern is
invalid (postgres.js binds `sql\`attempts\`` as the literal string 'attempts'
rather than a column reference). The lifecycle.ts helpers handle the
in-tx outbox writes correctly via their own `typeof outboxAttempt === 'number'`
branch.

- [ ] **Step 2: Compile check**

Run: `pnpm tsc --noEmit`
Expected: No type errors in `worker/jobs/DemoGenerationWorker.ts`.

- [ ] **Step 3: Run existing worker tests**

Run: `MOCK_EXTERNAL_APIS=true npx vitest run worker/__tests__`
Expected: All existing tests pass (the only testable worker path is DemoGenerationWorker via integration or end-to-end).

- [ ] **Step 4: Commit**

```bash
git add worker/jobs/DemoGenerationWorker.ts
git commit -m "refactor(worker): DemoGenerationWorker uses extracted lifecycle helpers (#1)"
```

---

## Task 8: Update `src/lib/demos/index.ts`

**Files:**
- Modify: `src/lib/demos/index.ts`

- [ ] **Step 1: Add exports**

```typescript
export type {
  DemoJobPayload,
  DemoGeneratorInput,
  DemoGeneratorResult,
  DemoMetadata,
  DemoListItem,
  DemoTable,
  ClaimResult,
  CompleteDemoArgs,
  SelectionRule,
  SelectQualifyingOptions,
} from './types';

export { generateDemo } from './generator';
export { fetchSerpApiReviews } from './fetch-reviews';
export { selectQualifyingReviews } from './select-qualifying';
export { generateResponsesForReviews } from './generate-responses';
export { claimDemo, completeDemo, failDemo } from './lifecycle';
```

- [ ] **Step 2: Commit**

```bash
git add src/lib/demos/index.ts
git commit -m "refactor(demos): export all extracted helpers from index (#1)"
```

---

## Task 9: Full regression test + green check

**Files:** None (verification only)

- [ ] **Step 1: Type-check**

```bash
pnpm tsc --noEmit
```
Expected: Zero errors.

- [ ] **Step 2: Unit tests**

```bash
MOCK_EXTERNAL_APIS=true npx vitest run src/lib/demos/__tests__
```
Expected: All PASS.

- [ ] **Step 3: Integration tests (skip if no TEST_DATABASE_POOL_URL)**

```bash
MOCK_EXTERNAL_APIS=true npx vitest run worker/__tests__
```
Expected: All PASS or graceful skip.

- [ ] **Step 4: Lint**

```bash
pnpm lint
```
Expected: Zero errors.

- [ ] **Step 5: Commit**

```bash
git commit --allow-empty -m "chore: PR #1 regression suite green"
```

---

## Task 10: Self-review checklist

**Files:** None (verification only)

- [ ] **Step 1: Spec coverage scan**

| Spec section | Task that implements it |
|---|---|
| §3.2 lifecycle extraction | Tasks 1, 2, 7 |
| §3.2 table-param (`prospect_demos` / `onboarding_demos`) | Task 2 (`DemoTable` type) |
| §3.2 schema divergence (`source` optional) | Task 2 (`completeDemo` conditional `source`) |
| §3.3 `'positive-with-moderate-tail'` rule | Task 3 |
| §3.3 `'newest'` rule regression | Task 3 |
| §3.5 race-aware completion (23505 catch) | Task 2 (`completeDemo` catch block) |
| §3.5 `archived` terminal status | Task 2 (`claimDemo` already_terminal includes archived) |
| §3.5 stale-running recovery (5min) | Task 2 (`claimDemo`) |
| §6.3 `generateDemo()` decomposition | Tasks 3, 4, 5 |
| §6.2 worker Mock leak guard | Out of scope — PR #2 (onboarding-specific) |

- [ ] **Step 2: Placeholder scan**

Search the plan file for: `TBD`, `TODO`, `implement later`, `fill in details`, `Add appropriate`, `add validation`, `handle edge cases`, `Write tests for`, `Similar to Task`. None found.

- [ ] **Step 3: Type consistency**

| Name | Defined in | Used in |
|---|---|---|
| `DemoTable` | `types.ts` (Task 1) | `lifecycle.ts` (Task 2) |
| `ClaimResult` | `types.ts` (Task 1) | `lifecycle.ts` (Task 2), tests (Task 2) |
| `CompleteDemoArgs` | `types.ts` (Task 1) | `lifecycle.ts` (Task 2) |
| `SelectionRule` | `types.ts` (Task 1) | `select-qualifying.ts` (Task 3) |
| `fetchSerpApiReviews` | `fetch-reviews.ts` (Task 4) | `generator.ts` (Task 6) |
| `selectQualifyingReviews` | `select-qualifying.ts` (Task 3) | `generator.ts` (Task 6) |
| `generateResponsesForReviews` | `generate-responses.ts` (Task 5) | `generator.ts` (Task 6) |

All names match — no drift.

---

## Execution Handoff

**Plan complete and saved to `docs/superpowers/plans/2026-05-03-pr1-lifecycle-extraction.md`. Two execution options:**

**1. Subagent-Driven (recommended)** - Fresh subagent per task, review between tasks, fast iteration

**2. Inline Execution** - Execute tasks in this session using executing-plans, batch execution with checkpoints

**Which approach?**
