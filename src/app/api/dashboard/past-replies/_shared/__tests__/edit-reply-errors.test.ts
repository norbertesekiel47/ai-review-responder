import { describe, it, expect, vi } from 'vitest';

// Mock the error classes so this test is self-contained and fast.
const {
  SubscriptionReadOnlyError,
  ForbiddenError,
  NotFoundError,
} = vi.hoisted(() => {
  class SubscriptionReadOnlyError extends Error {
    readonly status = 402;
    readonly error = 'past_due_read_only';
    constructor() { super('past_due_read_only'); this.name = 'SubscriptionReadOnlyError'; }
  }
  class ForbiddenError extends Error {
    constructor() { super('forbidden'); this.name = 'ForbiddenError'; }
  }
  class NotFoundError extends Error {
    constructor() { super('review_not_found'); this.name = 'NotFoundError'; }
  }
  return { SubscriptionReadOnlyError, ForbiddenError, NotFoundError };
});

vi.mock('@/lib/responses/edit-existing', () => ({
  SubscriptionReadOnlyError,
  ForbiddenError,
  NotFoundError,
}));

import { mapEditReplyError } from '../edit-reply-errors';

describe('mapEditReplyError', () => {
  it('maps SubscriptionReadOnlyError → 402 past_due_read_only', async () => {
    const response = mapEditReplyError(new SubscriptionReadOnlyError());
    expect(response).not.toBeNull();
    expect(response!.status).toBe(402);
    const body = await response!.json();
    expect(body).toEqual({ error: 'past_due_read_only' });
  });

  it('maps ForbiddenError → 403 forbidden', async () => {
    const response = mapEditReplyError(new ForbiddenError());
    expect(response).not.toBeNull();
    expect(response!.status).toBe(403);
    const body = await response!.json();
    expect(body).toEqual({ error: 'forbidden' });
  });

  it('maps NotFoundError → 404 review_not_found', async () => {
    const response = mapEditReplyError(new NotFoundError());
    expect(response).not.toBeNull();
    expect(response!.status).toBe(404);
    const body = await response!.json();
    expect(body).toEqual({ error: 'review_not_found' });
  });

  it('returns null for an unmapped error', () => {
    const result = mapEditReplyError(new Error('something else'));
    expect(result).toBeNull();
  });

  it('returns null for a non-error value', () => {
    expect(mapEditReplyError('string')).toBeNull();
    expect(mapEditReplyError(null)).toBeNull();
    expect(mapEditReplyError(42)).toBeNull();
  });
});
