import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Job } from 'bullmq';
import type { Sql } from 'postgres';
import { SKIP_REASON_ARCHIVED_LOCATION, type ZernioInitialBackfillPayload } from '../../../../src/lib/shared/worker-types';
import type { ZernioReview } from '../../../../src/lib/zernio/types';
import type { SubscriptionTierValue } from '../../../../src/lib/accounts/tier-config';

// ── Hoisted state shared between mock factories and tests ──────────────
const {
  sqlReturnQueue,
  mockSql,
  resetMockSql,
  mkTaggedResult,
  mockMarkOutboxCompleted,
  mockListAllReviews,
  mockProcessReview,
  mockReconcileExternallyAnsweredReview,
  mockOpenPhiReviewException,
  mockHandleZernioIngestError,
  mockLogger,
} = await vi.hoisted(async () => {
  const { createMockSql, mkTaggedResult, mockWorkerLogger } =
    await import('../../../__tests__/helpers/mock-sql');

  return {
    // sql.begin is not needed by ZernioBackfillWorker directly (it doesn't
    // call sql.begin itself — processReview and reconcile do, both mocked).
    ...createMockSql(),
    mkTaggedResult,
    mockMarkOutboxCompleted: vi.fn(),
    mockListAllReviews: vi.fn(),
    mockProcessReview: vi.fn(),
    mockReconcileExternallyAnsweredReview: vi.fn(),
    mockOpenPhiReviewException: vi.fn(),
    mockHandleZernioIngestError: vi.fn(),
    mockLogger: mockWorkerLogger(),
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
  openPhiReviewException: mockOpenPhiReviewException,
  handleZernioIngestError: mockHandleZernioIngestError,
}));
vi.mock('../../../../src/lib/shared/subscription-guard', () => ({
  checkSubscription: (input: { status: string }) => {
    if (input.status === 'active') return { allowed: true };
    return { allowed: false, reason: input.status };
  },
}));
vi.mock('../../../../src/lib/shared/logger', () => ({
  createWorkerLogger: () => mockLogger,
}));

import { handleZernioBackfill } from '../ZernioBackfillWorker';

// handleZernioBackfill now takes the injected client as its leading arg;
// mockSql (createMockSql()'s tagged-template mock) doesn't structurally match
// postgres.Sql, so pass a cast view while assertions keep referencing mockSql
// (same runtime object).
const sqlArg = mockSql as unknown as Sql;

// ── Fixtures ─────────────────────────────────────────────────────────────

const ACTIVATED_AT = '2026-04-01T00:00:00Z';
const ACTIVATED_MS = new Date(ACTIVATED_AT).getTime();

