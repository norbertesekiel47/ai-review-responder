import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { Job } from 'bullmq';
import type { PublishResponsePayload } from '../../../../src/lib/shared/worker-types';
import {
  ZernioAuthError,
  ZernioPermanentError,
  ZernioReplyAlreadyExistsError,
  ZernioReviewNotFoundError,
  ZernioTransientError,
} from '../../../../src/lib/zernio/errors';
import {
  PublisherTransientWithContext,
} from '../publisher-error-handlers';

// ── Hoisted state shared between mock factories and tests ──────────────
const {
  sqlReturnQueue,
  mockSql,
  mockMarkOutboxCompleted,
  mockMarkOutboxCompletedIfOwned,
  mockMarkOutboxFailed,
  mockLookupZernioReviewId,
  mockGetCachedZernioReviewPage,
  mockPostReply,
  mockListAllReviews,
  mockRunEditPublishIfApplicable,
  mockMaybeCaptureActivationCompleted,
  mockIsHeldForModerationReview,
  mockApplyJudgeGate,
  mockPublishAutoPolicyResponse,
  mockHasAutoPolicyProviderAttemptMarker,
} = vi.hoisted(() => {
  const sqlReturnQueue: unknown[] = [];

  const mockSql: any = vi.fn((_s: TemplateStringsArray, ..._v: unknown[]) => {
    const result = sqlReturnQueue.shift() ?? Object.assign([], { count: 0 });
    return Promise.resolve(result);
  });

  mockSql.begin = vi.fn(async (cb: (tx: any) => Promise<any>) => cb(mockSql));
  // Stand-in for Postgres.js's tx.json(value) (audit.ts's JSONB bind for the
  // auto-policy audit metadata column) — identity pass-through.
  mockSql.json = vi.fn((v: unknown) => v);

  return {
    sqlReturnQueue,
    mockSql,
    mockMarkOutboxCompleted: vi.fn(),
    mockMarkOutboxCompletedIfOwned: vi.fn().mockResolvedValue(true),
    mockMarkOutboxFailed: vi.fn(),
    mockLookupZernioReviewId: vi.fn(),
    // getCachedZernioReviewPage defaults to null (cache miss → full 4-page walk).
    mockGetCachedZernioReviewPage: vi.fn().mockResolvedValue(null),
    mockPostReply: vi.fn(),
    mockListAllReviews: vi.fn(),
    // Defaults to continue_to_fresh so existing tests stay on the POST-only path
    // even when the edit dispatch predicate happens to open the module.
    mockRunEditPublishIfApplicable: vi.fn().mockResolvedValue({ outcome: 'continue_to_fresh' }),
    mockMaybeCaptureActivationCompleted: vi.fn().mockResolvedValue(undefined),
    // F-5 hold gate: default "not held" so existing tests keep the post path.
    mockIsHeldForModerationReview: vi.fn().mockResolvedValue(false),
    mockApplyJudgeGate: vi.fn().mockResolvedValue('post'),
    mockPublishAutoPolicyResponse: vi.fn().mockResolvedValue(undefined),
    mockHasAutoPolicyProviderAttemptMarker: vi.fn().mockResolvedValue(false),
  };
});

// ── Module mocks ─────────────────────────────────────────────────────────
vi.mock('../../../../src/lib/db/server', () => ({ sql: mockSql, jsonb: (v: unknown) => v }));
vi.mock('../../../../src/lib/shared/outbox', () => ({
  markOutboxCompleted: mockMarkOutboxCompleted,
  markOutboxCompletedIfOwned: mockMarkOutboxCompletedIfOwned,
  markOutboxFailed: mockMarkOutboxFailed,
  extractOutboxHandle: (d: any, fallback: string) => ({
    outboxId: (d && typeof d.outbox_id === 'string') ? d.outbox_id : fallback,
    attempt: (d && typeof d.outbox_attempt === 'number') ? d.outbox_attempt : undefined,
  }),
}));
vi.mock('../../../../src/lib/publishing/zernio-publisher', () => ({
  lookupZernioReviewId: mockLookupZernioReviewId,
  getCachedZernioReviewPage: mockGetCachedZernioReviewPage,
}));
vi.mock('../../../../src/lib/zernio/client', () => ({
  zernioClient: { postReply: mockPostReply, listAllReviews: mockListAllReviews },
}));
vi.mock('uuid', () => ({ v7: vi.fn(() => 'test-uuid') }));
vi.mock('../edit-publish', () => ({
  runEditPublishIfApplicable: mockRunEditPublishIfApplicable,
}));
vi.mock('../activation', () => ({
  maybeCaptureActivationCompleted: mockMaybeCaptureActivationCompleted,
}));
vi.mock('../held-flag-gate', () => ({
  isHeldForModerationReview: mockIsHeldForModerationReview,
}));
vi.mock('../judge-gate', () => ({ applyJudgeGate: mockApplyJudgeGate }));
vi.mock('../auto-policy-publish', () => ({
  publishAutoPolicyResponse: mockPublishAutoPolicyResponse,
  hasAutoPolicyProviderAttemptMarker: mockHasAutoPolicyProviderAttemptMarker,
}));

import { handlePublishResponse } from '../ResponsePublisherWorker';

// ── Helpers ──────────────────────────────────────────────────────────────

function makeJob(
  overrides: Partial<PublishResponsePayload & { outbox_id: string; outbox_attempt: number }> = {},
): Job<PublishResponsePayload> {
  return {
    data: { response_id: 'resp-1', business_id: 'biz-1', ...overrides },
    id: 'outbox-pub-1',
  } as Job<PublishResponsePayload>;
}

function mockResponseRow(overrides: Record<string, unknown> = {}) {
  return {
    id: 'resp-1', review_id: 'rev-1', business_id: 'biz-1',
    approved_text: 'Thank you for your kind review!', status: 'approved',
    approval_method: null,
    posting_error: null,
    ...overrides,
  };
}

function mockBusinessRow(overrides: Record<string, unknown> = {}) {
  return {
    id: 'biz-1', account_id: 'acct-1', name: 'Test Biz', subscription_status: 'active',
    subscription_tier: 'autopilot', account_past_due_at: null, account_flags: {},
    account_updated_at: new Date(), archived_at: null,
    ...overrides,
  };
}

function mockZernioConnectionRow() {
  return { zernio_account_id: 'acct-1', zernio_location_id: 'loc-1' };
}

function makeZernioReview(id: string, replyComment: string | null = null) {
  return {
    id,
    name: `accounts/acct-1/locations/loc-1/reviews/${id}`,
    reviewer: { displayName: 'Test User', profilePhotoUrl: null, isAnonymous: false },
    rating: 5,
    starRating: 'FIVE' as const,
    comment: 'Great place!',
    createTime: '2026-01-01T00:00:00Z',
    updateTime: '2026-01-01T00:00:00Z',
    reviewReply: replyComment !== null ? { comment: replyComment, updateTime: '2026-01-02T00:00:00Z' } : null,
  };
}

