import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Job } from 'bullmq';
import type { SyncReviewsPayload } from '../../src/lib/shared/worker-types';
import type { MonitorResult } from '../../src/lib/reviews/types';

// ── Hoisted state shared between mock factories and tests ──────────────
const {
  sqlReturnQueue,
  mockSql,
  mockTx,
  mockMarkOutboxCompleted,
  mockMarkOutboxFailed,
  mockFetchReviews,
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

  const mockMarkOutboxCompleted = vi.fn();
  const mockMarkOutboxFailed = vi.fn();

  const mockFetchReviews = vi.fn<(placeId: string) => Promise<MonitorResult>>();

  return {
    sqlReturnQueue,
    mockSql,
    mockTx,
    mockMarkOutboxCompleted,
    mockMarkOutboxFailed,
    mockFetchReviews,
  };
});

// ── Module mocks (hoisted by vitest) ───────────────────────────────────
vi.mock('../../src/lib/db/server', () => ({
  sql: mockSql,
}));

vi.mock('../../src/lib/shared/outbox', () => ({
  markOutboxCompleted: mockMarkOutboxCompleted,
  markOutboxFailed: mockMarkOutboxFailed,
}));

vi.mock('../../src/lib/shared/mock-mode', () => ({
  getReviewMonitor: () => ({ fetchReviews: mockFetchReviews }),
}));

vi.mock('uuid', () => ({
  v7: vi.fn(() => 'deterministic-uuid-v7'),
}));

// Import after mocks are wired
import { handleReviewSync } from '../jobs/ReviewSyncWorker';

// ── Helpers ────────────────────────────────────────────────────────────

function makeJob(
  overrides: Partial<SyncReviewsPayload> = {},
  jobId = 'outbox-test-123',
): Job<SyncReviewsPayload> {
  return {
    data: {
      business_id: 'biz-001',
      google_place_id: 'ChIJ-test',
      ...overrides,
    },
    id: jobId,
  } as Job<SyncReviewsPayload>;
}

function activeBusiness(overrides: Record<string, unknown> = {}) {
  return {
    id: 'biz-001',
    subscription_status: 'active',
    google_place_id: 'ChIJ-test',
    place_id_verified: true,
    baseline_captured_at: new Date(),
    updated_at: new Date(),
    ...overrides,
  };
}

// ── Tests ──────────────────────────────────────────────────────────────

