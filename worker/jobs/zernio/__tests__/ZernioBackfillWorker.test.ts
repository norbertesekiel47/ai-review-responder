import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fc from 'fast-check';
import type { Job } from 'bullmq';
import type { Sql } from 'postgres';
import { SKIP_REASON_ARCHIVED_LOCATION, type ZernioInitialBackfillPayload } from '../../../../src/lib/shared/worker-types';
import { OUTBOX_COMPLETION_REASON } from '../../../../src/lib/shared/outbox-completion-reason';
import type { ZernioReview } from '../../../../src/lib/zernio/types';
import type { SubscriptionTierValue } from '../../../../src/lib/accounts/tier-config';

// ── Hoisted state shared between mock factories and tests ──────────────
const {
  sqlReturnQueue,
  mockSql,
  sqlCalls,
  resetMockSql,
  mkTaggedResult,
  mockMarkOutboxCompleted,
  mockMarkOutboxCompletedWithReason,
  mockMarkOutboxFailed,
  mockListReviews,
  mockProcessReview,
  mockImportReview,
  mockReconcileExternallyAnsweredReview,
  mockOpenPhiReviewException,
  mockHandleZernioIngestError,
  mockSentryCaptureException,
  mockLogger,
} = await vi.hoisted(async () => {
  const { createMockSql, mkTaggedResult, mockWorkerLogger } =
    await import('../../../__tests__/helpers/mock-sql');

  return {
    // sql.begin is not needed by ZernioBackfillWorker directly (it doesn't
    // call sql.begin itself — importReview and reconcile do, both mocked;
    // the PHI path's sql.begin wrapper invokes the mocked openPhiReviewException).
    ...createMockSql(),
    mkTaggedResult,
    mockMarkOutboxCompleted: vi.fn(),
    // #695: the refusal writer. `guardImportConsent` completes a consent-refused
    // row through THIS one (stamping completion_reason), while every other skip
    // in this worker still uses the plain writer above — keeping them separate
    // mocks is what lets a test name which writer ran.
    mockMarkOutboxCompletedWithReason: vi.fn(),
    mockMarkOutboxFailed: vi.fn(),
    mockListReviews: vi.fn(),
    mockProcessReview: vi.fn(),
    mockImportReview: vi.fn(),
    mockReconcileExternallyAnsweredReview: vi.fn(),
    mockOpenPhiReviewException: vi.fn(),
    mockHandleZernioIngestError: vi.fn(),
    mockSentryCaptureException: vi.fn(),
    mockLogger: mockWorkerLogger(),
  };
});

// ── Module mocks ─────────────────────────────────────────────────────────
vi.mock('../../../../src/lib/db/server', () => ({ sql: mockSql, jsonb: (v: unknown) => v }));
vi.mock('../../../../src/lib/shared/outbox', () => ({
  markOutboxCompleted: mockMarkOutboxCompleted,
  markOutboxCompletedWithReason: mockMarkOutboxCompletedWithReason,
  markOutboxFailed: mockMarkOutboxFailed,
  extractOutboxHandle: (d: any, fallback: string) => ({
    outboxId: (d && typeof d.outbox_id === 'string') ? d.outbox_id : fallback,
    attempt: (d && typeof d.outbox_attempt === 'number') ? d.outbox_attempt : undefined,
  }),
}));
vi.mock('../../../../src/lib/zernio/client', () => ({
  zernioClient: { listReviews: mockListReviews },
}));
vi.mock('../../../../src/lib/reviews/process-review', () => ({
  processReview: mockProcessReview,
  importReview: mockImportReview,
}));
// liveIngestCutoff must stay the REAL implementation (re-exported via
// vi.importActual) so the ZERNIO_RECENT_REVIEW_CONNECT_GRACE_MS config seam
// stays live for this suite — a hard-coded 5-min reimplementation here would
// silently stop covering the import's grace-boundary behavior (Task 2's test
// pins the seam; D7).
vi.mock('../zernio-ingest-shared', async () => {
  const actual = await vi.importActual<typeof import('../zernio-ingest-shared')>(
    '../zernio-ingest-shared',
  );
  return {
    liveIngestCutoff: actual.liveIngestCutoff,
    reconcileExternallyAnsweredReview: mockReconcileExternallyAnsweredReview,
    openPhiReviewException: mockOpenPhiReviewException,
    handleZernioIngestError: mockHandleZernioIngestError,
  };
});
vi.mock('../../../../src/lib/shared/subscription-guard', () => ({
  checkSubscription: (input: { status: string }) => {
    if (input.status === 'active') return { allowed: true };
    return { allowed: false, reason: input.status };
  },
}));
vi.mock('../../../../src/lib/shared/logger', () => ({
  createWorkerLogger: () => mockLogger,
}));
vi.mock('@sentry/node', () => ({
  captureException: mockSentryCaptureException,
  captureMessage: vi.fn(),
}));

import {
  handleZernioBackfill,
  selectImportWindow,
  IMPORT_TARGET_COUNT,
  IMPORT_FLOOR_MONTHS,
} from '../ZernioBackfillWorker';
import { resetWorkerConfigForTests } from '../../../../src/lib/config/worker';

// handleZernioBackfill now takes the injected client as its leading arg;
// mockSql (createMockSql()'s tagged-template mock) doesn't structurally match
// postgres.Sql, so pass a cast view while assertions keep referencing mockSql
// (same runtime object).
const sqlArg = mockSql as unknown as Sql;

// ── Fixtures ─────────────────────────────────────────────────────────────

const ACTIVATED_AT = '2026-04-01T00:00:00Z';

// Frozen "now" for every handler test — the Import window's floor is derived
// from runtime now (12 calendar months back), so fixtures anchor to T_NOW.
const T_NOW = Date.parse('2026-08-05T12:00:00.000Z');
/** The runtime import floor, derived exactly as the handler derives it. */
const IMPORT_FLOOR_RUNTIME_MS = (() => {
  const d = new Date(T_NOW);
  d.setMonth(d.getMonth() - IMPORT_FLOOR_MONTHS);
  return d.getTime();
})();
const CONNECTED_MS = T_NOW - 60 * 60_000; // connected one hour before T_NOW
const DEFAULT_GRACE_MS = 5 * 60_000;
/** Live-ingest cutoff under the DEFAULT 5-min grace (no env override). */
const CUTOFF_MS = CONNECTED_MS - DEFAULT_GRACE_MS;
/** In-window createTime, newest at i=0, spaced one minute below the cutoff. */
const inWindowMs = (i: number) => CUTOFF_MS - 60_000 * (i + 1);
const BELOW_FLOOR_MS = IMPORT_FLOOR_RUNTIME_MS - 86_400_000;

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

function page(reviews: ZernioReview[], nextPageToken?: string) {
  return { reviews, nextPageToken };
}

/** The derived Import consent state the guard's SELECT returns (#679). */
type ImportConsentFixture = 'accepted' | 'declined' | 'pending' | 'expired' | 'missing';

/**
 * Queue the consent gate's one read. 'missing' = no businesses row at all.
 *
 * ALWAYS queues, unconditionally. T0 carried a self-disabling shim here (skip
 * the push until `guardImportConsent` was exported) so the 35 pre-existing
 * tests would not go red from FIFO desync during the eval commit; T4 wired the
 * gate in and deleted it. Do not reintroduce a feature-detect guard: it
 * degrades SILENTLY on any rename of `guardImportConsent` — the fixture would
 * stop queuing consent results and a real regression would read as green.
 */
function pushImportConsentState(state: ImportConsentFixture) {
  sqlReturnQueue.push(mkTaggedResult(state === 'missing' ? [] : [{ state }]));
}