// SQL call order for Zernio success path:
// 1. SELECT response
// 2. SELECT business
// 3. SELECT zernio_connections
// (then lookupZernioReviewId is mocked — no SQL)
// (then zernioClient.postReply is mocked — no SQL)
// 4. UPDATE responses SET status='posted'

function pushZernioSuccessSequence(responseOverrides: Record<string, unknown> = {}) {
  sqlReturnQueue.push([mockResponseRow(responseOverrides)]);  // 1: response
  sqlReturnQueue.push([mockBusinessRow()]);                    // 2: business
  sqlReturnQueue.push([mockZernioConnectionRow()]);            // 3: zernio_connections
  sqlReturnQueue.push(Object.assign([], { count: 1 }));        // 4: UPDATE posted
}

// SQL call order for 409 verify path (post-lookup, after postReply throws):
// 1. SELECT response
// 2. SELECT business
// 3. SELECT zernio_connections
// (lookupZernioReviewId is mocked)
// (postReply throws ZernioReplyAlreadyExistsError)
// (listAllReviews is mocked)
// 4. UPDATE responses (posted or superseded depending on text match)

function push409BaseSequence() {
  sqlReturnQueue.push([mockResponseRow()]);       // 1: response
  sqlReturnQueue.push([mockBusinessRow()]);        // 2: business
  sqlReturnQueue.push([mockZernioConnectionRow()]); // 3: zernio_connections
}

// ── Tests ────────────────────────────────────────────────────────────────

