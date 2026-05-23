// Edit-publisher DELETE-before-POST module tests — spec §4.5 + §4.7.
//
// Ported from the parked tag
// `worker/__tests__/ResponsePublisherWorker-edit.test.ts` (which exercised the
// branch inline in the worker). On current `main` the branch is a standalone
// module (`edit-publish.ts`); these tests call `runEditPublishIfApplicable`
// directly with injected `zernioClient` + `verify409InTx` deps, so they cover
// the module in isolation (Task 6 wires the real deps in the dispatcher).
//
// Mock pattern mirrors the tag: SQL calls return items shifted off
// `sqlReturnQueue` in the order they fire. `sql.begin(cb)` invokes cb with
// `mockSql` so tx + standalone calls share the queue. ANY tx-internal throw
// rolls back by bubbling out of the begin callback.

import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  ZernioAuthError,
  ZernioPermanentError,
  ZernioReplyAlreadyDeletedError,
  ZernioReplyAlreadyExistsError,
  ZernioTransientError,
} from '../../../../src/lib/zernio/errors';
import {
  PublisherTransientWithContext,
  ZernioReplyVerificationIndeterminateError,
  type Verify409Disposition,
} from '../publisher-error-handlers';

// ── Hoisted state shared between mock factories and tests ──────────────
const {
  sqlReturnQueue,
  mockSql,
  mockPostReply,
  mockDeleteReply,
  mockVerify409InTx,
} = vi.hoisted(() => {
  const sqlReturnQueue: unknown[] = [];

  const mockSql: any = vi.fn((_s: TemplateStringsArray, ..._v: unknown[]) => {
    const result = sqlReturnQueue.shift() ?? Object.assign([], { count: 0 });
    return Promise.resolve(result);
  });
  // sql.begin runs cb with mockSql as `tx`. If cb throws, the throw escapes
  // (the module's catch-around-sql.begin sees it) — same as Postgres.js.
  mockSql.begin = vi.fn(async (cb: (tx: any) => Promise<any>) => cb(mockSql));

  return {
    sqlReturnQueue,
    mockSql,
    mockPostReply: vi.fn(),
    mockDeleteReply: vi.fn(),
    mockVerify409InTx: vi.fn(),
  };
});

vi.mock('../../../../src/lib/db/server', () => ({ sql: mockSql, jsonb: (v: unknown) => v }));
vi.mock('../../../../src/lib/zernio/client', () => ({
  zernioClient: { postReply: mockPostReply, deleteReply: mockDeleteReply },
}));
vi.mock('uuid', () => ({ v7: vi.fn(() => 'test-uuid') }));
vi.mock('@sentry/node', () => ({ captureMessage: vi.fn(), captureException: vi.fn() }));

import {
  runEditPublishIfApplicable,
  type EditPublishContext,
} from '../edit-publish';

// Typed view of the hoisted verify409InTx mock so `.mockResolvedValueOnce`
// accepts the discriminated-union dispositions.
const verify409: { mockResolvedValueOnce(v: Verify409Disposition): unknown } =
  mockVerify409InTx as unknown as {
    mockResolvedValueOnce(v: Verify409Disposition): unknown;
  };

// ── Helpers ──────────────────────────────────────────────────────────────

const logger = {
  log: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
} as unknown as EditPublishContext['logger'];

function makeContext(overrides: Partial<EditPublishContext> = {}): EditPublishContext {
  return {
    responseId: 'resp-1',
    businessId: 'biz-1',
    reviewId: 'rev-1',
    approvedText: 'Thank you for your kind review!',
    responsePostingError: null,
    zernioAccountId: 'acct-1',
    zernioLocationId: 'loc-1',
    zernioReviewId: 'zernio-rev-id-1',
    correlationId: undefined,
    logger,
    ...overrides,
  };
}

function deps() {
  return {
    zernioClient: { deleteReply: mockDeleteReply, postReply: mockPostReply } as any,
    verify409InTx: mockVerify409InTx as any,
  };
}

// Joins SQL template strings AND interpolates values so regex assertions can
// match `posting_error = 'delete_failed_inbox_addon_required'` even when the
// value comes from a `${kind}` interpolation.
function callTextsWithValues(): string[] {
  return (mockSql as any).mock.calls.map((c: any[]) => {
    const parts = c[0] as TemplateStringsArray;
    const values = c.slice(1);
    let out = '';
    for (let i = 0; i < parts.length; i++) {
      out += parts[i];
      if (i < values.length) {
        const v = values[i];
        out += typeof v === 'string' ? `'${v}'` : String(v);
      }
    }
    return out;
  });
}

