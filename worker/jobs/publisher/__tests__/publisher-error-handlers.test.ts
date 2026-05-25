import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@/lib/db/server', () => ({
  sql: Object.assign(
    vi.fn((_s: TemplateStringsArray, ..._v: unknown[]) => Promise.resolve(Object.assign([], { count: 0 }))),
    { begin: vi.fn() },
  ),
  jsonb: (v: unknown) => v,
}));
vi.mock('@/lib/shared/outbox', () => ({
  markOutboxCompleted: vi.fn(),
}));
vi.mock('@/lib/zernio/client', () => ({
  zernioClient: {
    listAllReviews: vi.fn(),
  },
}));
vi.mock('@/lib/publishing/zernio-publisher', () => ({
  getCachedZernioReviewPage: vi.fn().mockResolvedValue(null),
}));
vi.mock('../activation', () => ({
  maybeCaptureActivationCompleted: vi.fn().mockResolvedValue(undefined),
}));
vi.mock('@sentry/node', () => ({
  captureMessage: vi.fn(),
}));

import {
  handlePublisherAuthErrorTerminal,
  handlePublisherPermanentErrorTerminal,
  PublisherTransientWithContext,
  ZernioReplyVerificationIndeterminateError,
  verify409AndDispose,
  verify409InTx,
} from '../publisher-error-handlers';
import {
  ZernioTransientError,
  ZernioAuthError,
  ZernioPermanentError,
  ZernioValidationError,
} from '@/lib/zernio/errors';
import { maybeCaptureActivationCompleted } from '../activation';

const mkLogger = () => ({ log: vi.fn(), warn: vi.fn(), error: vi.fn() });

const mkTaggedResult = <T = unknown>(rows: T[]) => {
  const arr = rows as unknown as T[] & { count: number };
  arr.count = rows.length;
  return arr;
};

describe('PublisherTransientWithContext', () => {
  it('subclasses ZernioTransientError (instanceof check passes)', () => {
    const inner = new ZernioTransientError('timeout', { httpStatus: 504 });
    const wrapped = new PublisherTransientWithContext(inner, {
      response_id: 'R', business_id: 'B', account_id: 'A', location_id: 'L',
    });
    expect(wrapped instanceof ZernioTransientError).toBe(true);
  });

  it('forwards inner.kind to super constructor', () => {
    const inner = new ZernioTransientError('http_5xx', { httpStatus: 503 });
    const wrapped = new PublisherTransientWithContext(inner, {
      response_id: 'R', business_id: 'B', account_id: 'A', location_id: 'L',
    });
    expect(wrapped.kind).toBe('http_5xx');
  });

  it('exposes attemptContext for failed-hook unwrap', () => {
    const wrapped = new PublisherTransientWithContext(
      new ZernioTransientError('network_error', {}),
      { response_id: 'R', business_id: 'B', account_id: 'A', location_id: 'L' },
    );
    expect(wrapped.attemptContext).toEqual({
      response_id: 'R', business_id: 'B', account_id: 'A', location_id: 'L',
    });
  });
});

describe('ZernioReplyVerificationIndeterminateError', () => {
  it('carries meta with reason + ids + optional underlying_error', () => {
    const e = new ZernioReplyVerificationIndeterminateError({
      response_id: 'R', business_id: 'B', review_id: 'rev', account_id: 'A',
      location_id: 'L', zernio_review_id: 'zr', reason: 'verifier_unknown_error',
      underlying_error: 'connection refused',
    });
    expect(e.meta.reason).toBe('verifier_unknown_error');
    expect(e.meta.underlying_error).toBe('connection refused');
  });
});