/** Push the 5 standard SQL results for a run that proceeds to the fetch:
 *  1. SELECT businesses (Import consent gate, #679) → 'accepted'
 *  2. INSERT zernio_backfill_runs (ON CONFLICT DO NOTHING → no rows)
 *  3. SELECT run row → not yet completed
 *  4. SELECT businesses⋈accounts (eligibility gate) → active
 *  5. SELECT zernio_connections → connected_at row
 *  Counts/completed UPDATE results are not queued — the mock yields [] on an
 *  empty queue, which is what an UPDATE returns anyway.
 *
 *  The consent read is FIRST because the fail-closed gate runs before the
 *  zernio_backfill_runs INSERT (#679 T4): a refused run must leave no durable
 *  trace at all. `importDecision` varies the derived state — 'missing' queues
 *  no row, i.e. the businesses row does not exist.
 */
function pushImportSqlSetup(opts: {
  runId?: string;
  connectedAt?: Date | null;
  noConnection?: boolean;
  importDecision?: 'accepted' | 'declined' | 'pending' | 'expired' | 'missing';
} = {}) {
  const {
    runId = 'run-1',
    connectedAt = new Date(CONNECTED_MS),
    noConnection = false,
    importDecision = 'accepted',
  } = opts;
  pushImportConsentState(importDecision);
  sqlReturnQueue.push(mkTaggedResult([]));
  sqlReturnQueue.push(mkTaggedResult([{ id: runId, completed_at: null }]));
  sqlReturnQueue.push(mkTaggedResult([{
    subscription_status: 'active',
    past_due_at: null,
    account_flags: {},
    archived_at: null,
  }]));
  sqlReturnQueue.push(mkTaggedResult(noConnection ? [] : [{ connected_at: connectedAt }]));
}

const LEGACY_COUNTER_COLUMNS = [
  'gap_processed_count',
  'historical_processed_count',
  'gap_skipped_count',
  'historical_skipped_count',
] as const;

/** All captured tagged-template texts, values replaced by `?`. */
function sqlTexts(): string[] {
  return mockSql.mock.calls
    .filter((call: any[]) => Array.isArray(call[0]))
    .map((call: any[]) => (call[0] as readonly string[]).join('?'));
}

/** The collapsed-counters UPDATE calls (the only statement naming imported_count). */
function findImportCountsCalls(): any[][] {
  return mockSql.mock.calls.filter((call: any[]) => {
    const template = call[0];
    return Array.isArray(template) && template.some((s: string) => s.includes('imported_count'));
  });
}

function findCompletedAtUpdates(): any[][] {
  return mockSql.mock.calls.filter((call: any[]) => {
    const template = call[0];
    return Array.isArray(template) &&
      template.some((s: string) => s.includes('completed_at = NOW()')) &&
      template.some((s: string) => s.includes('zernio_backfill_runs'));
  });
}

function findBackfillInsertCalls(): any[][] {
  return mockSql.mock.calls.filter((call: any[]) => {
    const template = call[0];
    return Array.isArray(template) &&
      template.some((s: string) => s.includes('INSERT INTO zernio_backfill_runs'));
  });
}

const importedIds = (): string[] =>
  mockImportReview.mock.calls.map((c: any[]) => c[1].identity.providerReviewId as string);
const reconciledIds = (): string[] =>
  mockReconcileExternallyAnsweredReview.mock.calls.map((c: any[]) => (c[1] as ZernioReview).id);

function resetHarnessForNextRun() {
  vi.clearAllMocks();
  resetMockSql();
  mockImportReview.mockResolvedValue('new');
  mockProcessReview.mockResolvedValue(undefined);
  mockReconcileExternallyAnsweredReview.mockResolvedValue(undefined);
  mockHandleZernioIngestError.mockResolvedValue(undefined);
}

// ── Shared setup (both describes) ────────────────────────────────────────

beforeEach(() => {
  resetHarnessForNextRun();
  delete process.env.ZERNIO_IMPORT_MAX_PAGES;
  delete process.env.ZERNIO_RECENT_REVIEW_CONNECT_GRACE_MS;
  // maxPages/grace read the memoized getWorkerConfig(); clear the memo so each
  // test re-parses the current env (tests below set overrides then reset again).
  resetWorkerConfigForTests();
  vi.useFakeTimers({ now: T_NOW });
});

afterEach(() => {
  vi.useRealTimers();
});

// ── Tests ────────────────────────────────────────────────────────────────

