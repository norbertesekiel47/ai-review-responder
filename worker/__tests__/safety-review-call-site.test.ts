import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Job } from 'bullmq';
import type { GenerateResponsePayload } from '../../src/lib/shared/worker-types';
import type { GenerationResult } from '../../src/lib/responses/types';

// The Safety review CALL SITE in ResponseGeneratorWorker (G4-F1).
//
// Plan round-1 finding 5: T1's module, gate and step tests can all pass while
// the worker threads the WRONG verdict, treats not-cleared as a moderation
// hold, drops owner notification, or holds the review/business/entitlement
// locks (persist.ts:395) across provider latency. Those are separate branches,
// so they need worker-level assertions of their own.
//
// This file owns the ORDERING and SKIP half. The persistence half — what the
// verdict does to the stored row, the spine and the outbox — lives in
// response-generation/__tests__/persist.test.ts, against real persistence.
//
// Harness mirrors worker/jobs/__tests__/ResponseGeneratorWorker.test.ts, which
// is outside this branch's allowed edit surface.

const {
  sqlReturnQueue,
  mockSql,
  mockTx,
  mockIsMockMode,
  mockSanitizeText,
  mockGenerateResponse,
  mockModerateResponse,
  mockRunTriagePhase,
  mockReviewSafety,
  callOrder,
} = vi.hoisted(() => {
  const sqlReturnQueue: unknown[] = [];
  const callOrder: string[] = [];

  // Text-aware, because persist.ts runs the REAL auto-approval path and its
  // runtime-state read throws on a missing row. Everything else returns [],
  // which is what the lock/insert statements expect.
  const mockTx = vi.fn((strings: TemplateStringsArray, ..._v: unknown[]): Promise<unknown[]> => {
    const text = strings.join(' ').replace(/\s+/g, ' ');
    if (text.includes('FROM reviews r') && text.includes('JOIN accounts a')) {
      return Promise.resolve([
        {
          star_rating: 5,
          review_content_hash: null,
          archived_at: null,
          subscription_status: 'active',
          subscription_tier: 'autopilot',
          account_past_due_at: null,
          account_flags: {},
          triage_severity: null,
          triage_source: null,
        },
      ]);
    }
    if (text.includes('FROM reviews') && text.includes('FOR UPDATE')) {
      return Promise.resolve([{ id: 'rev-1' }]);
    }
    if (text.includes('FROM businesses') && text.includes('FOR UPDATE')) {
      return Promise.resolve([{ id: 'biz-1' }]);
    }
    if (text.includes('FROM approval_audit_log')) {
      return Promise.resolve([{ auto_approved_today: 0 }]);
    }
    if (text.includes('FROM auto_approval_policies')) {
      return Promise.resolve([]);
    }
    return Promise.resolve([]);
  });
  (mockTx as unknown as { json: (v: unknown) => unknown }).json = vi.fn((v: unknown) => v);

  const mockSql: any = vi.fn(() => Promise.resolve(sqlReturnQueue.shift() ?? []));
  mockSql.begin = vi.fn(async (callback: (tx: any) => Promise<any>) => {
    callOrder.push('tx:open');
    const out = await callback(mockTx);
    callOrder.push('tx:close');
    return out;
  });

  return {
    sqlReturnQueue,
    mockSql,
    mockTx,
    callOrder,
    mockIsMockMode: vi.fn(() => false),
    mockSanitizeText: vi.fn((text: string) => text),
    mockGenerateResponse: vi.fn<() => Promise<GenerationResult>>(),
    mockModerateResponse: vi.fn(),
    mockRunTriagePhase: vi.fn(async () => null),
    mockReviewSafety: vi.fn(),
  };
});

vi.mock('../../src/lib/db/server', () => ({ sql: mockSql, jsonb: (v: unknown) => v }));
vi.mock('../../src/lib/shared/outbox', () => ({
  markOutboxCompleted: vi.fn(),
  markOutboxCompletedWithReason: vi.fn(),
  markOutboxFailed: vi.fn(),
  extractOutboxHandle: (_d: unknown, fallback: string) => ({ outboxId: fallback }),
}));
vi.mock('../../src/lib/shared/mock-mode', () => ({ isMockMode: mockIsMockMode }));
vi.mock('../../src/lib/shared/sanitize', () => ({ sanitizeText: mockSanitizeText }));
vi.mock('../../src/lib/responses/generator', () => ({ generateResponse: mockGenerateResponse }));
vi.mock('../../src/lib/responses/mock-generator', () => ({ generateMockResponse: vi.fn() }));
vi.mock('../../src/lib/responses/voice-learning', () => ({
  getApprovedResponsePairs: vi.fn(async () => []),
}));
vi.mock('../../src/lib/costs/tracker', () => ({
  checkRegenBudget: vi.fn(),
  setCachedGeneration: vi.fn(),
  CostLimitExceededError: class extends Error {},
  GlobalCostLimitExceededError: class extends Error {},
  RegenBudgetExceededError: class extends Error {},
}));
vi.mock('../../src/lib/costs/concurrency-guard', () => ({
  ConcurrencyLimitExceededError: class extends Error {},
}));
vi.mock('../../src/lib/analytics/enqueue', () => ({ enqueueAnalyticsEvent: vi.fn() }));
vi.mock('../../src/lib/moderation/moderate', () => ({ moderateResponse: mockModerateResponse }));
vi.mock('../jobs/response-generation/triage', () => ({ runTriagePhase: mockRunTriagePhase }));
vi.mock('uuid', () => ({ v7: vi.fn(() => 'deterministic-uuid-v7') }));