describe('handlePublisherAuthErrorTerminal', () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  it('happy path: response → awaiting_owner_connect, both notify rows enqueued', async () => {
    const { sql } = await import('@/lib/db/server');
    const { markOutboxCompleted } = await import('@/lib/shared/outbox');

    let callIdx = 0;
    const tx = vi.fn((_s: TemplateStringsArray, ..._v: unknown[]) => {
      callIdx += 1;
      // Call 1: UPDATE zernio_connections RETURNING 1 → 1 row.
      if (callIdx === 1) return Promise.resolve(mkTaggedResult([{ '?column?': 1 }]));
      // Call 2: UPDATE responses RETURNING review_id → 1 row.
      if (callIdx === 2) return Promise.resolve(mkTaggedResult([{ review_id: 'rev-1' }]));
      // Calls 3-4: INSERT job_outbox rows.
      return Promise.resolve(mkTaggedResult([]));
    });
    (sql as any).begin = vi.fn(async (cb: any) => cb(tx));

    await handlePublisherAuthErrorTerminal({
      response_id: 'R', business_id: 'B', account_id: 'A', location_id: 'L',
      error_body: '401 expired', outboxId: 'outbox-1', outboxAttempt: 1, logger: mkLogger() as any,
    });

    expect(callIdx).toBe(4);  // disconnect, park, notify_reconnect, notify_lost
    expect(markOutboxCompleted).toHaveBeenCalledWith('outbox-1', 1);
  });

  it('skips notify enqueue when response already terminal', async () => {
    const { sql } = await import('@/lib/db/server');
    let callIdx = 0;
    const tx = vi.fn((_s: TemplateStringsArray, ..._v: unknown[]) => {
      callIdx += 1;
      if (callIdx === 1) return Promise.resolve(mkTaggedResult([{ '?column?': 1 }]));
      // Park returns empty (already terminal)
      if (callIdx === 2) return Promise.resolve(mkTaggedResult([]));
      return Promise.resolve(mkTaggedResult([]));
    });
    (sql as any).begin = vi.fn(async (cb: any) => cb(tx));

    await handlePublisherAuthErrorTerminal({
      response_id: 'R', business_id: 'B', account_id: 'A', location_id: 'L',
      error_body: '401', outboxId: 'outbox-1', outboxAttempt: 1, logger: mkLogger() as any,
    });
    expect(callIdx).toBe(2);  // disconnect + park; no notify enqueues
  });

  it('connection already disconnected → still parks response + reconnect notify, but NO connection_lost', async () => {
    const { sql } = await import('@/lib/db/server');
    let callIdx = 0;
    const tx = vi.fn((_s: TemplateStringsArray, ..._v: unknown[]) => {
      callIdx += 1;
      // Disconnect returns count=0 (already disconnected)
      if (callIdx === 1) return Promise.resolve(mkTaggedResult([]));
      if (callIdx === 2) return Promise.resolve(mkTaggedResult([{ review_id: 'rev-1' }]));
      return Promise.resolve(mkTaggedResult([]));
    });
    (sql as any).begin = vi.fn(async (cb: any) => cb(tx));

    await handlePublisherAuthErrorTerminal({
      response_id: 'R', business_id: 'B', account_id: 'A', location_id: 'L',
      error_body: '401', outboxId: 'outbox-1', outboxAttempt: 1, logger: mkLogger() as any,
    });
    expect(callIdx).toBe(3);  // disconnect (no-op), park, notify_reconnect — NOT lost
  });

  it('disconnect SQL pins by account_id AND location_id (regression for round-10)', async () => {
    const { sql } = await import('@/lib/db/server');
    let disconnectSql = '';
    let callIdx = 0;
    const tx = vi.fn((strings: TemplateStringsArray, ..._v: unknown[]) => {
      callIdx += 1;
      if (callIdx === 1) disconnectSql = strings.join('');
      return Promise.resolve(mkTaggedResult([]));
    });
    (sql as any).begin = vi.fn(async (cb: any) => cb(tx));

    await handlePublisherAuthErrorTerminal({
      response_id: 'R', business_id: 'B', account_id: 'A', location_id: 'L',
      error_body: '401', outboxId: 'outbox-1', outboxAttempt: 1, logger: mkLogger() as any,
    });
    expect(disconnectSql).toContain('zernio_account_id');
    expect(disconnectSql).toContain('zernio_location_id');
    expect(disconnectSql).toContain('disconnect_reason');
    expect(disconnectSql).toContain("'auth_error_on_publish'");
  });
});