function pushPhaseAProbe(siblingExists: boolean) {
  sqlReturnQueue.push(siblingExists ? [{ id: 'resp-prev' }] : []);
}

function pushPhaseBLockSequence(opts: {
  reviewLockFound?: boolean;
  candidate?: Record<string, unknown> | null;
  existingPosted?: { id: string; version: number } | null;
} = {}) {
  const reviewLockFound = opts.reviewLockFound ?? true;
  const candidate = opts.candidate === undefined
    ? {
        id: 'resp-1', status: 'approved', approved_text: 'Thank you for your kind review!',
        version: 1, posting_error: null, review_id: 'rev-1',
      }
    : opts.candidate;
  const existingPosted = opts.existingPosted === undefined
    ? { id: 'resp-prev', version: 1 }
    : opts.existingPosted;

  sqlReturnQueue.push(reviewLockFound ? [{ id: 'rev-1' }] : []);  // review FOR UPDATE
  sqlReturnQueue.push(candidate ? [candidate] : []);              // response FOR UPDATE
  sqlReturnQueue.push(existingPosted ? [existingPosted] : []);    // existingPosted FOR UPDATE
}

const okReply = { comment: 'ok', updateTime: '2026' };

beforeEach(() => {
  vi.clearAllMocks();
  sqlReturnQueue.length = 0;
});

// ── Branch decisions / Phase A inertness ────────────────────────────────

describe('runEditPublishIfApplicable — Phase A', () => {
  it('no sibling AND no orphan-marker → continue_to_fresh, NO DELETE, NO tx', async () => {
    sqlReturnQueue.push([]);  // Phase A probe: no sibling

    const result = await runEditPublishIfApplicable(makeContext(), deps());

    expect(result).toEqual({ outcome: 'continue_to_fresh' });
    expect(mockDeleteReply).not.toHaveBeenCalled();
    expect(mockPostReply).not.toHaveBeenCalled();
    expect(mockSql.begin).not.toHaveBeenCalled();  // Phase A is truly inert
  });

  it('no sibling BUT orphan-marker → enters Phase B no-DELETE branch', async () => {
    pushPhaseAProbe(false);  // no sibling
    pushPhaseBLockSequence({
      candidate: {
        id: 'resp-1', status: 'approved', approved_text: 'Thank you!',
        version: 1, posting_error: 'pending_after_delete_succeeded', review_id: 'rev-1',
      },
      existingPosted: null,
    });
    sqlReturnQueue.push(Object.assign([], { count: 1 }));  // candidate posted

    mockPostReply.mockResolvedValueOnce(okReply);

    const result = await runEditPublishIfApplicable(
      makeContext({ responsePostingError: 'pending_after_delete_succeeded' }),
      deps(),
    );

    expect(result).toEqual({ outcome: 'completed' });
    expect(mockDeleteReply).not.toHaveBeenCalled();  // no sibling → no DELETE
    expect(mockPostReply).toHaveBeenCalledTimes(1);
  });

  it('sibling exists → DELETE called before POST', async () => {
    pushPhaseAProbe(true);
    pushPhaseBLockSequence();
    sqlReturnQueue.push(Object.assign([], { count: 1 }));  // sibling superseded
    sqlReturnQueue.push(Object.assign([], { count: 1 }));  // candidate posted

    mockDeleteReply.mockResolvedValueOnce(undefined);
    mockPostReply.mockResolvedValueOnce(okReply);

    const result = await runEditPublishIfApplicable(makeContext(), deps());

    expect(result).toEqual({ outcome: 'completed' });
    expect(mockDeleteReply).toHaveBeenCalledWith('acct-1', 'zernio-rev-id-1');
    expect(mockPostReply).toHaveBeenCalledTimes(1);
    expect(mockDeleteReply.mock.invocationCallOrder[0]).toBeLessThan(
      mockPostReply.mock.invocationCallOrder[0]!,
    );
  });

  it('sibling vanished under lock AND no marker → continue_to_fresh (no external I/O)', async () => {
    pushPhaseAProbe(true);  // Phase A saw a sibling...
    pushPhaseBLockSequence({ existingPosted: null });  // ...but it's gone under lock

    const result = await runEditPublishIfApplicable(makeContext(), deps());

    expect(result).toEqual({ outcome: 'continue_to_fresh' });
    expect(mockDeleteReply).not.toHaveBeenCalled();
    expect(mockPostReply).not.toHaveBeenCalled();
  });

  it('candidate moved out of publishable state under lock → idempotent completed', async () => {
    pushPhaseAProbe(true);
    pushPhaseBLockSequence({ candidate: null });  // status guard caught it

    const result = await runEditPublishIfApplicable(makeContext(), deps());

    expect(result).toEqual({ outcome: 'completed' });
    expect(mockDeleteReply).not.toHaveBeenCalled();
    expect(mockPostReply).not.toHaveBeenCalled();
  });

  it('review row not lockable → failed publish_orphan_response_review', async () => {
    pushPhaseAProbe(true);
    pushPhaseBLockSequence({ reviewLockFound: false });

    const result = await runEditPublishIfApplicable(makeContext(), deps());

    expect(result).toEqual({ outcome: 'failed', reason: 'publish_orphan_response_review' });
  });
});

