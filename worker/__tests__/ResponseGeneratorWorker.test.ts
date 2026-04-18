import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Job } from 'bullmq';
import type { GenerateResponsePayload } from '../../src/lib/shared/worker-types';
import type { GenerationResult } from '../../src/lib/responses/types';

// ── Hoisted state shared between mock factories and tests ──────────────
const {
  sqlReturnQueue,
  mockSql,
  mockTx,
  mockMarkOutboxCompleted,
  mockMarkOutboxFailed,
  mockIsMockMode,
  mockSanitizeText,
  mockGenerateResponse,
  mockGenerateMockResponse,
  mockGetApprovedResponsePairs,
  mockCheckRegenBudget,
  mockSetCachedGeneration,
} = vi.hoisted(() => {
  const sqlReturnQueue: unknown[] = [];

  const mockTx = vi.fn((_strings: TemplateStringsArray, ..._values: unknown[]): Promise<unknown[]> => {
    return Promise.resolve([]);
  });

  const mockSql: any = vi.fn((_strings: TemplateStringsArray, ..._values: unknown[]) => {
    const result = sqlReturnQueue.shift() ?? [];
    return Promise.resolve(result);
  });

  mockSql.begin = vi.fn(async (callback: (tx: any) => Promise<any>) => {
    return callback(mockTx);
  });

  return {
    sqlReturnQueue,
    mockSql,
    mockTx,
    mockMarkOutboxCompleted: vi.fn(),
    mockMarkOutboxFailed: vi.fn(),
    mockIsMockMode: vi.fn(() => false),
    mockSanitizeText: vi.fn((text: string) => text),
    mockGenerateResponse: vi.fn<() => Promise<GenerationResult>>(),
    mockGenerateMockResponse: vi.fn<() => Promise<GenerationResult>>(),
    mockGetApprovedResponsePairs: vi.fn(async () => []),
    mockCheckRegenBudget: vi.fn(),
    mockSetCachedGeneration: vi.fn(),
  };
});

// ── Module mocks (hoisted by vitest) ───────────────────────────────────
vi.mock('../../src/lib/db/server', () => ({
  sql: mockSql, jsonb: (v: unknown) => v }));

vi.mock('../../src/lib/shared/outbox', () => ({
  markOutboxCompleted: mockMarkOutboxCompleted,
  markOutboxFailed: mockMarkOutboxFailed,
}));

vi.mock('../../src/lib/shared/mock-mode', () => ({
  isMockMode: mockIsMockMode,
}));

vi.mock('../../src/lib/shared/sanitize', () => ({
  sanitizeText: mockSanitizeText,
}));

vi.mock('../../src/lib/responses/generator', () => ({
  generateResponse: mockGenerateResponse,
}));

vi.mock('../../src/lib/responses/mock-generator', () => ({
  generateMockResponse: mockGenerateMockResponse,
}));

vi.mock('../../src/lib/responses/voice-learning', () => ({
  getApprovedResponsePairs: mockGetApprovedResponsePairs,
}));

vi.mock('../../src/lib/costs/tracker', () => ({
  checkRegenBudget: mockCheckRegenBudget,
  linkApiCostToResponse: vi.fn(),
  setCachedGeneration: mockSetCachedGeneration,
  CostLimitExceededError: class CostLimitExceededError extends Error {
    name = 'CostLimitExceededError';
    constructor(public readonly businessId: string) { super(`Daily cost limit exceeded for business ${businessId}`); }
  },
  GlobalCostLimitExceededError: class extends Error {
    name = 'GlobalCostLimitExceededError';
    constructor() { super('Global daily cost limit exceeded'); }
  },
  ConcurrencyLimitExceededError: class extends Error {
    name = 'ConcurrencyLimitExceededError';
    constructor(public readonly businessId: string) { super(`Concurrency limit exceeded for business ${businessId}`); }
  },
  RegenBudgetExceededError: class extends Error {
    name = 'RegenBudgetExceededError';
    constructor(public readonly reviewId: string) { super(`Regeneration budget exceeded for review ${reviewId}`); }
  },
}));

vi.mock('uuid', () => ({
  v7: vi.fn(() => 'deterministic-uuid-v7'),
}));

// Import after mocks are wired
import { handleResponseGeneration } from '../jobs/ResponseGeneratorWorker';
import { CostLimitExceededError } from '../../src/lib/costs/tracker';

// ── Helpers ────────────────────────────────────────────────────────────

