import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Job } from 'bullmq';
import type { PublishResponsePayload } from '../../src/lib/shared/worker-types';
import {
  ZernioAuthError,
  ZernioPermanentError,
  ZernioReplyAlreadyExistsError,
  ZernioReviewNotFoundError,
  ZernioTransientError,
} from '../../src/lib/zernio/errors';
import {
  PublisherTransientWithContext,
  ZernioReplyVerificationIndeterminateError,
} from '../jobs/publisher-error-handlers';

// ── Hoisted state shared between mock factories and tests ──────────────
const {
  sqlReturnQueue,
  mockSql,
  mockMarkOutboxCompleted,
  mockMarkOutboxFailed,
  mockLookupZernioReviewId,
  mockGetCachedZernioReviewPage,
  mockPostReply,
  mockListAllReviews,
} = vi.hoisted(() => {
  const sqlReturnQueue: unknown[] = [];

  const mockSql: any = vi.fn((_s: TemplateStringsArray, ..._v: unknown[]) => {
    const result = sqlReturnQueue.shift() ?? Object.assign([], { count: 0 });
    return Promise.resolve(result);
  });

  mockSql.begin = vi.fn(async (cb: (tx: any) => Promise<any>) => cb(mockSql));

  return {
    sqlReturnQueue,
    mockSql,
    mockMarkOutboxCompleted: vi.fn(),
    mockMarkOutboxFailed: vi.fn(),
    mockLookupZernioReviewId: vi.fn(),
    // getCachedZernioReviewPage defaults to null (cache miss → full 4-page walk).
    mockGetCachedZernioReviewPage: vi.fn().mockResolvedValue(null),
    mockPostReply: vi.fn(),
    mockListAllReviews: vi.fn(),
  };
});

// ── Module mocks ─────────────────────────────────────────────────────────
vi.mock('../../src/lib/db/server', () => ({ sql: mockSql, jsonb: (v: unknown) => v }));
vi.mock('../../src/lib/shared/outbox', () => ({
  markOutboxCompleted: mockMarkOutboxCompleted,
  markOutboxFailed: mockMarkOutboxFailed,
  extractOutboxHandle: (d: any, fallback: string) => ({
    outboxId: (d && typeof d.outbox_id === 'string') ? d.outbox_id : fallback,
    attempt: (d && typeof d.outbox_attempt === 'number') ? d.outbox_attempt : undefined,
  }),
}));
vi.mock('../../src/lib/publishing/zernio-publisher', () => ({
  lookupZernioReviewId: mockLookupZernioReviewId,
  getCachedZernioReviewPage: mockGetCachedZernioReviewPage,
}));
vi.mock('../../src/lib/zernio/client', () => ({
  zernioClient: { postReply: mockPostReply, listAllReviews: mockListAllReviews },
}));
vi.mock('uuid', () => ({ v7: vi.fn(() => 'test-uuid') }));

import { handlePublishResponse } from '../jobs/ResponsePublisherWorker';

// ── Helpers ──────────────────────────────────────────────────────────────

function makeJob(): Job<PublishResponsePayload> {
  return {
    data: { response_id: 'resp-1', business_id: 'biz-1' },
    id: 'outbox-pub-1',
  } as Job<PublishResponsePayload>;
}

function mockResponseRow(overrides: Record<string, unknown> = {}) {
  return {
    id: 'resp-1', review_id: 'rev-1', business_id: 'biz-1',
    approved_text: 'Thank you for your kind review!', status: 'approved',
    ...overrides,
  };
}