describe('ZernioBackfillWorker', () => {
  it('fails closed on an unsupported tier before SQL, provider, or child work', async () => {
    const unsupportedTier = 'retired_tier' as unknown as SubscriptionTierValue;

    await expect(handleZernioBackfill(
      sqlArg,
      makeJob({ subscription_tier: unsupportedTier }),
    )).rejects.toThrow('invalid_ws8_subscription_tier:retired_tier');

    expect(mockSql).not.toHaveBeenCalled();
    expect(sqlReturnQueue).toHaveLength(0);
    expect(mockListReviews).not.toHaveBeenCalled();
    expect(mockImportReview).not.toHaveBeenCalled();
    expect(mockReconcileExternallyAnsweredReview).not.toHaveBeenCalled();
    expect(mockMarkOutboxCompleted).not.toHaveBeenCalled();
  });

  it('reactivation backfill does not skip when an initial backfill completed earlier', async () => {
    pushImportSqlSetup();
    mockListReviews.mockResolvedValueOnce(page([
      makeReview('rev-reactivated', inWindowMs(0)),
    ]));

    await handleZernioBackfill(sqlArg, makeJob({ backfill_reason: 'reactivation' }));

    expect(mockListReviews).toHaveBeenCalled();
    expect(mockImportReview).toHaveBeenCalledTimes(1);
    // The run-claim statement, located by CONTENT rather than by
    // `mockSql.mock.calls[0]` — since #679 the first tagged template the
    // handler builds is the Import consent gate's derived-state fragment, so a
    // positional index no longer names the INSERT (deviation D18).
    const claimSql = findBackfillInsertCalls()[0]?.[0] as TemplateStringsArray | undefined;
    const claimSqlText = claimSql?.join('?') ?? '';
    expect(claimSqlText).toContain('run_reason');
    expect(claimSqlText).toContain('ON CONFLICT (correlation_id)');

    // #675: the reactivation INSERT no longer names ANY counter column —
    // DEFAULT 0 owns all of them (the four legacy ones froze at their
    // defaults when the #673 dual-write contract ended here).
    const [reactivationInsert] = findBackfillInsertCalls();
    expect(reactivationInsert).toBeDefined();
    const reactivationJoined = (reactivationInsert![0] as readonly string[]).join('?');
    expect(reactivationJoined).not.toContain('imported_count');
    // Standalone-identifier match, NOT a bare substring check (deviation D5).
    expect(reactivationJoined).not.toMatch(/(?<![A-Za-z0-9_])skipped_count/);
  });

  // Archived-location guard (mirrors the ingest worker's skip-as-success):
  // archived locations keep status='active' connections for reactivation, so
  // a queued backfill for an archived location must complete WITHOUT walking
  // listReviews — never fail or burn a retry. The row is also marked
  // cancelled to pin the archived-before-subscription ordering: the exit must
  // be the queryable archived path, not the silent subscription skip.
  it('archived location: skip-as-success — listReviews never called, structured log, outbox completed', async () => {
    // 0. SELECT businesses (Import consent gate, #679) → accepted, so the run
    //    reaches the archived guard rather than exiting one gate earlier.
    pushImportConsentState('accepted');
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

    expect(mockListReviews).not.toHaveBeenCalled();
    expect(mockImportReview).not.toHaveBeenCalled();
    expect(mockReconcileExternallyAnsweredReview).not.toHaveBeenCalled();
    expect(mockLogger.log).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({ reason: SKIP_REASON_ARCHIVED_LOCATION, business_id: 'biz-1' }),
    );
    expect(mockMarkOutboxCompleted).toHaveBeenCalledWith(sqlArg, 'outbox-backfill-1', undefined);

    // completed_at must NOT be stamped — un-archiving re-enters the same
    // zernio_backfill_runs row idempotently (same rule as the subscription skip).
    expect(findCompletedAtUpdates()).toHaveLength(0);
  });

  // Row-missing guard, REWRITTEN for #679. With the fail-closed consent gate
  // running FIRST, a missing `businesses` row is intercepted there and
  // `guardZernioJobEligibility`'s backfill-only `subscription_status=missing`
  // line becomes unreachable for this worker. That is deliberate — the
  // fail-closed reason is the more accurate one — so the test asserts the new
  // authority rather than a branch that can no longer fire.
  it('handleZernioBackfill blocks a missing business row before the subscription_status=missing skip line', async () => {
    // The consent gate's SELECT finds no row → fail closed. Nothing else is
    // queued: no INSERT, no run SELECT, no eligibility SELECT should run.
    pushImportConsentState('missing');

    await handleZernioBackfill(sqlArg, makeJob());

    expect(mockListReviews).not.toHaveBeenCalled();
    expect(mockImportReview).not.toHaveBeenCalled();
    expect(findBackfillInsertCalls()).toHaveLength(0);
    expect(mockLogger.log).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({ reason: 'missing', business_id: 'biz-1' }),
    );
    // The old skip line is now dead for the backfill lane. Asserting its
    // ABSENCE is what stops a later edit from re-ordering the guards and
    // quietly reopening the consent hole while the test still passed.
    for (const call of mockLogger.log.mock.calls) {
      expect(String(call[0])).not.toContain('subscription_status=missing');
    }
    // #695: the refusal is completed through the REASON writer. Naming it (and
    // asserting the plain writer stayed silent) is the second half of the same
    // claim the log loop above makes — the eligibility gate's plain-completion
    // skip never ran, the consent guard owned this row.
    expect(mockMarkOutboxCompletedWithReason).toHaveBeenCalledWith(
      sqlArg, 'outbox-backfill-1', OUTBOX_COMPLETION_REASON.IMPORT_CONSENT_BLOCKED, undefined,
    );
    expect(mockMarkOutboxCompleted).not.toHaveBeenCalled();
  });

  // Reconcile failure → partial counts written, completed_at NOT set, worker
  // throws so BullMQ retries (idempotent: importReview ON CONFLICT +
  // supersession idempotency).
  it('reconcile failure: counts written but completed_at not set, worker throws', async () => {
    pushImportSqlSetup();

    const answeredReview1 = makeReview('answered-1', inWindowMs(0), true);
    const answeredReview2 = makeReview('answered-2', inWindowMs(1), true);
    mockListReviews.mockResolvedValueOnce(page([answeredReview1, answeredReview2]));

    // First reconcile succeeds, second fails
    mockReconcileExternallyAnsweredReview
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(new Error('DB timeout'));

    await expect(handleZernioBackfill(sqlArg, makeJob())).rejects.toThrow(
      'Import reconciliation failed for 1 review(s)',
    );

    expect(mockMarkOutboxCompleted).not.toHaveBeenCalled();

    // Partial counts SHOULD have been written before the throw: only the
    // successful reconcile counts imported.
    const [countsCall] = findImportCountsCalls();
    expect(countsCall).toBeDefined();
    expect(countsCall!.slice(1)).toEqual([1, 0, null, 'run-1']);

    // The completed_at = NOW() update must NOT have run.
    expect(findCompletedAtUpdates()).toHaveLength(0);
  });
});

// ── #675 consented-import selection ──────────────────────────────────────
// Titles are the intake's tests_to_add VERBATIM (promised-tests gate).

const IMPORT_WINDOW_FLOOR = Date.parse('2025-08-05T00:00:00Z');
const IMPORT_WINDOW_CUTOFF = Date.parse('2026-08-01T00:00:00Z');

// createTimes from well before the floor to well after the cutoff, so the
// property test exercises the below-floor / in-window / at-or-after-cutoff
// partition on every run.
const arbReview = fc
  .record({
    id: fc.uuid(),
    t: fc.integer({
      min: IMPORT_WINDOW_FLOOR - 400 * 86_400_000,
      max: IMPORT_WINDOW_CUTOFF + 30 * 86_400_000,
    }),
  })
  .map(({ id, t }) => makeReview(id, t));

