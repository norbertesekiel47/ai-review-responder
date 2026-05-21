# ResponseGeneratorWorker Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the ResponseGeneratorWorker that processes `generate_response` BullMQ jobs — a thin orchestration wrapper around the existing `generateResponse()` / `generateMockResponse()` with subscription guards, input sanitization, voice learning, avoid-facts guardrails, and transactional response persistence.

**Architecture:** The worker reads the review + business from Postgres, builds a `BusinessContext` from the DB row, calls the existing generator (which handles cost guards, caching, LLM calls, fallback), checks avoid_facts against the output, then writes the response row + send_notification outbox entry in one transaction. Error classes from the cost tracker determine whether to fail the outbox (terminal) or throw for BullMQ retry (transient).

**Tech Stack:** Postgres.js (`sql`), BullMQ `Job`, UUIDv7, existing `generateResponse()` / `generateMockResponse()`, shared utilities (subscription-guard, outbox, sanitize, mock-mode, worker-types), `checkRegenBudget` / `linkApiCostToResponse` from costs/tracker

---

## File Map

| File | Action | Responsibility |
|---|---|---|
| `worker/jobs/ResponseGeneratorWorker.ts` | Create | Process generate_response jobs: validate, sanitize, generate, avoid-facts check, persist response + outbox |
| `worker/index.ts` | Modify | Register the new worker |
| `worker/__tests__/ResponseGeneratorWorker.test.ts` | Create | Unit tests with mocked SQL, generator, and cost tracker |

---

### Task 1: Create ResponseGeneratorWorker

**Files:**
- Create: `worker/jobs/ResponseGeneratorWorker.ts`

- [ ] **Step 1: Create the worker file**