describe('ResponsePublisherWorker — Zernio branching', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    sqlReturnQueue.length = 0;
    delete process.env.EDIT_REPLIES_ENABLED;
    delete process.env.AUTO_APPROVAL_ENABLED;
    // clearAllMocks wipes the queued/persistent return; re-establish the safe default.
    mockRunEditPublishIfApplicable.mockResolvedValue({ outcome: 'continue_to_fresh' });
    mockMaybeCaptureActivationCompleted.mockResolvedValue(undefined);
    mockIsHeldForModerationReview.mockResolvedValue(false);
    mockApplyJudgeGate.mockResolvedValue('post');
    mockPublishAutoPolicyResponse.mockResolvedValue(undefined);
    mockHasAutoPolicyProviderAttemptMarker.mockResolvedValue(false);
    mockMarkOutboxCompletedIfOwned.mockResolvedValue(true);
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  // ── Steps 1–3 unchanged behavior ────────────────────────────────────

  it('completes outbox without action when response already posted', async () => {
    sqlReturnQueue.push([mockResponseRow({ status: 'posted' })]);
    sqlReturnQueue.push([mockBusinessRow()]);

    await handlePublishResponse(mockSql, makeJob());

    expect(mockLookupZernioReviewId).not.toHaveBeenCalled();
    expect(mockPostReply).not.toHaveBeenCalled();
    expect(mockApplyJudgeGate).not.toHaveBeenCalled();
    expect(mockMarkOutboxCompleted).toHaveBeenCalledWith(mockSql, 'outbox-pub-1', undefined);
  });

  // Defense-in-depth: regression tests for non-publishable terminal states.
  // Without the publishable-state gate at Step 2, control would flow into
  // Zernio API calls (lookupZernioReviewId + postReply), creating phantom
  // Google replies that the status-guarded UPDATE no-ops on.
  it.each([
    ['failed'],
    ['superseded'],
    ['pending_approval'],
  ])('completes outbox without action when response status is %s', async (status) => {
    sqlReturnQueue.push([mockResponseRow({ status })]);
    sqlReturnQueue.push([mockBusinessRow()]);

    await handlePublishResponse(mockSql, makeJob());

    expect(mockLookupZernioReviewId).not.toHaveBeenCalled();
    expect(mockPostReply).not.toHaveBeenCalled();
    expect(mockMaybeCaptureActivationCompleted).not.toHaveBeenCalled();
    expect(mockMarkOutboxCompleted).toHaveBeenCalledWith(mockSql, 'outbox-pub-1', undefined);
    expect(mockMarkOutboxFailed).not.toHaveBeenCalled();
  });

  it('completes outbox without action when subscription is cancelled', async () => {
    sqlReturnQueue.push([mockResponseRow()]);
    sqlReturnQueue.push([mockBusinessRow({ subscription_status: 'cancelled' })]);

    await handlePublishResponse(mockSql, makeJob());

    expect(mockLookupZernioReviewId).not.toHaveBeenCalled();
    expect(mockPostReply).not.toHaveBeenCalled();
    expect(mockMarkOutboxCompleted).toHaveBeenCalledWith(mockSql, 'outbox-pub-1', undefined);
  });

  it('completes outbox without action when location is archived before publishing', async () => {
    sqlReturnQueue.push([mockResponseRow()]);
    sqlReturnQueue.push([mockBusinessRow({ archived_at: new Date('2026-05-09T00:00:00Z') })]);

    await handlePublishResponse(mockSql, makeJob());

    expect(mockLookupZernioReviewId).not.toHaveBeenCalled();
    expect(mockPostReply).not.toHaveBeenCalled();
    expect(mockMarkOutboxCompleted).toHaveBeenCalledWith(mockSql, 'outbox-pub-1', undefined);
    expect(mockMarkOutboxFailed).not.toHaveBeenCalled();
  });

  // F-5 belt-and-suspenders: even with an approved, active, connected response,
  // an OPEN moderation flag must block the Google post. Non-exploitable today
  // (flagged drafts stay pending_approval and never get a publish outbox row),
  // but this makes the moderation veto binding on the publish path too.
  it('completes outbox without posting when an open moderation flag holds the draft', async () => {
    mockIsHeldForModerationReview.mockResolvedValue(true);
    sqlReturnQueue.push([mockResponseRow()]);  // response (load-context)
    sqlReturnQueue.push([mockBusinessRow()]);   // business (load-context)

    await handlePublishResponse(mockSql, makeJob());

    expect(mockIsHeldForModerationReview).toHaveBeenCalledWith(mockSql, 'resp-1', 'biz-1');
    expect(mockLookupZernioReviewId).not.toHaveBeenCalled();
    expect(mockPostReply).not.toHaveBeenCalled();
    expect(mockMaybeCaptureActivationCompleted).not.toHaveBeenCalled();
    expect(mockMarkOutboxCompleted).toHaveBeenCalledWith(mockSql, 'outbox-pub-1', undefined);
    expect(mockMarkOutboxFailed).not.toHaveBeenCalled();
  });

  it.each([
    ['autopilot'],
    ['copilot'],
  ])('routes auto-policy rows into the fresh locked lane when the load hint is %s', async (subscriptionTier) => {
    sqlReturnQueue.push([mockResponseRow({ approval_method: 'auto_policy' })]);
    sqlReturnQueue.push([mockBusinessRow({ subscription_tier: subscriptionTier })]);

    await handlePublishResponse(mockSql, makeJob({
      correlation_id: 'corr-1',
      outbox_id: 'outbox-auto-1',
      outbox_attempt: 2,
    }));

    expect(mockPublishAutoPolicyResponse).toHaveBeenCalledWith(
      mockSql,
      expect.objectContaining({
        responseId: 'resp-1',
        reviewId: 'rev-1',
        businessId: 'biz-1',
        accountId: 'acct-1',
        outboxId: 'outbox-auto-1',
        outboxAttempt: 2,
      }),
    );
    expect(mockPostReply).not.toHaveBeenCalled();
    expect(mockIsHeldForModerationReview).not.toHaveBeenCalled();
  });

  it('owner-approved rows never touch the notice-delivery gate (flag on)', async () => {
    vi.stubEnv('AUTO_APPROVAL_ENABLED', 'true');
    pushZernioSuccessSequence({ approval_method: 'owner' });
    mockLookupZernioReviewId.mockResolvedValueOnce('zernio-rev-id-1');
    mockPostReply.mockResolvedValueOnce({ comment: 'Thank you for your kind review!', updateTime: '2026-04-27T00:00:00Z' });
    mockListAllReviews.mockResolvedValueOnce([
      makeZernioReview('zernio-rev-id-1', 'Thank you for your kind review!'),
    ]);

    await handlePublishResponse(mockSql, makeJob());

    const callTexts = (mockSql as any).mock.calls.map(
      (c: any[]) => (c[0] as TemplateStringsArray).join('?'),
    );
    expect(callTexts.some((t: string) => /notification_deliveries/.test(t))).toBe(false);
    expect(mockPostReply).toHaveBeenCalledTimes(1);
    expect(mockMarkOutboxCompleted).toHaveBeenCalledWith(mockSql, 'outbox-pub-1', undefined);
  });

  it('keeps owner-approved rows on the normal publisher path when runtime flag is off', async () => {
    sqlReturnQueue.push([mockResponseRow({ approval_method: 'owner' })]);
    sqlReturnQueue.push([mockBusinessRow()]);
    sqlReturnQueue.push([]); // zernio_connections
    sqlReturnQueue.push(Object.assign([], { count: 1 })); // UPDATE awaiting_owner_connect
    sqlReturnQueue.push(Object.assign([], { count: 1 })); // reconnect notify INSERT

    await handlePublishResponse(mockSql, makeJob());

    const callTexts = (mockSql as any).mock.calls.map(
      (c: any[]) => (c[0] as TemplateStringsArray).join('?'),
    );
    expect(callTexts.some((t: string) => /auto_policy_revoked_by_kill_switch/.test(t))).toBe(false);
    expect(callTexts.some((t: string) => /awaiting_owner_connect/.test(t))).toBe(true);
    expect(callTexts.some((t: string) => /notify_owner_reconnect/.test(t))).toBe(true);
    expect(mockMarkOutboxCompleted).toHaveBeenCalledWith(mockSql, 'outbox-pub-1', undefined);
  });

  it('marks outbox failed when response not found', async () => {
    sqlReturnQueue.push([]);  // response query returns empty

    await handlePublishResponse(mockSql, makeJob());

    expect(mockMarkOutboxFailed).toHaveBeenCalledWith(
      mockSql,
      'outbox-pub-1',
      'response_not_found: resp-1',
      undefined,
    );
  });

  it('marks outbox failed on business_id mismatch', async () => {
    sqlReturnQueue.push([mockResponseRow({ business_id: 'biz-other' })]);

    await handlePublishResponse(mockSql, makeJob());

    expect(mockMarkOutboxFailed).toHaveBeenCalledWith(
      mockSql,
      'outbox-pub-1',
      'business_id_mismatch',
      undefined,
    );
  });

  // ── Branch A: no active connection ──────────────────────────────────

  it('parks response at awaiting_owner_connect and enqueues reconnect notify when no active connection', async () => {
    sqlReturnQueue.push([mockResponseRow()]);                    // 1: response
    sqlReturnQueue.push([mockBusinessRow()]);                    // 2: business
    sqlReturnQueue.push([]);                                     // 3: zernio_connections (no active row)
    sqlReturnQueue.push(Object.assign([], { count: 1 }));        // 4: UPDATE awaiting_owner_connect
    sqlReturnQueue.push(Object.assign([], { count: 1 }));        // 5: INSERT job_outbox

    await handlePublishResponse(mockSql, makeJob());

    expect(mockLookupZernioReviewId).not.toHaveBeenCalled();
    expect(mockPostReply).not.toHaveBeenCalled();
    expect(mockMarkOutboxCompleted).toHaveBeenCalledWith(mockSql, 'outbox-pub-1', undefined);

    // Verify both an UPDATE awaiting_owner_connect and a notify_owner_reconnect
    // INSERT were issued.
    const callTexts = (mockSql as any).mock.calls.map(
      (c: any[]) => (c[0] as TemplateStringsArray).join('?'),
    );
    expect(callTexts.some((t: string) => /awaiting_owner_connect/.test(t))).toBe(true);
    expect(callTexts.some((t: string) => /notify_owner_reconnect/.test(t))).toBe(true);
  });

  it('skips reconnect notify when response goes terminal mid-flight (no connection branch)', async () => {
    // Simulates a parallel worker transitioning the row to terminal between
    // our SELECT and our UPDATE. The initial row passes the Step 2 gate
    // (status='approved'), but the status-guarded UPDATE no-ops because
    // the row is now superseded/failed/posted by the time the UPDATE runs.
    sqlReturnQueue.push([mockResponseRow()]);                           // 1: response (approved → passes gate)
    sqlReturnQueue.push([mockBusinessRow()]);                           // 2: business
    sqlReturnQueue.push([]);                                            // 3: no connection
    sqlReturnQueue.push(Object.assign([], { count: 0 }));               // 4: UPDATE no-op (terminal mid-flight)

    await handlePublishResponse(mockSql, makeJob());

    expect(mockMarkOutboxCompleted).toHaveBeenCalledWith(mockSql, 'outbox-pub-1', undefined);
    const callTexts = (mockSql as any).mock.calls.map(
      (c: any[]) => (c[0] as TemplateStringsArray).join('?'),
    );
    expect(callTexts.some((t: string) => /notify_owner_reconnect/.test(t))).toBe(false);
  });

  // ── Branch B: success path ─────────────────────────────────────────

  it('posts via Zernio and marks response posted on success', async () => {
    pushZernioSuccessSequence();
    mockLookupZernioReviewId.mockResolvedValueOnce('zernio-rev-id-1');
    mockPostReply.mockResolvedValueOnce({
      comment: 'Thank you for your kind review!',
      updateTime: '2026-04-27T00:00:00Z',
    });
    // Post-verify: our reply is actually attached on Zernio (matches approved_text).
    mockListAllReviews.mockResolvedValueOnce([
      makeZernioReview('zernio-rev-id-1', 'Thank you for your kind review!'),
    ]);

    await handlePublishResponse(mockSql, makeJob());

    expect(mockApplyJudgeGate).not.toHaveBeenCalled();
    expect(mockLookupZernioReviewId).toHaveBeenCalledWith(mockSql, 'biz-1', 'rev-1', 'acct-1', 'loc-1');
    expect(mockPostReply).toHaveBeenCalledWith('acct-1', 'zernio-rev-id-1', {
      comment: 'Thank you for your kind review!',
    });
    expect(mockMaybeCaptureActivationCompleted).toHaveBeenCalledWith(mockSql, {
      responseId: 'resp-1',
      businessId: 'biz-1',
      reviewId: 'rev-1',
      logger: expect.any(Object),
    });
    expect(mockMaybeCaptureActivationCompleted).toHaveBeenCalledTimes(1);
    expect(mockMarkOutboxCompleted).toHaveBeenCalledWith(mockSql, 'outbox-pub-1', undefined);
    // Contract: activation capture runs before the outbox is marked complete.
    expect(
      mockMaybeCaptureActivationCompleted.mock.invocationCallOrder[0]!,
    ).toBeLessThan(mockMarkOutboxCompleted.mock.invocationCallOrder[0]!);
  });

  // ── Branch B: Stage-5 seam TOCTOU regression ────────────────────────
  //
  // The ReviewPublisher seam moved connection + review-id resolution into the
  // adapter. The response's publishable-state gate still runs BEFORE resolution
  // and every mutating UPDATE on the publish path stays status-guarded, so a
  // status change landing mid-publish loses to the guard (no double-post / no
  // clobber) exactly as before the seam. This pins both facts: the markPosted
  // UPDATE carries the status guard, AND when that guard matches zero rows (a
  // parallel worker already transitioned the row) the publish path completes the
  // outbox idempotently — never throwing or marking failed.
  it('status-guards markPosted so a transition landing mid-publish loses without double-posting', async () => {
    sqlReturnQueue.push([mockResponseRow()]);          // 1: response
    sqlReturnQueue.push([mockBusinessRow()]);           // 2: business
    sqlReturnQueue.push([mockZernioConnectionRow()]);   // 3: zernio_connections (resolveTarget)
    sqlReturnQueue.push([]);                            // 4: markPosted reviews FOR UPDATE lock
    sqlReturnQueue.push([]);                            // 5: markPosted UPDATE matches ZERO rows (raced terminal)
    mockLookupZernioReviewId.mockResolvedValueOnce('zernio-rev-id-1');
    mockPostReply.mockResolvedValueOnce({
      comment: 'Thank you for your kind review!',
      updateTime: '2026-04-27T00:00:00Z',
    });
    mockListAllReviews.mockResolvedValueOnce([
      makeZernioReview('zernio-rev-id-1', 'Thank you for your kind review!'),
    ]);

    await handlePublishResponse(mockSql, makeJob());

    const markPostedUpdate = (mockSql as any).mock.calls
      .map((c: any[]) => (c[0] as TemplateStringsArray).join('?'))
      .find((t: string) => /UPDATE responses[\s\S]*SET status = 'posted'/.test(t));
    expect(markPostedUpdate).toBeDefined();
    expect(markPostedUpdate).toMatch(
      /status IN \('approved', 'edited', 'awaiting_owner_connect'\)/,
    );
    // Guard matched zero rows → idempotent completion, no failure, no re-post.
    expect(mockPostReply).toHaveBeenCalledTimes(1);
    expect(mockMarkOutboxCompleted).toHaveBeenCalledWith(mockSql, 'outbox-pub-1', undefined);
    expect(mockMarkOutboxFailed).not.toHaveBeenCalled();
  });

  // ── Branch B: auto-post FYI enqueue on the fresh-2xx success path ─────

  it('fresh 2xx success for an owner-approved response enqueues NO FYI', async () => {
    sqlReturnQueue.push([mockResponseRow({ approval_method: 'owner' })]); // 1: response
    sqlReturnQueue.push([mockBusinessRow()]);                              // 2: business
    sqlReturnQueue.push([mockZernioConnectionRow()]);                      // 3: zernio_connections
    sqlReturnQueue.push([]);                                               // 4: markPosted reviews FOR UPDATE lock
    sqlReturnQueue.push([{ id: 'resp-1', approval_method: 'owner' }]);      // 5: markPosted UPDATE ... RETURNING (owner)
    sqlReturnQueue.push([]);                                               // 6: findActiveReviewRun → no run (legacy review)
    mockLookupZernioReviewId.mockResolvedValueOnce('zernio-rev-id-1');
    mockPostReply.mockResolvedValueOnce({ comment: 'Thank you for your kind review!', updateTime: '2026-04-27T00:00:00Z' });
    mockListAllReviews.mockResolvedValueOnce([
      makeZernioReview('zernio-rev-id-1', 'Thank you for your kind review!'),
    ]);

    await handlePublishResponse(mockSql, makeJob());

    const callTexts = (mockSql as any).mock.calls.map(
      (c: any[]) => (c[0] as TemplateStringsArray).join('?'),
    );
    expect(callTexts.some((t: string) => /topic = 'auto_post_notice'/.test(t))).toBe(false);
    expect(mockMarkOutboxCompleted).toHaveBeenCalledWith(mockSql, 'outbox-pub-1', undefined);
  });

  // ── Branch B: ZernioReviewNotFoundError → terminal failed + exception

  it('opens review_exception and marks response failed on review-not-found', async () => {
    sqlReturnQueue.push([mockResponseRow()]);                       // 1: response
    sqlReturnQueue.push([mockBusinessRow()]);                       // 2: business
    sqlReturnQueue.push([mockZernioConnectionRow()]);               // 3: zernio_connections
    sqlReturnQueue.push(Object.assign([], { count: 1 }));           // 4: UPDATE failed
    sqlReturnQueue.push([{ id: 'exception-1' }]);                   // 5: INSERT review_exceptions
    sqlReturnQueue.push(Object.assign([], { count: 1 }));           // 6: INSERT job_outbox

    mockLookupZernioReviewId.mockRejectedValueOnce(
      new ZernioReviewNotFoundError({ ourReviewId: 'rev-1', accountId: 'acct-1' }),
    );

    await handlePublishResponse(mockSql, makeJob());

    expect(mockPostReply).not.toHaveBeenCalled();
    expect(mockMarkOutboxCompleted).toHaveBeenCalledWith(mockSql, 'outbox-pub-1', undefined);

    const callTexts = (mockSql as any).mock.calls.map(
      (c: any[]) => (c[0] as TemplateStringsArray).join('?'),
    );
    expect(callTexts.some((t: string) => /zernio_review_id_mismatch/.test(t))).toBe(true);
    // notify_admin_review_exception is an interpolated QUEUE_NAMES value, not
    // a template literal — check the bound values, not the raw strings array.
    const callValues = (mockSql as any).mock.calls.map((c: any[]) => c.slice(1));
    expect(callValues.some((values: unknown[]) => values.includes('notify_admin_review_exception'))).toBe(true);
  });

  it('skips exception/notify when response goes terminal mid-flight during review-not-found', async () => {
    // See note on the analogous "no connection branch" race test above.
    sqlReturnQueue.push([mockResponseRow()]);                            // approved → passes Step 2 gate
    sqlReturnQueue.push([mockBusinessRow()]);
    sqlReturnQueue.push([mockZernioConnectionRow()]);
    sqlReturnQueue.push(Object.assign([], { count: 0 })); // UPDATE no-op (race: row went terminal mid-flight)

    mockLookupZernioReviewId.mockRejectedValueOnce(
      new ZernioReviewNotFoundError({ ourReviewId: 'rev-1' }),
    );

    await handlePublishResponse(mockSql, makeJob());

    expect(mockMarkOutboxCompleted).toHaveBeenCalledWith(mockSql, 'outbox-pub-1', undefined);
    const callTexts = (mockSql as any).mock.calls.map(
      (c: any[]) => (c[0] as TemplateStringsArray).join('?'),
    );
    expect(callTexts.some((t: string) => /zernio_review_id_mismatch/.test(t))).toBe(false);
  });

  // ── Branch B: ZernioAuthError → delegate to shared helper ──────────

  it('disconnects connection and parks response on auth error', async () => {
    sqlReturnQueue.push([mockResponseRow()]);                           // 1: response
    sqlReturnQueue.push([mockBusinessRow()]);                           // 2: business
    sqlReturnQueue.push([mockZernioConnectionRow()]);                   // 3: zernio_connections
    // handlePublisherAuthErrorTerminal drives the SQL (through sql.begin)
    sqlReturnQueue.push(Object.assign([], { count: 1 }));               // 4: UPDATE zernio_connections disconnected
    sqlReturnQueue.push(Object.assign([{ review_id: 'rev-1' }], { count: 1 })); // 5: UPDATE responses → parked
    sqlReturnQueue.push(Object.assign([], { count: 1 }));               // 6: INSERT notify_owner_reconnect
    sqlReturnQueue.push(Object.assign([], { count: 1 }));               // 7: INSERT notify_owner_connection_lost

    mockLookupZernioReviewId.mockResolvedValueOnce('zernio-rev-id-1');
    mockPostReply.mockRejectedValueOnce(new ZernioAuthError(401, 'Unauthorized'));

    await handlePublishResponse(mockSql, makeJob());

    expect(mockMarkOutboxCompleted).toHaveBeenCalledWith(mockSql, 'outbox-pub-1', undefined);

    const callTexts = (mockSql as any).mock.calls.map(
      (c: any[]) => (c[0] as TemplateStringsArray).join('?'),
    );
    expect(callTexts.some((t: string) => /UPDATE zernio_connections/.test(t))).toBe(true);
    expect(callTexts.some((t: string) => /awaiting_owner_connect/.test(t))).toBe(true);
    expect(callTexts.some((t: string) => /notify_owner_reconnect/.test(t))).toBe(true);
    expect(callTexts.some((t: string) => /notify_owner_connection_lost/.test(t))).toBe(true);
  });

  it('skips notify enqueues on auth error when response goes terminal mid-flight', async () => {
    sqlReturnQueue.push([mockResponseRow()]);                            // approved → passes Step 2 gate
    sqlReturnQueue.push([mockBusinessRow()]);
    sqlReturnQueue.push([mockZernioConnectionRow()]);
    sqlReturnQueue.push(Object.assign([], { count: 1 })); // UPDATE conn (still applied)
    sqlReturnQueue.push(Object.assign([], { count: 0 })); // UPDATE response no-op (race: row went terminal mid-flight)

    mockLookupZernioReviewId.mockResolvedValueOnce('zernio-rev-id-1');
    mockPostReply.mockRejectedValueOnce(new ZernioAuthError(403, 'Forbidden'));

    await handlePublishResponse(mockSql, makeJob());

    expect(mockMarkOutboxCompleted).toHaveBeenCalledWith(mockSql, 'outbox-pub-1', undefined);
    const callTexts = (mockSql as any).mock.calls.map(
      (c: any[]) => (c[0] as TemplateStringsArray).join('?'),
    );
    // notify enqueues should not have been issued
    expect(callTexts.some((t: string) => /notify_owner_reconnect/.test(t))).toBe(false);
    expect(callTexts.some((t: string) => /notify_owner_connection_lost/.test(t))).toBe(false);
  });

  // ── Branch B: ZernioPermanentError → delegate to shared helper ──────

  it('opens permanent_4xx exception and marks response failed on ZernioPermanentError', async () => {
    sqlReturnQueue.push([mockResponseRow()]);
    sqlReturnQueue.push([mockBusinessRow()]);
    sqlReturnQueue.push([mockZernioConnectionRow()]);
    // handlePublisherPermanentErrorTerminal drives the SQL
    sqlReturnQueue.push(Object.assign([], { count: 1 }));        // UPDATE failed
    sqlReturnQueue.push([{ id: 'exception-1' }]);                // INSERT review_exceptions
    sqlReturnQueue.push(Object.assign([], { count: 1 }));        // INSERT job_outbox

    mockLookupZernioReviewId.mockResolvedValueOnce('zernio-rev-id-1');
    mockPostReply.mockRejectedValueOnce(
      new ZernioPermanentError('http_400', { status: 400, body: { code: 'invalid' }, endpointKind: 'publish_reply' }),
    );

    await handlePublishResponse(mockSql, makeJob());

    expect(mockMarkOutboxCompleted).toHaveBeenCalledWith(mockSql, 'outbox-pub-1', undefined);
    const callTexts = (mockSql as any).mock.calls.map(
      (c: any[]) => (c[0] as TemplateStringsArray).join('?'),
    );
    expect(callTexts.some((t: string) => /zernio_permanent_4xx/.test(t))).toBe(true);
    // Connection state must NOT be touched.
    expect(callTexts.some((t: string) => /UPDATE zernio_connections/.test(t))).toBe(false);
  });

  // ── Branch B: ZernioTransientError → rethrown as PublisherTransientWithContext

  it('re-throws ZernioTransientError as PublisherTransientWithContext so BullMQ retries', async () => {
    sqlReturnQueue.push([mockResponseRow()]);
    sqlReturnQueue.push([mockBusinessRow()]);
    sqlReturnQueue.push([mockZernioConnectionRow()]);

    mockLookupZernioReviewId.mockResolvedValueOnce('zernio-rev-id-1');
    mockPostReply.mockRejectedValueOnce(
      new ZernioTransientError('http_503', { status: 503, body: 'down' }),
    );

    await expect(handlePublishResponse(mockSql, makeJob())).rejects.toBeInstanceOf(PublisherTransientWithContext);

    expect(mockMarkOutboxCompleted).not.toHaveBeenCalled();
    expect(mockMarkOutboxFailed).not.toHaveBeenCalled();
  });

  it('re-throws unexpected non-Zernio errors so BullMQ retries', async () => {
    sqlReturnQueue.push([mockResponseRow()]);
    sqlReturnQueue.push([mockBusinessRow()]);
    sqlReturnQueue.push([mockZernioConnectionRow()]);

    mockLookupZernioReviewId.mockResolvedValueOnce('zernio-rev-id-1');
    mockPostReply.mockRejectedValueOnce(new Error('unexpected network kaboom'));

    await expect(handlePublishResponse(mockSql, makeJob())).rejects.toThrow('unexpected network kaboom');
    expect(mockMarkOutboxCompleted).not.toHaveBeenCalled();
    expect(mockMarkOutboxFailed).not.toHaveBeenCalled();
  });

  // ── Branch B: 409 verify-first flow ─────────────────────────────────

  it('409 + target found page 1 with matching text → response marked posted', async () => {
    push409BaseSequence();
    sqlReturnQueue.push(Object.assign([], { count: 1 })); // UPDATE posted

    mockLookupZernioReviewId.mockResolvedValueOnce('zernio-rev-id-1');
    mockPostReply.mockRejectedValueOnce(
      new ZernioReplyAlreadyExistsError({ message: 'reply already exists' }),
    );
    mockListAllReviews.mockResolvedValueOnce([
      makeZernioReview('zernio-rev-id-1', 'Thank you for your kind review!'),
    ]);

    await handlePublishResponse(mockSql, makeJob());

    expect(mockMarkOutboxCompleted).toHaveBeenCalledWith(mockSql, 'outbox-pub-1', undefined);
    const callTexts = (mockSql as any).mock.calls.map(
      (c: any[]) => (c[0] as TemplateStringsArray).join('?'),
    );
    expect(callTexts.some((t: string) => /SET status = 'posted'/.test(t))).toBe(true);
    expect(callTexts.some((t: string) => /superseded/.test(t))).toBe(false);
  });

  it('409 + target NOT found → throws ZernioReplyVerificationIndeterminateError reason=review_not_found_after_pagination', async () => {
    push409BaseSequence();
    // no UPDATE SQL — response should NOT be touched

    mockLookupZernioReviewId.mockResolvedValueOnce('zernio-rev-id-1');
    mockPostReply.mockRejectedValueOnce(
      new ZernioReplyAlreadyExistsError({ message: 'reply already exists' }),
    );
    // listAllReviews returns reviews that do NOT include the target id
    mockListAllReviews.mockResolvedValueOnce([
      makeZernioReview('some-other-review-id', 'Some reply'),
    ]);

    await expect(handlePublishResponse(mockSql, makeJob())).rejects.toMatchObject({
      name: 'ZernioReplyVerificationIndeterminateError',
      meta: { reason: 'review_not_found_after_pagination' },
    });

    expect(mockMarkOutboxCompleted).not.toHaveBeenCalled();
    expect(mockMarkOutboxFailed).not.toHaveBeenCalled();
    // response status must not be changed
    const callTexts = (mockSql as any).mock.calls.map(
      (c: any[]) => (c[0] as TemplateStringsArray).join('?'),
    );
    expect(callTexts.some((t: string) => /UPDATE responses/.test(t))).toBe(false);
  });

  it('409 + target found but reviewReply=null → throws ZernioReplyVerificationIndeterminateError reason=review_found_but_reply_null', async () => {
    push409BaseSequence();

    mockLookupZernioReviewId.mockResolvedValueOnce('zernio-rev-id-1');
    mockPostReply.mockRejectedValueOnce(
      new ZernioReplyAlreadyExistsError({ message: 'reply already exists' }),
    );
    // Review found but reviewReply=null (Zernio lag)
    mockListAllReviews.mockResolvedValueOnce([
      makeZernioReview('zernio-rev-id-1', null),
    ]);

    await expect(handlePublishResponse(mockSql, makeJob())).rejects.toMatchObject({
      name: 'ZernioReplyVerificationIndeterminateError',
      meta: { reason: 'review_found_but_reply_null' },
    });

    expect(mockMarkOutboxCompleted).not.toHaveBeenCalled();
    expect(mockMarkOutboxFailed).not.toHaveBeenCalled();
  });

  it('409 + target found with DIFFERENT text → response superseded with posting_error=already_replied_external', async () => {
    push409BaseSequence();
    sqlReturnQueue.push(Object.assign([], { count: 1 })); // UPDATE superseded

    mockLookupZernioReviewId.mockResolvedValueOnce('zernio-rev-id-1');
    mockPostReply.mockRejectedValueOnce(
      new ZernioReplyAlreadyExistsError({ message: 'reply already exists' }),
    );
    // Existing reply has completely different text (external reply by owner directly)
    mockListAllReviews.mockResolvedValueOnce([
      makeZernioReview('zernio-rev-id-1', 'A completely different reply posted by someone else'),
    ]);

    await handlePublishResponse(mockSql, makeJob());

    expect(mockMarkOutboxCompleted).toHaveBeenCalledWith(mockSql, 'outbox-pub-1', undefined);
    const callTexts = (mockSql as any).mock.calls.map(
      (c: any[]) => (c[0] as TemplateStringsArray).join('?'),
    );
    expect(callTexts.some((t: string) => /superseded/.test(t))).toBe(true);
    expect(callTexts.some((t: string) => /already_replied_external/.test(t))).toBe(true);
    expect(callTexts.some((t: string) => /SET status = 'posted'/.test(t))).toBe(false);
  });

  it('409 + listAllReviews throws ZernioTransientError → caught + rethrown as PublisherTransientWithContext', async () => {
    push409BaseSequence();

    mockLookupZernioReviewId.mockResolvedValueOnce('zernio-rev-id-1');
    mockPostReply.mockRejectedValueOnce(
      new ZernioReplyAlreadyExistsError({ message: 'reply already exists' }),
    );
    mockListAllReviews.mockRejectedValueOnce(
      new ZernioTransientError('http_503', { status: 503, body: 'unavailable' }),
    );

    const err = await handlePublishResponse(mockSql, makeJob()).catch((e) => e);

    expect(err).toBeInstanceOf(PublisherTransientWithContext);
    // Must NOT be a bare ZernioTransientError without context
    expect(err.name).toBe('PublisherTransientWithContext');
    expect(err.attemptContext).toMatchObject({
      response_id: 'resp-1',
      business_id: 'biz-1',
      account_id: 'acct-1',
      location_id: 'loc-1',
    });
    expect(mockMarkOutboxCompleted).not.toHaveBeenCalled();
    expect(mockMarkOutboxFailed).not.toHaveBeenCalled();
  });

  it('409 canonicalization: existing CRLF vs ours LF → text match → marked posted', async () => {
    push409BaseSequence();
    sqlReturnQueue.push(Object.assign([], { count: 1 })); // UPDATE posted

    mockLookupZernioReviewId.mockResolvedValueOnce('zernio-rev-id-1');
    mockPostReply.mockRejectedValueOnce(
      new ZernioReplyAlreadyExistsError({ message: 'reply already exists' }),
    );
    // Existing reply uses CRLF; our approved_text uses LF — should still match
    mockListAllReviews.mockResolvedValueOnce([
      makeZernioReview('zernio-rev-id-1', 'Thank you for your kind review!\r\n'),
    ]);

    await handlePublishResponse(mockSql, makeJob());

    expect(mockMarkOutboxCompleted).toHaveBeenCalledWith(mockSql, 'outbox-pub-1', undefined);
    const callTexts = (mockSql as any).mock.calls.map(
      (c: any[]) => (c[0] as TemplateStringsArray).join('?'),
    );
    expect(callTexts.some((t: string) => /SET status = 'posted'/.test(t))).toBe(true);
    expect(callTexts.some((t: string) => /superseded/.test(t))).toBe(false);
  });
});