describe('ReviewSyncWorker – handleReviewSync', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    sqlReturnQueue.length = 0;
    mockTx.mockImplementation(() => Promise.resolve([]));
  });

  // 1. Business not found
  it('completes the outbox when business is not found', async () => {
    sqlReturnQueue.push([]);

    await handleReviewSync(makeJob());

    expect(mockMarkOutboxCompleted).toHaveBeenCalledWith('outbox-test-123');
    expect(mockMarkOutboxFailed).not.toHaveBeenCalled();
    expect(mockFetchReviews).not.toHaveBeenCalled();
  });

  // 2. Subscription cancelled
  it('completes the outbox when subscription is cancelled', async () => {
    sqlReturnQueue.push([activeBusiness({ subscription_status: 'cancelled' })]);

    await handleReviewSync(makeJob());

    expect(mockMarkOutboxCompleted).toHaveBeenCalledWith('outbox-test-123');
    expect(mockMarkOutboxFailed).not.toHaveBeenCalled();
    expect(mockFetchReviews).not.toHaveBeenCalled();
  });

  // 3. Null google_place_id
  it('completes the outbox when google_place_id is null', async () => {
    sqlReturnQueue.push([activeBusiness({ google_place_id: null })]);

    await handleReviewSync(makeJob());

    expect(mockMarkOutboxCompleted).toHaveBeenCalledWith('outbox-test-123');
    expect(mockMarkOutboxFailed).not.toHaveBeenCalled();
    expect(mockFetchReviews).not.toHaveBeenCalled();
  });

  // 4. Permanent SerpAPI error (403/quota)
  it('fails the outbox on permanent SerpAPI error and does not throw', async () => {
    sqlReturnQueue.push([activeBusiness()]);
    mockFetchReviews.mockRejectedValueOnce(new Error('403 Forbidden - quota exceeded'));

    await handleReviewSync(makeJob());

    expect(mockMarkOutboxFailed).toHaveBeenCalledWith(
      'outbox-test-123',
      expect.stringContaining('serpapi_permanent'),
    );
    expect(mockMarkOutboxCompleted).not.toHaveBeenCalled();
  });

  // 5. Transient SerpAPI error (network)
  it('throws on transient SerpAPI error for BullMQ retry', async () => {
    sqlReturnQueue.push([activeBusiness()]);
    mockFetchReviews.mockRejectedValueOnce(new Error('ECONNRESET'));

    await expect(handleReviewSync(makeJob())).rejects.toThrow('ECONNRESET');

    expect(mockMarkOutboxCompleted).not.toHaveBeenCalled();
    expect(mockMarkOutboxFailed).not.toHaveBeenCalled();
  });

  // 6. New review — happy path (no existing row from FOR UPDATE → insert + outbox)
  it('processes a new review and completes the outbox', async () => {
    sqlReturnQueue.push([activeBusiness({ baseline_captured_at: new Date() })]);
    sqlReturnQueue.push([]); // UPDATE last_sync_at

    // Mock tx to simulate: no existing review (empty FOR UPDATE), then insert succeeds
    let txCallCount = 0;
    mockTx.mockImplementation(() => {
      txCallCount++;
      // Call 1: SELECT FOR UPDATE → no existing review
      if (txCallCount === 1) return Promise.resolve([]);
      // Call 2: INSERT review → return id
      if (txCallCount === 2) return Promise.resolve([{ id: 'new-review-id' }]);
      // Call 3: INSERT outbox entry
      return Promise.resolve([]);
    });

    mockFetchReviews.mockResolvedValueOnce({
      reviews: [makeMockMonitoredReview()],
      collisions: [],
    });

    await handleReviewSync(makeJob());

    expect(mockSql.begin).toHaveBeenCalled();
    // tx called at least 3 times: FOR UPDATE, INSERT review, INSERT outbox
    expect(mockTx.mock.calls.length).toBeGreaterThanOrEqual(3);
    expect(mockMarkOutboxCompleted).toHaveBeenCalledWith('outbox-test-123');
  });

  // 7. Unchanged review — no action taken
  it('skips unchanged reviews (same content hash)', async () => {
    sqlReturnQueue.push([activeBusiness({ baseline_captured_at: new Date() })]);
    sqlReturnQueue.push([]); // UPDATE last_sync_at

    // Mock tx: existing review with matching content hash
    let txCallCount = 0;
    mockTx.mockImplementation(() => {
      txCallCount++;
      // Call 1: SELECT FOR UPDATE → existing review with same hash
      if (txCallCount === 1) {
        return Promise.resolve([{ id: 'existing-review-id', review_content_hash: 'abc123hash' }]);
      }
      return Promise.resolve([]);
    });

    mockFetchReviews.mockResolvedValueOnce({
      reviews: [makeMockMonitoredReview({ contentHash: 'abc123hash' })],
      collisions: [],
    });

    await handleReviewSync(makeJob());

    // Only 1 tx call (the FOR UPDATE select) — no updates or inserts
    expect(txCallCount).toBe(1);
    expect(mockMarkOutboxCompleted).toHaveBeenCalledWith('outbox-test-123');
  });

  // 8. Content changed + pending_approval response → fail old, regenerate
  it('fails pending response and regenerates when review content changes', async () => {
    sqlReturnQueue.push([activeBusiness({ baseline_captured_at: new Date() })]);
    sqlReturnQueue.push([]); // UPDATE last_sync_at

    let txCallCount = 0;
    mockTx.mockImplementation(() => {
      txCallCount++;
      // Call 1: SELECT FOR UPDATE → existing review with different hash
      if (txCallCount === 1) {
        return Promise.resolve([{ id: 'existing-review-id', review_content_hash: 'old-hash' }]);
      }
      // Call 2: UPDATE review row with new content
      if (txCallCount === 2) return Promise.resolve([]);
      // Call 3: SELECT active response → pending_approval
      if (txCallCount === 3) {
        return Promise.resolve([{ id: 'resp-1', status: 'pending_approval', version: 1 }]);
      }
      // Call 4: UPDATE response to failed
      // Call 5: INSERT generate_response outbox entry
      return Promise.resolve([]);
    });

    mockFetchReviews.mockResolvedValueOnce({
      reviews: [makeMockMonitoredReview({ contentHash: 'new-hash' })],
      collisions: [],
    });

    await handleReviewSync(makeJob());

    // Should have called tx at least 5 times (FOR UPDATE, UPDATE review, SELECT response, UPDATE response, INSERT outbox)
    expect(txCallCount).toBeGreaterThanOrEqual(5);
    expect(mockMarkOutboxCompleted).toHaveBeenCalledWith('outbox-test-123');
  });

  // 9. Content changed + posted response → exception created
  it('creates review exception when posted response has content change', async () => {
    sqlReturnQueue.push([activeBusiness({ baseline_captured_at: new Date() })]);
    sqlReturnQueue.push([]); // UPDATE last_sync_at

    let txCallCount = 0;
    mockTx.mockImplementation(() => {
      txCallCount++;
      // Call 1: SELECT FOR UPDATE → existing review with different hash
      if (txCallCount === 1) {
        return Promise.resolve([{ id: 'existing-review-id', review_content_hash: 'old-hash' }]);
      }
      // Call 2: UPDATE review row
      if (txCallCount === 2) return Promise.resolve([]);
      // Call 3: SELECT active response → posted
      if (txCallCount === 3) {
        return Promise.resolve([{ id: 'resp-1', status: 'posted', version: 1 }]);
      }
      // Call 4: INSERT review_exception (count > 0 means inserted)
      if (txCallCount === 4) return Promise.resolve(Object.assign([], { count: 1 }));
      // Call 5: INSERT notify_admin outbox entry
      return Promise.resolve([]);
    });

    mockFetchReviews.mockResolvedValueOnce({
      reviews: [makeMockMonitoredReview({ contentHash: 'new-hash' })],
      collisions: [],
    });

    await handleReviewSync(makeJob());

    // Should have inserted exception + notify outbox (5 tx calls)
    expect(txCallCount).toBeGreaterThanOrEqual(5);
    expect(mockMarkOutboxCompleted).toHaveBeenCalledWith('outbox-test-123');
  });
  // 10. Identity collision — inserts into review_exceptions
  it('stores identity collision in review_exceptions', async () => {
    let sqlCallCount = 0;
    mockSql.mockImplementation((_s: TemplateStringsArray, ..._v: unknown[]) => {
      sqlCallCount++;
      // Call 1: business SELECT
      if (sqlCallCount === 1) return Promise.resolve([activeBusiness({ baseline_captured_at: new Date() })]);
      // Call 2: INSERT review_exception (collision) — simulate successful insert
      // Call 3: UPDATE last_sync_at
      return Promise.resolve(Object.assign([], { count: 1 }));
    });

    mockFetchReviews.mockResolvedValueOnce({
      reviews: [],
      collisions: [
        {
          review: {
            reviewerName: 'Duplicate User',
            starRating: 4,
            reviewText: 'Good place',
            reviewDate: '2026-04-01',
            detectedLanguage: 'en',
          },
          identity: {
            provider: 'serpapi_poll' as const,
            providerReviewId: 'collision-rev-id',
            providerReviewName: 'serpapi://ChIJ-test/reviews/collision-rev-id',
            providerLocationName: 'serpapi://ChIJ-test',
            identityStrategy: 'name_date_hash' as const,
          },
          contentHash: 'hash-a',
          collidesWithContentHash: 'hash-b',
        },
      ],
    });

    await handleReviewSync(makeJob());

    // sql was called: 1 (business) + 1 (collision insert) + 1 (last_sync_at) = 3
    expect(sqlCallCount).toBeGreaterThanOrEqual(3);
    // Verify the collision INSERT was called with the right type
    const collisionCall = mockSql.mock.calls.find(
      (call: unknown[]) => {
        const strings = call[0] as TemplateStringsArray;
        return Array.from(strings).some((s: string) => s.includes('identity_collision'));
      },
    );
    expect(collisionCall).toBeDefined();
    expect(mockMarkOutboxCompleted).toHaveBeenCalledWith('outbox-test-123');
  });

  // 11. place_id_verified = false — early return, no SerpAPI call
  it('completes the outbox without fetching reviews when place_id_verified is false', async () => {
    sqlReturnQueue.push([activeBusiness({ place_id_verified: false })]);

    await handleReviewSync(makeJob());

    expect(mockMarkOutboxCompleted).toHaveBeenCalledWith('outbox-test-123');
    expect(mockFetchReviews).not.toHaveBeenCalled();
  });

  // 12. Duplicate identity collision — suppressed by ON CONFLICT DO NOTHING
  it('does not fail when duplicate collision insert is suppressed', async () => {
    let sqlCallCount = 0;
    mockSql.mockImplementation((_s: TemplateStringsArray, ..._v: unknown[]) => {
      sqlCallCount++;
      if (sqlCallCount === 1) return Promise.resolve([activeBusiness({ baseline_captured_at: new Date() })]);
      // Call 2: INSERT collision — ON CONFLICT DO NOTHING returns count: 0
      if (sqlCallCount === 2) return Promise.resolve(Object.assign([], { count: 0 }));
      return Promise.resolve(Object.assign([], { count: 0 }));
    });

    mockFetchReviews.mockResolvedValueOnce({
      reviews: [],
      collisions: [
        {
          review: {
            reviewerName: 'Duplicate User',
            starRating: 4,
            reviewText: 'Good place',
            reviewDate: '2026-04-01',
            detectedLanguage: 'en',
          },
          identity: {
            provider: 'serpapi_poll' as const,
            providerReviewId: 'collision-rev-id',
            providerReviewName: 'serpapi://ChIJ-test/reviews/collision-rev-id',
            providerLocationName: 'serpapi://ChIJ-test',
            identityStrategy: 'name_date_hash' as const,
          },
          contentHash: 'hash-a',
          collidesWithContentHash: 'hash-b',
        },
      ],
    });

    // Should not throw — ON CONFLICT DO NOTHING silently skips
    await handleReviewSync(makeJob());

    expect(mockMarkOutboxCompleted).toHaveBeenCalledWith('outbox-test-123');
    expect(mockMarkOutboxFailed).not.toHaveBeenCalled();
  });
});

// ── Test data factory ─────────────────────────────────────────────────

function makeMockMonitoredReview(overrides: Record<string, unknown> = {}) {
  return {
    review: {
      reviewerName: 'Jane Doe',
      starRating: 5,
      reviewText: 'Great service!',
      reviewDate: '2026-04-01',
      detectedLanguage: 'en',
    },
    identity: {
      provider: 'serpapi_poll' as const,
      providerReviewId: 'rev-abc',
      providerReviewName: 'serpapi://ChIJ-test/reviews/rev-abc',
      providerLocationName: 'serpapi://ChIJ-test',
      identityStrategy: 'source_id' as const,
    },
    contentHash: 'abc123hash',
    ...overrides,
  };
}
