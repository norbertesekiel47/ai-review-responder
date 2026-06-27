// Worker-chain correlation test.
//
// Proves the correlation_id injected at the Zernio ingest entry point flows
// through the full ingest→response→notification chain:
//
//   ingest_zernio_review [corr-X]
//     → ZernioReviewIngestWorker / processReview(monitored, bizId, corr-X)
//     → generate_response [corr-X]                   ← asserted in Part A
//       → ResponseGeneratorWorker / persistResponseAndNotify
//       → send_notification [corr-X]                 ← asserted in Part B
//
// Each worker runs in a separate BullMQ context, so we assert the boundary
// contract at each hop: whatever correlation_id comes in must be present in
// every outbox payload this worker creates.

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Job } from 'bullmq';
import type { IngestZernioReviewPayload } from '../../src/lib/shared/worker-types';

const UPSTREAM_CORRELATION = 'upstream-corr-chain-xyz';

// ─── Part A shared state ────────────────────────────────────────────

const {
  mockSqlA,
  mockMarkOutboxCompletedA,
  mockProcessReview,
  mockZernioClient,
  mockBuildZernioMonitoredReview,
  mockExtractLocationFromReviewName,
} = vi.hoisted(() => {
  const mockSqlA: any = vi.fn(
    (_strings: TemplateStringsArray, ..._values: unknown[]): Promise<unknown[]> =>
      Promise.resolve([]),
  );
  mockSqlA.begin = vi.fn(async (callback: (tx: unknown) => Promise<unknown>) => callback(mockSqlA));

  const mockMarkOutboxCompletedA = vi.fn();
  const mockProcessReview = vi.fn<(monitored: unknown, bizId: string, corrId?: string) => Promise<string>>();
  const mockZernioClient = {
    listReviews: vi.fn<() => Promise<{ reviews: unknown[]; nextPageToken?: string }>>(),
  };
  const mockBuildZernioMonitoredReview = vi.fn();
  const mockExtractLocationFromReviewName = vi.fn<(name: string) => string | null>();

  return {
    mockSqlA,
    mockMarkOutboxCompletedA,
    mockProcessReview,
    mockZernioClient,
    mockBuildZernioMonitoredReview,
    mockExtractLocationFromReviewName,
  };
});

// ─── Module mocks ────────────────────────────────────────────────────

vi.mock('../../src/lib/db/server', () => ({
  sql: mockSqlA,
  jsonb: (v: unknown) => v,
}));

vi.mock('../../src/lib/shared/outbox', () => ({
  markOutboxCompleted: mockMarkOutboxCompletedA,
  markOutboxFailed: vi.fn(),
  extractOutboxHandle: (d: Record<string, unknown>, fallback: string) => ({
    outboxId: typeof d?.outbox_id === 'string' ? d.outbox_id : fallback,
    attempt: typeof d?.outbox_attempt === 'number' ? d.outbox_attempt : undefined,
  }),
}));

vi.mock('../../src/lib/reviews/process-review', () => ({
  processReview: mockProcessReview,
}));

vi.mock('../../src/lib/zernio/client', () => ({
  zernioClient: mockZernioClient,
}));

vi.mock('../../src/lib/reviews/zernio-normalize', () => ({
  buildZernioMonitoredReview: mockBuildZernioMonitoredReview,
  extractLocationFromReviewName: mockExtractLocationFromReviewName,
  ZernioReviewNormalizationError: class ZernioReviewNormalizationError extends Error {
    constructor(message: string) {
      super(message);
      this.name = 'ZernioReviewNormalizationError';
    }
  },
}));

vi.mock('../../src/lib/shared/subscription-guard', () => ({
  checkSubscription: vi.fn(() => ({ allowed: true })),
}));

vi.mock('../../src/lib/shared/logger', () => ({
  createWorkerLogger: () => ({ log: vi.fn(), warn: vi.fn(), error: vi.fn() }),
}));

vi.mock('uuid', () => ({
  v7: vi.fn(() => 'test-uuid-v7'),
}));

// Import after mocks are wired
import { handleZernioReviewIngest } from '../jobs/zernio/ZernioReviewIngestWorker';

// ─── Helpers ─────────────────────────────────────────────────────────

function makeIngestJob(correlationId: string): Job<IngestZernioReviewPayload> {
  return {
    data: {
      business_id: 'biz-001',
      zernio_account_id: 'acct-001',
      zernio_location_id: 'loc-001',
      zernio_review_id: 'rev-abc123',
      correlation_id: correlationId,
    },
    id: 'ingest-outbox-id',
    opts: { attempts: 5 },
    attemptsMade: 0,
  } as unknown as Job<IngestZernioReviewPayload>;
}

function makeZernioReview() {
  return {
    id: 'rev-abc123',
    name: 'accounts/acct-001/locations/loc-001/reviews/rev-abc123',
    reviewer: { displayName: 'Test User' },
    starRating: 'FIVE',
    comment: 'Great service!',
    createTime: new Date().toISOString(),
    updateTime: new Date().toISOString(),
    reviewReply: null,
  };
}

// ─── Part A: ingest_zernio_review → generate_response boundary ───────

describe('correlation chain — Part A: ZernioReviewIngestWorker propagates to processReview', () => {
  beforeEach(() => {
    vi.clearAllMocks();

    // Business subscription SELECT + connection SELECT return rows
    mockSqlA.mockImplementation(() => Promise.resolve([
      { subscription_status: 'active', updated_at: new Date() },
    ]));
  });

  it('passes incoming correlation_id through to processReview (which writes generate_response outbox)', async () => {
    // Mock SQL: first call = biz subscription, second call = zernio_connections
    let callCount = 0;
    mockSqlA.mockImplementation(() => {
      callCount++;
      if (callCount === 1) return Promise.resolve([{ subscription_status: 'active', updated_at: new Date() }]);
      if (callCount === 2) return Promise.resolve([{ id: 'conn-001' }]);
      return Promise.resolve([]);
    });

    const zernioReview = makeZernioReview();
    mockZernioClient.listReviews.mockResolvedValueOnce({
      reviews: [zernioReview],
      nextPageToken: undefined,
    });

    // extractLocationFromReviewName returns a matching location id
    mockExtractLocationFromReviewName.mockReturnValue('loc-001');

    // buildZernioMonitoredReview returns a stub MonitoredReview
    const stubMonitored = { review: { reviewerName: 'Test User' }, identity: {}, contentHash: 'hash' };
    mockBuildZernioMonitoredReview.mockReturnValue(stubMonitored);

    // processReview is the boundary — it internally INSERTs generate_response.
    // We capture the correlationId argument passed to it.
    mockProcessReview.mockResolvedValue('new');

    await handleZernioReviewIngest(makeIngestJob(UPSTREAM_CORRELATION));

    // The ingest worker must call processReview with the upstream correlation_id.
    expect(mockProcessReview).toHaveBeenCalledTimes(1);
    const [, , capturedCorrelationId] = mockProcessReview.mock.calls[0]!;
    expect(capturedCorrelationId).toBe(UPSTREAM_CORRELATION);

    // Outbox should be marked completed.
    expect(mockMarkOutboxCompletedA).toHaveBeenCalled();
  });
});

// ─── Part B: generate_response → send_notification boundary ─────────
//
// The runtime assertion for this hop lives in ResponseGeneratorWorker.test.ts
// (test: "propagates incoming correlation_id into the serialized
// send_notification outbox payload"). That test runs the full handler path
// with mocked dependencies and parses the JSON-serialized payload from the
// tx mock call args to verify correlation_id matches the incoming job's value.
// Together with Part A above, the chain is proven at runtime through both
// worker boundaries.
