import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Job } from 'bullmq';
import type { GenerateResponsePayload } from '../../../src/lib/shared/worker-types';
import type { GenerationResult } from '../../../src/lib/responses/types';
import type { TriageSeverity } from '../../../src/lib/reviews/triage-schema';

// ── Hoisted state shared between mock factories and tests ──────────────
const {
  sqlReturnQueue,
  mockSql,
  mockTx,
  mockMarkOutboxCompleted,
  mockMarkOutboxCompletedWithReason,
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
  mockRunTriagePhase,
} = vi.hoisted(() => {
  const sqlReturnQueue: unknown[] = [];

  const mockTx = vi.fn((_strings: TemplateStringsArray, ..._values: unknown[]): Promise<unknown[]> => {
    return Promise.resolve([]);
  });
  // persist.ts binds the JSONB moderation_categories via tx.json(...) now
  // (was the module-level jsonb() helper) — identity pass-through in the mock.
  (mockTx as unknown as { json: (v: unknown) => unknown }).json = vi.fn((v: unknown) => v);

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
    mockMarkOutboxCompletedWithReason: vi.fn(),
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
    // Default null (flag off / positive lane) so every pre-triage test's
    // behavior is unchanged; clearAllMocks keeps this implementation.
    mockRunTriagePhase: vi.fn<() => Promise<TriageSeverity | null>>(async () => null),
  };
});

// ── Module mocks (hoisted by vitest) ───────────────────────────────────
vi.mock('../../../src/lib/db/server', () => ({
  sql: mockSql, jsonb: (v: unknown) => v }));