```typescript
import type { Job } from 'bullmq';
import { v7 as uuidv7 } from 'uuid';
import { sql } from '../../src/lib/db/server';
import { checkSubscription } from '../../src/lib/shared/subscription-guard';
import { markOutboxCompleted, markOutboxFailed } from '../../src/lib/shared/outbox';
import { isMockMode } from '../../src/lib/shared/mock-mode';
import { sanitizeText } from '../../src/lib/shared/sanitize';
import { getApprovedResponsePairs } from '../../src/lib/responses/voice-learning';
import { generateResponse } from '../../src/lib/responses/generator';
import { generateMockResponse } from '../../src/lib/responses/mock-generator';
import {
  CostLimitExceededError,
  GlobalCostLimitExceededError,
  ConcurrencyLimitExceededError,
  RegenBudgetExceededError,
  checkRegenBudget,
  linkApiCostToResponse,
} from '../../src/lib/costs/tracker';
import type { GenerateResponsePayload, SendNotificationPayload } from '../../src/lib/shared/worker-types';
import type { NormalizedReview } from '../../src/lib/reviews/types';
import type { BusinessContext, GenerationResult, VoiceExample } from '../../src/lib/responses/types';

const LOG_PREFIX = '[ResponseGeneratorWorker]';

export async function handleResponseGeneration(
  job: Job<GenerateResponsePayload>,
): Promise<void> {
  const { review_id, business_id, version } = job.data;
  const outboxId = job.id!;

  // ── Step 1: Read review and business ─────────────────────────────────
  const [review] = await sql<{
    id: string;
    reviewer_name: string;
    star_rating: number;
    review_text: string | null;
    review_date: string;
    detected_language: string;
  }[]>`
    SELECT id, reviewer_name, star_rating, review_text, review_date, detected_language
    FROM reviews WHERE id = ${review_id}
  `;

  if (!review) {
    console.warn(`${LOG_PREFIX} Review ${review_id} not found`);
    await markOutboxFailed(outboxId, 'review_not_found');
    return;
  }

  const [business] = await sql<{
    id: string;
    name: string;
    category: string | null;
    tone: string;
    products_services: string | null;
    staff_names: string[] | null;
    highlight_facts: string[] | null;
    avoid_facts: string[] | null;
    sample_responses: string[] | null;
    subscription_status: string;
    subscription_tier: string;
    updated_at: Date;
  }[]>`
    SELECT id, name, category, tone, products_services, staff_names,
           highlight_facts, avoid_facts, sample_responses,
           subscription_status, subscription_tier, updated_at
    FROM businesses WHERE id = ${business_id}
  `;

  if (!business) {
    console.warn(`${LOG_PREFIX} Business ${business_id} not found`);
    await markOutboxFailed(outboxId, 'business_not_found');
    return;
  }

  // ── Step 2: Subscription guard ───────────────────────────────────────
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

  // ── Step 3: Build NormalizedReview with sanitized text ────────────────
  const normalizedReview: NormalizedReview = {
    reviewerName: review.reviewer_name,
    starRating: review.star_rating,
    reviewText: review.review_text ? sanitizeText(review.review_text) : null,
    reviewDate: review.review_date,
    detectedLanguage: review.detected_language,
  };

  // ── Step 4: Build BusinessContext from DB row ────────────────────────
  // JSONB parsing guard: Postgres.js may return TEXT[] as strings through PgBouncer
  const parseArray = (val: unknown): string[] => {
    if (Array.isArray(val)) return val as string[];
    if (typeof val === 'string') {
      try { return JSON.parse(val) as string[]; } catch { return []; }
    }
    return [];
  };

  const businessContext: BusinessContext = {
    id: business.id,
    name: business.name,
    category: business.category,
    tone: business.tone,
    productsServices: business.products_services,
    staffNames: parseArray(business.staff_names),
    highlightFacts: parseArray(business.highlight_facts),
    avoidFacts: parseArray(business.avoid_facts),
    sampleResponses: parseArray(business.sample_responses),
    subscriptionTier: business.subscription_tier as BusinessContext['subscriptionTier'],
  };

  // ── Step 5: Voice learning ──────────────────────────────────────────
  const voiceExamples: VoiceExample[] = await getApprovedResponsePairs(business_id);

  // ── Step 6: Regeneration budget check ───────────────────────────────
  if (version > 1) {
    try {
      await checkRegenBudget(review_id);
    } catch (err) {
      if (err instanceof RegenBudgetExceededError) {
        console.warn(`${LOG_PREFIX} Regen budget exceeded for review ${review_id}`);
        await markOutboxFailed(outboxId, err.message);
        return;
      }
      throw err;
    }
  }

  // ── Step 7: Generate response ───────────────────────────────────────
  let result: GenerationResult;
  try {
    if (isMockMode()) {
      result = await generateMockResponse(
        normalizedReview,
        businessContext,
        voiceExamples,
        { mode: 'production', reviewId: review_id, version, businessId: business_id, subscriptionTier: businessContext.subscriptionTier },
      );
    } else {
      result = await generateResponse(
        normalizedReview,
        businessContext,
        voiceExamples,
        { mode: 'production', reviewId: review_id, version, businessId: business_id, subscriptionTier: businessContext.subscriptionTier },
      );
    }
  } catch (err) {
    if (err instanceof CostLimitExceededError || err instanceof GlobalCostLimitExceededError) {
      console.warn(`${LOG_PREFIX} Cost limit exceeded for business ${business_id}: ${err.message}`);
      await markOutboxFailed(outboxId, err.message);
      return;
    }
    if (err instanceof ConcurrencyLimitExceededError) {
      // Transient — other jobs will finish, then this one can proceed
      throw err;
    }
    // LLM failures (both providers down) or other errors
    console.error(`${LOG_PREFIX} Generation failed for review ${review_id}: ${err instanceof Error ? err.message : err}`);
    await markOutboxFailed(outboxId, `generation_failed: ${err instanceof Error ? err.message : err}`);
    return;
  }

  // ── Step 8: Avoid-facts guardrail ───────────────────────────────────
  const avoidFacts = businessContext.avoidFacts;
  if (avoidFacts.length > 0) {
    const violation = findAvoidFactViolation(result.responseText, avoidFacts);
    if (violation) {
      console.warn(`${LOG_PREFIX} Avoid-fact violation for review ${review_id}: "${violation}". Regenerating once.`);
      try {
        const retryResult = isMockMode()
          ? await generateMockResponse(normalizedReview, businessContext, voiceExamples,
              { mode: 'production', reviewId: review_id, version, businessId: business_id, subscriptionTier: businessContext.subscriptionTier })
          : await generateResponse(normalizedReview, businessContext, voiceExamples,
              { mode: 'production', reviewId: review_id, version, businessId: business_id, subscriptionTier: businessContext.subscriptionTier });

        // Accumulate cost from both attempts
        result = {
          ...retryResult,
          costUsd: result.costUsd + retryResult.costUsd,
        };
      } catch {
        // Best-effort retry failed — use the original result
        console.warn(`${LOG_PREFIX} Avoid-fact retry failed for review ${review_id}, using original response`);
      }
    }
  }

  // ── Step 9: Persist response + outbox in one transaction ────────────
  const responseId = uuidv7();
  try {
    await sql.begin(async (tx) => {
      await tx`
        INSERT INTO responses (
          id, review_id, business_id, response_text, response_language,
          version, status, original_draft_text,
          llm_provider, llm_model, prompt_tokens, completion_tokens
        ) VALUES (
          ${responseId}, ${review_id}, ${business_id}, ${result.responseText}, ${result.language},
          ${version}, 'pending_approval', ${result.responseText},
          ${result.provider}, ${result.model}, ${result.usage.promptTokens}, ${result.usage.completionTokens}
        )
      `;

      const notifyPayload: SendNotificationPayload = {
        response_id: responseId,
        business_id: business_id,
      };

      await tx`
        INSERT INTO job_outbox (id, topic, aggregate_type, aggregate_id, payload, status)
        VALUES (
          ${uuidv7()}, 'send_notification', 'response', ${responseId},
          ${JSON.stringify(notifyPayload)}::jsonb, 'pending'
        )
      `;
    });
  } catch (err) {
    // DB transaction failure — throw for BullMQ retry (transient)
    throw err;
  }

  // Link api_costs to response (best-effort, outside transaction)
  if (result.apiCostId) {
    try {
      await linkApiCostToResponse(result.apiCostId, responseId);
    } catch (err) {
      console.error(`${LOG_PREFIX} Failed to link api_cost to response: ${err instanceof Error ? err.message : err}`);
    }
  }

  // ── Step 10: Complete outbox ─────────────────────────────────────────
  await markOutboxCompleted(outboxId);
  console.log(`${LOG_PREFIX} Response ${responseId} generated for review ${review_id} (v${version})`);
}

// ── Helpers ─────────────────────────────────────────────────────────────

function findAvoidFactViolation(text: string, avoidFacts: string[]): string | null {
  const lower = text.toLowerCase();
  for (const fact of avoidFacts) {
    if (fact && lower.includes(fact.toLowerCase())) {
      return fact;
    }
  }
  return null;
}
```