// ── DELETE-branch per-CATCH commit semantics ────────────────────────────

describe('runEditPublishIfApplicable — DELETE branch', () => {
  it('DELETE 404 via ZernioReplyAlreadyDeletedError → treated as success, proceeds to POST', async () => {
    pushPhaseAProbe(true);
    pushPhaseBLockSequence();
    sqlReturnQueue.push(Object.assign([], { count: 1 }));  // sibling superseded
    sqlReturnQueue.push(Object.assign([], { count: 1 }));  // candidate posted

    mockDeleteReply.mockRejectedValueOnce(new ZernioReplyAlreadyDeletedError('zernio-rev-id-1'));
    mockPostReply.mockResolvedValueOnce(okReply);

    const result = await runEditPublishIfApplicable(makeContext(), deps());

    expect(result).toEqual({ outcome: 'completed' });
    expect(mockPostReply).toHaveBeenCalledTimes(1);
  });

  it('DELETE 404 via generic ZernioPermanentError(http_404, delete_reply) → treated as success (TASK-1 gap)', async () => {
    // The main classifier does NOT yet throw ZernioReplyAlreadyDeletedError on
    // a delete 404 (reviewId out of scope). It surfaces the generic
    // ZernioPermanentError('http_404', { endpointKind: 'delete_reply' }).
    // The module detects this shape and treats it as DELETE success.
    pushPhaseAProbe(true);
    pushPhaseBLockSequence();
    sqlReturnQueue.push(Object.assign([], { count: 1 }));  // sibling superseded
    sqlReturnQueue.push(Object.assign([], { count: 1 }));  // candidate posted

    mockDeleteReply.mockRejectedValueOnce(
      new ZernioPermanentError('http_404', { endpointKind: 'delete_reply', body: {} }),
    );
    mockPostReply.mockResolvedValueOnce(okReply);

    const result = await runEditPublishIfApplicable(makeContext(), deps());

    expect(result).toEqual({ outcome: 'completed' });
    expect(mockPostReply).toHaveBeenCalledTimes(1);
    // It must NOT be misclassified as delete_failed_*.
    const callTexts = callTextsWithValues();
    expect(callTexts.some((t) => /delete_failed_/.test(t))).toBe(false);
  });

  it('a non-delete-endpoint http_404 is NOT treated as already-deleted → delete_failed_*', async () => {
    pushPhaseAProbe(true);
    pushPhaseBLockSequence();
    sqlReturnQueue.push(Object.assign([], { count: 1 }));  // candidate failed

    mockDeleteReply.mockRejectedValueOnce(
      new ZernioPermanentError('http_404', { endpointKind: 'publish_reply', body: {} }),
    );

    const result = await runEditPublishIfApplicable(makeContext(), deps());

    expect(result).toEqual({ outcome: 'failed', reason: 'zernio_permanent_after_edit_publish' });
    expect(mockPostReply).not.toHaveBeenCalled();
    const callTexts = callTextsWithValues();
    expect(callTexts.some((t) => /delete_failed_http_404/.test(t))).toBe(true);
  });

  it('DELETE permanent (inbox_addon_required) → response failed, sibling UNCHANGED', async () => {
    pushPhaseAProbe(true);
    pushPhaseBLockSequence();
    sqlReturnQueue.push(Object.assign([], { count: 1 }));  // candidate failed

    mockDeleteReply.mockRejectedValueOnce(
      new ZernioPermanentError('inbox_addon_required', { endpointKind: 'delete_reply' }),
    );

    const result = await runEditPublishIfApplicable(makeContext(), deps());

    expect(result).toEqual({ outcome: 'failed', reason: 'zernio_permanent_after_edit_publish' });
    expect(mockPostReply).not.toHaveBeenCalled();
    const callTexts = callTextsWithValues();
    expect(callTexts.some((t) => /delete_failed_inbox_addon_required/.test(t))).toBe(true);
    expect(callTexts.filter((t) => /superseded/.test(t)).length).toBe(0);  // sibling NOT touched
  });

  it('DELETE auth → sibling UNCHANGED, candidate awaiting_owner_connect with plain zernio_auth_error', async () => {
    pushPhaseAProbe(true);
    pushPhaseBLockSequence();
    sqlReturnQueue.push(Object.assign([], { count: 1 }));  // UPDATE zernio_connections disconnected
    sqlReturnQueue.push(Object.assign([{ review_id: 'rev-1' }], { count: 1 }));  // park candidate
    sqlReturnQueue.push(Object.assign([], { count: 1 }));  // INSERT notify_owner_reconnect
    sqlReturnQueue.push(Object.assign([], { count: 1 }));  // INSERT notify_owner_connection_lost

    mockDeleteReply.mockRejectedValueOnce(new ZernioAuthError(401, 'Unauthorized'));

    const result = await runEditPublishIfApplicable(makeContext(), deps());

    expect(result).toEqual({ outcome: 'completed' });  // drain re-enqueues
    expect(mockPostReply).not.toHaveBeenCalled();
    const callTexts = callTextsWithValues();
    expect(callTexts.some((t) =>
      /'zernio_auth_error'/.test(t) && /awaiting_owner_connect/.test(t),
    )).toBe(true);
    expect(callTexts.some((t) => /zernio_auth_error_after_delete_succeeded/.test(t))).toBe(false);
    expect(callTexts.filter((t) => /UPDATE responses SET status = 'superseded'/.test(t)).length).toBe(0);
  });

  it('DELETE transient → throw (rollback, BullMQ retries)', async () => {
    pushPhaseAProbe(true);
    pushPhaseBLockSequence();

    mockDeleteReply.mockRejectedValueOnce(
      new ZernioTransientError('http_503', { status: 503, body: 'down' }),
    );

    const result = await runEditPublishIfApplicable(makeContext(), deps());

    expect(result.outcome).toBe('throw');
    if (result.outcome === 'throw') {
      expect(result.error).toBeInstanceOf(PublisherTransientWithContext);
    }
    expect(mockPostReply).not.toHaveBeenCalled();
  });
});