describe('verify409AndDispose', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    vi.mocked(maybeCaptureActivationCompleted).mockResolvedValue(undefined);
  });

  const baseArgs = {
    response_id: 'R',
    business_id: 'B',
    review_id: 'rev',
    account_id: 'acct',
    location_id: 'loc',
    zernio_review_id: 'zr-1',
    approved_text: 'Thank you!',
    outboxId: 'outbox-1',
    outboxAttempt: 1 as number | undefined,
    logger: { log: vi.fn(), warn: vi.fn(), error: vi.fn() } as any,
  };

  function makeZernioReviewWith(replyComment: string | null) {
    return {
      id: 'zr-1',
      name: 'accounts/acct/locations/loc/reviews/zr-1',
      reviewer: { displayName: 'Alice', profilePhotoUrl: null, isAnonymous: false },
      rating: 5,
      starRating: 'FIVE' as const,
      comment: 'Great!',
      createTime: '2026-04-26T12:00:00Z',
      updateTime: '2026-04-26T12:00:00Z',
      reviewReply: replyComment !== null
        ? { comment: replyComment, updateTime: '2026-04-27T00:00:00Z' }
        : null,
    };
  }

  it('happy path posted: text match → UPDATE posted + markOutboxCompleted, returns { outcome: posted }', async () => {
    const { zernioClient } = await import('@/lib/zernio/client');
    const { getCachedZernioReviewPage } = await import('@/lib/publishing/zernio-publisher');
    const { markOutboxCompleted } = await import('@/lib/shared/outbox');
    const { sql } = await import('@/lib/db/server');

    (getCachedZernioReviewPage as ReturnType<typeof vi.fn>).mockResolvedValue(null);
    (zernioClient as any).listAllReviews = vi.fn().mockResolvedValue([
      makeZernioReviewWith('Thank you!'),
    ]);
    (sql as any).mockResolvedValue(Object.assign([], { count: 1 }));

    const result = await verify409AndDispose(baseArgs);

    expect(result.outcome).toBe('posted');
    expect(maybeCaptureActivationCompleted).toHaveBeenCalledWith({
      responseId: 'R',
      businessId: 'B',
      reviewId: 'rev',
      logger: expect.any(Object),
    });
    expect(markOutboxCompleted).toHaveBeenCalledWith('outbox-1', 1);
  });

  it('superseded: text mismatch → UPDATE superseded + markOutboxCompleted, returns { outcome: superseded }', async () => {
    const { zernioClient } = await import('@/lib/zernio/client');
    const { getCachedZernioReviewPage } = await import('@/lib/publishing/zernio-publisher');
    const { markOutboxCompleted } = await import('@/lib/shared/outbox');
    const { sql } = await import('@/lib/db/server');

    (getCachedZernioReviewPage as ReturnType<typeof vi.fn>).mockResolvedValue(null);
    (zernioClient as any).listAllReviews = vi.fn().mockResolvedValue([
      makeZernioReviewWith('A completely different reply by someone else'),
    ]);
    (sql as any).mockResolvedValue(Object.assign([], { count: 1 }));

    const result = await verify409AndDispose(baseArgs);

    expect(result.outcome).toBe('superseded');
    expect(maybeCaptureActivationCompleted).not.toHaveBeenCalled();
    expect(markOutboxCompleted).toHaveBeenCalledWith('outbox-1', 1);
  });
});