function makeJob(overrides = {}): Job<GenerateResponsePayload> {
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

function mockBusinessRow(overrides = {}) {
  return {
    id: 'biz-1', name: 'Test Biz', category: 'restaurant', tone: 'warm',
    products_services: null, staff_names: [], highlight_facts: [], avoid_facts: [],
    sample_responses: [], subscription_status: 'active', subscription_tier: 'standard',
    updated_at: new Date(), ...overrides,
  };
}

const MOCK_RESULT: GenerationResult = {
  responseText: 'Thank you, Jane!', language: 'en', provider: 'openai' as const,
  model: 'gpt-4o-mini', usage: { promptTokens: 100, completionTokens: 50 },
  costUsd: 0.001, apiCostId: 'cost-1',
};

// ── Tests ──────────────────────────────────────────────────────────────

describe('ResponseGeneratorWorker – handleResponseGeneration', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    sqlReturnQueue.length = 0;
    mockTx.mockImplementation(() => Promise.resolve([]));
    mockIsMockMode.mockReturnValue(false);
  });

  // 1. Successful generation
  it('generates a response and persists it with outbox in one transaction', async () => {
    sqlReturnQueue.push([mockReviewRow()]);
    sqlReturnQueue.push([mockBusinessRow()]);
    mockGenerateResponse.mockResolvedValueOnce(MOCK_RESULT);

    await handleResponseGeneration(makeJob());

    expect(mockGenerateResponse).toHaveBeenCalledOnce();
    expect(mockSql.begin).toHaveBeenCalledOnce();
    // api_costs link happens inside the transaction — verify tx was called
    // with the cost ID from MOCK_RESULT.apiCostId ('cost-1')
    const txCallArgs = mockTx.mock.calls.map((c) => c.slice(1)).flat();
    expect(txCallArgs).toContain('cost-1');
    expect(mockMarkOutboxCompleted).toHaveBeenCalledWith('outbox-gen-1');
  });

  // 1b. Correlation propagation into send_notification payload
  it('propagates incoming correlation_id into the serialized send_notification outbox payload', async () => {
    const INCOMING_CORRELATION = 'upstream-corr-propagation-test';
    sqlReturnQueue.push([mockReviewRow()]);
    sqlReturnQueue.push([mockBusinessRow()]);
    mockGenerateResponse.mockResolvedValueOnce(MOCK_RESULT);

    await handleResponseGeneration(makeJob({ correlation_id: INCOMING_CORRELATION }));

    // Extract outbox payloads from tx template-arg calls. The INSERT INTO
    // job_outbox now binds via jsonb(notifyPayload) — in the test mock that
    // passes the OBJECT through, so we look for object args directly.
    const payloads = mockTx.mock.calls
      .flat()
      .filter(
        (arg): arg is Record<string, unknown> =>
          !!arg && typeof arg === 'object' && !Array.isArray(arg) && 'correlation_id' in (arg as Record<string, unknown>),
      );

    // send_notification payload shape: { response_id, business_id, correlation_id }
    // Distinguish from any other payloads by the exact key set.
    const sendNotificationPayload = payloads.find(
      (p) =>
        typeof p.response_id === 'string' &&
        typeof p.business_id === 'string' &&
        !('version' in p) && // not a GenerateResponsePayload
        !('review_id' in p), // not a GenerateResponsePayload
    );

    expect(sendNotificationPayload).toBeDefined();
    expect(sendNotificationPayload!.correlation_id).toBe(INCOMING_CORRELATION);
  });

  // 2. Subscription cancelled
  it('completes the outbox without generating when subscription is cancelled', async () => {
    sqlReturnQueue.push([mockReviewRow()]);
    sqlReturnQueue.push([mockBusinessRow({ subscription_status: 'cancelled' })]);

    await handleResponseGeneration(makeJob());

    expect(mockMarkOutboxCompleted).toHaveBeenCalledWith('outbox-gen-1');
    expect(mockGenerateResponse).not.toHaveBeenCalled();
    expect(mockGenerateMockResponse).not.toHaveBeenCalled();
  });

  // 3. Cost limit exceeded
  it('fails the outbox on cost limit exceeded and does not throw', async () => {
    sqlReturnQueue.push([mockReviewRow()]);
    sqlReturnQueue.push([mockBusinessRow()]);
    mockGenerateResponse.mockRejectedValueOnce(new CostLimitExceededError('biz-1'));

    await handleResponseGeneration(makeJob());

    expect(mockMarkOutboxFailed).toHaveBeenCalledWith(
      'outbox-gen-1',
      expect.stringContaining('cost limit exceeded'),
    );
    expect(mockMarkOutboxCompleted).not.toHaveBeenCalled();
  });

  // 4. Mock mode
  it('calls generateMockResponse instead of generateResponse in mock mode', async () => {
    mockIsMockMode.mockReturnValue(true);
    sqlReturnQueue.push([mockReviewRow()]);
    sqlReturnQueue.push([mockBusinessRow()]);
    mockGenerateMockResponse.mockResolvedValueOnce(MOCK_RESULT);

    await handleResponseGeneration(makeJob());

    expect(mockGenerateMockResponse).toHaveBeenCalledOnce();
    expect(mockGenerateResponse).not.toHaveBeenCalled();
    expect(mockMarkOutboxCompleted).toHaveBeenCalledWith('outbox-gen-1');
  });

  // 5. Avoid-facts violation triggers retry
  it('retries generation once when avoid-facts violation is detected', async () => {
    sqlReturnQueue.push([mockReviewRow()]);
    sqlReturnQueue.push([mockBusinessRow({ avoid_facts: ['bad word'] })]);

    const violatingResult: GenerationResult = {
      ...MOCK_RESULT,
      responseText: 'This mentions bad word in it',
      costUsd: 0.001,
    };
    const cleanResult: GenerationResult = {
      ...MOCK_RESULT,
      responseText: 'Thank you for the kind review!',
      costUsd: 0.002,
    };

    mockGenerateResponse
      .mockResolvedValueOnce(violatingResult)
      .mockResolvedValueOnce(cleanResult);

    await handleResponseGeneration(makeJob());

    expect(mockGenerateResponse).toHaveBeenCalledTimes(2);
    // The retry call must use skipCache: true so the cached violating
    // response doesn't short-circuit the regeneration
    const calls = mockGenerateResponse.mock.calls as unknown[][];
    const retryCallOpts = calls[1]?.[3] as Record<string, unknown> | undefined;
    expect(retryCallOpts).toMatchObject({ skipCache: true });
    // First call should NOT have skipCache
    const firstCallOpts = calls[0]?.[3] as Record<string, unknown> | undefined;
    expect(firstCallOpts?.skipCache).toBeFalsy();
    // Cache must be overwritten with the clean retry result
    expect(mockSetCachedGeneration).toHaveBeenCalledWith(
      'rev-1',
      1,
      expect.stringContaining('Thank you for the kind review!'),
    );
    expect(mockMarkOutboxCompleted).toHaveBeenCalledWith('outbox-gen-1');
  });
});