vi.mock('../../src/lib/moderation/safety-review', () => ({ reviewSafety: mockReviewSafety }));

import { handleResponseGeneration } from '../jobs/ResponseGeneratorWorker';
import {
  makeLoadContextReviewRow as mockReviewRow,
  makeLoadContextBusinessRow as mockBusinessRow,
} from '../jobs/response-generation/__tests__/load-context-fixtures';

const MOCK_RESULT: GenerationResult = {
  responseText: 'Thank you for the kind review.',
  language: 'en',
  provider: 'openai',
  model: 'gpt-4o-mini-2024-07-18',
  usage: { promptTokens: 100, completionTokens: 50 },
  costUsd: 0.001,
  apiCostId: 'cost-1',
};

const CLEARED = { cleared: true, concern: null, source: 'llm', provider: 'openai' } as const;

function makeJob(overrides = {}): Job<GenerateResponsePayload> {
  return {
    data: {
      review_id: 'rev-1',
      business_id: 'biz-1',
      version: 1,
      origin_lane: 'live_ingest_new',
      ...overrides,
    },
    id: 'outbox-gen-1',
  } as Job<GenerateResponsePayload>;
}

function primeContext() {
  sqlReturnQueue.push([mockReviewRow()]);
  sqlReturnQueue.push([mockBusinessRow()]);
  mockGenerateResponse.mockResolvedValueOnce(MOCK_RESULT);
}

describe('safety review call site', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    sqlReturnQueue.length = 0;
    callOrder.length = 0;
    process.env.AUTO_APPROVAL_ENABLED = 'true';
    mockIsMockMode.mockReturnValue(false);
    mockModerateResponse.mockResolvedValue({
      flagged: false,
      severity: 'low',
      reason: null,
      categories: {},
      score: 0,
      source: null,
      providerStatus: null,
    });
    mockReviewSafety.mockImplementation(async () => {
      callOrder.push('safety:done');
      return CLEARED;
    });
  });

  it('finishes the safety-review LLM call before opening the persist transaction', async () => {
    // The locks begin at persist.ts:395. An LLM call placed inside sql.begin
    // would hold the review, business and entitlement locks across provider
    // latency — seconds, on a pooled connection. Round 1 upheld the placement
    // and asked for the assertion that pins it.
    primeContext();

    await handleResponseGeneration(makeJob());

    expect(callOrder).toContain('safety:done');
    expect(callOrder.indexOf('safety:done')).toBeLessThan(callOrder.indexOf('tx:open'));
  });

  it('skips the safety review and makes no LLM call when moderation already flagged the draft', async () => {
    // The gate already blocks on moderation_flagged, so a second paid call
    // could not change the outcome.
    primeContext();
    mockModerateResponse.mockResolvedValue({
      flagged: true,
      severity: 'medium',
      reason: 'openai_moderation',
      categories: {},
      score: 1,
      source: 'openai_moderation',
      providerStatus: null,
    });

    await handleResponseGeneration(makeJob());

    expect(mockReviewSafety).not.toHaveBeenCalled();
  });

  it.each([
    ['a non-live origin lane', { origin_lane: 'on_demand_generate' }],
    ['a regeneration', { version: 2 }],
    ['a suppressed notification', { suppress_notification: true }],
  ])(
    'skips the safety review and makes no LLM call when the draft is not an auto-approval candidate',
    async (_case, overrides) => {
      // Every draft today, since AUTO_APPROVAL_ENABLED is false everywhere.
      // The skip is what keeps this feature's cost at zero until the flag flips.
      primeContext();

      await handleResponseGeneration(makeJob(overrides));

      expect(mockReviewSafety).not.toHaveBeenCalled();
    },
  );

  it('does not retry the job when the safety review fails', async () => {
    // The draft is already generated and PAID FOR. A BullMQ retry would buy a
    // second paid draft to fix a gate failure. reviewSafety never throws, so
    // the handler must complete — the locked "No retry" invariant.
    //
    // Scoped to CHECK failures only: a response/outbox/spine persistence
    // failure still rolls back and still retries (round-1 finding 5).
    primeContext();
    mockReviewSafety.mockResolvedValue({
      cleared: false,
      concern: null,
      source: 'failed',
      provider: null,
    });

    await expect(handleResponseGeneration(makeJob())).resolves.toBeUndefined();
    expect(mockSql.begin).toHaveBeenCalled();
  });
});