// ── DELETE-success + POST-failure (orphan) per-CATCH semantics ───────────

describe('runEditPublishIfApplicable — POST branch after DELETE success', () => {
  it('DELETE success + POST permanent → failed with post_after_delete_failed_*, sibling SUPERSEDED', async () => {
    pushPhaseAProbe(true);
    pushPhaseBLockSequence();
    sqlReturnQueue.push(Object.assign([], { count: 1 }));  // sibling superseded
    sqlReturnQueue.push(Object.assign([], { count: 1 }));  // candidate failed

    mockDeleteReply.mockResolvedValueOnce(undefined);
    mockPostReply.mockRejectedValueOnce(
      new ZernioPermanentError('http_400', { status: 400, body: { code: 'invalid' }, endpointKind: 'publish_reply' }),
    );

    const result = await runEditPublishIfApplicable(makeContext(), deps());

    expect(result).toEqual({ outcome: 'failed', reason: 'zernio_permanent_after_edit_publish' });
    const callTexts = callTextsWithValues();
    expect(callTexts.some((t) => /post_after_delete_failed_http_400/.test(t))).toBe(true);
    expect(callTexts.some((t) => /UPDATE responses SET status = 'superseded'/.test(t))).toBe(true);
  });

  it('DELETE success + POST transient → sibling SUPERSEDED + orphan marker set, throw retry', async () => {
    pushPhaseAProbe(true);
    pushPhaseBLockSequence();
    sqlReturnQueue.push(Object.assign([], { count: 1 }));  // sibling superseded
    sqlReturnQueue.push(Object.assign([], { count: 1 }));  // candidate orphan marker

    mockDeleteReply.mockResolvedValueOnce(undefined);
    mockPostReply.mockRejectedValueOnce(
      new ZernioTransientError('http_503', { status: 503, body: 'down' }),
    );

    const result = await runEditPublishIfApplicable(makeContext(), deps());

    expect(result.outcome).toBe('throw');
    if (result.outcome === 'throw') {
      expect(result.error).toBeInstanceOf(PublisherTransientWithContext);
    }
    const callTexts = callTextsWithValues();
    expect(callTexts.some((t) => /UPDATE responses SET status = 'superseded'/.test(t))).toBe(true);
    expect(callTexts.some((t) => /pending_after_delete_succeeded/.test(t))).toBe(true);
  });

  it('DELETE success + POST auth → sibling SUPERSEDED, candidate awaiting_owner_connect with suffixed marker', async () => {
    pushPhaseAProbe(true);
    pushPhaseBLockSequence();
    sqlReturnQueue.push(Object.assign([], { count: 1 }));  // UPDATE zernio_connections disconnected
    sqlReturnQueue.push(Object.assign([], { count: 1 }));  // sibling superseded (postDeleteCommitted)
    sqlReturnQueue.push(Object.assign([{ review_id: 'rev-1' }], { count: 1 }));  // park candidate
    sqlReturnQueue.push(Object.assign([], { count: 1 }));  // INSERT notify_owner_reconnect
    sqlReturnQueue.push(Object.assign([], { count: 1 }));  // INSERT notify_owner_connection_lost

    mockDeleteReply.mockResolvedValueOnce(undefined);
    mockPostReply.mockRejectedValueOnce(new ZernioAuthError(401, 'Unauthorized'));

    const result = await runEditPublishIfApplicable(makeContext(), deps());

    expect(result).toEqual({ outcome: 'completed' });
    const callTexts = callTextsWithValues();
    expect(callTexts.some((t) => /zernio_auth_error_after_delete_succeeded/.test(t))).toBe(true);
    expect(callTexts.some((t) => /UPDATE responses SET status = 'superseded'/.test(t))).toBe(true);
  });

  it('DELETE success + POST success → sibling superseded, candidate posted, marker cleared', async () => {
    pushPhaseAProbe(true);
    pushPhaseBLockSequence();
    sqlReturnQueue.push(Object.assign([], { count: 1 }));  // sibling superseded
    sqlReturnQueue.push(Object.assign([], { count: 1 }));  // candidate posted + clear marker

    mockDeleteReply.mockResolvedValueOnce(undefined);
    mockPostReply.mockResolvedValueOnce(okReply);

    const result = await runEditPublishIfApplicable(makeContext(), deps());

    expect(result).toEqual({ outcome: 'completed' });
    const callTexts = callTextsWithValues();
    expect(callTexts.some((t) =>
      /SET\s+status = 'posted'/.test(t) && /posting_error = NULL/.test(t),
    )).toBe(true);
  });
});

