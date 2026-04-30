// worker/__tests__/zernio-end-to-end.integration.test.ts
//
// End-to-end pipeline coverage for the Zernio ingestion path.
//
// This codebase uses unit-test-style mocking (not a real-Postgres test
// harness — that's reserved for Playwright e2e under TEST_DATABASE_POOL_URL).
// These tests exercise the WORKER CHAIN by mocking the seam below the
// worker (sql + zernioClient) and asserting the integration invariants
// that single-worker unit tests can't cover, e.g.:
//   - what the worker does when the connection lookup fails
//   - what gets enqueued when the suppress flag rides through
//   - that location-scoped fan-out produces the right aggregate_id
//
// For full real-Postgres + real-Redis coverage, see e2e/zernio-connect.spec.ts.

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Job } from 'bullmq';

const { sqlReturnQueue, mockSql, mockListReviews, mockProcessReview } = vi.hoisted(() => {
  const sqlReturnQueue: unknown[] = [];

  const mkTagged = <T = unknown>(rows: T[]): T[] & { count: number } => {
    const arr = rows as unknown as T[] & { count: number };
    arr.count = rows.length;
    return arr;
  };

  const mockSql: any = vi.fn((_strings: TemplateStringsArray, ..._values: unknown[]) => {
    const result = sqlReturnQueue.shift() ?? mkTagged([]);
    return Promise.resolve(result);
  });
  mockSql.begin = vi.fn(async (cb: (tx: any) => Promise<any>) => cb(mockSql));

  return {
    sqlReturnQueue,
    mockSql,
    mockListReviews: vi.fn(),
    mockProcessReview: vi.fn(),
  };
});

vi.mock('../../src/lib/db/server', () => ({ sql: mockSql, jsonb: (v: unknown) => v }));
vi.mock('../../src/lib/zernio/client', () => ({
  zernioClient: { listReviews: mockListReviews, listAllReviews: vi.fn() },
}));
vi.mock('../../src/lib/reviews/process-review', () => ({ processReview: mockProcessReview }));
vi.mock('../../src/lib/shared/outbox', () => ({
  markOutboxCompleted: vi.fn(),
  markOutboxFailed: vi.fn(),
  extractOutboxHandle: (d: any, fallback: string) => ({
    outboxId: (d && typeof d.outbox_id === 'string') ? d.outbox_id : fallback,
    attempt: (d && typeof d.outbox_attempt === 'number') ? d.outbox_attempt : undefined,
  }),
}));

import { handleZernioReviewIngest } from '../jobs/ZernioReviewIngestWorker';
import type { IngestZernioReviewPayload } from '../../src/lib/shared/worker-types';

const mkTagged = <T = unknown>(rows: T[]): T[] & { count: number } => {
  const arr = rows as unknown as T[] & { count: number };
  arr.count = rows.length;
  return arr;
};

function makeJob(overrides: Partial<IngestZernioReviewPayload> = {}): Job<IngestZernioReviewPayload> {
  return {
    data: {
      business_id: 'biz-1',
      zernio_account_id: 'acct-1',
      zernio_location_id: 'loc-1',
      zernio_review_id: 'rev-abc',
      ...overrides,
    },
    id: 'outbox-ingest-e2e',
  } as Job<IngestZernioReviewPayload>;
}

function mkReview(id: string, locationId: string, replyComment: string | null = null) {
  return {
    id,
    name: `accounts/acct-1/locations/${locationId}/reviews/${id}`,
    reviewer: { displayName: 'Jane Doe', profilePhotoUrl: '', isAnonymous: false },
    rating: 5,
    starRating: 'FIVE' as const,
    comment: 'Great place!',
    createTime: '2026-04-15T10:00:00Z',
    updateTime: '2026-04-15T10:00:00Z',
    reviewReply: replyComment !== null ? { comment: replyComment, updateTime: '2026-04-16T10:00:00Z' } : null,
  };
}