vi.mock('../../../src/lib/shared/outbox', () => ({
  markOutboxCompleted: mockMarkOutboxCompleted,
  markOutboxCompletedWithReason: mockMarkOutboxCompletedWithReason,
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

vi.mock('../response-generation/triage', () => ({
  runTriagePhase: mockRunTriagePhase,
}));

vi.mock('uuid', () => ({
  v7: vi.fn(() => 'deterministic-uuid-v7'),
}));

vi.mock('../response-generation/persist', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../response-generation/persist')>();
  return {
    ...actual,
    persistResponseAndNotify: vi.fn(actual.persistResponseAndNotify),
  };
});

// Import after mocks are wired
import { handleResponseGeneration } from '../ResponseGeneratorWorker';
import { persistResponseAndNotify } from '../response-generation/persist';
import { CostLimitExceededError, RegenBudgetExceededError } from '../../../src/lib/costs/tracker';
import { CostInfraUnavailableError } from '../../../src/lib/costs/errors';
import { SKIP_REASON_ARCHIVED_LOCATION } from '../../../src/lib/shared/worker-types';
import { OUTBOX_COMPLETION_REASON } from '../../../src/lib/shared/outbox-completion-reason';
import {
  makeLoadContextReviewRow as mockReviewRow,
  makeLoadContextBusinessRow as mockBusinessRow,
} from '../response-generation/__tests__/load-context-fixtures';

// ── Helpers ────────────────────────────────────────────────────────────

function makeJob(overrides = {}): Job<GenerateResponsePayload> {
  return {
    data: { review_id: 'rev-1', business_id: 'biz-1', version: 1, origin_lane: 'live_ingest_new', ...overrides },
    id: 'outbox-gen-1',
  } as Job<GenerateResponsePayload>;
}

// send_notification outbox payload shape: { response_id, business_id,
// correlation_id } — distinguished from a GenerateResponsePayload by the
// absence of version/review_id. The INSERT INTO job_outbox binds via
// jsonb(payload); the test mock passes the object through, so payloads
// appear as object args in the tx template calls.
// The skip reason must be an OBJECT arg so it lands in the queryable `data`
// field of the structured record (string args are verbatim only). Parses the
// console.log spy's JSON lines and returns the record with the given message.
function findLogRecord(
  logSpy: { mock: { calls: unknown[][] } },
  message: string,
): { message?: string; data?: Record<string, unknown> } | undefined {
  return logSpy.mock.calls
    .map((call) => {
      try {
        return JSON.parse(String(call[0])) as { message?: string; data?: Record<string, unknown> };
      } catch {
        return null;
      }
    })
    .filter((record): record is { message?: string; data?: Record<string, unknown> } => record !== null)
    .find((record) => record.message === message);
}

function findSkipLogRecord(
  logSpy: { mock: { calls: unknown[][] } },
): { message?: string; data?: Record<string, unknown> } | undefined {
  return findLogRecord(logSpy, 'skipping generation');
}

function findSendNotificationPayloads(): Record<string, unknown>[] {
  return mockTx.mock.calls
    .flat()
    .filter(
      (arg): arg is Record<string, unknown> =>
        !!arg && typeof arg === 'object' && !Array.isArray(arg)
        && 'response_id' in arg
        && 'business_id' in arg
        && !('version' in arg)
        && !('review_id' in arg),
    );
}

// Review/business rows come from the shared loadGenerationContext fixtures
// (imported above) so this suite can't drift from the projection shape again.

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
    mockMarkOutboxFailed.mockResolvedValue(true);
    sqlReturnQueue.length = 0;
    mockTx.mockImplementation((strings: TemplateStringsArray) => {
      const text = strings.join(' ');
      // persist.ts's review FOR UPDATE lock (tx statement #1) — return a row
      // so the orphan-review warn path stays off in these worker-level tests.
      if (text.includes('FROM reviews') && text.includes('FOR UPDATE')) {
        return Promise.resolve([{ id: 'rev-1' }]);
      }
      // WS4: persist.ts's businesses FOR UPDATE lock (tx statement #2) and
      // loadAutoApprovalRuntimeState's same-tx re-take share this shape.
      if (text.includes('FROM businesses') && text.includes('FOR UPDATE')) {
        return Promise.resolve([{ id: 'biz-1' }]);
      }
      // WS4: the loader's daily-cap count throws auto_approval_cap_count_missing
      // if its (always-one-row) aggregate result is absent — feed zero used.
      if (text.includes('auto_approved_today')) {
        return Promise.resolve([{ auto_approved_today: 0 }]);
      }
      if (text.includes('FROM reviews r')) {
        return Promise.resolve([{
          star_rating: 5,
          review_content_hash: 'hash-loaded',
          archived_at: null,
          subscription_status: 'active',
          account_past_due_at: null,
          account_flags: {},
        }]);
      }
      if (text.includes('FROM auto_approval_policies')) {
        return Promise.resolve([]);
      }
      if (text.includes('FROM zernio_connections')) {
        return Promise.resolve([]);
      }
      return Promise.resolve([]);
    });
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
    expect(mockMarkOutboxCompleted).toHaveBeenCalledWith(mockSql, 'outbox-gen-1', undefined);
  });

  // Content-freshness gate (ADR 0017): a skipped_stale_content persist outcome
  // completes the outbox — not fails — with the queryable one-owner reason,
  // and must not fire first_response_drafted (nothing was drafted).
  it('completes the outbox with stale_review_content and skips first_response_drafted on a gate skip', async () => {
    sqlReturnQueue.push([mockReviewRow()]);
    sqlReturnQueue.push([mockBusinessRow()]);
    mockGenerateResponse.mockResolvedValueOnce(MOCK_RESULT);
    vi.mocked(persistResponseAndNotify).mockResolvedValueOnce({ kind: 'skipped_stale_content' });

    await handleResponseGeneration(makeJob());

    expect(mockMarkOutboxCompletedWithReason).toHaveBeenCalledWith(
      mockSql, 'outbox-gen-1', OUTBOX_COMPLETION_REASON.STALE_REVIEW_CONTENT, undefined,
    );
    expect(mockMarkOutboxCompleted).not.toHaveBeenCalled();
    expect(mockEnqueueAnalyticsEvent).not.toHaveBeenCalled(); // first_response_drafted must not fire
  });

  it('passes a normalized valid origin lane and suppress flag to persistence', async () => {
    sqlReturnQueue.push([mockReviewRow()]);
    sqlReturnQueue.push([mockBusinessRow()]);
    mockGenerateResponse.mockResolvedValueOnce(MOCK_RESULT);

    await handleResponseGeneration(makeJob({
      origin_lane: 'live_ingest_new',
      suppress_notification: true,
      extra_key: 'allowed',
    }));

    expect(persistResponseAndNotify).toHaveBeenCalledWith(mockSql, expect.objectContaining({
      originLane: 'live_ingest_new',
      suppressNotification: true,
    }));
  });

  it('passes a null origin lane for legacy missing-lane jobs without noisy logging', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    sqlReturnQueue.push([mockReviewRow()]);
    sqlReturnQueue.push([mockBusinessRow()]);
    mockGenerateResponse.mockResolvedValueOnce(MOCK_RESULT);

    // Simulate an in-flight job enqueued before origin_lane existed: the wire
    // type now requires the lane, but the boundary parser must still tolerate
    // its absence by resolving to a non-auto null (spec §5).
    const legacyJob = makeJob();
    delete (legacyJob.data as unknown as Record<string, unknown>).origin_lane;
    await handleResponseGeneration(legacyJob);

    expect(persistResponseAndNotify).toHaveBeenCalledWith(mockSql, expect.objectContaining({
      originLane: null,
    }));
    expect(warnSpy).not.toHaveBeenCalled();
    warnSpy.mockRestore();
  });

  it('fails unknown non-empty origin lanes closed and logs a sanitized lane once', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    sqlReturnQueue.push([mockReviewRow()]);
    sqlReturnQueue.push([mockBusinessRow()]);
    mockGenerateResponse.mockResolvedValueOnce(MOCK_RESULT);

    await handleResponseGeneration(makeJob({ origin_lane: ' live ingest:surprise! ' }));

    expect(persistResponseAndNotify).toHaveBeenCalledWith(mockSql, expect.objectContaining({
      originLane: null,
    }));
    expect(warnSpy).toHaveBeenCalledTimes(1);
    const record = JSON.parse(String(warnSpy.mock.calls[0]?.[0])) as {
      message?: string;
      data?: Record<string, unknown>;
    };
    expect(record.message).toBe('Unknown generate_response origin_lane; falling back to manual approval');
    expect(record.data).toEqual({ origin_lane: 'live_ingest_surprise_' });
    warnSpy.mockRestore();
  });

  it('loads review_content_hash and passes it to persistence for freshness checks', async () => {
    sqlReturnQueue.push([mockReviewRow({ review_content_hash: 'fresh-hash' })]);
    sqlReturnQueue.push([mockBusinessRow()]);
    mockGenerateResponse.mockResolvedValueOnce(MOCK_RESULT);

    await handleResponseGeneration(makeJob({ origin_lane: 'live_ingest_new' }));

    const reviewSelect = (mockSql.mock.calls[0]?.[0] as TemplateStringsArray).join(' ');
    expect(reviewSelect).toContain('review_content_hash');
    expect(persistResponseAndNotify).toHaveBeenCalledWith(mockSql, expect.objectContaining({
      loadedReviewContentHash: 'fresh-hash',
    }));
  });

  it('enqueues first_response_drafted once with deterministic event key', async () => {
    sqlReturnQueue.push([mockReviewRow()]);
    sqlReturnQueue.push([mockBusinessRow()]);
    sqlReturnQueue.push([]);
    sqlReturnQueue.push([mockFirstDraftLookup()]);
    mockGenerateResponse.mockResolvedValueOnce(MOCK_RESULT);

    await handleResponseGeneration(makeJob());

    expect(mockEnqueueAnalyticsEvent).toHaveBeenCalledWith(mockSql, expect.objectContaining({
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
    expect(persistResponseAndNotify).not.toHaveBeenCalled();
    expect(mockSql.begin).not.toHaveBeenCalled();
    expect(mockEnqueueAnalyticsEvent).toHaveBeenCalledWith(mockSql, expect.objectContaining({
      eventName: 'first_response_drafted',
      eventKey: 'first_response_drafted:acct-1',
      distinctId: 'acct-1',
      accountId: 'acct-1',
      businessId: 'biz-1',
    }));
    expect(mockMarkOutboxCompleted).toHaveBeenCalledWith(mockSql, 'outbox-gen-1', undefined);
    const analyticsCallOrder = mockEnqueueAnalyticsEvent.mock.invocationCallOrder[0];
    const completedCallOrder = mockMarkOutboxCompleted.mock.invocationCallOrder[0];
    expect(analyticsCallOrder).toBeDefined();
    expect(completedCallOrder).toBeDefined();
    expect(analyticsCallOrder!).toBeLessThan(completedCallOrder!);
  });

  // already_exists + processingBlocked: the outbox-completion recovery still
  // applies (the work WAS done), but the durable analytics enqueue must be
  // suppressed — the dispatch poller has no offboarding gate and would export
  // a fresh event for an account mid-purge.
  it('suppresses first_response_drafted on existing-response retry when active offboarding blocks processing', async () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    sqlReturnQueue.push([mockReviewRow()]);
    sqlReturnQueue.push([mockBusinessRow({
      offboarding_id: 'offboarding-1',
      offboarding_account_id: 'acct-1',
      offboarding_mode: 'delete_data',
      offboarding_status: 'pending',
      offboarding_failed_step: null,
      offboarding_access_ends_at: null,
      offboarding_teardown_started_at: null,
      offboarding_purge_after: null,
      offboarding_purge_started_at: null,
      offboarding_purge_cancelled_at: null,
    })]);
    sqlReturnQueue.push([mockExistingResponseRow()]);

    await handleResponseGeneration(makeJob());

    expect(mockGenerateResponse).not.toHaveBeenCalled();
    expect(mockEnqueueAnalyticsEvent).not.toHaveBeenCalled();
    expect(mockMarkOutboxCompleted).toHaveBeenCalledWith(mockSql, 'outbox-gen-1', undefined);
    expect(mockMarkOutboxFailed).not.toHaveBeenCalled();

    const record = findLogRecord(logSpy, 'suppressing first_response_drafted enqueue');
    expect(record).toBeDefined();
    expect(record!.data).toMatchObject({ reason: 'account_offboarding_blocked', business_id: 'biz-1' });
    logSpy.mockRestore();
  });

  it('does not enqueue first_response_drafted when an earlier account response exists', async () => {
    sqlReturnQueue.push([mockReviewRow()]);
    sqlReturnQueue.push([mockBusinessRow()]);
    sqlReturnQueue.push([]);
    sqlReturnQueue.push([mockFirstDraftLookup({ earlier_exists: true })]);
    mockGenerateResponse.mockResolvedValueOnce(MOCK_RESULT);

    await handleResponseGeneration(makeJob());

    expect(mockEnqueueAnalyticsEvent).not.toHaveBeenCalled();
    expect(mockMarkOutboxCompleted).toHaveBeenCalledWith(mockSql, 'outbox-gen-1', undefined);
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
    expect(mockMarkOutboxCompleted).toHaveBeenCalledWith(mockSql, 'outbox-gen-1', undefined);
  });

  // 1b. Correlation propagation into send_notification payload
  it('propagates incoming correlation_id into the serialized send_notification outbox payload', async () => {
    const INCOMING_CORRELATION = 'upstream-corr-propagation-test';
    sqlReturnQueue.push([mockReviewRow()]);
    sqlReturnQueue.push([mockBusinessRow()]);
    mockGenerateResponse.mockResolvedValueOnce(MOCK_RESULT);

    await handleResponseGeneration(makeJob({ correlation_id: INCOMING_CORRELATION }));

    const [sendNotificationPayload] = findSendNotificationPayloads();

    expect(sendNotificationPayload).toBeDefined();
    expect(sendNotificationPayload!.correlation_id).toBe(INCOMING_CORRELATION);
  });

  // 2. Subscription cancelled → skip-as-success with a queryable reason
  it('completes the outbox without generating when subscription is cancelled, with a structured skip log', async () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    sqlReturnQueue.push([mockReviewRow()]);
    sqlReturnQueue.push([mockBusinessRow({ subscription_status: 'cancelled' })]);

    await handleResponseGeneration(makeJob());

    expect(mockMarkOutboxCompleted).toHaveBeenCalledWith(mockSql, 'outbox-gen-1', undefined);
    expect(mockGenerateResponse).not.toHaveBeenCalled();
    expect(mockGenerateMockResponse).not.toHaveBeenCalled();
    const skipRecord = findSkipLogRecord(logSpy);
    expect(skipRecord).toBeDefined();
    expect(skipRecord!.data).toMatchObject({ reason: 'cancelled', business_id: 'biz-1' });
    logSpy.mockRestore();
  });

  // 2b. Archived location → terminal skip-as-success
  it('skips generation as success when the location is archived, with a structured skip log', async () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    sqlReturnQueue.push([mockReviewRow()]);
    sqlReturnQueue.push([mockBusinessRow({ archived_at: new Date('2026-06-01T00:00:00Z') })]);

    await handleResponseGeneration(makeJob());

    expect(mockGenerateResponse).not.toHaveBeenCalled();
    expect(mockGenerateMockResponse).not.toHaveBeenCalled();
    expect(mockMarkOutboxCompleted).toHaveBeenCalledWith(mockSql, 'outbox-gen-1', undefined);
    expect(mockMarkOutboxFailed).not.toHaveBeenCalled();

    const skipRecord = findSkipLogRecord(logSpy);
    expect(skipRecord).toBeDefined();
    expect(skipRecord!.data).toMatchObject({ reason: SKIP_REASON_ARCHIVED_LOCATION, business_id: 'biz-1' });
    logSpy.mockRestore();
  });

  // FIX 2 regression (idempotency-before-archived ordering): a crash-retry
  // whose response was committed pre-archive must take the already_exists
  // path — including the first_response_drafted recovery — not be dropped
  // as a skip.
  it('takes the already_exists path when the response was committed before the location was archived', async () => {
    sqlReturnQueue.push([mockReviewRow()]);
    sqlReturnQueue.push([mockBusinessRow({ archived_at: new Date('2026-06-01T00:00:00Z') })]);
    sqlReturnQueue.push([mockExistingResponseRow()]);
    sqlReturnQueue.push([mockFirstDraftLookup()]);

    await handleResponseGeneration(makeJob());

    expect(mockGenerateResponse).not.toHaveBeenCalled();
    expect(mockEnqueueAnalyticsEvent).toHaveBeenCalledWith(mockSql, expect.objectContaining({
      eventName: 'first_response_drafted',
      eventKey: 'first_response_drafted:acct-1',
    }));
    expect(mockMarkOutboxCompleted).toHaveBeenCalledWith(mockSql, 'outbox-gen-1', undefined);
  });

  // 3. Cost limit exceeded
  it('atomically fails the active review run and outbox after taking the reviews lock first (no live draft)', async () => {
    mockTx.mockImplementation((strings: TemplateStringsArray) => {
      const text = strings.join(' ');
      if (text.includes('FROM reviews') && text.includes('FOR UPDATE')) {
        return Promise.resolve([{ id: 'rev-1' }]);
      }
      // WS5 live-draft guard: no owner-actionable response for the review.
      if (text.includes('FROM responses')) {
        return Promise.resolve([]);
      }
      if (text.includes('FROM agent_runs') && text.includes("status = 'running'")) {
        return Promise.resolve([{ id: 'run-1', account_id: 'acct-1' }]);
      }
      if (text.includes('UPDATE agent_runs')) {
        return Promise.resolve(Object.assign([{ id: 'run-1' }], { count: 1 }));
      }
      return Promise.resolve([]);
    });
    sqlReturnQueue.push([mockReviewRow()]);
    sqlReturnQueue.push([mockBusinessRow()]);
    mockGenerateResponse.mockRejectedValueOnce(new CostLimitExceededError('biz-1'));

    await handleResponseGeneration(makeJob());

    expect(mockSql.begin).toHaveBeenCalledOnce();
    const txSql = mockTx.mock.calls.map((call) =>
      (call[0] as TemplateStringsArray).join(' '),
    );
    expect(txSql[0]).toContain('FROM reviews');
    expect(txSql[0]).toContain('FOR UPDATE');
    expect(txSql[1]).toContain('FROM responses');
    expect(txSql[2]).toContain('FROM agent_runs');
    expect(txSql[3]).toContain('UPDATE agent_runs');
    expect(mockTx.mock.calls[3]!.slice(1)).toEqual(expect.arrayContaining([
      'run-1',
      'failed',
      { reason: 'Daily cost limit exceeded for business biz-1' },
    ]));
    expect(mockMarkOutboxFailed).toHaveBeenCalledWith(
      mockTx,
      'outbox-gen-1',
      expect.stringContaining('cost limit exceeded'), undefined);
    expect(mockMarkOutboxCompleted).not.toHaveBeenCalled();
  });

  // 3b. WS5 live-draft guard: a terminal regen failure while an earlier draft
  // is still owner-actionable must fail the outbox but leave the run running
  // (timeline renders waiting_on_owner, and the eventual post keeps its run).
  it('leaves the run running when a regen-budget terminal failure finds a live draft awaiting the owner', async () => {
    mockTx.mockImplementation((strings: TemplateStringsArray) => {
      const text = strings.join(' ');
      if (text.includes('FROM reviews') && text.includes('FOR UPDATE')) {
        return Promise.resolve([{ id: 'rev-1' }]);
      }
      // Live v1 draft still pending_approval.
      if (text.includes('FROM responses')) {
        return Promise.resolve([{ live: 1 }]);
      }
      return Promise.resolve([]);
    });
    sqlReturnQueue.push([mockReviewRow()]);
    sqlReturnQueue.push([mockBusinessRow()]);
    mockCheckRegenBudget.mockRejectedValueOnce(new RegenBudgetExceededError('rev-1'));

    await handleResponseGeneration(makeJob({ version: 2 }));

    expect(mockSql.begin).toHaveBeenCalledOnce();
    const txSql = mockTx.mock.calls.map((call) =>
      (call[0] as TemplateStringsArray).join(' '),
    );
    // Statement order: reviews lock FIRST, then the live-draft read; the
    // guard short-circuits before any agent_runs statement.
    expect(txSql).toHaveLength(2);
    expect(txSql[0]).toContain('FROM reviews');
    expect(txSql[0]).toContain('FOR UPDATE');
    expect(txSql[1]).toContain('FROM responses');
    expect(txSql.some((text) => text.includes('agent_runs'))).toBe(false);
    // The outbox CAS still happens as today.
    expect(mockMarkOutboxFailed).toHaveBeenCalledWith(
      mockTx,
      'outbox-gen-1',
      expect.stringContaining('Regeneration budget exceeded'),
      undefined,
    );
    expect(mockMarkOutboxCompleted).not.toHaveBeenCalled();
  });

  it('still fails the outbox when a legacy review has no active run', async () => {
    mockTx.mockImplementation((strings: TemplateStringsArray) => {
      const text = strings.join(' ');
      if (text.includes('FROM reviews') && text.includes('FOR UPDATE')) {
        return Promise.resolve([{ id: 'rev-1' }]);
      }
      return Promise.resolve([]);
    });
    sqlReturnQueue.push([mockReviewRow()]);
    sqlReturnQueue.push([mockBusinessRow()]);
    mockGenerateResponse.mockRejectedValueOnce(new CostLimitExceededError('biz-1'));

    await handleResponseGeneration(makeJob());

    expect(mockSql.begin).toHaveBeenCalledOnce();
    const txSql = mockTx.mock.calls.map((call) =>
      (call[0] as TemplateStringsArray).join(' '),
    );
    expect(txSql[0]).toContain('FROM reviews');
    expect(txSql[0]).toContain('FOR UPDATE');
    expect(txSql.some((text) => text.includes('UPDATE agent_runs'))).toBe(false);
    expect(mockMarkOutboxFailed).toHaveBeenCalledWith(
      mockTx,
      'outbox-gen-1',
      expect.stringContaining('cost limit exceeded'),
      undefined,
    );
  });

  it('fails only the outbox when the tenant-scoped review lock row is absent', async () => {
    mockTx.mockResolvedValue([]);
    sqlReturnQueue.push([mockReviewRow()]);
    sqlReturnQueue.push([mockBusinessRow()]);
    mockGenerateResponse.mockRejectedValueOnce(new CostLimitExceededError('biz-1'));

    await handleResponseGeneration(makeJob());

    const txSql = mockTx.mock.calls.map((call) =>
      (call[0] as TemplateStringsArray).join(' '),
    );
    expect(txSql).toHaveLength(1);
    expect(txSql[0]).toContain('FROM reviews');
    expect(txSql[0]).toContain('business_id');
    expect(txSql[0]).toContain('FOR UPDATE');
    expect(txSql.some((text) => text.includes('agent_runs'))).toBe(false);
    expect(mockMarkOutboxFailed).toHaveBeenCalledWith(
      mockTx,
      'outbox-gen-1',
      expect.stringContaining('cost limit exceeded'),
      undefined,
    );
  });

  it('does not fail the run when a stale outbox attempt loses the guarded transition', async () => {
    mockTx.mockImplementation((strings: TemplateStringsArray) => {
      const text = strings.join(' ');
      if (text.includes('FROM reviews') && text.includes('FOR UPDATE')) {
        return Promise.resolve([{ id: 'rev-1' }]);
      }
      return Promise.resolve([]);
    });
    mockMarkOutboxFailed.mockResolvedValueOnce(false);
    sqlReturnQueue.push([mockReviewRow()]);
    sqlReturnQueue.push([mockBusinessRow()]);
    mockGenerateResponse.mockRejectedValueOnce(new CostLimitExceededError('biz-1'));

    await handleResponseGeneration(makeJob({ outbox_attempt: 1 }));

    const txSql = mockTx.mock.calls.map((call) =>
      (call[0] as TemplateStringsArray).join(' '),
    );
    expect(txSql).toHaveLength(1);
    expect(txSql[0]).toContain('FROM reviews');
    expect(txSql.some((text) => text.includes('agent_runs'))).toBe(false);
    expect(mockMarkOutboxFailed).toHaveBeenCalledWith(
      mockTx,
      'outbox-gen-1',
      expect.stringContaining('cost limit exceeded'),
      1,
    );
  });

  it('leaves the run and outbox open when generation throws a retryable infra error', async () => {
    sqlReturnQueue.push([mockReviewRow()]);
    sqlReturnQueue.push([mockBusinessRow()]);
    mockGenerateResponse.mockRejectedValueOnce(new CostInfraUnavailableError('reserveCost'));

    await expect(handleResponseGeneration(makeJob())).rejects.toBeInstanceOf(CostInfraUnavailableError);

    expect(mockSql.begin).not.toHaveBeenCalled();
    expect(mockMarkOutboxFailed).not.toHaveBeenCalled();
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
    expect(mockMarkOutboxCompleted).toHaveBeenCalledWith(mockSql, 'outbox-gen-1', undefined);
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
    // options is arg[4] now that `sql` leads the generateResponse signature.
    const retryCallOpts = calls[1]?.[4] as Record<string, unknown> | undefined;
    expect(retryCallOpts).toMatchObject({ skipCache: true });
    // First call should NOT have skipCache
    const firstCallOpts = calls[0]?.[4] as Record<string, unknown> | undefined;
    expect(firstCallOpts?.skipCache).toBeFalsy();
    // Cache must be overwritten with the clean retry result
    expect(mockSetCachedGeneration).toHaveBeenCalledWith(
      'rev-1',
      1,
      expect.stringContaining('Thank you for the kind review!'),
    );
    expect(mockMarkOutboxCompleted).toHaveBeenCalledWith(mockSql, 'outbox-gen-1', undefined);
  });

  // 6. suppress_notification flag (spec §4.6, §6.7)
  it('skips send_notification outbox enqueue when suppress_notification=true', async () => {
    sqlReturnQueue.push([mockReviewRow()]);
    sqlReturnQueue.push([mockBusinessRow()]);
    mockGenerateResponse.mockResolvedValueOnce(MOCK_RESULT);

    await handleResponseGeneration(makeJob({ suppress_notification: true }));

    expect(findSendNotificationPayloads()).toHaveLength(0);
    expect(mockMarkOutboxCompleted).toHaveBeenCalledWith(mockSql, 'outbox-gen-1', undefined);
  });

  it('enqueues send_notification when suppress_notification is omitted (default false)', async () => {
    sqlReturnQueue.push([mockReviewRow()]);
    sqlReturnQueue.push([mockBusinessRow()]);
    mockGenerateResponse.mockResolvedValueOnce(MOCK_RESULT);

    await handleResponseGeneration(makeJob());

    expect(findSendNotificationPayloads()).toHaveLength(1);
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

    expect(findSendNotificationPayloads()).toHaveLength(0);

    const txArgs = mockTx.mock.calls.flat();
    expect(txArgs).toContain('local_regex');
    expect(txArgs).toContain('open');

    expect(mockMarkOutboxCompleted).toHaveBeenCalledWith(mockSql, 'outbox-gen-1', undefined);
  });

  // 7. Triage phase (WS2)
  it('runs the triage phase after context load and threads its severity into generation options', async () => {
    sqlReturnQueue.push([mockReviewRow()]);
    sqlReturnQueue.push([mockBusinessRow()]);
    mockGenerateResponse.mockResolvedValueOnce(MOCK_RESULT);
    mockRunTriagePhase.mockResolvedValueOnce('high');

    await handleResponseGeneration(makeJob());

    expect(mockRunTriagePhase).toHaveBeenCalledOnce();
    // This suite runs the REAL generateDraft, so the severity is observed at
    // the generateResponse seam: options is arg[4].
    expect(mockGenerateResponse).toHaveBeenCalledWith(
      expect.anything(), expect.anything(), expect.anything(), expect.anything(),
      expect.objectContaining({ triageSeverity: 'high' }),
    );
    expect(mockMarkOutboxCompleted).toHaveBeenCalledWith(mockSql, 'outbox-gen-1', undefined);
  });

  it('does not reach the triage phase on skip paths (cancelled subscription, existing response)', async () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    // Skipped: cancelled subscription
    sqlReturnQueue.push([mockReviewRow()]);
    sqlReturnQueue.push([mockBusinessRow({ subscription_status: 'cancelled' })]);
    await handleResponseGeneration(makeJob());
    expect(mockRunTriagePhase).not.toHaveBeenCalled();

    // already_exists: idempotent retry with a committed response
    sqlReturnQueue.push([mockReviewRow()]);
    sqlReturnQueue.push([mockBusinessRow()]);
    sqlReturnQueue.push([mockExistingResponseRow()]);
    sqlReturnQueue.push([mockFirstDraftLookup()]);
    await handleResponseGeneration(makeJob());
    expect(mockRunTriagePhase).not.toHaveBeenCalled();
    logSpy.mockRestore();
  });

  it('sends the normal notification when moderation does not flag (default)', async () => {
    sqlReturnQueue.push([mockReviewRow()]);
    sqlReturnQueue.push([mockBusinessRow()]);
    mockGenerateResponse.mockResolvedValueOnce(MOCK_RESULT);

    await handleResponseGeneration(makeJob());

    expect(findSendNotificationPayloads()).toHaveLength(1);
    const txArgs = mockTx.mock.calls.flat();
    expect(txArgs).not.toContain('open');
  });
});