function makeJob(overrides: Partial<ZernioInitialBackfillPayload> = {}): Job<ZernioInitialBackfillPayload> {
  return {
    data: {
      business_id: 'biz-1',
      zernio_account_id: 'acct-1',
      zernio_location_id: 'loc-1',
      subscription_tier: 'copilot',
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
  // 3. SELECT business (active, not archived)
  sqlReturnQueue.push(mkTaggedResult([{
    subscription_status: 'active',
    past_due_at: null,
    account_flags: {},
    archived_at: null,
  }]));
}

function pushCountsUpdate() {
  // UPDATE zernio_backfill_runs (counts)
  sqlReturnQueue.push(mkTaggedResult([]));
}

function pushCompletedUpdate() {
  // UPDATE zernio_backfill_runs (completed_at)
  sqlReturnQueue.push(mkTaggedResult([]));
}

// #673 dual-write contract: the ONE counts UPDATE, exactly this shape, until
// #680 drops the legacy set. Normalized against Task 3 Step 1's statement.
const DUAL_WRITE_TEMPLATE =
  'UPDATE zernio_backfill_runs SET gap_processed_count = ?, historical_processed_count = ?, ' +
  'gap_skipped_count = ?, historical_skipped_count = ?, imported_count = ?, skipped_count = ?, ' +
  'oldest_skipped_create_time = ?, updated_at = NOW() WHERE id = ?';

function normalizeTemplate(template: readonly string[]): string {
  return template.join('?').replace(/\s+/g, ' ').trim();
}

function findCountsCalls(): any[][] {
  return mockSql.mock.calls.filter((call: any[]) => {
    const template = call[0];
    return Array.isArray(template) && template.some((s: string) => s.includes('gap_processed_count'));
  });
}

// ── Tests ────────────────────────────────────────────────────────────────

describe('ZernioBackfillWorker', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetMockSql();
    mockProcessReview.mockResolvedValue(undefined);
    mockReconcileExternallyAnsweredReview.mockResolvedValue(undefined);
    mockHandleZernioIngestError.mockResolvedValue(undefined);
  });

  it('fails closed on an unsupported tier before SQL, provider, or child work', async () => {
    const unsupportedTier = 'retired_tier' as unknown as SubscriptionTierValue;

    await expect(handleZernioBackfill(
      sqlArg,
      makeJob({ subscription_tier: unsupportedTier }),
    )).rejects.toThrow('invalid_ws8_subscription_tier:retired_tier');

    expect(mockSql).not.toHaveBeenCalled();
    expect(sqlReturnQueue).toHaveLength(0);
    expect(mockListAllReviews).not.toHaveBeenCalled();
    expect(mockProcessReview).not.toHaveBeenCalled();
    expect(mockReconcileExternallyAnsweredReview).not.toHaveBeenCalled();
    expect(mockMarkOutboxCompleted).not.toHaveBeenCalled();
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

    await handleZernioBackfill(sqlArg, makeJob());

    expect(mockListAllReviews).toHaveBeenCalledWith('acct-1', {
      locationId: 'loc-1',
      pageSize: 50,
      maxPages: 4,
    });
    expect(mockProcessReview).toHaveBeenCalledTimes(5);
    // Every processReview call must have suppressNotification: true
    for (const call of mockProcessReview.mock.calls) {
      expect(call[4]).toMatchObject({ suppressNotification: true });
    }
    expect(mockMarkOutboxCompleted).toHaveBeenCalledWith(sqlArg, 'outbox-backfill-1', undefined);
  });

  it('reactivation backfill does not skip when an initial backfill completed earlier', async () => {
    sqlReturnQueue.push(mkTaggedResult([]));
    sqlReturnQueue.push(mkTaggedResult([{ id: 'run-1', completed_at: null }]));
    sqlReturnQueue.push(mkTaggedResult([{
      subscription_status: 'active',
      past_due_at: null,
      account_flags: {},
    }]));
    pushCountsUpdate();
    pushCompletedUpdate();
    mockListAllReviews.mockResolvedValueOnce([
      makeReview('rev-reactivated', ACTIVATED_MS + 60_000),
    ]);

    await handleZernioBackfill(sqlArg, makeJob({ backfill_reason: 'reactivation' }));

    expect(mockListAllReviews).toHaveBeenCalled();
    expect(mockProcessReview).toHaveBeenCalledTimes(1);
    const firstSql = mockSql.mock.calls[0]?.[0] as TemplateStringsArray | undefined;
    const firstSqlText = firstSql?.join('?') ?? '';
    expect(firstSqlText).toContain('run_reason');
    expect(firstSqlText).toContain('ON CONFLICT (correlation_id)');

    // #673 locked decision 5 (reactivation branch): DEFAULT 0 owns the
    // collapsed counters — the explicit-zero column list stays legacy-only.
    const reactivationInsert = mockSql.mock.calls.find((call: any[]) => {
      const template = call[0];
      return Array.isArray(template) &&
        template.some((s: string) => s.includes('INSERT INTO zernio_backfill_runs'));
    });
    expect(reactivationInsert).toBeDefined();
    const reactivationJoined = (reactivationInsert![0] as readonly string[]).join('?');
    expect(reactivationJoined).not.toContain('imported_count');
    // Standalone-identifier match, NOT a bare substring check: this branch
    // legitimately names the legacy gap_skipped_count/historical_skipped_count
    // columns, which CONTAIN 'skipped_count' — reject the collapsed column
    // only when it appears unprefixed (deviation D5).
    expect(reactivationJoined).not.toMatch(/(?<![A-Za-z0-9_])skipped_count/);
  });

  // Archived-location guard (mirrors the ingest worker's skip-as-success):
  // archived locations keep status='active' connections for reactivation, so
  // a queued backfill for an archived location must complete WITHOUT walking
  // listAllReviews — never fail or burn a retry. The row is also marked
  // cancelled to pin the archived-before-subscription ordering: the exit must
  // be the queryable archived path, not the silent subscription skip.
  it('archived location: skip-as-success — listAllReviews never called, structured log, outbox completed', async () => {
    // 1. INSERT zernio_backfill_runs (no result needed)
    sqlReturnQueue.push(mkTaggedResult([]));
    // 2. SELECT run row (not yet completed)
    sqlReturnQueue.push(mkTaggedResult([{ id: 'run-1', completed_at: null }]));
    // 3. SELECT business — archived AND cancelled
    sqlReturnQueue.push(mkTaggedResult([{
      subscription_status: 'cancelled',
      past_due_at: null,
      account_flags: {},
      archived_at: '2026-06-01T00:00:00Z',
    }]));

    await handleZernioBackfill(sqlArg, makeJob());

    expect(mockListAllReviews).not.toHaveBeenCalled();
    expect(mockProcessReview).not.toHaveBeenCalled();
    expect(mockReconcileExternallyAnsweredReview).not.toHaveBeenCalled();
    expect(mockLogger.log).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({ reason: SKIP_REASON_ARCHIVED_LOCATION, business_id: 'biz-1' }),
    );
    expect(mockMarkOutboxCompleted).toHaveBeenCalledWith(sqlArg, 'outbox-backfill-1', undefined);

    // completed_at must NOT be stamped — un-archiving re-enters the same
    // zernio_backfill_runs row idempotently (same rule as the subscription skip).
    const completedAtUpdateCall = mockSql.mock.calls.find((call: any[]) => {
      const template = call[0];
      return Array.isArray(template) &&
        template.some((s: string) => s.includes('completed_at = NOW()')) &&
        template.some((s: string) => s.includes('zernio_backfill_runs'));
    });
    expect(completedAtUpdateCall).toBeUndefined();
  });

  // Row-missing guard: the shared eligibility gate checks "no businesses⋈
  // accounts row" BEFORE reading archived_at, and the backfill lane keeps its
  // historical subscription_status=missing skip line.
  it('missing business/account row: skip-as-success with subscription_status=missing log', async () => {
    // 1. INSERT zernio_backfill_runs (no result needed)
    sqlReturnQueue.push(mkTaggedResult([]));
    // 2. SELECT run row (not yet completed)
    sqlReturnQueue.push(mkTaggedResult([{ id: 'run-1', completed_at: null }]));
    // 3. SELECT business → no row
    sqlReturnQueue.push(mkTaggedResult([]));

    await handleZernioBackfill(sqlArg, makeJob());

    expect(mockListAllReviews).not.toHaveBeenCalled();
    expect(mockProcessReview).not.toHaveBeenCalled();
    expect(mockLogger.log).toHaveBeenCalledWith(
      expect.stringContaining('subscription_status=missing'),
    );
    expect(mockMarkOutboxCompleted).toHaveBeenCalledWith(sqlArg, 'outbox-backfill-1', undefined);
  });

  // Historical replies are a non-autonomy feature available to Copilot.
  it('Copilot processes historical reviews up to the historical cap', async () => {
    pushStandardSqlSetup();
    pushCountsUpdate();
    pushCompletedUpdate();

    // 3 reviews all before activated_at (historical)
    const reviews = Array.from({ length: 3 }, (_, i) =>
      makeReview(`rev-hist-${i}`, ACTIVATED_MS - (i + 1) * 3_600_000),
    );
    mockListAllReviews.mockResolvedValueOnce(reviews);

    await handleZernioBackfill(sqlArg, makeJob({ subscription_tier: 'copilot' }));

    expect(mockProcessReview).toHaveBeenCalledTimes(3);
    for (const call of mockProcessReview.mock.calls) {
      expect(call[4]).toMatchObject({ suppressNotification: true });
    }
    expect(mockMarkOutboxCompleted).toHaveBeenCalledWith(sqlArg, 'outbox-backfill-1', undefined);

    // Verify counts update call — the 3rd SQL call after insert + select_run + select_biz is counts update
    const sqlCalls = mockSql.mock.calls;
    // Find the UPDATE counts call (has gap_processed_count in query)
    const countsCallStrings = sqlCalls.find((call: any[]) => {
      const template = call[0];
      return Array.isArray(template) && template.some((s: string) => s.includes('gap_processed_count'));
    });
    expect(countsCallStrings).toBeDefined();
    expect(countsCallStrings!.slice(1)).toEqual([0, 3, 0, 0, null, 'run-1']);
  });

  // Autopilot receives the same non-autonomy backfill capability.
  it('Autopilot processes historical reviews up to cap=50', async () => {
    pushStandardSqlSetup();
    pushCountsUpdate();
    pushCompletedUpdate();

    // 10 historical reviews (all before activated_at)
    const reviews = Array.from({ length: 10 }, (_, i) =>
      makeReview(`rev-hist-${i}`, ACTIVATED_MS - (i + 1) * 3_600_000),
    );
    mockListAllReviews.mockResolvedValueOnce(reviews);

    await handleZernioBackfill(sqlArg, makeJob({ subscription_tier: 'autopilot' }));

    // All 10 should be processed (under cap of 50)
    expect(mockProcessReview).toHaveBeenCalledTimes(10);
    for (const call of mockProcessReview.mock.calls) {
      expect(call[4]).toMatchObject({ suppressNotification: true });
    }
    expect(mockMarkOutboxCompleted).toHaveBeenCalledWith(sqlArg, 'outbox-backfill-1', undefined);
  });

  // Mixed 30 gap + 30 historical on Autopilot → gap=25, historical=30.
  it('mixed Autopilot backfill caps gap at 25 and processes 30 historical reviews', async () => {
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

    await handleZernioBackfill(sqlArg, makeJob({ subscription_tier: 'autopilot' }));

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
    const values = countsCall!.slice(1); // skip the template strings array
    expect(values).toContain(25); // gap processed
    expect(values).toContain(30); // historical processed
    expect(values).toContain(5);  // gap skipped
    expect(values).toContain(0);  // historical skipped

    expect(mockMarkOutboxCompleted).toHaveBeenCalledWith(sqlArg, 'outbox-backfill-1', undefined);
  });

  // #673 dual-write transition (spec §8a R4): the collapsed counters ride the
  // same UPDATE as the legacy four until #680 drops the legacy set.
  it.each([
    { gapTotal: 28, histTotal: 52, expected: [25, 50, 3, 2, 75, 5] },
    { gapTotal: 27, histTotal: 51, expected: [25, 50, 2, 1, 75, 3] },
  ])(
    'counters UPDATE dual-writes imported_count and skipped_count as sums of the gap and historical counters (gap=$gapTotal hist=$histTotal)',
    async ({ gapTotal, histTotal, expected }) => {
      pushStandardSqlSetup();
      pushCountsUpdate();
      pushCompletedUpdate();

      // gapTotal gap reviews (after activation; GAP_CAP=25) + histTotal
      // historical (before activation; HISTORICAL_CAP=50).
      const reviews = [
        ...Array.from({ length: gapTotal }, (_, i) => makeReview(`rev-gap-${i}`, ACTIVATED_MS + (i + 1) * 60_000)),
        ...Array.from({ length: histTotal }, (_, i) => makeReview(`rev-hist-${i}`, ACTIVATED_MS - (i + 1) * 3_600_000)),
      ];
      mockListAllReviews.mockResolvedValueOnce(reviews);

      await handleZernioBackfill(sqlArg, makeJob({ subscription_tier: 'autopilot' }));

      // Exactly ONE counts UPDATE, exactly the contract template.
      const countsCalls = findCountsCalls();
      expect(countsCalls).toHaveLength(1);
      expect(normalizeTemplate(countsCalls[0]![0])).toBe(DUAL_WRITE_TEMPLATE);
      // Positional: legacy four, collapsed sums, oldestSkipped, runId.
      expect(countsCalls[0]!.slice(1)).toEqual([...expected, expect.anything(), 'run-1']);

      // Locked decision 5 (initial branch): the INSERT does not name the
      // collapsed counters — DEFAULT 0 owns initialization.
      const insertCalls = mockSql.mock.calls.filter((call: any[]) => {
        const template = call[0];
        return Array.isArray(template) &&
          template.some((s: string) => s.includes('INSERT INTO zernio_backfill_runs'));
      });
      expect(insertCalls.length).toBeGreaterThan(0);
      for (const call of insertCalls) {
        const insertJoined = (call[0] as readonly string[]).join('?');
        expect(insertJoined).not.toContain('imported_count');
        expect(insertJoined).not.toContain('skipped_count');
      }
    },
  );

  // Test 5: createTime DESC sort applied BEFORE slice — newest 25 processed, not first 25 returned
  it('sort applied before slice: the 25 newest gap reviews are processed', async () => {
    pushStandardSqlSetup();
    pushCountsUpdate();
    pushCompletedUpdate();

    const processedIds: string[] = [];
    mockProcessReview.mockImplementation(async (_sql: any, monitored: any) => {
      processedIds.push(monitored.identity.providerReviewId);
    });

    // 30 gap reviews. Return them in ASCENDING time order (oldest first).
    // Worker must sort DESC and take first 25 (newest 25).
    const reviews = Array.from({ length: 30 }, (_, i) =>
      makeReview(`gap-${i}`, ACTIVATED_MS + (i + 1) * 60_000), // gap-0 is oldest, gap-29 is newest
    );
    mockListAllReviews.mockResolvedValueOnce(reviews);

    await handleZernioBackfill(sqlArg, makeJob());

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

    await handleZernioBackfill(sqlArg, makeJob());

    expect(mockProcessReview).toHaveBeenCalledTimes(3);
    for (const call of mockProcessReview.mock.calls) {
      // call signature: (sql, monitored, business_id, correlation_id?, options?)
      const options = call[4];
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

    await handleZernioBackfill(sqlArg, makeJob());

    expect(mockProcessReview).toHaveBeenCalledTimes(1);
    expect(mockProcessReview.mock.calls[0]?.[1].identity.providerReviewId).toBe('ordinary-review');
    expect(mockOpenPhiReviewException).toHaveBeenCalledWith(
      mockSql,
      expect.objectContaining({
        businessId: 'biz-1',
        accountId: 'acct-1',
        locationId: 'loc-1',
        review: phiReview,
        source: 'backfill',
        reasons: expect.arrayContaining(['mrn']),
      }),
      expect.anything(),
    );
    const countsCall = mockSql.mock.calls.find((call: any[]) => {
      const template = call[0];
      return Array.isArray(template) && template.some((s: string) => s.includes('gap_processed_count'));
    });
    expect(countsCall?.slice(1)).toContain(1);
    expect(countsCall?.slice(1)).not.toContain(2);
    expect(mockMarkOutboxCompleted).toHaveBeenCalledWith(sqlArg, 'outbox-backfill-1', undefined);
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

    await expect(handleZernioBackfill(sqlArg, makeJob())).rejects.toThrow(
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

    // #673: the dual-write rides the partial-counts UPDATE that precedes the
    // reconcile-failure throw — retries must never persist legacy-only counts.
    const [reconcileCounts] = findCountsCalls();
    expect(reconcileCounts).toBeDefined();
    expect(normalizeTemplate(reconcileCounts![0])).toBe(DUAL_WRITE_TEMPLATE);
    const v = reconcileCounts!.slice(1) as number[];
    expect(v[4]).toBe(v[0]! + v[1]!); // imported = gap + historical processed
    expect(v[5]).toBe(v[2]! + v[3]!); // skipped = gap + historical skipped
  });
});