// ── 409 verifier dispositions ────────────────────────────────────────────

describe('runEditPublishIfApplicable — POST 409 via verify409InTx', () => {
  it('409 matches_our_text → sibling superseded, candidate posted, marker cleared', async () => {
    pushPhaseAProbe(true);
    pushPhaseBLockSequence();
    sqlReturnQueue.push(Object.assign([], { count: 1 }));  // sibling superseded
    sqlReturnQueue.push(Object.assign([], { count: 1 }));  // candidate posted

    mockDeleteReply.mockResolvedValueOnce(undefined);
    mockPostReply.mockRejectedValueOnce(new ZernioReplyAlreadyExistsError({ message: '409' }));
    verify409.mockResolvedValueOnce({
      disposition: 'matches_our_text',
      verifierText: 'thank you for your kind review!',
    });

    const result = await runEditPublishIfApplicable(makeContext(), deps());

    expect(result).toEqual({ outcome: 'completed' });
    const callTexts = callTextsWithValues();
    expect(callTexts.some((t) =>
      /SET\s+status = 'posted'/.test(t) && /posting_error = NULL/.test(t),
    )).toBe(true);
  });

  it('409 mismatch after DELETE success → sibling + candidate superseded, exception inserted', async () => {
    pushPhaseAProbe(true);
    pushPhaseBLockSequence();
    sqlReturnQueue.push(Object.assign([], { count: 1 }));  // sibling superseded
    sqlReturnQueue.push(Object.assign([], { count: 1 }));  // candidate superseded
    sqlReturnQueue.push(Object.assign([], { count: 1 }));  // INSERT review_exception

    mockDeleteReply.mockResolvedValueOnce(undefined);
    mockPostReply.mockRejectedValueOnce(new ZernioReplyAlreadyExistsError({ message: '409' }));
    verify409.mockResolvedValueOnce({
      disposition: 'mismatch',
      verifierText: 'some completely different reply',
    });

    const result = await runEditPublishIfApplicable(makeContext(), deps());

    expect(result).toEqual({ outcome: 'failed', reason: 'edit_publish_409_mismatch_after_delete' });
    const callTexts = callTextsWithValues();
    expect(callTexts.some((t) => /edit_publish_409_mismatch_after_delete/.test(t))).toBe(true);
  });

  it('409 indeterminate after DELETE success → sibling superseded + orphan marker, throw retry', async () => {
    pushPhaseAProbe(true);
    pushPhaseBLockSequence();
    sqlReturnQueue.push(Object.assign([], { count: 1 }));  // sibling superseded
    sqlReturnQueue.push(Object.assign([], { count: 1 }));  // candidate orphan marker

    mockDeleteReply.mockResolvedValueOnce(undefined);
    mockPostReply.mockRejectedValueOnce(new ZernioReplyAlreadyExistsError({ message: '409' }));
    verify409.mockResolvedValueOnce({
      disposition: 'indeterminate',
      reason: 'review_not_found_after_pagination',
      meta: { pages_walked: 4, reviews_seen: 3 },
    });

    const result = await runEditPublishIfApplicable(makeContext(), deps());

    expect(result.outcome).toBe('throw');
    if (result.outcome === 'throw') {
      expect(result.error).toBeInstanceOf(ZernioReplyVerificationIndeterminateError);
    }
    const callTexts = callTextsWithValues();
    expect(callTexts.some((t) => /UPDATE responses SET status = 'superseded'/.test(t))).toBe(true);
    expect(callTexts.some((t) => /pending_after_delete_succeeded/.test(t))).toBe(true);
  });

  it('409 mismatch with NO DELETE (orphan retry, no sibling) → candidate superseded (no exception)', async () => {
    pushPhaseAProbe(false);
    pushPhaseBLockSequence({
      candidate: {
        id: 'resp-1', status: 'approved', approved_text: 'Thank you!',
        version: 1, posting_error: 'pending_after_delete_succeeded', review_id: 'rev-1',
      },
      existingPosted: null,
    });
    // Orphan retry: postDeleteCommitted=true (marker) but no existingPosted →
    // mismatch path runs the post-delete branch (sibling supersede skipped,
    // candidate superseded, exception inserted).
    sqlReturnQueue.push(Object.assign([], { count: 1 }));  // candidate superseded
    sqlReturnQueue.push(Object.assign([], { count: 1 }));  // INSERT review_exception

    mockPostReply.mockRejectedValueOnce(new ZernioReplyAlreadyExistsError({ message: '409' }));
    verify409.mockResolvedValueOnce({
      disposition: 'mismatch',
      verifierText: 'third party text',
    });

    const result = await runEditPublishIfApplicable(
      makeContext({ responsePostingError: 'pending_after_delete_succeeded' }),
      deps(),
    );

    expect(result).toEqual({ outcome: 'failed', reason: 'edit_publish_409_mismatch_after_delete' });
    expect(mockDeleteReply).not.toHaveBeenCalled();
  });
});