- [ ] **Step 2: Verify TypeScript compiles**

Run: `npx tsc --noEmit`
Expected: No errors

- [ ] **Step 3: Commit**

```bash
git add worker/jobs/ResponseGeneratorWorker.ts
git commit -m "feat: add ResponseGeneratorWorker for generate_response job processing"
```

---

### Task 2: Register worker in worker/index.ts

**Files:**
- Modify: `worker/index.ts`

- [ ] **Step 1: Add import**

After the ReviewSyncWorker import:
```typescript
import { handleResponseGeneration } from './jobs/ResponseGeneratorWorker';
```

- [ ] **Step 2: Add worker creation**

After the `reviewSyncWorker` creation:
```typescript
const responseGenWorker = new Worker(QUEUE_NAMES.GENERATE_RESPONSE, handleResponseGeneration, {
  connection: redisOpts,
});
```

- [ ] **Step 3: Add to workers array**

Change `const workers = [demoWorker, reviewSyncWorker];` to:
```typescript
const workers = [demoWorker, reviewSyncWorker, responseGenWorker];
```

- [ ] **Step 4: Verify TypeScript compiles and tests pass**

Run: `npx tsc --noEmit && pnpm test`
Expected: No errors, all tests pass

- [ ] **Step 5: Commit**

```bash
git add worker/index.ts
git commit -m "feat: register ResponseGeneratorWorker in worker lifecycle"
```

---

### Task 3: Write unit tests

**Files:**
- Create: `worker/__tests__/ResponseGeneratorWorker.test.ts`

Tests cover the 5 required cases:
1. Successful generation → response row + send_notification outbox entry created, markOutboxCompleted called
2. Subscription cancelled → markOutboxCompleted, no generation
3. Cost limit exceeded → markOutboxFailed, no throw
4. Mock mode → generateMockResponse used instead of generateResponse
5. Avoid-facts violation → regenerates once

- [ ] **Step 1: Create the test file**