describe('consented import selection (#675)', () => {
  it('imports newest 100 reviews within the 12-month floor, answered and unanswered alike', async () => {
    pushImportSqlSetup();

    // 120 in-window reviews (every 3rd answered) + 10 older than the floor.
    const inWindow = Array.from({ length: 120 }, (_, i) =>
      makeReview(`r-${i}`, inWindowMs(i), i % 3 === 0),
    );
    const belowFloor = Array.from({ length: 10 }, (_, i) =>
      makeReview(`old-${i}`, BELOW_FLOOR_MS - i * 60_000),
    );
    mockListReviews.mockResolvedValueOnce(page([...inWindow, ...belowFloor]));

    await handleZernioBackfill(sqlArg, makeJob());

    // Selected = the newest 100 (i = 0..99); answered → reconcile with the
    // consented-lane opt, unanswered → importReview. Nothing below the floor,
    // nothing from the in-window overflow (i = 100..119).
    const expectedAnswered = Array.from({ length: 100 }, (_, i) => i)
      .filter((i) => i % 3 === 0).map((i) => `r-${i}`);
    const expectedUnanswered = Array.from({ length: 100 }, (_, i) => i)
      .filter((i) => i % 3 !== 0).map((i) => `r-${i}`);

    expect(importedIds().sort()).toEqual([...expectedUnanswered].sort());
    expect(reconciledIds().sort()).toEqual([...expectedAnswered].sort());
    for (const call of mockReconcileExternallyAnsweredReview.mock.calls) {
      expect(call[6]).toEqual({ consentedImport: true });
    }
    expect(importedIds().length + reconciledIds().length).toBe(IMPORT_TARGET_COUNT);
    expect(mockMarkOutboxCompleted).toHaveBeenCalledWith(sqlArg, 'outbox-backfill-1', undefined);
  });

  it('excludes reviews at or after connected_at minus grace from the import selection (live-lane ownership)', async () => {
    // Configured 120s grace — the REAL liveIngestCutoff honors it (Task 2
    // pins the config seam; this proves the import half of complementarity).
    process.env.ZERNIO_RECENT_REVIEW_CONNECT_GRACE_MS = '120000';
    resetWorkerConfigForTests();

    const T_CONN = T_NOW - 10 * 60_000;
    pushImportSqlSetup({ connectedAt: new Date(T_CONN) });

    mockListReviews.mockResolvedValueOnce(page([
      makeReview('at-connect', T_CONN),
      makeReview('at-cutoff', T_CONN - 120_000), // exactly the cutoff → live lane owns it
      makeReview('just-below-cutoff', T_CONN - 120_000 - 1), // import owns it
      makeReview('old-in-window', IMPORT_FLOOR_RUNTIME_MS + 86_400_000),
    ]));

    await handleZernioBackfill(sqlArg, makeJob());

    expect(importedIds().sort()).toEqual(['just-below-cutoff', 'old-in-window'].sort());
    expect(mockMarkOutboxCompleted).toHaveBeenCalled();
  });

  it('imports nothing and completes successfully when the window is empty', async () => {
    pushImportSqlSetup();
    mockListReviews.mockResolvedValueOnce(page([
      makeReview('old-0', BELOW_FLOOR_MS),
      makeReview('old-1', BELOW_FLOOR_MS - 60_000),
      makeReview('old-2', BELOW_FLOOR_MS - 120_000),
    ]));

    await handleZernioBackfill(sqlArg, makeJob());

    expect(mockImportReview).not.toHaveBeenCalled();
    expect(mockReconcileExternallyAnsweredReview).not.toHaveBeenCalled();
    const [countsCall] = findImportCountsCalls();
    expect(countsCall!.slice(1)).toEqual([0, 0, null, 'run-1']);
    expect(findCompletedAtUpdates()).toHaveLength(1);
    expect(mockMarkOutboxFailed).not.toHaveBeenCalled();
    expect(mockMarkOutboxCompleted).toHaveBeenCalledWith(sqlArg, 'outbox-backfill-1', undefined);
  });

  it('stores answered reviews as list rows with their posted response regardless of EXTERNAL_REPLY_IMPORT_ENABLED', async () => {
    // Flag unset/false — the consented lane must not depend on it.
    delete process.env.EXTERNAL_REPLY_IMPORT_ENABLED;
    pushImportSqlSetup();

    const answered = makeReview('answered-flag-off', inWindowMs(0), true);
    mockListReviews.mockResolvedValueOnce(page([answered]));

    await handleZernioBackfill(sqlArg, makeJob());

    expect(mockReconcileExternallyAnsweredReview).toHaveBeenCalledTimes(1);
    const call = mockReconcileExternallyAnsweredReview.mock.calls[0]!;
    expect((call[1] as ZernioReview).id).toBe('answered-flag-off');
    expect(call[2]).toBe('biz-1');
    expect(call[6]).toEqual({ consentedImport: true });
    expect(mockMarkOutboxCompleted).toHaveBeenCalled();
  });

  it('enqueues no generate_response and writes no job_outbox row for imported reviews', async () => {
    pushImportSqlSetup();
    mockListReviews.mockResolvedValueOnce(page([
      makeReview('u-0', inWindowMs(0)),
      makeReview('u-1', inWindowMs(1)),
      makeReview('a-0', inWindowMs(2), true),
    ]));

    await handleZernioBackfill(sqlArg, makeJob());

    expect(mockProcessReview).not.toHaveBeenCalled();
    for (const text of sqlTexts()) {
      expect(text).not.toContain('INSERT INTO job_outbox');
    }
    expect(mockImportReview).toHaveBeenCalledTimes(2);
    expect(mockMarkOutboxCompleted).toHaveBeenCalled();
  });

  it('pages until the target is met and stops early at the 12-month floor when ordering is clean', async () => {
    // Case A: two clean pages of 50 in-window each → target met after page 2,
    // even though a nextPageToken is still available.
    pushImportSqlSetup();
    mockListReviews
      .mockResolvedValueOnce(page(
        Array.from({ length: 50 }, (_, i) => makeReview(`p1-${i}`, inWindowMs(i))), 'tok-2',
      ))
      .mockResolvedValueOnce(page(
        Array.from({ length: 50 }, (_, i) => makeReview(`p2-${i}`, inWindowMs(50 + i))), 'tok-3',
      ));

    await handleZernioBackfill(sqlArg, makeJob());

    expect(mockListReviews).toHaveBeenCalledTimes(2);
    expect(mockImportReview).toHaveBeenCalledTimes(100);
    expect(mockMarkOutboxFailed).not.toHaveBeenCalled();
    expect(mockMarkOutboxCompleted).toHaveBeenCalled();

    // Case B: page 1 descends past the floor with a token still set → the
    // clean-ordering floor stop ends paging after ONE call.
    resetHarnessForNextRun();
    pushImportSqlSetup();
    mockListReviews.mockResolvedValueOnce(page([
      makeReview('in-0', inWindowMs(0)),
      makeReview('in-1', inWindowMs(1)),
      makeReview('below-0', BELOW_FLOOR_MS),
      makeReview('below-1', BELOW_FLOOR_MS - 60_000),
    ], 'tok-2'));

    await handleZernioBackfill(sqlArg, makeJob());

    expect(mockListReviews).toHaveBeenCalledTimes(1);
    expect(importedIds().sort()).toEqual(['in-0', 'in-1']);
    expect(mockMarkOutboxFailed).not.toHaveBeenCalled();
    expect(mockMarkOutboxCompleted).toHaveBeenCalled();
  });

  it('fails the outbox row terminally with ZernioImportPaginationCapExhaustedError and leaves completed_at NULL on cap exhaustion', async () => {
    process.env.ZERNIO_IMPORT_MAX_PAGES = '2';
    resetWorkerConfigForTests();
    pushImportSqlSetup();

    // Every page 50 out-of-window (post-cutoff) reviews with a token still set.
    const postCutoff = (i: number) => makeReview(`post-${i}`, T_NOW - 1000 - 30_000 * i);
    mockListReviews
      .mockResolvedValueOnce(page(Array.from({ length: 50 }, (_, i) => postCutoff(i)), 'tok-2'))
      .mockResolvedValueOnce(page(Array.from({ length: 50 }, (_, i) => postCutoff(50 + i)), 'tok-3'));

    // TERMINAL but not thrown: the handler resolves.
    await handleZernioBackfill(sqlArg, makeJob());

    expect(mockListReviews).toHaveBeenCalledTimes(2);
    expect(mockMarkOutboxFailed).toHaveBeenCalledTimes(1);
    const [failedSql, failedOutboxId, failedMsg, failedAttempt] = mockMarkOutboxFailed.mock.calls[0]!;
    expect(failedSql).toBe(mockSql);
    expect(failedOutboxId).toBe('outbox-backfill-1');
    expect(failedMsg).toContain('ZernioImportPaginationCapExhaustedError');
    expect(failedMsg).toContain('cap=2');
    expect(failedAttempt).toBeUndefined();
    expect(mockSentryCaptureException).toHaveBeenCalledWith(
      expect.objectContaining({ name: 'ZernioImportPaginationCapExhaustedError' }),
    );
    expect(findCompletedAtUpdates()).toHaveLength(0);
    expect(mockMarkOutboxCompleted).not.toHaveBeenCalled();
    expect(mockImportReview).not.toHaveBeenCalled();
  });

  it('logs a non-descending page order warning and disables early stops for that run', async () => {
    pushImportSqlSetup();

    // Ascending step (in-2 is NEWER than in-1) + oldest item below the floor
    // + token set: clean mode would floor-stop after page 1; dirty mode pages on.
    mockListReviews
      .mockResolvedValueOnce(page([
        makeReview('in-0', inWindowMs(5)),
        makeReview('in-1', inWindowMs(6)),
        makeReview('in-2', inWindowMs(2)), // inversion
        makeReview('below-0', BELOW_FLOOR_MS),
      ], 'tok-2'))
      .mockResolvedValueOnce(page([
        makeReview('below-1', BELOW_FLOOR_MS - 60_000),
      ]));

    await handleZernioBackfill(sqlArg, makeJob());

    expect(mockLogger.warn).toHaveBeenCalledWith(expect.stringContaining('non-descending'));
    expect(mockListReviews).toHaveBeenCalledTimes(2); // floor stop was disabled
    expect(importedIds().sort()).toEqual(['in-0', 'in-1', 'in-2']);
    expect(mockMarkOutboxCompleted).toHaveBeenCalled();
  });

  it('continues paging to feed end or cap when ordering is dirty instead of stopping at the target', async () => {
    pushImportSqlSetup();

    // Page 1: 100 in-window with an inversion (dirty). Page 2 holds 20 NEWER
    // reviews — stopping at the target on page 1 would select the wrong 100.
    const page1 = [
      makeReview('p1-1', inWindowMs(1)),
      makeReview('p1-0', inWindowMs(0)), // inversion: newer than its predecessor
      ...Array.from({ length: 98 }, (_, i) => makeReview(`p1-${i + 2}`, inWindowMs(i + 2))),
    ];
    const page2 = Array.from({ length: 20 }, (_, i) =>
      makeReview(`p2-${i}`, CUTOFF_MS - 30_000 - i * 100), // newer than every page-1 review
    );
    mockListReviews
      .mockResolvedValueOnce(page(page1, 'tok-2'))
      .mockResolvedValueOnce(page(page2));

    await handleZernioBackfill(sqlArg, makeJob());

    expect(mockListReviews).toHaveBeenCalledTimes(2);
    const ids = importedIds();
    expect(ids).toHaveLength(100);
    // All 20 newer page-2 reviews made the selection…
    for (let i = 0; i < 20; i++) expect(ids).toContain(`p2-${i}`);
    // …displacing the 20 oldest page-1 reviews.
    for (let i = 80; i < 100; i++) expect(ids).not.toContain(`p1-${i}`);
    expect(mockMarkOutboxCompleted).toHaveBeenCalled();
  });

  it('writes only imported_count and skipped_count; legacy counters stay at their defaults', async () => {
    pushImportSqlSetup();
    mockListReviews.mockResolvedValueOnce(page([
      makeReview('u-0', inWindowMs(0)),
      makeReview('u-1', inWindowMs(1)),
    ]));

    await handleZernioBackfill(sqlArg, makeJob());

    const countsCalls = findImportCountsCalls();
    expect(countsCalls).toHaveLength(1);
    const countsText = (countsCalls[0]![0] as readonly string[]).join('?');
    expect(countsText).toContain('imported_count');
    expect(countsText).toContain('skipped_count');
    expect(countsCalls[0]!.slice(1)).toEqual([2, 0, null, 'run-1']);
    // No statement in the whole run may touch a legacy counter column.
    for (const text of sqlTexts()) {
      for (const legacy of LEGACY_COUNTER_COLUMNS) {
        expect(text).not.toContain(legacy);
      }
    }
  });

  it('counts PHI and malformed reviews as skipped and already-ingested rows as imported', async () => {
    pushImportSqlSetup();

    const phiReview = makeReview('phi-review', inWindowMs(0));
    phiReview.comment = 'Patient MRN 12345 needs diabetes treatment follow up';
    const malformedReview = makeReview('malformed-review', inWindowMs(1));
    malformedReview.rating = 0; // real buildZernioMonitoredReview throws on it
    const unchangedReview = makeReview('unchanged-review', inWindowMs(2));
    mockImportReview.mockResolvedValueOnce('unchanged');
    mockListReviews.mockResolvedValueOnce(page([phiReview, malformedReview, unchangedReview]));

    await handleZernioBackfill(sqlArg, makeJob());

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
    expect(importedIds()).toEqual(['unchanged-review']);
    // imported = 1 ('unchanged' still counts imported); skipped = 2 (PHI + malformed)
    const [countsCall] = findImportCountsCalls();
    expect(countsCall!.slice(1)).toEqual([1, 2, null, 'run-1']);
    expect(mockMarkOutboxCompleted).toHaveBeenCalled();
  });

  it('routes answered PHI reviews through reconciliation and counts them imported', async () => {
    pushImportSqlSetup();

    const answeredPhi = makeReview('answered-phi', inWindowMs(0), true);
    answeredPhi.comment = 'Patient MRN 12345 needs diabetes treatment follow up';
    mockListReviews.mockResolvedValueOnce(page([answeredPhi]));

    await handleZernioBackfill(sqlArg, makeJob());

    // No worker-side pre-screen for answered reviews — reconcile owns PHI on
    // its import branches; the exception row there is the audit trail.
    expect(mockReconcileExternallyAnsweredReview).toHaveBeenCalledTimes(1);
    expect((mockReconcileExternallyAnsweredReview.mock.calls[0]![1] as ZernioReview).id).toBe('answered-phi');
    expect(mockOpenPhiReviewException).not.toHaveBeenCalled();
    const [countsCall] = findImportCountsCalls();
    expect(countsCall!.slice(1)).toEqual([1, 0, null, 'run-1']);
    expect(mockMarkOutboxCompleted).toHaveBeenCalled();
  });

  it('skips as success when no active connection row exists, leaving completed_at NULL', async () => {
    pushImportSqlSetup({ noConnection: true });

    await handleZernioBackfill(sqlArg, makeJob());

    expect(mockListReviews).not.toHaveBeenCalled();
    expect(mockLogger.warn).toHaveBeenCalledWith(expect.stringContaining('No active connection'));
    expect(findCompletedAtUpdates()).toHaveLength(0);
    expect(mockMarkOutboxCompleted).toHaveBeenCalledWith(sqlArg, 'outbox-backfill-1', undefined);
  });

  it('applies no upper cutoff when connected_at is NULL', async () => {
    pushImportSqlSetup({ connectedAt: null });

    mockListReviews.mockResolvedValueOnce(page([
      makeReview('very-recent', T_NOW - 1000), // would be post-cutoff under any connected_at
      makeReview('year-old', IMPORT_FLOOR_RUNTIME_MS + 86_400_000),
    ]));

    await handleZernioBackfill(sqlArg, makeJob());

    expect(importedIds().sort()).toEqual(['very-recent', 'year-old'].sort());
    expect(mockMarkOutboxCompleted).toHaveBeenCalled();
  });

  it('property: selection is always within the Import window and never exceeds 100 rows', () => {
    fc.assert(
      fc.property(fc.array(arbReview, { maxLength: 300 }), (reviews) => {
        const { selected, capOverflow } = selectImportWindow(reviews, {
          floorMs: IMPORT_WINDOW_FLOOR,
          upperCutoffMs: IMPORT_WINDOW_CUTOFF,
        });
        // Partition completeness (plan-review r1): selected + capOverflow is
        // EXACTLY the in-window input multiset — no silent omissions — and
        // selected takes min(100, available).
        const inWindowIds = reviews
          .filter((z) => {
            const t = new Date(z.createTime).getTime();
            return Number.isFinite(t) && t >= IMPORT_WINDOW_FLOOR && t < IMPORT_WINDOW_CUTOFF;
          })
          .map((z) => z.id)
          .sort();
        const returnedIds = [...selected, ...capOverflow].map((z) => z.id).sort();
        expect(returnedIds).toEqual(inWindowIds);
        expect(selected.length).toBe(Math.min(IMPORT_TARGET_COUNT, inWindowIds.length));
        for (const z of [...selected, ...capOverflow]) {
          const t = new Date(z.createTime).getTime();
          expect(t).toBeGreaterThanOrEqual(IMPORT_WINDOW_FLOOR);
          expect(t).toBeLessThan(IMPORT_WINDOW_CUTOFF);
        }
        // selected is the NEWEST in-window slice: nothing in capOverflow is newer
        const oldestSelected = Math.min(...selected.map((z) => new Date(z.createTime).getTime()));
        for (const z of capOverflow) {
          expect(new Date(z.createTime).getTime()).toBeLessThanOrEqual(oldestSelected);
        }
      }),
    );
  });

  it('createTime exactly at the floor is included', () => {
    const atFloor = makeReview('rev-floor', IMPORT_WINDOW_FLOOR);
    const { selected, capOverflow } = selectImportWindow([atFloor], {
      floorMs: IMPORT_WINDOW_FLOOR,
      upperCutoffMs: IMPORT_WINDOW_CUTOFF,
    });
    expect(selected.map((z) => z.id)).toEqual(['rev-floor']);
    expect(capOverflow).toHaveLength(0);
  });

  it('createTime exactly at the cutoff is excluded (upper bound is exclusive)', () => {
    const atCutoff = makeReview('rev-cutoff', IMPORT_WINDOW_CUTOFF);
    const { selected, capOverflow } = selectImportWindow([atCutoff], {
      floorMs: IMPORT_WINDOW_FLOOR,
      upperCutoffMs: IMPORT_WINDOW_CUTOFF,
    });
    expect(selected).toHaveLength(0);
    expect(capOverflow).toHaveLength(0);
  });

  it('applies no upper cutoff when upperCutoffMs is null (connected_at-null case)', () => {
    const farFuture = makeReview('rev-far-future', IMPORT_WINDOW_CUTOFF + 10 * 365 * 86_400_000);
    const { selected, capOverflow } = selectImportWindow([farFuture], {
      floorMs: IMPORT_WINDOW_FLOOR,
      upperCutoffMs: null,
    });
    expect(selected.map((z) => z.id)).toEqual(['rev-far-future']);
    expect(capOverflow).toHaveLength(0);
  });

  it('marks the outbox completed only after the run completion write succeeds', async () => {
    pushImportSqlSetup();
    mockListReviews.mockResolvedValueOnce(page([makeReview('u-0', inWindowMs(0))]));
    // Counts UPDATE succeeds…
    sqlReturnQueue.push(mkTaggedResult([]));
    // …then the completed_at = NOW() UPDATE rejects.
    const completionFailure = Promise.reject(new Error('completion write failed'));
    completionFailure.catch(() => { /* pre-handled: consumed via the queue */ });
    sqlReturnQueue.push(completionFailure);

    await expect(handleZernioBackfill(sqlArg, makeJob())).rejects.toThrow('completion write failed');

    expect(mockMarkOutboxCompleted).not.toHaveBeenCalled();
  });

  it('passes each nextPageToken to the following listReviews request', async () => {
    pushImportSqlSetup();
    mockListReviews
      .mockResolvedValueOnce(page(
        Array.from({ length: 50 }, (_, i) => makeReview(`p1-${i}`, inWindowMs(i))), 'tok-2',
      ))
      .mockResolvedValueOnce(page(
        Array.from({ length: 10 }, (_, i) => makeReview(`p2-${i}`, inWindowMs(50 + i))),
      ));

    await handleZernioBackfill(sqlArg, makeJob());

    expect(mockListReviews).toHaveBeenCalledTimes(2);
    expect(mockListReviews).toHaveBeenNthCalledWith(1, 'acct-1', {
      locationId: 'loc-1',
      pageSize: 50,
      pageToken: undefined,
    });
    expect(mockListReviews).toHaveBeenNthCalledWith(2, 'acct-1', {
      locationId: 'loc-1',
      pageSize: 50,
      pageToken: 'tok-2',
    });
  });

  it('imports the exact globally newest 100 from shuffled multi-page results', async () => {
    pushImportSqlSetup();

    // 150 in-window reviews split odd/even across two pages — the globally
    // newest (r-0) sits on page TWO, so page order alone would mis-select.
    const all = Array.from({ length: 150 }, (_, i) => makeReview(`r-${i}`, inWindowMs(i)));
    const page1 = all.filter((_, i) => i % 2 === 1);
    const page2 = all.filter((_, i) => i % 2 === 0);
    mockListReviews
      .mockResolvedValueOnce(page(page1, 'tok-2'))
      .mockResolvedValueOnce(page(page2));

    await handleZernioBackfill(sqlArg, makeJob());

    const expected = Array.from({ length: 100 }, (_, i) => `r-${i}`).sort();
    expect(importedIds().sort()).toEqual(expected);
    expect(mockMarkOutboxCompleted).toHaveBeenCalled();
  });

  it('imports every available review when the feed ends below 100', async () => {
    pushImportSqlSetup();
    mockListReviews.mockResolvedValueOnce(page(
      Array.from({ length: 37 }, (_, i) => makeReview(`r-${i}`, inWindowMs(i))),
    ));

    await handleZernioBackfill(sqlArg, makeJob());

    expect(mockImportReview).toHaveBeenCalledTimes(37);
    expect(mockMarkOutboxFailed).not.toHaveBeenCalled();
    expect(mockSentryCaptureException).not.toHaveBeenCalled();
    const [countsCall] = findImportCountsCalls();
    expect(countsCall!.slice(1)).toEqual([37, 0, null, 'run-1']);
    expect(mockMarkOutboxCompleted).toHaveBeenCalled();
  });

  it('does not report cap exhaustion when the target is met or a clean floor stop ends paging', async () => {
    // (i) Target met exactly on the capped page, token still set → success.
    process.env.ZERNIO_IMPORT_MAX_PAGES = '2';
    resetWorkerConfigForTests();
    pushImportSqlSetup();
    mockListReviews
      .mockResolvedValueOnce(page(
        Array.from({ length: 50 }, (_, i) => makeReview(`p1-${i}`, inWindowMs(i))), 'tok-2',
      ))
      .mockResolvedValueOnce(page(
        Array.from({ length: 50 }, (_, i) => makeReview(`p2-${i}`, inWindowMs(50 + i))), 'tok-3',
      ));

    await handleZernioBackfill(sqlArg, makeJob());

    expect(mockListReviews).toHaveBeenCalledTimes(2);
    expect(mockMarkOutboxFailed).not.toHaveBeenCalled();
    expect(mockSentryCaptureException).not.toHaveBeenCalled();
    expect(mockMarkOutboxCompleted).toHaveBeenCalled();

    // (ii) Clean floor stop before the cap, token still set → success.
    resetHarnessForNextRun();
    delete process.env.ZERNIO_IMPORT_MAX_PAGES;
    resetWorkerConfigForTests();
    pushImportSqlSetup();
    mockListReviews.mockResolvedValueOnce(page([
      makeReview('in-0', inWindowMs(0)),
      makeReview('below-0', BELOW_FLOOR_MS),
    ], 'tok-2'));

    await handleZernioBackfill(sqlArg, makeJob());

    expect(mockListReviews).toHaveBeenCalledTimes(1);
    expect(mockMarkOutboxFailed).not.toHaveBeenCalled();
    expect(mockSentryCaptureException).not.toHaveBeenCalled();
    expect(mockMarkOutboxCompleted).toHaveBeenCalled();
  });

  it('derives the 12-calendar-month floor at run time and keeps paging at floor equality', async () => {
    pushImportSqlSetup();

    // Page 1's oldest row sits exactly AT the 12-calendar-month floor: the
    // floor is inclusive (row imports) and equality must NOT early-stop
    // (< comparison) — page 2 is still fetched while a token exists.
    mockListReviews
      .mockResolvedValueOnce(page([
        makeReview('newest', inWindowMs(0)),
        makeReview('at-floor', IMPORT_FLOOR_RUNTIME_MS),
      ], 'tok-2'))
      .mockResolvedValueOnce(page([
        makeReview('below-floor', BELOW_FLOOR_MS),
      ]));

    await handleZernioBackfill(sqlArg, makeJob());

    expect(mockListReviews).toHaveBeenCalledTimes(2);
    expect(importedIds().sort()).toEqual(['at-floor', 'newest']);
    expect(mockMarkOutboxCompleted).toHaveBeenCalled();
  });

  it('recomputes the import floor from runtime now on retry', async () => {
    // Attempt 1 at frozen T_NOW: the answered review is in-window; reconcile
    // fails, so the run stays incomplete and BullMQ retries.
    const agingReview = makeReview('aging-review', IMPORT_FLOOR_RUNTIME_MS + 24 * 3_600_000, true);
    pushImportSqlSetup();
    mockListReviews.mockResolvedValueOnce(page([agingReview]));
    mockReconcileExternallyAnsweredReview.mockRejectedValueOnce(new Error('transient db'));

    await expect(handleZernioBackfill(sqlArg, makeJob())).rejects.toThrow(
      'Import reconciliation failed',
    );
    expect(reconciledIds()).toEqual(['aging-review']);

    // Attempt 2 at T_NOW + 48h: the floor is recomputed from the NEW now, the
    // row has aged out, and the selection no longer includes it.
    vi.setSystemTime(T_NOW + 48 * 3_600_000);
    resetHarnessForNextRun();
    pushImportSqlSetup();
    mockListReviews.mockResolvedValueOnce(page([agingReview]));

    await handleZernioBackfill(sqlArg, makeJob());

    expect(mockReconcileExternallyAnsweredReview).not.toHaveBeenCalled();
    expect(mockImportReview).not.toHaveBeenCalled();
    const [countsCall] = findImportCountsCalls();
    expect(countsCall!.slice(1)).toEqual([0, 0, null, 'run-1']);
    expect(mockMarkOutboxCompleted).toHaveBeenCalled();
  });

  it('skips all provider and storage work when the run is already completed', async () => {
    // 0. consent gate → accepted; 1. INSERT (ON CONFLICT no-op);
    // 2. run SELECT → completed sentinel.
    pushImportConsentState('accepted');
    sqlReturnQueue.push(mkTaggedResult([]));
    sqlReturnQueue.push(mkTaggedResult([{ id: 'run-1', completed_at: new Date(T_NOW - 86_400_000) }]));

    await handleZernioBackfill(sqlArg, makeJob());

    expect(mockListReviews).not.toHaveBeenCalled();
    expect(mockImportReview).not.toHaveBeenCalled();
    expect(mockReconcileExternallyAnsweredReview).not.toHaveBeenCalled();
    expect(mockOpenPhiReviewException).not.toHaveBeenCalled();
    expect(findImportCountsCalls()).toHaveLength(0);
    expect(mockMarkOutboxCompleted).toHaveBeenCalledWith(sqlArg, 'outbox-backfill-1', undefined);
  });

  it('reactivation runs use the identical import window and stay correlation-idempotent', async () => {
    const reactivationJob = () => makeJob({
      backfill_reason: 'reactivation',
      correlation_id: 'corr-675',
    } as Partial<ZernioInitialBackfillPayload>);

    // Attempt 1: boundary rows — floor-equal imports, cutoff−1ms imports,
    // cutoff-equal is the live lane's (identical semantics to initial runs).
    pushImportSqlSetup({ runId: 'run-r' });
    mockListReviews.mockResolvedValueOnce(page([
      makeReview('b-at-cutoff', CUTOFF_MS),
      makeReview('b-cutoff-minus-1', CUTOFF_MS - 1),
      makeReview('b-at-floor', IMPORT_FLOOR_RUNTIME_MS),
    ]));

    await handleZernioBackfill(sqlArg, reactivationJob());

    expect(importedIds().sort()).toEqual(['b-at-floor', 'b-cutoff-minus-1']);
    const [insert1] = findBackfillInsertCalls();
    expect((insert1![0] as readonly string[]).join('?')).toContain('ON CONFLICT (correlation_id)');
    expect(mockMarkOutboxCompleted).toHaveBeenCalled();

    // Attempt 2, same correlation_id: the correlation-keyed claim resolves to
    // the SAME (now completed) run row → sentinel skip, no provider work.
    resetHarnessForNextRun();
    pushImportConsentState('accepted');
    sqlReturnQueue.push(mkTaggedResult([]));
    sqlReturnQueue.push(mkTaggedResult([{ id: 'run-r', completed_at: new Date(T_NOW) }]));

    await handleZernioBackfill(sqlArg, reactivationJob());

    const [insert2] = findBackfillInsertCalls();
    expect((insert2![0] as readonly string[]).join('?')).toContain('ON CONFLICT (correlation_id)');
    expect(mockListReviews).not.toHaveBeenCalled();
    expect(mockImportReview).not.toHaveBeenCalled();
    expect(mockMarkOutboxCompleted).toHaveBeenCalledWith(sqlArg, 'outbox-backfill-1', undefined);
  });

  it('reactivation INSERT names no legacy counter column', async () => {
    pushImportSqlSetup({ runId: 'run-r' });
    mockListReviews.mockResolvedValueOnce(page([]));

    await handleZernioBackfill(sqlArg, makeJob({ backfill_reason: 'reactivation' }));

    const [reactivationInsert] = findBackfillInsertCalls();
    expect(reactivationInsert).toBeDefined();
    const insertText = (reactivationInsert![0] as readonly string[]).join('?');
    for (const legacy of LEGACY_COUNTER_COLUMNS) {
      expect(insertText).not.toContain(legacy);
    }
    // The non-counter reactivation columns stay.
    expect(insertText).toContain('oldest_skipped_create_time');
    expect(insertText).toContain('started_at');
  });

  it('sets skipped_count from cap overflow and oldest_skipped_create_time to the chronologically oldest overflow', async () => {
    pushImportSqlSetup();

    // 100 newest selected + 20 overflow. The two chronologically oldest
    // overflow rows carry differing fractional-second precision where string
    // comparison misorders: '…00.5Z' (500ms) is chronologically OLDER than
    // '…00.55Z' (550ms) but lexicographically GREATER ('Z' > '5').
    const selected = Array.from({ length: 100 }, (_, i) =>
      makeReview(`sel-${i}`, CUTOFF_MS - 1000 - i * 1000),
    );
    const overflowRegular = Array.from({ length: 18 }, (_, i) =>
      makeReview(`ovf-${i}`, Date.parse('2026-02-01T00:00:00Z') + i * 1000),
    );
    const oldestOverflow = makeReview('ovf-oldest', Date.parse('2026-01-15T10:00:00.500Z'));
    oldestOverflow.createTime = '2026-01-15T10:00:00.5Z';
    const lexTrap = makeReview('ovf-lex-trap', Date.parse('2026-01-15T10:00:00.550Z'));
    lexTrap.createTime = '2026-01-15T10:00:00.55Z';
    mockListReviews.mockResolvedValueOnce(page([
      ...selected, ...overflowRegular, lexTrap, oldestOverflow,
    ]));

    await handleZernioBackfill(sqlArg, makeJob());

    const [countsCall] = findImportCountsCalls();
    expect(countsCall!.slice(1)).toEqual([100, 20, '2026-01-15T10:00:00.5Z', 'run-1']);
    expect(mockMarkOutboxCompleted).toHaveBeenCalled();
  });

  it('deduplicates reviews repeated across page boundaries', async () => {
    pushImportSqlSetup();

    const dupB = makeReview('dup-b', inWindowMs(1));
    mockListReviews
      .mockResolvedValueOnce(page([makeReview('r-a', inWindowMs(0)), dupB], 'tok-2'))
      .mockResolvedValueOnce(page([dupB, makeReview('r-c', inWindowMs(2))]));

    await handleZernioBackfill(sqlArg, makeJob());

    expect(mockImportReview).toHaveBeenCalledTimes(3);
    expect(importedIds().sort()).toEqual(['dup-b', 'r-a', 'r-c']);
    const [countsCall] = findImportCountsCalls();
    expect(countsCall!.slice(1)).toEqual([3, 0, null, 'run-1']);
  });
});