// ── Orphan-retry sub-cases (no sibling, marker present) ──────────────────

describe('runEditPublishIfApplicable — orphan retry', () => {
  it('orphan retry + POST permanent → candidate failed with post_after_delete_failed_*', async () => {
    pushPhaseAProbe(false);
    pushPhaseBLockSequence({
      candidate: {
        id: 'resp-1', status: 'approved', approved_text: 'Thank you!',
        version: 1, posting_error: 'pending_after_delete_succeeded', review_id: 'rev-1',
      },
      existingPosted: null,
    });
    sqlReturnQueue.push(Object.assign([], { count: 1 }));  // candidate failed

    mockPostReply.mockRejectedValueOnce(
      new ZernioPermanentError('http_400', { endpointKind: 'publish_reply' }),
    );

    const result = await runEditPublishIfApplicable(
      makeContext({ responsePostingError: 'pending_after_delete_succeeded' }),
      deps(),
    );

    expect(result).toEqual({ outcome: 'failed', reason: 'zernio_permanent_after_edit_publish' });
    expect(mockDeleteReply).not.toHaveBeenCalled();
    const callTexts = callTextsWithValues();
    expect(callTexts.some((t) => /post_after_delete_failed_http_400/.test(t))).toBe(true);
  });

  it('orphan retry + POST success → candidate posted, marker cleared, no sibling supersede', async () => {
    pushPhaseAProbe(false);
    pushPhaseBLockSequence({
      candidate: {
        id: 'resp-1', status: 'approved', approved_text: 'Thank you for your kind review!',
        version: 1, posting_error: 'pending_after_delete_succeeded', review_id: 'rev-1',
      },
      existingPosted: null,
    });
    sqlReturnQueue.push(Object.assign([], { count: 1 }));  // candidate posted

    mockPostReply.mockResolvedValueOnce(okReply);

    const result = await runEditPublishIfApplicable(
      makeContext({ responsePostingError: 'pending_after_delete_succeeded' }),
      deps(),
    );

    expect(result).toEqual({ outcome: 'completed' });
    const callTexts = callTextsWithValues();
    expect(callTexts.some((t) =>
      /SET\s+status = 'posted'/.test(t) && /posting_error = NULL/.test(t),
    )).toBe(true);
    expect(callTexts.filter((t) => /UPDATE responses SET status = 'superseded'/.test(t)).length).toBe(0);
  });

  it('orphan retry + POST transient → throw retry, marker preserved (no DB writes)', async () => {
    pushPhaseAProbe(false);
    pushPhaseBLockSequence({
      candidate: {
        id: 'resp-1', status: 'approved', approved_text: 'Thank you!',
        version: 1, posting_error: 'pending_after_delete_succeeded', review_id: 'rev-1',
      },
      existingPosted: null,
    });

    mockPostReply.mockRejectedValueOnce(
      new ZernioTransientError('http_503', { status: 503, body: 'down' }),
    );

    const result = await runEditPublishIfApplicable(
      makeContext({ responsePostingError: 'pending_after_delete_succeeded' }),
      deps(),
    );

    expect(result.outcome).toBe('throw');
    if (result.outcome === 'throw') {
      expect(result.error).toBeInstanceOf(PublisherTransientWithContext);
    }
  });
});

