import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Job } from 'bullmq';
import type { ZernioInitialBackfillPayload } from '../../../../src/lib/shared/worker-types';
import type { ZernioReview } from '../../../../src/lib/zernio/types';

// ── Hoisted state shared between mock factories and tests ──────────────
const {
  sqlReturnQueue,
  mockSql,
  mkTaggedResult,
  mockMarkOutboxCompleted,
  mockListAllReviews,
  mockProcessReview,
  mockReconcileExternallyAnsweredReview,
  mockHandleZernioIngestError,
} = vi.hoisted(() => {
  const sqlReturnQueue: unknown[] = [];

  const mkTaggedResult = <T = unknown>(rows: T[]): unknown[] & { count: number } => {
    const arr = rows as unknown as unknown[] & { count: number };
    arr.count = rows.length;
    return arr;
  };

  const mockSql: any = vi.fn((_strings: TemplateStringsArray, ..._values: unknown[]) => {
    const result = sqlReturnQueue.shift() ?? mkTaggedResult([]);
    return Promise.resolve(result);
  });

  // sql.begin is not needed by ZernioBackfillWorker directly (it doesn't
  // call sql.begin itself — processReview and reconcile do, both mocked).
  mockSql.begin = vi.fn(async (cb: (tx: any) => Promise<any>) => cb(mockSql));

  return {
    sqlReturnQueue,
    mockSql,
    mkTaggedResult,
    mockMarkOutboxCompleted: vi.fn(),
    mockListAllReviews: vi.fn(),
    mockProcessReview: vi.fn(),
    mockReconcileExternallyAnsweredReview: vi.fn(),
    mockHandleZernioIngestError: vi.fn(),
  };
});

// ── Module mocks ─────────────────────────────────────────────────────────
vi.mock('../../../../src/lib/db/server', () => ({ sql: mockSql, jsonb: (v: unknown) => v }));
vi.mock('../../../../src/lib/shared/outbox', () => ({
  markOutboxCompleted: mockMarkOutboxCompleted,
  markOutboxFailed: vi.fn(),
  extractOutboxHandle: (d: any, fallback: string) => ({
    outboxId: (d && typeof d.outbox_id === 'string') ? d.outbox_id : fallback,
    attempt: (d && typeof d.outbox_attempt === 'number') ? d.outbox_attempt : undefined,
  }),
}));
vi.mock('../../../../src/lib/zernio/client', () => ({
  zernioClient: { listAllReviews: mockListAllReviews },
}));
vi.mock('../../../../src/lib/reviews/process-review', () => ({
  processReview: mockProcessReview,
}));
vi.mock('../zernio-ingest-shared', () => ({
  reconcileExternallyAnsweredReview: mockReconcileExternallyAnsweredReview,
  handleZernioIngestError: mockHandleZernioIngestError,
}));
vi.mock('../../../../src/lib/shared/subscription-guard', () => ({
  checkSubscription: (_status: string, _updatedAt: Date, _workerType: string) => {
    if (_status === 'active') return { allowed: true };
    return { allowed: false, reason: _status };
  },
}));

import { handleZernioBackfill } from '../ZernioBackfillWorker';

// ── Fixtures ─────────────────────────────────────────────────────────────

const ACTIVATED_AT = '2026-04-01T00:00:00Z';
const ACTIVATED_MS = new Date(ACTIVATED_AT).getTime();

function makeJob(overrides: Partial<ZernioInitialBackfillPayload> = {}): Job<ZernioInitialBackfillPayload> {
  return {
    data: {
      business_id: 'biz-1',
      zernio_account_id: 'acct-1',
      zernio_location_id: 'loc-1',
      subscription_tier: 'standard',
      subscription_activated_at: ACTIVATED_AT,
      ...overrides,
    },
    id: 'outbox-backfill-1',
  } as Job<ZernioInitialBackfillPayload>;
}

function makeReview(id: string, createTimeMs: number, hasReply = false): ZernioReview {
  return {
    id,
    name: `accounts/acct-1/locations/loc-1/reviews/${id}`,
    reviewer: { displayName: 'Test User', profilePhotoUrl: '', isAnonymous: false },
    rating: 4,
    starRating: 'FOUR',
    comment: `Review text for ${id}`,
    createTime: new Date(createTimeMs).toISOString(),
    updateTime: new Date(createTimeMs).toISOString(),
    reviewReply: hasReply ? { comment: 'Thank you!', updateTime: new Date(createTimeMs + 1000).toISOString() } : null,
  };
}