```typescript
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Job } from 'bullmq';
import type { GenerateResponsePayload } from '../../src/lib/shared/worker-types';

// ── Hoisted state ────────────────────────────────────────────────────
const {
  sqlReturnQueue,
  mockSql,
  mockTx,
  mockMarkOutboxCompleted,
  mockMarkOutboxFailed,
  mockGenerateResponse,
  mockGenerateMockResponse,
  mockGetApprovedResponsePairs,
  mockCheckRegenBudget,
  mockLinkApiCostToResponse,
  mockIsMockMode,
} = vi.hoisted(() => {
  const sqlReturnQueue: unknown[] = [];

  const mockTx = vi.fn((_s: TemplateStringsArray, ..._v: unknown[]): Promise<unknown[]> => {
    return Promise.resolve([]);
  });

  const mockSql: any = vi.fn((_s: TemplateStringsArray, ..._v: unknown[]) => {
    const result = sqlReturnQueue.shift() ?? [];
    return Promise.resolve(result);
  });

  mockSql.begin = vi.fn(async (cb: (tx: any) => Promise<any>) => cb(mockTx));

  return {
    sqlReturnQueue,
    mockSql,
    mockTx,
    mockMarkOutboxCompleted: vi.fn(),
    mockMarkOutboxFailed: vi.fn(),
    mockGenerateResponse: vi.fn(),
    mockGenerateMockResponse: vi.fn(),
    mockGetApprovedResponsePairs: vi.fn().mockResolvedValue([]),
    mockCheckRegenBudget: vi.fn(),
    mockLinkApiCostToResponse: vi.fn(),
    mockIsMockMode: vi.fn().mockReturnValue(false),
  };
});

// ── Mocks ────────────────────────────────────────────────────────────
vi.mock('../../src/lib/db/server', () => ({ sql: mockSql }));
vi.mock('../../src/lib/shared/outbox', () => ({
  markOutboxCompleted: mockMarkOutboxCompleted,
  markOutboxFailed: mockMarkOutboxFailed,
}));
vi.mock('../../src/lib/shared/mock-mode', () => ({
  isMockMode: mockIsMockMode,
}));
vi.mock('../../src/lib/responses/generator', () => ({
  generateResponse: mockGenerateResponse,
  CostLimitExceededError: class extends Error { name = 'CostLimitExceededError'; },
  GlobalCostLimitExceededError: class extends Error { name = 'GlobalCostLimitExceededError'; },
  ConcurrencyLimitExceededError: class extends Error { name = 'ConcurrencyLimitExceededError'; },
  RegenBudgetExceededError: class extends Error { name = 'RegenBudgetExceededError'; },
}));
vi.mock('../../src/lib/responses/mock-generator', () => ({
  generateMockResponse: mockGenerateMockResponse,
}));
vi.mock('../../src/lib/responses/voice-learning', () => ({
  getApprovedResponsePairs: mockGetApprovedResponsePairs,
}));
vi.mock('../../src/lib/costs/tracker', () => ({
  checkRegenBudget: mockCheckRegenBudget,
  linkApiCostToResponse: mockLinkApiCostToResponse,
  CostLimitExceededError: class extends Error {
    name = 'CostLimitExceededError';
    constructor(public readonly businessId: string) { super(`Cost limit exceeded for ${businessId}`); }
  },
  GlobalCostLimitExceededError: class extends Error { name = 'GlobalCostLimitExceededError'; },
  ConcurrencyLimitExceededError: class extends Error {
    name = 'ConcurrencyLimitExceededError';
    constructor(public readonly businessId: string) { super(`Concurrency limit exceeded for ${businessId}`); }
  },
  RegenBudgetExceededError: class extends Error {
    name = 'RegenBudgetExceededError';
    constructor(public readonly reviewId: string) { super(`Regen budget exceeded for ${reviewId}`); }
  },
}));
vi.mock('../../src/lib/shared/sanitize', () => ({
  sanitizeText: vi.fn((t: string) => t),
}));
vi.mock('uuid', () => ({ v7: vi.fn(() => 'test-uuid') }));

import { handleResponseGeneration } from '../jobs/ResponseGeneratorWorker';
import { CostLimitExceededError } from '../../src/lib/costs/tracker';

// ── Helpers ──────────────────────────────────────────────────────────

function makeJob(overrides: Partial<GenerateResponsePayload> = {}): Job<GenerateResponsePayload> {
  return {
    data: { review_id: 'rev-1', business_id: 'biz-1', version: 1, ...overrides },
    id: 'outbox-gen-1',
  } as Job<GenerateResponsePayload>;
}

function mockReviewRow() {
  return {
    id: 'rev-1', reviewer_name: 'Jane', star_rating: 5,
    review_text: 'Great!', review_date: '2026-04-01', detected_language: 'en',
  };
}

function mockBusinessRow(overrides: Record<string, unknown> = {}) {
  return {
    id: 'biz-1', name: 'Test Biz', category: 'restaurant', tone: 'warm',
    products_services: null, staff_names: [], highlight_facts: [], avoid_facts: [],
    sample_responses: [], subscription_status: 'active', subscription_tier: 'standard',
    updated_at: new Date(), ...overrides,
  };
}

const MOCK_RESULT = {
  responseText: 'Thank you, Jane!', language: 'en', provider: 'openai' as const,
  model: 'gpt-4o-mini', usage: { promptTokens: 100, completionTokens: 50 },
  costUsd: 0.001, apiCostId: 'cost-1',
};

// ── Tests ────────────────────────────────────────────────────────────

describe('ResponseGeneratorWorker', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    sqlReturnQueue.length = 0;
    mockIsMockMode.mockReturnValue(false);
    mockGenerateResponse.mockResolvedValue(MOCK_RESULT);
    mockGenerateMockResponse.mockResolvedValue({ ...MOCK_RESULT, apiCostId: null, costUsd: 0 });
  });

  it('generates response and creates outbox entry on success', async () => {
    sqlReturnQueue.push([mockReviewRow()]);
    sqlReturnQueue.push([mockBusinessRow()]);
    sqlReturnQueue.push([]); // linkApiCostToResponse (best-effort)

    await handleResponseGeneration(makeJob());

    expect(mockGenerateResponse).toHaveBeenCalled();
    expect(mockSql.begin).toHaveBeenCalled();
    expect(mockMarkOutboxCompleted).toHaveBeenCalledWith('outbox-gen-1');
  });

  it('completes outbox when subscription is cancelled', async () => {
    sqlReturnQueue.push([mockReviewRow()]);
    sqlReturnQueue.push([mockBusinessRow({ subscription_status: 'cancelled' })]);

    await handleResponseGeneration(makeJob());

    expect(mockGenerateResponse).not.toHaveBeenCalled();
    expect(mockMarkOutboxCompleted).toHaveBeenCalledWith('outbox-gen-1');
  });

  it('fails outbox on cost limit exceeded without throwing', async () => {
    sqlReturnQueue.push([mockReviewRow()]);
    sqlReturnQueue.push([mockBusinessRow()]);

    mockGenerateResponse.mockRejectedValueOnce(new CostLimitExceededError('biz-1'));

    await handleResponseGeneration(makeJob());

    expect(mockMarkOutboxFailed).toHaveBeenCalledWith('outbox-gen-1', expect.stringContaining('Cost limit'));
    expect(mockMarkOutboxCompleted).not.toHaveBeenCalled();
  });

  it('uses mock generator when MOCK_EXTERNAL_APIS=true', async () => {
    mockIsMockMode.mockReturnValue(true);
    sqlReturnQueue.push([mockReviewRow()]);
    sqlReturnQueue.push([mockBusinessRow()]);

    await handleResponseGeneration(makeJob());

    expect(mockGenerateMockResponse).toHaveBeenCalled();
    expect(mockGenerateResponse).not.toHaveBeenCalled();
    expect(mockMarkOutboxCompleted).toHaveBeenCalledWith('outbox-gen-1');
  });

  it('regenerates once on avoid-facts violation', async () => {
    sqlReturnQueue.push([mockReviewRow()]);
    sqlReturnQueue.push([mockBusinessRow({ avoid_facts: ['bad word'] })]);

    // First call contains the avoided term, second call is clean
    mockGenerateResponse
      .mockResolvedValueOnce({ ...MOCK_RESULT, responseText: 'This has bad word in it' })
      .mockResolvedValueOnce({ ...MOCK_RESULT, responseText: 'Clean response' });

    await handleResponseGeneration(makeJob());

    expect(mockGenerateResponse).toHaveBeenCalledTimes(2);
    expect(mockMarkOutboxCompleted).toHaveBeenCalledWith('outbox-gen-1');
  });
});
```

- [ ] **Step 2: Run tests**

Run: `pnpm test`
Expected: All tests pass

- [ ] **Step 3: Commit**

```bash
git add worker/__tests__/ResponseGeneratorWorker.test.ts
git commit -m "test: add ResponseGeneratorWorker unit tests"
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

Update `.claude/CLAUDE.md` current status with Prompt 10 completion.
Append Prompt 10 entry to `docs/progresstracking.md`.