// ── Affected-row-count assertion ─────────────────────────────────────────

describe('runEditPublishIfApplicable — affected-row assertions', () => {
  it('sibling supersede affected==0 → throws sibling_lost_during_publish', async () => {
    pushPhaseAProbe(true);
    pushPhaseBLockSequence();
    sqlReturnQueue.push(Object.assign([], { count: 0 }));  // sibling supersede no-op

    mockDeleteReply.mockResolvedValueOnce(undefined);
    mockPostReply.mockResolvedValueOnce(okReply);

    const result = await runEditPublishIfApplicable(makeContext(), deps());

    expect(result.outcome).toBe('throw');
    if (result.outcome === 'throw') {
      expect((result.error as Error).message).toBe('sibling_lost_during_publish');
    }
  });

  it('candidate posted affected==0 → throws candidate_lost_during_publish', async () => {
    pushPhaseAProbe(true);
    pushPhaseBLockSequence();
    sqlReturnQueue.push(Object.assign([], { count: 1 }));  // sibling superseded
    sqlReturnQueue.push(Object.assign([], { count: 0 }));  // candidate posted no-op

    mockDeleteReply.mockResolvedValueOnce(undefined);
    mockPostReply.mockResolvedValueOnce(okReply);

    const result = await runEditPublishIfApplicable(makeContext(), deps());

    expect(result.outcome).toBe('throw');
    if (result.outcome === 'throw') {
      expect((result.error as Error).message).toBe('candidate_lost_during_publish');
    }
  });
});
