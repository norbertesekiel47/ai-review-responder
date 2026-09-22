import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';

const { enabled, assertSameOrigin, resolveOwnerScope, order, SameOriginError, ScopeError } = vi.hoisted(() => {
  class SameOriginError extends Error {}
  class ScopeError extends Error {
    constructor(message: string, readonly statusCode: number) { super(message); }
  }
  return {
    enabled: vi.fn(),
    assertSameOrigin: vi.fn(),
    resolveOwnerScope: vi.fn(),
    order: [] as string[],
    SameOriginError,
    ScopeError,
  };
});

vi.mock('@/lib/past-replies/flags', () => ({ editRepliesEnabled: enabled }));
vi.mock('@/lib/shared/csrf', () => ({ assertSameOrigin, SameOriginError }));
vi.mock('@/lib/auth/resolve-owner-scope', () => ({ resolveOwnerScope, ScopeError }));
vi.mock('@/lib/responses/edit-existing', () => ({
  assertCanEditReply: vi.fn(),
  SubscriptionReadOnlyError: class extends Error {},
  ForbiddenError: class extends Error {},
  NotFoundError: class extends Error {},
  ReviewChangedError: class extends Error {},
  ResponseChangedError: class extends Error {},
}));

import {
  authorizeEditReplyResponse,
  resolveEditReplyRequest,
  resolveEditReplyScope,
} from '../edit-reply-request';

const db = (() => Promise.resolve([])) as never;
const request = () => new NextRequest('https://app.example.com/api/test', {
  headers: { origin: 'https://app.example.com' },
});

describe('resolveEditReplyRequest', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    order.length = 0;
    enabled.mockImplementation(() => { order.push('feature'); return true; });
    assertSameOrigin.mockImplementation(() => { order.push('origin'); });
    resolveOwnerScope.mockImplementation(async () => {
      order.push('scope');
      return { accountId: 'account-1', locationId: 'location-1', userId: 'user-1' };
    });
  });

  it('preserves feature, same-origin, owner-scope, and parameter ordering', async () => {
    const params = Promise.resolve({ responseId: 'response-1' });

    await expect(resolveEditReplyRequest(db, request(), params)).resolves.toEqual({
      ok: true,
      value: {
        accountId: 'account-1',
        locationId: 'location-1',
        userId: 'user-1',
        responseId: 'response-1',
      },
    });
    expect(order).toEqual(['feature', 'origin', 'scope']);
  });

  it('stops before owner scope on same-origin failure', async () => {
    assertSameOrigin.mockImplementation(() => { order.push('origin'); throw new SameOriginError(); });
    const result = await resolveEditReplyRequest(db, request(), Promise.resolve({ responseId: 'response-1' }));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.response.status).toBe(403);
    expect(resolveOwnerScope).not.toHaveBeenCalled();
  });

  it('maps owner scope and missing-parameter failures without authorization', async () => {
    resolveOwnerScope.mockRejectedValueOnce(new ScopeError('owner_required', 403));
    const scopeResult = await resolveEditReplyRequest(db, request(), Promise.resolve({ responseId: 'response-1' }));
    expect(scopeResult.ok).toBe(false);
    if (!scopeResult.ok) expect(scopeResult.response.status).toBe(403);

    const paramResult = await resolveEditReplyRequest(db, request(), Promise.resolve({ responseId: '' }));
    expect(paramResult.ok).toBe(false);
    if (!paramResult.ok) expect(paramResult.response.status).toBe(400);
  });
});

describe('authorizeEditReplyResponse', () => {
  it('returns 400 invalid_response_id before any query when the id is not a UUID (#1362)', async () => {
    const sql = vi.fn(async () => []);

    const result = await authorizeEditReplyResponse(
      sql as unknown as Parameters<typeof authorizeEditReplyResponse>[0],
      'not-a-uuid',
      { accountId: 'account-1', locationId: 'location-1' },
    );

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.response.status).toBe(400);
      await expect(result.response.json()).resolves.toEqual({ error: 'invalid_response_id' });
    }
    expect(sql).not.toHaveBeenCalled();
  });
});

// ── The consumer-layer re-throw the #1361 gate fix rests on (#1400) ──────────
//
// #1361 made `resolveOwnerScope` re-throw a non-`ScopeError` instead of wrapping
// it as `ScopeError('unauthorized', 401)`. That fix only holds because every
// consumer re-throws a non-`ScopeError` too. Both consumers in this file front
// five routes (publish, draft POST, draft PATCH, retry, restore-original), and
// until these rows NOTHING pinned their two `throw err;` statements: a red-team
// pass replaced both with a catch-all 401 — reintroducing the #1361 defect one
// layer up — and 123 of 123 past-replies tests stayed green.
//
// The assertion is identity: the ORIGINAL fault comes back out. Mapping it to
// any response at all is the regression, so the test names the mapped status
// rather than just "did not throw".
describe('non-ScopeError faults propagate out of the edit-reply preamble', () => {
  const settle = async <T>(promise: Promise<T>): Promise<unknown> =>
    promise.then((value) => ({ mappedTo: value }), (error: unknown) => ({ threw: error }));

  beforeEach(() => {
    vi.clearAllMocks();
    enabled.mockReturnValue(true);
    assertSameOrigin.mockImplementation(() => {});
  });

  it('resolveEditReplyScope re-throws a non-ScopeError instead of mapping it to a 4xx', async () => {
    const fault = new Error('pool exhausted');
    resolveOwnerScope.mockRejectedValueOnce(fault);

    expect(await settle(resolveEditReplyScope(db, request()))).toEqual({ threw: fault });
  });

  it('resolveEditReplyRequest re-throws a non-ScopeError instead of mapping it to a 4xx', async () => {
    const fault = new Error('pool exhausted');
    resolveOwnerScope.mockRejectedValueOnce(fault);

    expect(
      await settle(resolveEditReplyRequest(db, request(), Promise.resolve({ responseId: 'r-1' }))),
    ).toEqual({ threw: fault });
  });

  // A non-Error rejection value has no prototype to test, so a `catch (err) { if
  // (err instanceof ScopeError) … }` that is later loosened to a name comparison
  // still has to let this one through unchanged.
  it.each([
    ['resolveEditReplyScope', () => resolveEditReplyScope(db, request())],
    [
      'resolveEditReplyRequest',
      () => resolveEditReplyRequest(db, request(), Promise.resolve({ responseId: 'r-1' })),
    ],
  ])('%s re-throws a non-Error rejection value unchanged', async (_label, call) => {
    resolveOwnerScope.mockRejectedValueOnce('pool exhausted');

    expect(await settle(call())).toEqual({ threw: 'pool exhausted' });
  });
});