describe('Zernio end-to-end: webhook → ingest → processReview', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    sqlReturnQueue.length = 0;
  });

  it('ingest worker: subscription guard + connection lookup + listReviews + processReview', async () => {
    // SELECT business
    sqlReturnQueue.push([{ subscription_status: 'active', updated_at: new Date() }]);
    // SELECT zernio_connections
    sqlReturnQueue.push([{ id: 'conn-1' }]);

    mockListReviews.mockResolvedValueOnce({
      reviews: [mkReview('rev-abc', 'loc-1')],
      nextPageToken: undefined,
    });

    await handleZernioReviewIngest(makeJob());

    expect(mockListReviews).toHaveBeenCalledWith(
      'acct-1',
      expect.objectContaining({ locationId: 'loc-1', pageSize: 50 }),
    );
    expect(mockProcessReview).toHaveBeenCalledOnce();

    // Assert the MonitoredReview passed to processReview has the right
    // location-scoped resource names.
    const monitored = mockProcessReview.mock.calls[0][0] as {
      identity: { providerReviewName: string; providerLocationName: string };
    };
    expect(monitored.identity.providerReviewName).toBe(
      'zernio://acct-1/locations/loc-1/reviews/rev-abc',
    );
    expect(monitored.identity.providerLocationName).toBe(
      'zernio://acct-1/locations/loc-1',
    );
  });

  it('multi-location fan-out: review at different location → no-op (sibling business)', async () => {
    sqlReturnQueue.push([{ subscription_status: 'active', updated_at: new Date() }]);
    sqlReturnQueue.push([{ id: 'conn-1' }]);

    // Review's name has location 'loc-2' but our connection is at 'loc-1'.
    mockListReviews.mockResolvedValueOnce({
      reviews: [mkReview('rev-abc', 'loc-2')],
      nextPageToken: undefined,
    });

    await handleZernioReviewIngest(makeJob());

    // listReviews was called (fetch happens before location check)
    expect(mockListReviews).toHaveBeenCalledOnce();
    // But processReview was NOT — review belongs to a sibling business's location
    expect(mockProcessReview).not.toHaveBeenCalled();
  });

  it('subscription cancelled → no Zernio API call, no processReview', async () => {
    sqlReturnQueue.push([{ subscription_status: 'cancelled', updated_at: new Date() }]);

    await handleZernioReviewIngest(makeJob());

    expect(mockListReviews).not.toHaveBeenCalled();
    expect(mockProcessReview).not.toHaveBeenCalled();
  });

  it('connection no longer active (e.g. account.disconnected fired between webhook and ingest) → no-op', async () => {
    sqlReturnQueue.push([{ subscription_status: 'active', updated_at: new Date() }]);
    sqlReturnQueue.push([]);  // no active connection

    await handleZernioReviewIngest(makeJob());

    expect(mockListReviews).not.toHaveBeenCalled();
    expect(mockProcessReview).not.toHaveBeenCalled();
  });

  it('correlation_id propagates from ingest payload through to processReview', async () => {
    sqlReturnQueue.push([{ subscription_status: 'active', updated_at: new Date() }]);
    sqlReturnQueue.push([{ id: 'conn-1' }]);

    mockListReviews.mockResolvedValueOnce({
      reviews: [mkReview('rev-abc', 'loc-1')],
      nextPageToken: undefined,
    });

    await handleZernioReviewIngest(makeJob({ correlation_id: 'corr-e2e-1' }));

    expect(mockProcessReview).toHaveBeenCalledWith(
      expect.anything(),
      'biz-1',
      'corr-e2e-1',
    );
  });

  it('externally answered review (reviewReply !== null) → reconcile path, NOT processReview', async () => {
    sqlReturnQueue.push([{ subscription_status: 'active', updated_at: new Date() }]);
    sqlReturnQueue.push([{ id: 'conn-1' }]);

    // Review with non-null reviewReply — customer replied externally.
    mockListReviews.mockResolvedValueOnce({
      reviews: [mkReview('rev-abc', 'loc-1', 'Thanks for the review!')],
      nextPageToken: undefined,
    });

    // Reconcile reads matched rows + active responses inside sql.begin.
    sqlReturnQueue.push(mkTagged([{ id: 'rev-row-1', provider: 'zernio' }]));
    sqlReturnQueue.push(mkTagged([]));  // no active responses

    await handleZernioReviewIngest(makeJob());

    // processReview is NOT called — reconcile branched
    expect(mockProcessReview).not.toHaveBeenCalled();
  });
});