describe('handlePublisherPermanentErrorTerminal', () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  it('happy path: response → failed, exception inserted, admin notify enqueued', async () => {
    const { sql } = await import('@/lib/db/server');
    const { markOutboxCompleted } = await import('@/lib/shared/outbox');
    let callIdx = 0;
    const tx = vi.fn((_s: TemplateStringsArray, ..._v: unknown[]) => {
      callIdx += 1;
      if (callIdx === 1) return Promise.resolve(mkTaggedResult([{ '?column?': 1 }]));
      if (callIdx === 2) return Promise.resolve(mkTaggedResult([{ id: 'exc-1' }]));
      return Promise.resolve(mkTaggedResult([]));
    });
    (sql as any).begin = vi.fn(async (cb: any) => cb(tx));

    await handlePublisherPermanentErrorTerminal({
      response_id: 'R', business_id: 'B', review_id: 'rev', endpoint_kind: 'publish_reply',
      http_status: 422, error_body: { msg: 'bad' },
      outboxId: 'outbox-1', outboxAttempt: 1, logger: mkLogger() as any,
    });

    expect(callIdx).toBe(3);  // mark failed, insert exception, notify enqueue
    expect(markOutboxCompleted).toHaveBeenCalledWith('outbox-1', 1);
  });

  it('skips work when response already terminal (count=0)', async () => {
    const { sql } = await import('@/lib/db/server');
    let callIdx = 0;
    const tx = vi.fn((_s: TemplateStringsArray, ..._v: unknown[]) => {
      callIdx += 1;
      if (callIdx === 1) return Promise.resolve(mkTaggedResult([]));
      return Promise.resolve(mkTaggedResult([]));
    });
    (sql as any).begin = vi.fn(async (cb: any) => cb(tx));

    await handlePublisherPermanentErrorTerminal({
      response_id: 'R', business_id: 'B', review_id: 'rev', endpoint_kind: 'x',
      http_status: 422, error_body: {},
      outboxId: 'outbox-1', outboxAttempt: 1, logger: mkLogger() as any,
    });
    expect(callIdx).toBe(1);  // only the UPDATE; no exception INSERT
  });
});

