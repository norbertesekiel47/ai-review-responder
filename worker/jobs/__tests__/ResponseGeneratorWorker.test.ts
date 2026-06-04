import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Job } from 'bullmq';
import type { GenerateResponsePayload } from '../../../src/lib/shared/worker-types';
import type { GenerationResult } from '../../../src/lib/responses/types';

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
  mockEnqueueAnalyticsEvent,
  mockModerateResponse,
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
    mockEnqueueAnalyticsEvent: vi.fn(),
    mockModerateResponse: vi.fn(),
  };
});

// ── Module mocks (hoisted by vitest) ───────────────────────────────────
vi.mock('../../../src/lib/db/server', () => ({
  sql: mockSql, jsonb: (v: unknown) => v }));

vi.mock('../../../src/lib/shared/outbox', () => ({
  markOutboxCompleted: mockMarkOutboxCompleted,
  markOutboxFailed: mockMarkOutboxFailed,
  extractOutboxHandle: (d: any, fallback: string) => ({ outboxId: (d && typeof d.outbox_id === 'string') ? d.outbox_id : fallback, attempt: (d && typeof d.outbox_attempt === 'number') ? d.outbox_attempt : undefined }),
}));

vi.mock('../../../src/lib/shared/mock-mode', () => ({
  isMockMode: mockIsMockMode,
}));

vi.mock('../../../src/lib/shared/sanitize', () => ({
  sanitizeText: mockSanitizeText,
}));

vi.mock('../../../src/lib/responses/generator', () => ({
  generateResponse: mockGenerateResponse,
}));

vi.mock('../../../src/lib/responses/mock-generator', () => ({
  generateMockResponse: mockGenerateMockResponse,
}));

vi.mock('../../../src/lib/responses/voice-learning', () => ({
  getApprovedResponsePairs: mockGetApprovedResponsePairs,
}));

vi.mock('../../../src/lib/costs/tracker', () => ({
  checkRegenBudget: mockCheckRegenBudget,
  setCachedGeneration: mockSetCachedGeneration,
  CostLimitExceededError: class CostLimitExceededError extends Error {
    name = 'CostLimitExceededError';
    constructor(public readonly businessId: string) { super(`Daily cost limit exceeded for business ${businessId}`); }
  },
  GlobalCostLimitExceededError: class extends Error {
    name = 'GlobalCostLimitExceededError';
    constructor() { super('Global daily cost limit exceeded'); }
  },
  RegenBudgetExceededError: class extends Error {
    name = 'RegenBudgetExceededError';
    constructor(public readonly reviewId: string) { super(`Regeneration budget exceeded for review ${reviewId}`); }
  },
}));

vi.mock('../../../src/lib/costs/concurrency-guard', () => ({
  ConcurrencyLimitExceededError: class extends Error {
    name = 'ConcurrencyLimitExceededError';
    constructor(public readonly businessId: string) { super(`Concurrency limit exceeded for business ${businessId}`); }
  },
}));

vi.mock('../../../src/lib/analytics/enqueue', () => ({
  enqueueAnalyticsEvent: mockEnqueueAnalyticsEvent,
}));

vi.mock('../../../src/lib/moderation/moderate', () => ({
  moderateResponse: mockModerateResponse,
}));

vi.mock('uuid', () => ({
  v7: vi.fn(() => 'deterministic-uuid-v7'),
}));

// Import after mocks are wired
import { handleResponseGeneration } from '../ResponseGeneratorWorker';
import { CostLimitExceededError } from '../../../src/lib/costs/tracker';

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
    account_id: 'acct-1', account_updated_at: new Date(), ...overrides,
  };
}

function mockExistingResponseRow(overrides = {}) {
  return { id: 'resp-existing-1', business_id: 'biz-1', account_id: 'acct-1', ...overrides };
}