// ── Task 6: edit-publish dispatch (posted-sibling / orphan-marker) ─────────
//
// SQL order on the dispatch decision (flag on): after the response / business /
// zernio_connections SELECTs (lookupZernioReviewId is mocked, no SQL), the
// worker runs the business-scoped sibling probe, then either enters
// runEditPublishIfApplicable (mocked) or falls through to the POST-only path.
describe('ResponsePublisherWorker — edit-publish dispatch (Task 6)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    sqlReturnQueue.length = 0;
    delete process.env.EDIT_REPLIES_ENABLED;
    delete process.env.AUTO_APPROVAL_ENABLED;
    mockRunEditPublishIfApplicable.mockResolvedValue({ outcome: 'continue_to_fresh' });
    mockMaybeCaptureActivationCompleted.mockResolvedValue(undefined);
  });

  function pushDispatchBaseSequence(responseOverrides: Record<string, unknown> = {}) {
    sqlReturnQueue.push([mockResponseRow(responseOverrides)]); // 1: response
    sqlReturnQueue.push([mockBusinessRow()]);                   // 2: business
    sqlReturnQueue.push([mockZernioConnectionRow()]);           // 3: zernio_connections
  }

  it('dispatches to runEditPublishIfApplicable when flag on AND a posted sibling exists', async () => {
    process.env.EDIT_REPLIES_ENABLED = 'true';
    pushDispatchBaseSequence();
    sqlReturnQueue.push([{ id: 'resp-posted-sibling' }]); // 4: sibling probe → sibling found
    mockLookupZernioReviewId.mockResolvedValueOnce('zernio-rev-id-1');
    mockRunEditPublishIfApplicable.mockResolvedValueOnce({ outcome: 'completed' });

    await handlePublishResponse(mockSql, makeJob());

    expect(mockRunEditPublishIfApplicable).toHaveBeenCalledTimes(1);
    const ctx = mockRunEditPublishIfApplicable.mock.calls[0]![1];
    expect(ctx).toMatchObject({
      responseId: 'resp-1',
      businessId: 'biz-1',
      reviewId: 'rev-1',
      approvedText: 'Thank you for your kind review!',
      responsePostingError: null,
      zernioAccountId: 'acct-1',
      zernioLocationId: 'loc-1',
      zernioReviewId: 'zernio-rev-id-1',
    });
    // The sibling probe must be business-scoped.
    const probeCall = (mockSql as any).mock.calls.find((c: any[]) =>
      /status = 'posted'/.test((c[0] as TemplateStringsArray).join('?')),
    );
    expect(probeCall).toBeDefined();
    expect((probeCall![0] as TemplateStringsArray).join('?')).toMatch(/business_id =/);
    // 'completed' → outbox completed, POST-only path NOT taken.
    expect(mockPostReply).not.toHaveBeenCalled();
    expect(mockMarkOutboxCompleted).toHaveBeenCalledWith(mockSql, 'outbox-pub-1', undefined);
  });

  it('captures activation before completing outbox when edit-publish posts a response', async () => {
    process.env.EDIT_REPLIES_ENABLED = 'true';
    pushDispatchBaseSequence();
    sqlReturnQueue.push([{ id: 'resp-posted-sibling' }]); // 4: sibling probe → sibling found
    mockLookupZernioReviewId.mockResolvedValueOnce('zernio-rev-id-1');
    const activationLogger = {
      log: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    };
    mockRunEditPublishIfApplicable.mockResolvedValueOnce({
      outcome: 'completed',
      postedResponse: {
        responseId: 'resp-1',
        businessId: 'biz-1',
        reviewId: 'rev-1',
        logger: activationLogger,
      },
    });

    await handlePublishResponse(mockSql, makeJob());

    expect(mockMaybeCaptureActivationCompleted).toHaveBeenCalledWith(mockSql, {
      responseId: 'resp-1',
      businessId: 'biz-1',
      reviewId: 'rev-1',
      logger: activationLogger,
    });
    expect(mockMaybeCaptureActivationCompleted).toHaveBeenCalledTimes(1);
    expect(mockMarkOutboxCompleted).toHaveBeenCalledWith(mockSql, 'outbox-pub-1', undefined);
    // Contract: activation capture runs before the outbox is marked complete.
    expect(
      mockMaybeCaptureActivationCompleted.mock.invocationCallOrder[0]!,
    ).toBeLessThan(mockMarkOutboxCompleted.mock.invocationCallOrder[0]!);
    expect(mockPostReply).not.toHaveBeenCalled();
  });

  it('routes a marked pending owner-veto state into provider truth recovery before ordinary gates', async () => {
    sqlReturnQueue.push([mockResponseRow({
      status: 'pending_approval',
      approval_method: null,
      approved_text: null,
    })]);
    sqlReturnQueue.push([mockBusinessRow({ archived_at: new Date('2026-07-15T00:00:00Z') })]);
    mockHasAutoPolicyProviderAttemptMarker.mockResolvedValueOnce(true);

    await handlePublishResponse(mockSql, makeJob({
      outbox_id: 'outbox-1',
      outbox_attempt: 3,
    }));

    expect(mockPublishAutoPolicyResponse).toHaveBeenCalledWith(
      mockSql,
      expect.objectContaining({
        responseId: 'resp-1',
        approvedText: '',
        outboxId: 'outbox-1',
        outboxAttempt: 3,
      }),
    );
    expect(mockMarkOutboxCompleted).not.toHaveBeenCalled();
    expect(mockPostReply).not.toHaveBeenCalled();
  });

  it('dispatches when flag on AND posting_error is an orphan marker even with NO posted sibling', async () => {
    process.env.EDIT_REPLIES_ENABLED = 'true';
    pushDispatchBaseSequence({ posting_error: 'pending_after_delete_succeeded' });
    sqlReturnQueue.push([]); // 4: sibling probe → none
    mockLookupZernioReviewId.mockResolvedValueOnce('zernio-rev-id-1');
    mockRunEditPublishIfApplicable.mockResolvedValueOnce({ outcome: 'completed' });

    await handlePublishResponse(mockSql, makeJob());

    expect(mockRunEditPublishIfApplicable).toHaveBeenCalledTimes(1);
    expect(mockRunEditPublishIfApplicable.mock.calls[0]![1]).toMatchObject({
      responsePostingError: 'pending_after_delete_succeeded',
    });
    expect(mockPostReply).not.toHaveBeenCalled();
    expect(mockMarkOutboxCompleted).toHaveBeenCalledWith(mockSql, 'outbox-pub-1', undefined);
  });

  it('does NOT dispatch (uses POST-only path) when flag OFF even if a posted sibling exists', async () => {
    // Flag off → predicate never evaluated, sibling probe never runs.
    pushZernioSuccessSequence();
    mockLookupZernioReviewId.mockResolvedValueOnce('zernio-rev-id-1');
    mockPostReply.mockResolvedValueOnce({
      comment: 'Thank you for your kind review!',
      updateTime: '2026-04-27T00:00:00Z',
    });
    mockListAllReviews.mockResolvedValueOnce([
      makeZernioReview('zernio-rev-id-1', 'Thank you for your kind review!'),
    ]);

    await handlePublishResponse(mockSql, makeJob());

    expect(mockRunEditPublishIfApplicable).not.toHaveBeenCalled();
    expect(mockPostReply).toHaveBeenCalledTimes(1);
    // No sibling-probe SQL was issued.
    const callTexts = (mockSql as any).mock.calls.map(
      (c: any[]) => (c[0] as TemplateStringsArray).join('?'),
    );
    expect(callTexts.some((t: string) => /status = 'posted'[\s\S]*id <>/m.test(t))).toBe(false);
    expect(mockMarkOutboxCompleted).toHaveBeenCalledWith(mockSql, 'outbox-pub-1', undefined);
  });

  it('does NOT dispatch for a normal first publish (flag on, no sibling, no orphan marker)', async () => {
    process.env.EDIT_REPLIES_ENABLED = 'true';
    pushDispatchBaseSequence(); // posting_error defaults to undefined → not orphan
    sqlReturnQueue.push([]);    // 4: sibling probe → none
    sqlReturnQueue.push(Object.assign([], { count: 1 })); // 5: UPDATE posted (POST-only path)
    mockLookupZernioReviewId.mockResolvedValueOnce('zernio-rev-id-1');
    mockPostReply.mockResolvedValueOnce({
      comment: 'Thank you for your kind review!',
      updateTime: '2026-04-27T00:00:00Z',
    });
    mockListAllReviews.mockResolvedValueOnce([
      makeZernioReview('zernio-rev-id-1', 'Thank you for your kind review!'),
    ]);

    await handlePublishResponse(mockSql, makeJob());

    expect(mockRunEditPublishIfApplicable).not.toHaveBeenCalled();
    expect(mockPostReply).toHaveBeenCalledTimes(1);
    expect(mockMarkOutboxCompleted).toHaveBeenCalledWith(mockSql, 'outbox-pub-1', undefined);
  });

  it("'throw' outcome propagates so BullMQ retries", async () => {
    process.env.EDIT_REPLIES_ENABLED = 'true';
    pushDispatchBaseSequence();
    sqlReturnQueue.push([{ id: 'resp-posted-sibling' }]); // sibling found
    mockLookupZernioReviewId.mockResolvedValueOnce('zernio-rev-id-1');
    const retryErr = new PublisherTransientWithContext(
      new ZernioTransientError('http_503', { status: 503, body: 'down' }),
      { response_id: 'resp-1', business_id: 'biz-1', account_id: 'acct-1', location_id: 'loc-1' },
    );
    mockRunEditPublishIfApplicable.mockResolvedValueOnce({ outcome: 'throw', error: retryErr });

    await expect(handlePublishResponse(mockSql, makeJob())).rejects.toBe(retryErr);

    expect(mockPostReply).not.toHaveBeenCalled();
    expect(mockMarkOutboxCompleted).not.toHaveBeenCalled();
    expect(mockMarkOutboxFailed).not.toHaveBeenCalled();
  });

  it("'failed' outcome marks outbox failed", async () => {
    process.env.EDIT_REPLIES_ENABLED = 'true';
    pushDispatchBaseSequence();
    sqlReturnQueue.push([{ id: 'resp-posted-sibling' }]); // sibling found
    mockLookupZernioReviewId.mockResolvedValueOnce('zernio-rev-id-1');
    mockRunEditPublishIfApplicable.mockResolvedValueOnce({
      outcome: 'failed',
      reason: 'zernio_permanent_after_edit_publish',
    });

    await handlePublishResponse(mockSql, makeJob());

    expect(mockPostReply).not.toHaveBeenCalled();
    expect(mockMarkOutboxFailed).toHaveBeenCalledWith(
      mockSql,
      'outbox-pub-1',
      'zernio_permanent_after_edit_publish',
      undefined,
    );
    expect(mockMarkOutboxCompleted).not.toHaveBeenCalled();
  });

  it("'continue_to_fresh' outcome falls through to the POST-only path", async () => {
    process.env.EDIT_REPLIES_ENABLED = 'true';
    pushDispatchBaseSequence();
    sqlReturnQueue.push([{ id: 'resp-posted-sibling' }]); // sibling found → dispatch opens
    sqlReturnQueue.push(Object.assign([], { count: 1 }));  // UPDATE posted (POST-only fall-through)
    mockLookupZernioReviewId.mockResolvedValueOnce('zernio-rev-id-1');
    mockRunEditPublishIfApplicable.mockResolvedValueOnce({ outcome: 'continue_to_fresh' });
    mockPostReply.mockResolvedValueOnce({
      comment: 'Thank you for your kind review!',
      updateTime: '2026-04-27T00:00:00Z',
    });
    mockListAllReviews.mockResolvedValueOnce([
      makeZernioReview('zernio-rev-id-1', 'Thank you for your kind review!'),
    ]);

    await handlePublishResponse(mockSql, makeJob());

    expect(mockRunEditPublishIfApplicable).toHaveBeenCalledTimes(1);
    expect(mockPostReply).toHaveBeenCalledTimes(1);
    expect(mockMarkOutboxCompleted).toHaveBeenCalledWith(mockSql, 'outbox-pub-1', undefined);
    expect(mockMarkOutboxFailed).not.toHaveBeenCalled();
  });
});
