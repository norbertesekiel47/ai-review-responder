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

import { resolveEditReplyRequest } from '../edit-reply-request';

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