function mockBusinessRow(overrides: Record<string, unknown> = {}) {
  return {
    id: 'biz-1', name: 'Test Biz', subscription_status: 'active',
    updated_at: new Date(),
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
  });

  // ── Steps 1–3 unchanged behavior ────────────────────────────────────

  it('completes outbox without action when response already posted', async () => {
    sqlReturnQueue.push([mockResponseRow({ status: 'posted' })]);
    sqlReturnQueue.push([mockBusinessRow()]);

    await handlePublishResponse(makeJob());

    expect(mockLookupZernioReviewId).not.toHaveBeenCalled();
    expect(mockPostReply).not.toHaveBeenCalled();
    expect(mockMarkOutboxCompleted).toHaveBeenCalledWith('outbox-pub-1', undefined);
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

    await handlePublishResponse(makeJob());

    expect(mockLookupZernioReviewId).not.toHaveBeenCalled();
    expect(mockPostReply).not.toHaveBeenCalled();
    expect(mockMarkOutboxCompleted).toHaveBeenCalledWith('outbox-pub-1', undefined);
    expect(mockMarkOutboxFailed).not.toHaveBeenCalled();
  });

  it('completes outbox without action when subscription is cancelled', async () => {
    sqlReturnQueue.push([mockResponseRow()]);
    sqlReturnQueue.push([mockBusinessRow({ subscription_status: 'cancelled' })]);

    await handlePublishResponse(makeJob());

    expect(mockLookupZernioReviewId).not.toHaveBeenCalled();
    expect(mockPostReply).not.toHaveBeenCalled();
    expect(mockMarkOutboxCompleted).toHaveBeenCalledWith('outbox-pub-1', undefined);
  });

  it('marks outbox failed when response not found', async () => {
    sqlReturnQueue.push([]);  // response query returns empty

    await handlePublishResponse(makeJob());

    expect(mockMarkOutboxFailed).toHaveBeenCalledWith(
      'outbox-pub-1',
      'response_not_found: resp-1',
      undefined,
    );
  });

  it('marks outbox failed on business_id mismatch', async () => {
    sqlReturnQueue.push([mockResponseRow({ business_id: 'biz-other' })]);

    await handlePublishResponse(makeJob());

    expect(mockMarkOutboxFailed).toHaveBeenCalledWith(
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

    await handlePublishResponse(makeJob());

    expect(mockLookupZernioReviewId).not.toHaveBeenCalled();
    expect(mockPostReply).not.toHaveBeenCalled();
    expect(mockMarkOutboxCompleted).toHaveBeenCalledWith('outbox-pub-1', undefined);

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

    await handlePublishResponse(makeJob());

    expect(mockMarkOutboxCompleted).toHaveBeenCalledWith('outbox-pub-1', undefined);
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

    await handlePublishResponse(makeJob());

    expect(mockLookupZernioReviewId).toHaveBeenCalledWith('biz-1', 'rev-1', 'acct-1', 'loc-1');
    expect(mockPostReply).toHaveBeenCalledWith('acct-1', 'zernio-rev-id-1', {
      comment: 'Thank you for your kind review!',
    });
    expect(mockMarkOutboxCompleted).toHaveBeenCalledWith('outbox-pub-1', undefined);
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

    await handlePublishResponse(makeJob());

    expect(mockPostReply).not.toHaveBeenCalled();
    expect(mockMarkOutboxCompleted).toHaveBeenCalledWith('outbox-pub-1', undefined);

    const callTexts = (mockSql as any).mock.calls.map(
      (c: any[]) => (c[0] as TemplateStringsArray).join('?'),
    );
    expect(callTexts.some((t: string) => /zernio_review_id_mismatch/.test(t))).toBe(true);
    expect(callTexts.some((t: string) => /notify_admin_review_exception/.test(t))).toBe(true);
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

    await handlePublishResponse(makeJob());

    expect(mockMarkOutboxCompleted).toHaveBeenCalledWith('outbox-pub-1', undefined);
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

    await handlePublishResponse(makeJob());

    expect(mockMarkOutboxCompleted).toHaveBeenCalledWith('outbox-pub-1', undefined);

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

    await handlePublishResponse(makeJob());

    expect(mockMarkOutboxCompleted).toHaveBeenCalledWith('outbox-pub-1', undefined);
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

    await handlePublishResponse(makeJob());

    expect(mockMarkOutboxCompleted).toHaveBeenCalledWith('outbox-pub-1', undefined);
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

    await expect(handlePublishResponse(makeJob())).rejects.toBeInstanceOf(PublisherTransientWithContext);

    expect(mockMarkOutboxCompleted).not.toHaveBeenCalled();
    expect(mockMarkOutboxFailed).not.toHaveBeenCalled();
  });

  it('re-throws unexpected non-Zernio errors so BullMQ retries', async () => {
    sqlReturnQueue.push([mockResponseRow()]);
    sqlReturnQueue.push([mockBusinessRow()]);
    sqlReturnQueue.push([mockZernioConnectionRow()]);

    mockLookupZernioReviewId.mockResolvedValueOnce('zernio-rev-id-1');
    mockPostReply.mockRejectedValueOnce(new Error('unexpected network kaboom'));

    await expect(handlePublishResponse(makeJob())).rejects.toThrow('unexpected network kaboom');
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

    await handlePublishResponse(makeJob());

    expect(mockMarkOutboxCompleted).toHaveBeenCalledWith('outbox-pub-1', undefined);
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

    await expect(handlePublishResponse(makeJob())).rejects.toMatchObject({
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

    await expect(handlePublishResponse(makeJob())).rejects.toMatchObject({
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

    await handlePublishResponse(makeJob());

    expect(mockMarkOutboxCompleted).toHaveBeenCalledWith('outbox-pub-1', undefined);
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

    const err = await handlePublishResponse(makeJob()).catch((e) => e);

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

    await handlePublishResponse(makeJob());

    expect(mockMarkOutboxCompleted).toHaveBeenCalledWith('outbox-pub-1', undefined);
    const callTexts = (mockSql as any).mock.calls.map(
      (c: any[]) => (c[0] as TemplateStringsArray).join('?'),
    );
    expect(callTexts.some((t: string) => /SET status = 'posted'/.test(t))).toBe(true);
    expect(callTexts.some((t: string) => /superseded/.test(t))).toBe(false);
  });
});
