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
    id: 'biz-1', name: 'Test Biz', subscription_status: 'active',
    account_updated_at: new Date(), archived_at: null,
    ...overrides,
  };
}

function mockZernioConnectionRow() {
  return { zernio_account_id: 'acct-1', zernio_location_id: 'loc-1' };
}

// Notice-delivery gate fixtures (veto-window-gate.ts): first delivered notice
// 16 minutes ago against a 15-minute granted window → full window elapsed.
// The gate issues TWO queries: the MIN(sent_at) aggregate, then the audit
// grant-window lookup.
function pushGateWindowElapsedRows() {
  sqlReturnQueue.push([{ first_sent: new Date(Date.now() - 16 * 60 * 1000), db_now: new Date() }]);
  sqlReturnQueue.push([{ veto_window_minutes: 15 }]);
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
    ['approved'],
    ['edited'],
    ['awaiting_owner_connect'],
  ])('downgrades auto-policy %s rows to owner review when runtime flag is off', async (status) => {
    sqlReturnQueue.push([mockResponseRow({ status, approval_method: 'auto_policy' })]);
    sqlReturnQueue.push([mockBusinessRow()]);
    sqlReturnQueue.push([{ review_id: 'rev-1' }]); // unlocked response pre-read
    sqlReturnQueue.push([{ id: 'rev-1' }]); // reviews lock anchor
    sqlReturnQueue.push([{ id: 'biz-1' }]); // businesses lock
    sqlReturnQueue.push([{ status, approval_method: 'auto_policy' }]); // response lock
    sqlReturnQueue.push([{ id: 'resp-1' }]); // downgrade UPDATE RETURNING
    sqlReturnQueue.push([{ account_id: 'acc-1' }]); // audit account lookup
    sqlReturnQueue.push([]); // audit INSERT
    sqlReturnQueue.push([]); // send_notification INSERT

    await handlePublishResponse(mockSql, makeJob({
      correlation_id: 'corr-1',
      outbox_id: 'outbox-auto-1',
      outbox_attempt: 2,
    }));

    expect(mockLookupZernioReviewId).not.toHaveBeenCalled();
    expect(mockPostReply).not.toHaveBeenCalled();
    expect(mockMarkOutboxCompletedIfOwned).toHaveBeenCalledWith(
      mockSql,
      'outbox-auto-1',
      2,
    );

    const calls = (mockSql as any).mock.calls as unknown[][];
    const downgradeCall = calls.find((call) => {
      const text = (call[0] as TemplateStringsArray).join('|');
      return text.includes('UPDATE responses') && text.includes("status = 'pending_approval'");
    });
    expect(downgradeCall).toBeDefined();
    expect(downgradeCall).toContain('auto_policy_revoked_by_kill_switch');
    expect(downgradeCall).toContain('auto_policy');

    const auditCall = calls.find((call) =>
      (call[0] as TemplateStringsArray).join('|').includes('approval_audit_log'),
    );
    expect(auditCall).toBeDefined();
    expect(auditCall).toContain('auto_policy_revoked_by_kill_switch');
    const auditMetadata = auditCall!.find(
      (arg): arg is Record<string, unknown> =>
        !!arg && typeof arg === 'object' && !Array.isArray(arg) && 'downgrade_reason' in arg,
    );
    expect(auditMetadata).toEqual({
      correlation_id: 'corr-1',
      downgrade_reason: 'auto_approval_disabled',
      outbox_attempt: 2,
      outbox_id: 'outbox-auto-1',
      runtime_enabled: false,
    });

    const notifyCall = calls.find((call) => {
      const text = (call[0] as TemplateStringsArray).join('|');
      return text.includes('INSERT INTO job_outbox') && call.includes('send_notification');
    });
    expect(notifyCall).toBeDefined();
    const notifyPayload = notifyCall!.find(
      (arg): arg is Record<string, unknown> =>
        !!arg && typeof arg === 'object' && !Array.isArray(arg) && 'response_id' in arg,
    );
    expect(notifyPayload).toEqual({
      business_id: 'biz-1',
      correlation_id: 'corr-1',
      response_id: 'resp-1',
    });
  });

  it('completes publish outbox without notification when auto-policy downgrade row is already gone', async () => {
    sqlReturnQueue.push([mockResponseRow({ approval_method: 'auto_policy' })]);
    sqlReturnQueue.push([mockBusinessRow()]);
    sqlReturnQueue.push([]); // anchor pre-read: response disappeared

    await handlePublishResponse(mockSql, makeJob());

    const callTexts = (mockSql as any).mock.calls.map(
      (c: any[]) => (c[0] as TemplateStringsArray).join('?'),
    );
    expect(callTexts.some((t: string) => /approval_audit_log/.test(t))).toBe(false);
    expect(callTexts.some((t: string) => /send_notification/.test(t))).toBe(false);
    expect(mockLookupZernioReviewId).not.toHaveBeenCalled();
    expect(mockPostReply).not.toHaveBeenCalled();
    expect(mockMarkOutboxCompletedIfOwned).toHaveBeenCalledWith(
      mockSql,
      'outbox-pub-1',
      undefined,
    );
  });

  it('downgrades auto-policy rows before archived-location terminal handling', async () => {
    sqlReturnQueue.push([mockResponseRow({ approval_method: 'auto_policy' })]);
    sqlReturnQueue.push([mockBusinessRow({ archived_at: new Date('2026-05-09T00:00:00Z') })]);
    sqlReturnQueue.push([{ review_id: 'rev-1' }]);
    sqlReturnQueue.push([{ id: 'rev-1' }]);
    sqlReturnQueue.push([{ id: 'biz-1' }]);
    sqlReturnQueue.push([{ status: 'approved', approval_method: 'auto_policy' }]);
    sqlReturnQueue.push([{ id: 'resp-1' }]);
    sqlReturnQueue.push([{ account_id: 'acc-1' }]);
    sqlReturnQueue.push([]);
    sqlReturnQueue.push([]);

    await handlePublishResponse(mockSql, makeJob());

    const callTexts = (mockSql as any).mock.calls.map(
      (c: any[]) => (c[0] as TemplateStringsArray).join('?'),
    );
    expect(callTexts.some((t: string) => /pending_approval/.test(t))).toBe(true);
    expect((mockSql as any).mock.calls.some((call: unknown[]) => call.includes('send_notification'))).toBe(true);
    expect(mockMarkOutboxCompletedIfOwned).toHaveBeenCalledWith(
      mockSql,
      'outbox-pub-1',
      undefined,
    );
    expect(mockLookupZernioReviewId).not.toHaveBeenCalled();
  });

  it('preserves archived-location terminal behavior for auto-policy rows while runtime flag is on', async () => {
    vi.stubEnv('AUTO_APPROVAL_ENABLED', 'true');
    sqlReturnQueue.push([mockResponseRow({ approval_method: 'auto_policy' })]);
    sqlReturnQueue.push([mockBusinessRow({ archived_at: new Date('2026-05-09T00:00:00Z') })]);
    pushGateWindowElapsedRows(); // notice-delivery gate → delivered + window elapsed

    await handlePublishResponse(mockSql, makeJob());

    const callTexts = (mockSql as any).mock.calls.map(
      (c: any[]) => (c[0] as TemplateStringsArray).join('?'),
    );
    expect(callTexts.some((t: string) => /pending_approval/.test(t))).toBe(false);
    expect(mockLookupZernioReviewId).not.toHaveBeenCalled();
    expect(mockPostReply).not.toHaveBeenCalled();
    expect(mockMarkOutboxCompleted).toHaveBeenCalledWith(mockSql, 'outbox-pub-1', undefined);
  });

  // ── Notice-delivery gate (spec §2.11): flag ON + auto_policy ─────────
  // An unnotified auto-post fails toward the owner: zero DELIVERED
  // pending_post_notice rows at publish time ⇒ downgrade, never post.

  it('downgrades auto-policy rows when NO pending-post notice was delivered (flag on)', async () => {
    vi.stubEnv('AUTO_APPROVAL_ENABLED', 'true');
    sqlReturnQueue.push([mockResponseRow({ approval_method: 'auto_policy' })]); // 1: response
    sqlReturnQueue.push([mockBusinessRow()]);                                    // 2: business
    sqlReturnQueue.push([{ first_sent: null, db_now: new Date() }]);            // 3: notice-delivery gate → zero delivered
    sqlReturnQueue.push([{ review_id: 'rev-1' }]);                               // 4: unlocked response pre-read
    sqlReturnQueue.push([{ id: 'rev-1' }]);                                      // 5: reviews lock anchor
    sqlReturnQueue.push([{ id: 'biz-1' }]);                                      // 6: businesses lock
    sqlReturnQueue.push([{ status: 'approved', approval_method: 'auto_policy' }]); // 7: response lock
    sqlReturnQueue.push([{ id: 'resp-1' }]);                                     // 8: downgrade UPDATE RETURNING
    sqlReturnQueue.push([{ account_id: 'acc-1' }]);                              // 9: audit account lookup
    sqlReturnQueue.push([]);                                                     // 10: audit INSERT
    sqlReturnQueue.push([]);                                                     // 11: send_notification INSERT

    await handlePublishResponse(mockSql, makeJob({
      correlation_id: 'corr-notice-1',
      outbox_id: 'outbox-notice-1',
      outbox_attempt: 1,
    }));

    expect(mockLookupZernioReviewId).not.toHaveBeenCalled();
    expect(mockPostReply).not.toHaveBeenCalled();
    expect(mockMarkOutboxCompletedIfOwned).toHaveBeenCalledWith(
      mockSql,
      'outbox-notice-1',
      1,
    );

    const calls = (mockSql as any).mock.calls as unknown[][];
    const gateCall = calls.find((call) =>
      (call[0] as TemplateStringsArray).join('|').includes('notification_deliveries'),
    );
    expect(gateCall).toBeDefined();
    expect((gateCall![0] as TemplateStringsArray).join('|')).toContain("template = 'pending_post_notice'");
    expect((gateCall![0] as TemplateStringsArray).join('|')).toContain('sent_at IS NOT NULL');

    const downgradeCall = calls.find((call) => {
      const text = (call[0] as TemplateStringsArray).join('|');
      return text.includes('UPDATE responses') && text.includes("status = 'pending_approval'");
    });
    expect(downgradeCall).toBeDefined();
    expect(downgradeCall).toContain('auto_post_notice_undelivered');

    const auditCall = calls.find((call) =>
      (call[0] as TemplateStringsArray).join('|').includes('INSERT INTO approval_audit_log'),
    );
    expect(auditCall).toBeDefined();
    expect(auditCall).toContain('auto_post_notice_undelivered');
    const auditMetadata = auditCall!.find(
      (arg): arg is Record<string, unknown> =>
        !!arg && typeof arg === 'object' && !Array.isArray(arg) && 'downgrade_reason' in arg,
    );
    expect(auditMetadata).toEqual({
      correlation_id: 'corr-notice-1',
      downgrade_reason: 'notice_undelivered',
      outbox_attempt: 1,
      outbox_id: 'outbox-notice-1',
      runtime_enabled: true,
    });

    const notifyCall = calls.find((call) => {
      const text = (call[0] as TemplateStringsArray).join('|');
      return text.includes('INSERT INTO job_outbox') && call.includes('send_notification');
    });
    expect(notifyCall).toBeDefined();
  });

  it('posts auto-policy rows normally when a pending-post notice WAS delivered (flag on)', async () => {
    vi.stubEnv('AUTO_APPROVAL_ENABLED', 'true');
    sqlReturnQueue.push([mockResponseRow({ approval_method: 'auto_policy' })]); // 1: response
    sqlReturnQueue.push([mockBusinessRow()]);                                    // 2: business
    pushGateWindowElapsedRows();                                                 // 3: notice-delivery gate → delivered + elapsed
    sqlReturnQueue.push([mockZernioConnectionRow()]);                            // 4: zernio_connections
    sqlReturnQueue.push([]);                                                     // 5: markPosted reviews FOR UPDATE lock
    sqlReturnQueue.push([{ id: 'resp-1', approval_method: 'auto_policy' }]);     // 6: markPosted UPDATE ... RETURNING
    sqlReturnQueue.push([]);                                                     // 7: findActiveReviewRun → no run
    sqlReturnQueue.push(Object.assign([], { count: 0 }));                        // 8: enqueueAutoPostNotice INSERT
    mockLookupZernioReviewId.mockResolvedValueOnce('zernio-rev-id-1');
    mockPostReply.mockResolvedValueOnce({ comment: 'Thank you for your kind review!', updateTime: '2026-04-27T00:00:00Z' });
    mockListAllReviews.mockResolvedValueOnce([
      makeZernioReview('zernio-rev-id-1', 'Thank you for your kind review!'),
    ]);

    await handlePublishResponse(mockSql, makeJob());

    expect(mockApplyJudgeGate).toHaveBeenCalledWith(mockSql, expect.objectContaining({
      responseId: 'resp-1',
      businessId: 'biz-1',
    }));
    expect(mockPostReply).toHaveBeenCalledTimes(1);
    const callTexts = (mockSql as any).mock.calls.map(
      (c: any[]) => (c[0] as TemplateStringsArray).join('?'),
    );
    expect(callTexts.some((t: string) => /pending_approval/.test(t))).toBe(false);
    expect(mockMarkOutboxCompleted).toHaveBeenCalledWith(mockSql, 'outbox-pub-1', undefined);
    expect(mockMarkOutboxFailed).not.toHaveBeenCalled();
  });

  it('stops before external publishing when the post-WS4 Judge gate downgrades', async () => {
    vi.stubEnv('AUTO_APPROVAL_ENABLED', 'true');
    mockApplyJudgeGate.mockResolvedValueOnce('downgraded');
    sqlReturnQueue.push([mockResponseRow({ approval_method: 'auto_policy' })]);
    sqlReturnQueue.push([mockBusinessRow()]);
    pushGateWindowElapsedRows();

    await handlePublishResponse(mockSql, makeJob());

    expect(mockApplyJudgeGate).toHaveBeenCalledTimes(1);
    expect(mockLookupZernioReviewId).not.toHaveBeenCalled();
    expect(mockPostReply).not.toHaveBeenCalled();
  });

  // ── Elapsed-window enforcement: a late notice pushes the deadline ─────
  // The gate guarantees a FULL veto window since the FIRST delivery. A
  // late-delivered notice must not shrink the owner's window: push
  // auto_post_scheduled_at to first_sent + granted window, complete the
  // current outbox row, and re-enqueue the publish at the new deadline.

  it('pushes the deadline instead of posting when the notice was delivered late (window not elapsed)', async () => {
    vi.stubEnv('AUTO_APPROVAL_ENABLED', 'true');
    const firstSent = new Date('2026-07-12T10:05:00Z');
    const anchoredDeadline = new Date('2026-07-12T10:20:00Z');
    sqlReturnQueue.push([mockResponseRow({ approval_method: 'auto_policy' })]); // 1: response
    sqlReturnQueue.push([mockBusinessRow()]);                                    // 2: business
    sqlReturnQueue.push([{
      first_sent: firstSent, db_now: new Date('2026-07-12T10:06:00Z'),
    }]);                                                                         // 3: gate → late notice (window ends 10:20)
    sqlReturnQueue.push([{ veto_window_minutes: 15 }]);                          // 4: audit grant-window lookup
    sqlReturnQueue.push([{ auto_post_scheduled_at: anchoredDeadline }]);         // 5: push UPDATE RETURNING
    sqlReturnQueue.push(Object.assign([], { count: 1 }));                        // 6: enqueuePublishResponse INSERT

    await handlePublishResponse(mockSql, makeJob({
      correlation_id: 'corr-late-1',
      outbox_id: 'outbox-late-1',
      outbox_attempt: 1,
    }));

    expect(mockLookupZernioReviewId).not.toHaveBeenCalled();
    expect(mockPostReply).not.toHaveBeenCalled();
    // Current outbox row completed inside the push tx (tx == mockSql here).
    expect(mockMarkOutboxCompleted).toHaveBeenCalledWith(mockSql, 'outbox-late-1', 1);
    expect(mockMarkOutboxFailed).not.toHaveBeenCalled();

    const calls = (mockSql as any).mock.calls as unknown[][];
    const pushCall = calls.find((call) => {
      const text = (call[0] as TemplateStringsArray).join('|');
      return text.includes('UPDATE responses') && text.includes('auto_post_scheduled_at =');
    });
    expect(pushCall).toBeDefined();
    // Absolute anchored deadline bound (first_sent + granted window), guarded
    // to still-approved auto_policy rows only.
    const boundDeadline = pushCall!.find((value): value is Date => value instanceof Date);
    expect(boundDeadline?.getTime()).toBe(anchoredDeadline.getTime());
    expect((pushCall![0] as TemplateStringsArray).join('|')).toContain("status = 'approved'");

    const enqueueCall = calls.find((call) => {
      const text = (call[0] as TemplateStringsArray).join('|');
      return text.includes('INSERT INTO job_outbox') && text.includes("topic = 'publish_response'");
    });
    expect(enqueueCall).toBeDefined();
    // availableAt binding = the pushed deadline.
    expect(enqueueCall).toContain(anchoredDeadline);

    // Never downgraded: the owner WAS notified — the countdown just started late.
    const callTexts = calls.map((c) => (c[0] as TemplateStringsArray).join('?'));
    expect(callTexts.some((t: string) => /pending_approval/.test(t))).toBe(false);
  });

  it('completes outbox without re-enqueue when the deadline push loses the state race (retry-safe)', async () => {
    vi.stubEnv('AUTO_APPROVAL_ENABLED', 'true');
    sqlReturnQueue.push([mockResponseRow({ approval_method: 'auto_policy' })]); // 1: response
    sqlReturnQueue.push([mockBusinessRow()]);                                    // 2: business
    sqlReturnQueue.push([{
      first_sent: new Date('2026-07-12T10:05:00Z'), db_now: new Date('2026-07-12T10:06:00Z'),
    }]);                                                                         // 3: gate → late notice
    sqlReturnQueue.push([{ veto_window_minutes: 15 }]);                          // 4: audit grant-window lookup
    sqlReturnQueue.push([]);                                                     // 5: push UPDATE → 0 rows (state changed)

    await handlePublishResponse(mockSql, makeJob({
      outbox_id: 'outbox-late-2',
      outbox_attempt: 2,
    }));

    expect(mockPostReply).not.toHaveBeenCalled();
    expect(mockMarkOutboxCompleted).toHaveBeenCalledWith(mockSql, 'outbox-late-2', 2);
    const callTexts = ((mockSql as any).mock.calls as unknown[][]).map(
      (c) => (c[0] as TemplateStringsArray).join('?'),
    );
    expect(callTexts.some((t: string) => /INSERT INTO job_outbox/.test(t))).toBe(false);
    expect(callTexts.some((t: string) => /pending_approval/.test(t))).toBe(false);
  });

  it('throws when a delivered notice exists but the approval audit window is missing', async () => {
    vi.stubEnv('AUTO_APPROVAL_ENABLED', 'true');
    sqlReturnQueue.push([mockResponseRow({ approval_method: 'auto_policy' })]); // 1: response
    sqlReturnQueue.push([mockBusinessRow()]);                                    // 2: business
    sqlReturnQueue.push([{
      first_sent: new Date('2026-07-12T10:05:00Z'), db_now: new Date('2026-07-12T10:06:00Z'),
    }]);                                                                         // 3: gate → delivered notice
    sqlReturnQueue.push([]);                                                     // 4: audit grant-window lookup → missing (impossible state)

    await expect(handlePublishResponse(mockSql, makeJob())).rejects.toThrow(
      /Invariant violation: auto_policy response resp-1/,
    );
    expect(mockPostReply).not.toHaveBeenCalled();
    expect(mockMarkOutboxCompleted).not.toHaveBeenCalled();
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

  it('fresh 2xx success for an auto_policy response enqueues the auto-post FYI exactly once', async () => {
    process.env.AUTO_APPROVAL_ENABLED = 'true'; // else the auto_policy row is downgraded, not published
    sqlReturnQueue.push([mockResponseRow({ approval_method: 'auto_policy' })]); // 1: response
    sqlReturnQueue.push([mockBusinessRow()]);                                    // 2: business
    pushGateWindowElapsedRows();                                                 // 2b: notice-delivery gate → delivered + elapsed
    sqlReturnQueue.push([mockZernioConnectionRow()]);                            // 3: zernio_connections
    sqlReturnQueue.push([]);                                                      // 4: markPosted reviews FOR UPDATE lock
    sqlReturnQueue.push([{ id: 'resp-1', approval_method: 'auto_policy' }]);      // 5: markPosted UPDATE ... RETURNING (1 row transitioned)
    sqlReturnQueue.push([]);                                                      // 6: findActiveReviewRun → no run (legacy review)
    sqlReturnQueue.push(Object.assign([], { count: 0 }));                         // 7: enqueueAutoPostNotice INSERT
    mockLookupZernioReviewId.mockResolvedValueOnce('zernio-rev-id-1');
    mockPostReply.mockResolvedValueOnce({ comment: 'Thank you for your kind review!', updateTime: '2026-04-27T00:00:00Z' });
    mockListAllReviews.mockResolvedValueOnce([
      makeZernioReview('zernio-rev-id-1', 'Thank you for your kind review!'),
    ]);

    await handlePublishResponse(mockSql, makeJob());

    const callTexts = (mockSql as any).mock.calls.map(
      (c: any[]) => (c[0] as TemplateStringsArray).join('?'),
    );
    // The in-flight ON CONFLICT predicate carries the literal topic in the
    // template text, so exactly one enqueue is observable here.
    expect(callTexts.filter((t: string) => /topic = 'auto_post_notice'/.test(t))).toHaveLength(1);
    expect(mockMarkOutboxCompleted).toHaveBeenCalledWith(mockSql, 'outbox-pub-1', undefined);
  });

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

  it('409 recovery for an auto_policy response enqueues the auto-post FYI exactly once', async () => {
    process.env.AUTO_APPROVAL_ENABLED = 'true';
    sqlReturnQueue.push([mockResponseRow({ approval_method: 'auto_policy' })]); // 1: response
    sqlReturnQueue.push([mockBusinessRow()]);                                    // 2: business
    pushGateWindowElapsedRows();                                                 // 2b: notice-delivery gate → delivered + elapsed
    sqlReturnQueue.push([mockZernioConnectionRow()]);                            // 3: zernio_connections
    sqlReturnQueue.push([]);                                                      // 4: markPosted reviews FOR UPDATE lock (inside verify409 begin)
    sqlReturnQueue.push([{ id: 'resp-1', approval_method: 'auto_policy' }]);      // 5: markPosted UPDATE ... RETURNING (inside verify409 begin)
    sqlReturnQueue.push([]);                                                      // 6: findActiveReviewRun → no run (legacy review)
    sqlReturnQueue.push(Object.assign([], { count: 0 }));                         // 7: enqueueAutoPostNotice INSERT
    mockLookupZernioReviewId.mockResolvedValueOnce('zernio-rev-id-1');
    mockPostReply.mockRejectedValueOnce(
      new ZernioReplyAlreadyExistsError({ message: 'reply already exists' }),
    );
    mockListAllReviews.mockResolvedValueOnce([
      makeZernioReview('zernio-rev-id-1', 'Thank you for your kind review!'),
    ]);

    await handlePublishResponse(mockSql, makeJob());

    const callTexts = (mockSql as any).mock.calls.map(
      (c: any[]) => (c[0] as TemplateStringsArray).join('?'),
    );
    expect(callTexts.filter((t: string) => /topic = 'auto_post_notice'/.test(t))).toHaveLength(1);
    expect(mockMarkOutboxCompleted).toHaveBeenCalledWith(mockSql, 'outbox-pub-1', undefined);
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

  it('P1 regression: flag ON + auto_policy + no sibling/orphan → falls through to fresh POST (NO throw) and enqueues the FYI', async () => {
    process.env.EDIT_REPLIES_ENABLED = 'true';
    process.env.AUTO_APPROVAL_ENABLED = 'true';
    sqlReturnQueue.push([mockResponseRow({ approval_method: 'auto_policy' })]); // 1: response
    sqlReturnQueue.push([mockBusinessRow()]);                                    // 2: business
    pushGateWindowElapsedRows();                                                 // 2b: notice-delivery gate → delivered + elapsed
    sqlReturnQueue.push([mockZernioConnectionRow()]);                            // 3: zernio_connections
    sqlReturnQueue.push([]);                                       // 4: sibling probe → none
    sqlReturnQueue.push([]);                                       // 5: markPosted reviews FOR UPDATE lock
    sqlReturnQueue.push([{ id: 'resp-1', approval_method: 'auto_policy' }]); // 6: markPosted UPDATE ... RETURNING
    sqlReturnQueue.push([]);                                       // 7: findActiveReviewRun → no run (legacy review)
    sqlReturnQueue.push(Object.assign([], { count: 0 }));          // 8: enqueueAutoPostNotice INSERT
    mockLookupZernioReviewId.mockResolvedValueOnce('zernio-rev-id-1');
    mockPostReply.mockResolvedValueOnce({ comment: 'Thank you for your kind review!', updateTime: '2026-04-27T00:00:00Z' });
    mockListAllReviews.mockResolvedValueOnce([
      makeZernioReview('zernio-rev-id-1', 'Thank you for your kind review!'),
    ]);

    // Must NOT throw the edit-publish invariant assertion: auto_policy never
    // entered the edit path (no sibling, no orphan), so it falls through to the
    // fresh POST. (The assertion now lives INSIDE the edit-path branch.)
    await handlePublishResponse(mockSql, makeJob());

    expect(mockRunEditPublishIfApplicable).not.toHaveBeenCalled();
    expect(mockPostReply).toHaveBeenCalledTimes(1);
    const callTexts = (mockSql as any).mock.calls.map(
      (c: any[]) => (c[0] as TemplateStringsArray).join('?'),
    );
    expect(callTexts.filter((t: string) => /topic = 'auto_post_notice'/.test(t))).toHaveLength(1);
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