// ── #679 fail-closed Import consent gate (spec §5.3) ─────────────────────
// Titles are the intake's tests_to_add VERBATIM (promised-tests gate).
//
// The four enqueue producers have been consent-gated since #677, but the WORKER
// was not: a hand-inserted zernio_initial_backfill outbox row still imported a
// customer's review history without consent. ADR 0015 §3 accepted that only
// while production held zero customers. These titles close it.

describe('import consent gate (#679)', () => {
  /** First `sqlCalls` index whose flattened text matches, or -1. */
  function firstSqlCallIndex(needle: string): number {
    return sqlCalls.findIndex((call) => call.text.includes(needle));
  }

  it('handleZernioBackfill runs guardImportConsent before inserting the zernio_backfill_runs row', async () => {
    // Ordering IS the contract (T4, owner decision 2026-08-07): the gate runs
    // immediately after extractOutboxHandle and BEFORE the run-row INSERT, so a
    // refused run leaves no durable trace at all — not even a claimed
    // zernio_backfill_runs row an operator would later read as "the import was
    // attempted".
    pushImportSqlSetup();
    mockListReviews.mockResolvedValueOnce(page([]));

    await handleZernioBackfill(sqlArg, makeJob());

    const consentIndex = firstSqlCallIndex('import_decision');
    const insertIndex = firstSqlCallIndex('INSERT INTO zernio_backfill_runs');
    expect(consentIndex, 'no Import consent read was issued').toBeGreaterThanOrEqual(0);
    expect(insertIndex).toBeGreaterThanOrEqual(0);
    expect(consentIndex).toBeLessThan(insertIndex);
    // And it is the FIRST statement the handler runs, not merely an earlier one.
    expect(consentIndex).toBe(0);
  });

  it('handleZernioBackfill writes no zernio_backfill_runs row when consent blocks the run', async () => {
    pushImportConsentState('pending');

    await handleZernioBackfill(sqlArg, makeJob());

    // The queryable proof the block holds (intake `observability` item 3): zero
    // zernio_backfill_runs rows for a business whose consent is not accepted.
    expect(findBackfillInsertCalls()).toHaveLength(0);
    expect(mockListReviews).not.toHaveBeenCalled();
    expect(mockImportReview).not.toHaveBeenCalled();
    // Skip-as-success: completed, never failed or thrown — and since #695 the
    // completion carries the durable refusal marker.
    expect(mockMarkOutboxFailed).not.toHaveBeenCalled();
    expect(mockMarkOutboxCompletedWithReason).toHaveBeenCalledWith(
      sqlArg, 'outbox-backfill-1', OUTBOX_COMPLETION_REASON.IMPORT_CONSENT_BLOCKED, undefined,
    );
  });

  it('handleZernioBackfill leaves completed_at untouched when consent blocks the run', async () => {
    pushImportConsentState('declined');

    await handleZernioBackfill(sqlArg, makeJob());

    // Nothing durable is written at all — no run row to stamp, no counts, no
    // completion. Spec §5.1's retryability lives on the completed_at IS NULL
    // sentinel, and a consent skip must never consume it.
    expect(findCompletedAtUpdates()).toHaveLength(0);
    expect(findImportCountsCalls()).toHaveLength(0);
    expect(mockMarkOutboxCompletedWithReason).toHaveBeenCalledWith(
      sqlArg, 'outbox-backfill-1', OUTBOX_COMPLETION_REASON.IMPORT_CONSENT_BLOCKED, undefined,
    );
  });

  it('handleZernioBackfill blocks a hand-inserted outbox row for a pending business', async () => {
    // THE HOLE THIS TICKET CLOSES. A row nobody's consent produced — the admin
    // re-enqueue path, or a bug — is refused on the same predicate, which is
    // what makes D8's "blocked permanently, admin path included" true rather
    // than aspirational.
    pushImportConsentState('pending');

    await handleZernioBackfill(sqlArg, makeJob({ outbox_id: 'outbox-hand-inserted-1' }));

    expect(mockListReviews).not.toHaveBeenCalled();
    expect(mockImportReview).not.toHaveBeenCalled();
    expect(findBackfillInsertCalls()).toHaveLength(0);
    expect(mockMarkOutboxCompletedWithReason).toHaveBeenCalledWith(
      sqlArg, 'outbox-hand-inserted-1',
      OUTBOX_COMPLETION_REASON.IMPORT_CONSENT_BLOCKED, undefined,
    );
  });

  it('handleZernioBackfill gates a reactivation backfill on accepted consent', async () => {
    // No exemption for backfill_reason 'reactivation'. The reactivation producer
    // (archive-location-tx.ts) already requires `accepted`, and an answered
    // decision outranks its deadline — so a post-expiry reactivation catch-up
    // for an accepted business still passes, while a declined one does not.
    pushImportConsentState('declined');

    await handleZernioBackfill(sqlArg, makeJob({ backfill_reason: 'reactivation' }));

    expect(findBackfillInsertCalls()).toHaveLength(0);
    expect(mockListReviews).not.toHaveBeenCalled();
    expect(mockMarkOutboxCompletedWithReason).toHaveBeenCalledWith(
      sqlArg, 'outbox-backfill-1', OUTBOX_COMPLETION_REASON.IMPORT_CONSENT_BLOCKED, undefined,
    );

    // The other half, so the gate cannot be read as "reactivation is blocked":
    // accepted consent still runs the catch-up through its correlation-keyed
    // claim.
    resetHarnessForNextRun();
    pushImportSqlSetup({ runId: 'run-r', importDecision: 'accepted' });
    mockListReviews.mockResolvedValueOnce(page([makeReview('rev-reactivated', inWindowMs(0))]));

    await handleZernioBackfill(sqlArg, makeJob({ backfill_reason: 'reactivation' }));

    const [reactivationInsert] = findBackfillInsertCalls();
    expect(reactivationInsert).toBeDefined();
    expect((reactivationInsert![0] as readonly string[]).join('?')).toContain('ON CONFLICT (correlation_id)');
    expect(mockImportReview).toHaveBeenCalledTimes(1);
  });

  it('handleZernioBackfill makes no Zernio API call when consent blocks the run', async () => {
    // `observability` item 4: a block must be distinguishable from a fetch that
    // returned nothing — no listReviews call means no api_costs row and no
    // pagination log line.
    pushImportConsentState('expired');

    await handleZernioBackfill(sqlArg, makeJob());

    expect(mockListReviews).not.toHaveBeenCalled();
    expect(mockReconcileExternallyAnsweredReview).not.toHaveBeenCalled();
    expect(mockOpenPhiReviewException).not.toHaveBeenCalled();
    expect(mockMarkOutboxCompletedWithReason).toHaveBeenCalledWith(
      sqlArg, 'outbox-backfill-1', OUTBOX_COMPLETION_REASON.IMPORT_CONSENT_BLOCKED, undefined,
    );
  });

  it('handleZernioBackfill throws on an unsupported tier before reaching the consent guard', async () => {
    // THE MALFORMED-PAYLOAD CARVE-OUT, pinned so a later reorder is a red test
    // rather than a silent behaviour change. `isSubscriptionTier` throws at
    // ZernioBackfillWorker.ts:135-137, before extractOutboxHandle and therefore
    // before the consent gate. That ordering STAYS: an unparseable tier is an
    // impossible state to assert on, not a state to branch around, and no import
    // happens on either path — only the outbox disposition differs (throw/retry
    // rather than skip-complete), so the consent promise is intact. Moving
    // consent ahead of tier validation was proposed in review and rejected: it
    // trades a loud bug signal for a silent skip.
    const unsupportedTier = 'retired_tier' as unknown as SubscriptionTierValue;

    await expect(handleZernioBackfill(
      sqlArg,
      makeJob({ subscription_tier: unsupportedTier }),
    )).rejects.toThrow('invalid_ws8_subscription_tier:retired_tier');

    // No consent read, and no transaction opened for one.
    expect(sqlCalls).toHaveLength(0);
    expect(mockSql.begin).not.toHaveBeenCalled();
    expect(mockMarkOutboxCompleted).not.toHaveBeenCalled();
  });
});