describe('verify409InTx — tx-aware verifier', () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  const baseInTxArgs = () => ({
    tx: vi.fn() as any,                  // outer tx — verify409InTx must NOT touch it
    account_id: 'acct',
    location_id: 'loc',
    zernio_review_id: 'zr-1',
    approved_text: 'Thanks!',
    logger: { log: vi.fn(), warn: vi.fn(), error: vi.fn() } as any,
  });

  function makeZernioReviewWith(replyComment: string | null) {
    return {
      id: 'zr-1',
      name: 'accounts/acct/locations/loc/reviews/zr-1',
      reviewer: { displayName: 'Alice', profilePhotoUrl: null, isAnonymous: false },
      rating: 5,
      starRating: 'FIVE' as const,
      comment: 'Great!',
      createTime: '2026-04-26T12:00:00Z',
      updateTime: '2026-04-26T12:00:00Z',
      reviewReply: replyComment !== null
        ? { comment: replyComment, updateTime: '2026-04-27T00:00:00Z' }
        : null,
    };
  }

  it('matches_our_text: canonicalized text equals approved_text → returns matches_our_text + verifierText', async () => {
    const { zernioClient } = await import('@/lib/zernio/client');
    const { getCachedZernioReviewPage } = await import('@/lib/publishing/zernio-publisher');
    (getCachedZernioReviewPage as ReturnType<typeof vi.fn>).mockResolvedValue(null);
    // Trailing whitespace must be canonicalized away (canonicalizeReplyText trims).
    (zernioClient as any).listAllReviews = vi.fn().mockResolvedValue([
      makeZernioReviewWith('Thanks!\n\n'),
    ]);

    const result = await verify409InTx(baseInTxArgs());

    expect(result.disposition).toBe('matches_our_text');
    if (result.disposition === 'matches_our_text') {
      expect(result.verifierText).toBe('Thanks!');
    }
  });

  it('mismatch: canonical text differs → returns mismatch + verifierText', async () => {
    const { zernioClient } = await import('@/lib/zernio/client');
    const { getCachedZernioReviewPage } = await import('@/lib/publishing/zernio-publisher');
    (getCachedZernioReviewPage as ReturnType<typeof vi.fn>).mockResolvedValue(null);
    (zernioClient as any).listAllReviews = vi.fn().mockResolvedValue([
      makeZernioReviewWith('Someone else replied here'),
    ]);

    const result = await verify409InTx(baseInTxArgs());

    expect(result.disposition).toBe('mismatch');
    if (result.disposition === 'mismatch') {
      expect(result.verifierText).toBe('Someone else replied here');
    }
  });

  it('indeterminate: review not in walk results → review_not_found_after_pagination + meta', async () => {
    const { zernioClient } = await import('@/lib/zernio/client');
    const { getCachedZernioReviewPage } = await import('@/lib/publishing/zernio-publisher');
    (getCachedZernioReviewPage as ReturnType<typeof vi.fn>).mockResolvedValue(null);
    // Walk returns 2 unrelated reviews — target zr-1 not present.
    (zernioClient as any).listAllReviews = vi.fn().mockResolvedValue([
      { ...makeZernioReviewWith('whatever'), id: 'other-a' },
      { ...makeZernioReviewWith('whatever'), id: 'other-b' },
    ]);

    const result = await verify409InTx(baseInTxArgs());

    expect(result.disposition).toBe('indeterminate');
    if (result.disposition === 'indeterminate') {
      expect(result.reason).toBe('review_not_found_after_pagination');
      expect(result.meta.pages_walked).toBe(4);
      expect(result.meta.reviews_seen).toBe(2);
    }
  });

  it('indeterminate: found but reviewReply null → review_found_but_reply_null', async () => {
    const { zernioClient } = await import('@/lib/zernio/client');
    const { getCachedZernioReviewPage } = await import('@/lib/publishing/zernio-publisher');
    (getCachedZernioReviewPage as ReturnType<typeof vi.fn>).mockResolvedValue(null);
    (zernioClient as any).listAllReviews = vi.fn().mockResolvedValue([
      makeZernioReviewWith(null),
    ]);

    const result = await verify409InTx(baseInTxArgs());

    expect(result.disposition).toBe('indeterminate');
    if (result.disposition === 'indeterminate') {
      expect(result.reason).toBe('review_found_but_reply_null');
    }
  });

  it('auth: listAllReviews throws ZernioAuthError → returns auth + lookupErr', async () => {
    const { zernioClient } = await import('@/lib/zernio/client');
    const { getCachedZernioReviewPage } = await import('@/lib/publishing/zernio-publisher');
    (getCachedZernioReviewPage as ReturnType<typeof vi.fn>).mockResolvedValue(null);
    const authErr = new ZernioAuthError(401, 'expired');
    (zernioClient as any).listAllReviews = vi.fn().mockRejectedValue(authErr);

    const result = await verify409InTx(baseInTxArgs());

    expect(result.disposition).toBe('auth');
    if (result.disposition === 'auth') {
      expect(result.lookupErr).toBe(authErr);
    }
  });

  it('transient: listAllReviews throws ZernioTransientError → returns transient + lookupErr', async () => {
    const { zernioClient } = await import('@/lib/zernio/client');
    const { getCachedZernioReviewPage } = await import('@/lib/publishing/zernio-publisher');
    (getCachedZernioReviewPage as ReturnType<typeof vi.fn>).mockResolvedValue(null);
    const transErr = new ZernioTransientError('timeout', { httpStatus: 504 });
    (zernioClient as any).listAllReviews = vi.fn().mockRejectedValue(transErr);

    const result = await verify409InTx(baseInTxArgs());

    expect(result.disposition).toBe('transient');
    if (result.disposition === 'transient') {
      expect(result.lookupErr).toBe(transErr);
    }
  });

  it('permanent: listAllReviews throws ZernioPermanentError → returns permanent + lookupErr', async () => {
    const { zernioClient } = await import('@/lib/zernio/client');
    const { getCachedZernioReviewPage } = await import('@/lib/publishing/zernio-publisher');
    (getCachedZernioReviewPage as ReturnType<typeof vi.fn>).mockResolvedValue(null);
    const permErr = new ZernioPermanentError('bad_input', { httpStatus: 422 });
    (zernioClient as any).listAllReviews = vi.fn().mockRejectedValue(permErr);

    const result = await verify409InTx(baseInTxArgs());

    expect(result.disposition).toBe('permanent');
    if (result.disposition === 'permanent') {
      expect(result.lookupErr).toBe(permErr);
    }
  });

  it('permanent: listAllReviews throws ZernioValidationError → returns permanent + lookupErr', async () => {
    const { zernioClient } = await import('@/lib/zernio/client');
    const { getCachedZernioReviewPage } = await import('@/lib/publishing/zernio-publisher');
    (getCachedZernioReviewPage as ReturnType<typeof vi.fn>).mockResolvedValue(null);
    const valErr = new ZernioValidationError('schema_invalid', { issues: ['bad payload'] });
    (zernioClient as any).listAllReviews = vi.fn().mockRejectedValue(valErr);

    const result = await verify409InTx(baseInTxArgs());

    expect(result.disposition).toBe('permanent');
    if (result.disposition === 'permanent') {
      expect(result.lookupErr).toBe(valErr);
    }
  });

  it('indeterminate: listAllReviews throws unknown Error → verifier_unknown_error + meta.underlying_error', async () => {
    const { zernioClient } = await import('@/lib/zernio/client');
    const { getCachedZernioReviewPage } = await import('@/lib/publishing/zernio-publisher');
    (getCachedZernioReviewPage as ReturnType<typeof vi.fn>).mockResolvedValue(null);
    (zernioClient as any).listAllReviews = vi.fn().mockRejectedValue(new Error('connection refused'));

    const result = await verify409InTx(baseInTxArgs());

    expect(result.disposition).toBe('indeterminate');
    if (result.disposition === 'indeterminate') {
      expect(result.reason).toBe('verifier_unknown_error');
      expect(result.meta.underlying_error).toBe('connection refused');
    }
  });

  it('does NOT call markOutboxCompleted (caller owns outbox lifecycle)', async () => {
    const { zernioClient } = await import('@/lib/zernio/client');
    const { getCachedZernioReviewPage } = await import('@/lib/publishing/zernio-publisher');
    const { markOutboxCompleted } = await import('@/lib/shared/outbox');
    (getCachedZernioReviewPage as ReturnType<typeof vi.fn>).mockResolvedValue(null);
    (zernioClient as any).listAllReviews = vi.fn().mockResolvedValue([
      makeZernioReviewWith('Thanks!'),
    ]);

    await verify409InTx(baseInTxArgs());

    expect(markOutboxCompleted).not.toHaveBeenCalled();
  });

  it('does NOT mutate responses or any other DB row (no module-level sql calls)', async () => {
    const { zernioClient } = await import('@/lib/zernio/client');
    const { getCachedZernioReviewPage } = await import('@/lib/publishing/zernio-publisher');
    const { sql } = await import('@/lib/db/server');
    (getCachedZernioReviewPage as ReturnType<typeof vi.fn>).mockResolvedValue(null);
    (zernioClient as any).listAllReviews = vi.fn().mockResolvedValue([
      makeZernioReviewWith('Thanks!'),
    ]);

    const sqlMock = sql as unknown as ReturnType<typeof vi.fn>;
    sqlMock.mockClear();

    const args = baseInTxArgs();
    await verify409InTx(args);

    // Module-level sql tagged-template never called.
    expect(sqlMock).not.toHaveBeenCalled();
    // Outer tx never called either — verify409InTx reserves it for future use.
    expect(args.tx).not.toHaveBeenCalled();
  });
});