/** Push the 4 standard SQL results in order:
 *  1. INSERT zernio_backfill_runs (no result needed)
 *  2. SELECT run row → row with no completed_at
 *  3. SELECT business → active biz
 *  Then optionally add more for the counts/completed updates.
 */
function pushStandardSqlSetup(runId = 'run-1') {
  // 1. INSERT ON CONFLICT DO NOTHING → no rows needed
  sqlReturnQueue.push(mkTaggedResult([]));
  // 2. SELECT run row (not yet completed)
  sqlReturnQueue.push(mkTaggedResult([{ id: runId, completed_at: null }]));
  // 3. SELECT business (active)
  sqlReturnQueue.push(mkTaggedResult([{ subscription_status: 'active', updated_at: new Date() }]));
}

function pushCountsUpdate() {
  // UPDATE zernio_backfill_runs (counts)
  sqlReturnQueue.push(mkTaggedResult([]));
}

function pushCompletedUpdate() {
  // UPDATE zernio_backfill_runs (completed_at)
  sqlReturnQueue.push(mkTaggedResult([]));
}

// ── Tests ────────────────────────────────────────────────────────────────

describe('ZernioBackfillWorker', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    sqlReturnQueue.length = 0;
    mockProcessReview.mockResolvedValue(undefined);
    mockReconcileExternallyAnsweredReview.mockResolvedValue(undefined);
    mockHandleZernioIngestError.mockResolvedValue(undefined);
  });

  // Test 1: First run — gap-only fixture
  it('first run: 5 gap reviews → 5 processReview calls with suppressNotification, outbox completed', async () => {
    pushStandardSqlSetup();
    pushCountsUpdate();
    pushCompletedUpdate();

    // 5 reviews all after activated_at
    const reviews = Array.from({ length: 5 }, (_, i) =>
      makeReview(`rev-${i}`, ACTIVATED_MS + (i + 1) * 60_000),
    );
    mockListAllReviews.mockResolvedValueOnce(reviews);

    await handleZernioBackfill(makeJob());

    expect(mockListAllReviews).toHaveBeenCalledWith('acct-1', {
      locationId: 'loc-1',
      pageSize: 50,
      maxPages: 4,
    });
    expect(mockProcessReview).toHaveBeenCalledTimes(5);
    // Every processReview call must have suppressNotification: true
    for (const call of mockProcessReview.mock.calls) {
      expect(call[3]).toMatchObject({ suppressNotification: true });
    }
    expect(mockMarkOutboxCompleted).toHaveBeenCalledWith('outbox-backfill-1', undefined);
  });

  it('reactivation backfill does not skip when an initial backfill completed earlier', async () => {
    sqlReturnQueue.push(mkTaggedResult([]));
    sqlReturnQueue.push(mkTaggedResult([{ id: 'run-1', completed_at: null }]));
    sqlReturnQueue.push(mkTaggedResult([{ subscription_status: 'active', updated_at: new Date() }]));
    pushCountsUpdate();
    pushCompletedUpdate();
    mockListAllReviews.mockResolvedValueOnce([
      makeReview('rev-reactivated', ACTIVATED_MS + 60_000),
    ]);

    await handleZernioBackfill(makeJob({ backfill_reason: 'reactivation' }));

    expect(mockListAllReviews).toHaveBeenCalled();
    expect(mockProcessReview).toHaveBeenCalledTimes(1);
    const firstSql = mockSql.mock.calls[0]?.[0] as TemplateStringsArray | undefined;
    const firstSqlText = firstSql?.join('?') ?? '';
    expect(firstSqlText).toContain('run_reason');
    expect(firstSqlText).toContain('ON CONFLICT (correlation_id)');
  });

  // Test 2: Historical fixture, non-premium tier → historical=0
  it('standard tier: historical reviews are NOT processed, historicalSkipped=total', async () => {
    pushStandardSqlSetup();
    pushCountsUpdate();
    pushCompletedUpdate();

    // 3 reviews all before activated_at (historical)
    const reviews = Array.from({ length: 3 }, (_, i) =>
      makeReview(`rev-hist-${i}`, ACTIVATED_MS - (i + 1) * 3_600_000),
    );
    mockListAllReviews.mockResolvedValueOnce(reviews);

    await handleZernioBackfill(makeJob({ subscription_tier: 'standard' }));

    // No processing since all are historical and tier is standard
    expect(mockProcessReview).not.toHaveBeenCalled();
    expect(mockMarkOutboxCompleted).toHaveBeenCalledWith('outbox-backfill-1', undefined);

    // Verify counts update call — the 3rd SQL call after insert + select_run + select_biz is counts update
    const sqlCalls = mockSql.mock.calls;
    // Find the UPDATE counts call (has gap_processed_count in query)
    const countsCallStrings = sqlCalls.find((call: any[]) => {
      const template = call[0];
      return Array.isArray(template) && template.some((s: string) => s.includes('gap_processed_count'));
    });
    expect(countsCallStrings).toBeDefined();
    // historicalSkipped = 3 (all historical, non-premium)
    const allValues = countsCallStrings.flat();
    const historicalSkippedIndex = allValues.findIndex((v: any) => v === 3 && typeof v === 'number');
    expect(historicalSkippedIndex).toBeGreaterThanOrEqual(0);
  });

  // Test 3: Premium tier processes historical up to cap=50
  it('premium tier: historical reviews processed up to cap=50', async () => {
    pushStandardSqlSetup();
    pushCountsUpdate();
    pushCompletedUpdate();

    // 10 historical reviews (all before activated_at)
    const reviews = Array.from({ length: 10 }, (_, i) =>
      makeReview(`rev-hist-${i}`, ACTIVATED_MS - (i + 1) * 3_600_000),
    );
    mockListAllReviews.mockResolvedValueOnce(reviews);

    await handleZernioBackfill(makeJob({ subscription_tier: 'premium' }));

    // All 10 should be processed (under cap of 50)
    expect(mockProcessReview).toHaveBeenCalledTimes(10);
    for (const call of mockProcessReview.mock.calls) {
      expect(call[3]).toMatchObject({ suppressNotification: true });
    }
    expect(mockMarkOutboxCompleted).toHaveBeenCalledWith('outbox-backfill-1', undefined);
  });

  // Test 4: Mixed 30 gap + 30 historical, premium → gap=25 (cap), historical=30, gapSkipped=5
  it('mixed gap/historical premium: gap capped at 25, historical all 30, gapSkipped=5', async () => {
    pushStandardSqlSetup();
    pushCountsUpdate();
    pushCompletedUpdate();

    // 30 gap reviews (after activated_at), 30 historical (before)
    const gapReviews = Array.from({ length: 30 }, (_, i) =>
      makeReview(`gap-${i}`, ACTIVATED_MS + (i + 1) * 60_000),
    );
    const histReviews = Array.from({ length: 30 }, (_, i) =>
      makeReview(`hist-${i}`, ACTIVATED_MS - (i + 1) * 3_600_000),
    );
    mockListAllReviews.mockResolvedValueOnce([...gapReviews, ...histReviews]);

    await handleZernioBackfill(makeJob({ subscription_tier: 'premium' }));

    // gap=25 (capped) + historical=30 (under cap 50) = 55 total processReview calls
    expect(mockProcessReview).toHaveBeenCalledTimes(55);

    // Verify the counts update includes gap_skipped=5, historical_skipped=0
    const sqlCalls = mockSql.mock.calls;
    const countsCall = sqlCalls.find((call: any[]) => {
      const template = call[0];
      return Array.isArray(template) && template.some((s: string) => s.includes('gap_processed_count'));
    });
    expect(countsCall).toBeDefined();

    // gap_processed_count=25, historical_processed_count=30, gap_skipped=5, historical_skipped=0
    const values = countsCall.slice(1); // skip the template strings array
    expect(values).toContain(25); // gap processed
    expect(values).toContain(30); // historical processed
    expect(values).toContain(5);  // gap skipped
    expect(values).toContain(0);  // historical skipped

    expect(mockMarkOutboxCompleted).toHaveBeenCalledWith('outbox-backfill-1', undefined);
  });

  // Test 5: createTime DESC sort applied BEFORE slice — newest 25 processed, not first 25 returned
  it('sort applied before slice: the 25 newest gap reviews are processed', async () => {
    pushStandardSqlSetup();
    pushCountsUpdate();
    pushCompletedUpdate();

    const processedIds: string[] = [];
    mockProcessReview.mockImplementation(async (monitored: any) => {
      processedIds.push(monitored.identity.providerReviewId);
    });

    // 30 gap reviews. Return them in ASCENDING time order (oldest first).
    // Worker must sort DESC and take first 25 (newest 25).
    const reviews = Array.from({ length: 30 }, (_, i) =>
      makeReview(`gap-${i}`, ACTIVATED_MS + (i + 1) * 60_000), // gap-0 is oldest, gap-29 is newest
    );
    mockListAllReviews.mockResolvedValueOnce(reviews);

    await handleZernioBackfill(makeJob());

    expect(mockProcessReview).toHaveBeenCalledTimes(25);

    // The 25 processed should be the newest (gap-5 through gap-29)
    // gap-0 through gap-4 are the 5 oldest and should be skipped
    for (let i = 5; i < 30; i++) {
      expect(processedIds).toContain(`gap-${i}`);
    }
    for (let i = 0; i < 5; i++) {
      expect(processedIds).not.toContain(`gap-${i}`);
    }
  });

  // Test 6: suppressNotification=true on every processReview call
  it('every processReview call carries suppressNotification=true', async () => {
    pushStandardSqlSetup();
    pushCountsUpdate();
    pushCompletedUpdate();

    const reviews = Array.from({ length: 3 }, (_, i) =>
      makeReview(`rev-${i}`, ACTIVATED_MS + (i + 1) * 60_000),
    );
    mockListAllReviews.mockResolvedValueOnce(reviews);

    await handleZernioBackfill(makeJob());

    expect(mockProcessReview).toHaveBeenCalledTimes(3);
    for (const call of mockProcessReview.mock.calls) {
      // call signature: (monitored, business_id, correlation_id?, options?)
      const options = call[3];
      expect(options).toEqual(expect.objectContaining({ suppressNotification: true }));
    }
  });

  it('skips likely PHI in unanswered backfill reviews without sending to processReview', async () => {
    pushStandardSqlSetup();
    pushCountsUpdate();
    pushCompletedUpdate();

    const phiReview = makeReview('phi-review', ACTIVATED_MS + 60_000);
    phiReview.comment = 'Patient MRN 12345 needs diabetes treatment follow up';
    const ordinaryReview = makeReview('ordinary-review', ACTIVATED_MS + 120_000);
    mockListAllReviews.mockResolvedValueOnce([phiReview, ordinaryReview]);

    await handleZernioBackfill(makeJob());

    expect(mockProcessReview).toHaveBeenCalledTimes(1);
    expect(mockProcessReview.mock.calls[0]?.[0].identity.providerReviewId).toBe('ordinary-review');
    expect(mockMarkOutboxCompleted).toHaveBeenCalledWith('outbox-backfill-1', undefined);
  });

  // Test 7: Reconcile failure → counts written, completed_at NOT set, worker throws
  it('reconcile failure: counts written but completed_at not set, worker throws', async () => {
    pushStandardSqlSetup();
    // counts update only (no completed_at update because reconcile fails)
    pushCountsUpdate();
    // NO completed_at update push — the error should be thrown before it

    const answeredReview1 = makeReview('answered-1', ACTIVATED_MS + 60_000, true);
    const answeredReview2 = makeReview('answered-2', ACTIVATED_MS + 120_000, true);

    mockListAllReviews.mockResolvedValueOnce([answeredReview1, answeredReview2]);

    // First reconcile succeeds, second fails
    mockReconcileExternallyAnsweredReview
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(new Error('DB timeout'));

    await expect(handleZernioBackfill(makeJob())).rejects.toThrow(
      'Backfill reconciliation failed for 1 review(s)',
    );

    // completed_at should NOT be set (worker threw before that SQL call)
    expect(mockMarkOutboxCompleted).not.toHaveBeenCalled();

    // Counts update SHOULD have been called
    const sqlCalls = mockSql.mock.calls;
    const countsCall = sqlCalls.find((call: any[]) => {
      const template = call[0];
      return Array.isArray(template) && template.some((s: string) => s.includes('gap_processed_count'));
    });
    expect(countsCall).toBeDefined();

    // The completed_at update SQL should NOT have been called (it contains 'completed_at')
    // Note: we check that the specific completed_at update is absent
    // (the counts update also writes updated_at but NOT completed_at = NOW())
    const completedAtUpdateCall = sqlCalls.find((call: any[]) => {
      const template = call[0];
      return Array.isArray(template) &&
        template.some((s: string) => s.includes('completed_at = NOW()')) &&
        template.some((s: string) => s.includes('zernio_backfill_runs')) &&
        !template.some((s: string) => s.includes('gap_processed_count'));
    });
    expect(completedAtUpdateCall).toBeUndefined();
  });
});