function mockFirstDraftLookup(overrides = {}) {
  return { earlier_exists: false, email_verified_at: null, ...overrides };
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
    mockModerateResponse.mockResolvedValue({
      flagged: false, severity: 'low', reason: null, categories: {}, score: 0, source: null,
      providerStatus: null,
    });
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
    expect(mockMarkOutboxCompleted).toHaveBeenCalledWith('outbox-gen-1', undefined);
  });

  it('enqueues first_response_drafted once with deterministic event key', async () => {
    sqlReturnQueue.push([mockReviewRow()]);
    sqlReturnQueue.push([mockBusinessRow()]);
    sqlReturnQueue.push([]);
    sqlReturnQueue.push([mockFirstDraftLookup()]);
    mockGenerateResponse.mockResolvedValueOnce(MOCK_RESULT);

    await handleResponseGeneration(makeJob());

    expect(mockEnqueueAnalyticsEvent).toHaveBeenCalledWith(expect.objectContaining({
      eventName: 'first_response_drafted',
      eventKey: 'first_response_drafted:acct-1',
      distinctId: 'acct-1',
      accountId: 'acct-1',
      businessId: 'biz-1',
    }));
  });

  it('enqueues first_response_drafted on existing-response retry before completing outbox', async () => {
    sqlReturnQueue.push([mockReviewRow()]);
    sqlReturnQueue.push([mockBusinessRow()]);
    sqlReturnQueue.push([mockExistingResponseRow()]);
    sqlReturnQueue.push([mockFirstDraftLookup()]);

    await handleResponseGeneration(makeJob());

    expect(mockGenerateResponse).not.toHaveBeenCalled();
    expect(mockEnqueueAnalyticsEvent).toHaveBeenCalledWith(expect.objectContaining({
      eventName: 'first_response_drafted',
      eventKey: 'first_response_drafted:acct-1',
      distinctId: 'acct-1',
      accountId: 'acct-1',
      businessId: 'biz-1',
    }));
    expect(mockMarkOutboxCompleted).toHaveBeenCalledWith('outbox-gen-1', undefined);
    const analyticsCallOrder = mockEnqueueAnalyticsEvent.mock.invocationCallOrder[0];
    const completedCallOrder = mockMarkOutboxCompleted.mock.invocationCallOrder[0];
    expect(analyticsCallOrder).toBeDefined();
    expect(completedCallOrder).toBeDefined();
    expect(analyticsCallOrder!).toBeLessThan(completedCallOrder!);
  });

  it('does not enqueue first_response_drafted when an earlier account response exists', async () => {
    sqlReturnQueue.push([mockReviewRow()]);
    sqlReturnQueue.push([mockBusinessRow()]);
    sqlReturnQueue.push([]);
    sqlReturnQueue.push([mockFirstDraftLookup({ earlier_exists: true })]);
    mockGenerateResponse.mockResolvedValueOnce(MOCK_RESULT);

    await handleResponseGeneration(makeJob());

    expect(mockEnqueueAnalyticsEvent).not.toHaveBeenCalled();
    expect(mockMarkOutboxCompleted).toHaveBeenCalledWith('outbox-gen-1', undefined);
  });

  it('completes outbox when first_response_drafted enqueue fails after normal response commit', async () => {
    sqlReturnQueue.push([mockReviewRow()]);
    sqlReturnQueue.push([mockBusinessRow()]);
    sqlReturnQueue.push([]);
    sqlReturnQueue.push([mockFirstDraftLookup()]);
    mockGenerateResponse.mockResolvedValueOnce(MOCK_RESULT);
    mockEnqueueAnalyticsEvent.mockRejectedValueOnce(new Error('analytics down'));

    await handleResponseGeneration(makeJob());

    expect(mockEnqueueAnalyticsEvent).toHaveBeenCalledOnce();
    expect(mockMarkOutboxCompleted).toHaveBeenCalledWith('outbox-gen-1', undefined);
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

    expect(mockMarkOutboxCompleted).toHaveBeenCalledWith('outbox-gen-1', undefined);
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
      expect.stringContaining('cost limit exceeded'), undefined);
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
    expect(mockMarkOutboxCompleted).toHaveBeenCalledWith('outbox-gen-1', undefined);
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
    expect(mockMarkOutboxCompleted).toHaveBeenCalledWith('outbox-gen-1', undefined);
  });

  // 6. suppress_notification flag (spec §4.6, §6.7)
  it('skips send_notification outbox enqueue when suppress_notification=true', async () => {
    sqlReturnQueue.push([mockReviewRow()]);
    sqlReturnQueue.push([mockBusinessRow()]);
    mockGenerateResponse.mockResolvedValueOnce(MOCK_RESULT);

    await handleResponseGeneration(makeJob({ suppress_notification: true }));

    // No tx call should have a SendNotificationPayload-shaped object.
    // Distinguish by key set: send_notification payload has response_id +
    // business_id + correlation_id only — no version, no review_id.
    const sendNotificationPayloads = mockTx.mock.calls
      .flat()
      .filter(
        (arg): arg is Record<string, unknown> =>
          !!arg && typeof arg === 'object' && !Array.isArray(arg)
          && 'response_id' in (arg as Record<string, unknown>)
          && 'business_id' in (arg as Record<string, unknown>)
          && !('version' in (arg as Record<string, unknown>))
          && !('review_id' in (arg as Record<string, unknown>)),
      );
    expect(sendNotificationPayloads).toHaveLength(0);
    expect(mockMarkOutboxCompleted).toHaveBeenCalledWith('outbox-gen-1', undefined);
  });

  it('enqueues send_notification when suppress_notification is omitted (default false)', async () => {
    sqlReturnQueue.push([mockReviewRow()]);
    sqlReturnQueue.push([mockBusinessRow()]);
    mockGenerateResponse.mockResolvedValueOnce(MOCK_RESULT);

    await handleResponseGeneration(makeJob());

    const sendNotificationPayloads = mockTx.mock.calls
      .flat()
      .filter(
        (arg): arg is Record<string, unknown> =>
          !!arg && typeof arg === 'object' && !Array.isArray(arg)
          && 'response_id' in (arg as Record<string, unknown>)
          && 'business_id' in (arg as Record<string, unknown>)
          && !('version' in (arg as Record<string, unknown>))
          && !('review_id' in (arg as Record<string, unknown>)),
      );
    expect(sendNotificationPayloads).toHaveLength(1);
  });

  it('holds a high-severity flagged draft: no send_notification, writes a flagged_responses row', async () => {
    sqlReturnQueue.push([mockReviewRow()]);
    sqlReturnQueue.push([mockBusinessRow()]);
    mockGenerateResponse.mockResolvedValueOnce(MOCK_RESULT);
    mockModerateResponse.mockResolvedValueOnce({
      flagged: true, severity: 'high', reason: 'refund_discount',
      categories: { refund_discount: 1 }, score: 1, source: 'local_regex',
      providerStatus: null,
    });

    await handleResponseGeneration(makeJob());

    const sendNotificationPayloads = mockTx.mock.calls
      .flat()
      .filter(
        (arg): arg is Record<string, unknown> =>
          !!arg && typeof arg === 'object' && !Array.isArray(arg)
          && 'response_id' in (arg as Record<string, unknown>)
          && 'business_id' in (arg as Record<string, unknown>)
          && !('version' in (arg as Record<string, unknown>))
          && !('review_id' in (arg as Record<string, unknown>)),
      );
    expect(sendNotificationPayloads).toHaveLength(0);

    const txArgs = mockTx.mock.calls.flat();
    expect(txArgs).toContain('local_regex');
    expect(txArgs).toContain('open');

    expect(mockMarkOutboxCompleted).toHaveBeenCalledWith('outbox-gen-1', undefined);
  });

  it('sends the normal notification when moderation does not flag (default)', async () => {
    sqlReturnQueue.push([mockReviewRow()]);
    sqlReturnQueue.push([mockBusinessRow()]);
    mockGenerateResponse.mockResolvedValueOnce(MOCK_RESULT);

    await handleResponseGeneration(makeJob());

    const sendNotificationPayloads = mockTx.mock.calls
      .flat()
      .filter(
        (arg): arg is Record<string, unknown> =>
          !!arg && typeof arg === 'object' && !Array.isArray(arg)
          && 'response_id' in (arg as Record<string, unknown>)
          && 'business_id' in (arg as Record<string, unknown>)
          && !('version' in (arg as Record<string, unknown>))
          && !('review_id' in (arg as Record<string, unknown>)),
      );
    expect(sendNotificationPayloads).toHaveLength(1);
    const txArgs = mockTx.mock.calls.flat();
    expect(txArgs).not.toContain('open');
  });
});
