import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { SubscriptionTierValue } from '@/lib/accounts/tier-config';

import {
  assertCanEditReply,
  validateOptimisticConcurrency,
  SubscriptionReadOnlyError,
  ReviewChangedError,
  ResponseChangedError,
  ForbiddenError,
  NotFoundError,
} from '../edit-existing';

// ── sql is now an explicit leading param (spec §2.1) — no module mock needed ──

const sqlReturnQueue: unknown[][] = [];
const sqlMockFn = vi.fn(async () => sqlReturnQueue.shift() ?? []);
const sqlMock = sqlMockFn as unknown as Parameters<typeof assertCanEditReply>[0];

beforeEach(() => {
  sqlReturnQueue.length = 0;
  sqlMockFn.mockClear();
});

// Tx mock — captures calls to a fake "transaction client". The validate
// function uses it like `tx`...`...` template-literal style. We seed
// per-call return values via the same queue mechanism.
function makeTxMock() {
  const txQueue: unknown[][] = [];
  const tx = vi.fn(async () => txQueue.shift() ?? []);
  return {
    tx: tx as unknown as Parameters<typeof validateOptimisticConcurrency>[0],
    seed: (...rows: unknown[][]) => {
      txQueue.push(...rows);
    },
  };
}

// ── assertCanEditReply ────────────────────────────────────────────────
//
// Account-scope note: the query JOINs businesses → accounts, so
// activated_at / tier are resolved from `accounts` (not `businesses`).
// The mock rows reflect that shape.

describe('assertCanEditReply', () => {
  const ownerLocationId = 'biz-1';
  const ownerAccountId = 'acc-1';
  const ctx = { accountId: ownerAccountId, locationId: ownerLocationId };
  const activeSubscription = {
    subscription_status: 'active',
    past_due_at: null,
    flags: {},
  };

  it('Autopilot owner + historical → passes', async () => {
    sqlReturnQueue.push([
      {
        review_business_id: ownerLocationId,
        review_date: new Date('2025-01-01T00:00:00Z'),
        activated_at: new Date('2025-06-01T00:00:00Z'),
        tier: 'autopilot',
        ...activeSubscription,
      },
    ]);
    await expect(assertCanEditReply(sqlMock, 'rev-1', ctx)).resolves.toBeUndefined();
  });

  it('Copilot owner + non-historical (review after activation) → passes', async () => {
    sqlReturnQueue.push([
      {
        review_business_id: ownerLocationId,
        review_date: new Date('2025-07-01T00:00:00Z'),
        activated_at: new Date('2025-06-01T00:00:00Z'),
        tier: 'copilot',
        ...activeSubscription,
      },
    ]);
    await expect(assertCanEditReply(sqlMock, 'rev-1', ctx)).resolves.toBeUndefined();
  });

  it('Copilot owner + historical → passes', async () => {
    sqlReturnQueue.push([
      {
        review_business_id: ownerLocationId,
        review_date: new Date('2025-01-01T00:00:00Z'),
        activated_at: new Date('2025-06-01T00:00:00Z'),
        tier: 'copilot',
        ...activeSubscription,
      },
    ]);
    await expect(assertCanEditReply(sqlMock, 'rev-1', ctx)).resolves.toBeUndefined();
  });

  it('Copilot with NULL activation still allows historical editing', async () => {
    sqlReturnQueue.push([
      {
        review_business_id: ownerLocationId,
        review_date: new Date('2025-01-01T00:00:00Z'),
        activated_at: null,
        tier: 'copilot',
        ...activeSubscription,
      },
    ]);
    await expect(assertCanEditReply(sqlMock, 'rev-1', ctx)).resolves.toBeUndefined();
  });

  it('Autopilot with NULL activation still allows historical editing', async () => {
    sqlReturnQueue.push([
      {
        review_business_id: ownerLocationId,
        review_date: new Date('2025-01-01T00:00:00Z'),
        activated_at: null,
        tier: 'autopilot',
        ...activeSubscription,
      },
    ]);
    await expect(assertCanEditReply(sqlMock, 'rev-1', ctx)).resolves.toBeUndefined();
  });

  it('owner of different location → throws ForbiddenError', async () => {
    sqlReturnQueue.push([
      {
        review_business_id: 'biz-OTHER',
        review_date: new Date('2025-07-01T00:00:00Z'),
        activated_at: new Date('2025-06-01T00:00:00Z'),
        tier: 'copilot',
        ...activeSubscription,
      },
    ]);
    await expect(assertCanEditReply(sqlMock, 'rev-1', ctx)).rejects.toBeInstanceOf(ForbiddenError);
  });

  it('non-existent review → throws NotFoundError', async () => {
    sqlReturnQueue.push([]);
    await expect(
      assertCanEditReply(sqlMock, 'rev-MISSING', ctx),
    ).rejects.toBeInstanceOf(NotFoundError);
  });

  it('review belonging to a different account → throws NotFoundError (account_id mismatch returns no row)', async () => {
    // The AND b.account_id = ${ctx.accountId} predicate filters the row out,
    // so the query returns empty — same "no row" path as a missing review.
    sqlReturnQueue.push([]);
    await expect(
      assertCanEditReply(sqlMock, 'rev-cross-account', { accountId: 'acc-OTHER', locationId: ownerLocationId }),
    ).rejects.toBeInstanceOf(NotFoundError);
  });

  it('boundary: review_date == subscription_activated_at counts as gap (not historical)', async () => {
    const ts = new Date('2025-06-01T12:00:00Z');
    sqlReturnQueue.push([
      {
        review_business_id: ownerLocationId,
        review_date: ts,
        activated_at: ts,
        tier: 'copilot',
        ...activeSubscription,
      },
    ]);
    await expect(assertCanEditReply(sqlMock, 'rev-1', ctx)).resolves.toBeUndefined();
  });

  it.each([
    ['gap', new Date('2025-07-01T00:00:00Z')],
    ['historical', new Date('2025-01-01T00:00:00Z')],
  ])('fails closed on an unsupported tier for a %s reply', async (_bucket, reviewDate) => {
    const unsupportedTier = 'retired_tier' as unknown as SubscriptionTierValue;
    sqlReturnQueue.push([{
      review_business_id: ownerLocationId,
      review_date: reviewDate,
      activated_at: new Date('2025-06-01T00:00:00Z'),
      tier: unsupportedTier,
      ...activeSubscription,
    }]);

    await expect(assertCanEditReply(sqlMock, 'rev-1', ctx)).rejects.toBeInstanceOf(
      ForbiddenError,
    );
    expect(sqlMockFn).toHaveBeenCalledTimes(1);
    expect(sqlReturnQueue).toHaveLength(0);
  });

  it('throws SubscriptionReadOnlyError when the account is past-due read-only', async () => {
    sqlReturnQueue.push([
      {
        review_business_id: ownerLocationId,
        review_date: new Date('2026-05-21T00:00:00Z'),
        activated_at: new Date('2026-05-01T00:00:00Z'),
        tier: 'copilot',
        subscription_status: 'past_due',
        past_due_at: new Date('2026-05-10T00:00:00Z'),
        flags: {},
      },
    ]);

    await expect(assertCanEditReply(sqlMock, 'rev-1', ctx)).rejects.toBeInstanceOf(SubscriptionReadOnlyError);
  });

  it('throws SubscriptionReadOnlyError when the account subscription is inactive', async () => {
    sqlReturnQueue.push([
      {
        review_business_id: ownerLocationId,
        review_date: new Date('2026-05-21T00:00:00Z'),
        activated_at: new Date('2026-05-01T00:00:00Z'),
        tier: 'copilot',
        subscription_status: 'pending_payment',
        past_due_at: null,
        flags: {},
      },
    ]);

    await expect(assertCanEditReply(sqlMock, 'rev-1', ctx)).rejects.toMatchObject({
      name: 'SubscriptionReadOnlyError',
      message: 'subscription_inactive',
      status: 403,
    });
  });
});

// ── validateOptimisticConcurrency ─────────────────────────────────────

describe('validateOptimisticConcurrency', () => {
  it('hash + version match → passes', async () => {
    const { tx, seed } = makeTxMock();
    seed(
      [{ review_content_hash: 'hash-A', review_text: 'Great food' }],
      [{ version: 3 }],
    );
    await expect(
      validateOptimisticConcurrency(tx, 'rev-1', { hash: 'hash-A', version: 3 }),
    ).resolves.toBeUndefined();
  });

  it('hash mismatch → throws ReviewChangedError with current review text in payload', async () => {
    const { tx, seed } = makeTxMock();
    seed([{ review_content_hash: 'hash-B', review_text: 'Edited review text' }]);
    try {
      await validateOptimisticConcurrency(tx, 'rev-1', { hash: 'hash-A', version: 3 });
      throw new Error('expected throw');
    } catch (err) {
      expect(err).toBeInstanceOf(ReviewChangedError);
      expect((err as ReviewChangedError).current).toEqual({
        reviewText: 'Edited review text',
        reviewHash: 'hash-B',
      });
    }
  });

  it('version mismatch → throws ResponseChangedError', async () => {
    const { tx, seed } = makeTxMock();
    seed(
      [{ review_content_hash: 'hash-A', review_text: 'Same' }],
      [{ version: 4 }],
    );
    await expect(
      validateOptimisticConcurrency(tx, 'rev-1', { hash: 'hash-A', version: 3 }),
    ).rejects.toBeInstanceOf(ResponseChangedError);
  });

  it('no posted row exists → throws ResponseChangedError', async () => {
    const { tx, seed } = makeTxMock();
    seed([{ review_content_hash: 'hash-A', review_text: 'Same' }], []);
    await expect(
      validateOptimisticConcurrency(tx, 'rev-1', { hash: 'hash-A', version: 3 }),
    ).rejects.toBeInstanceOf(ResponseChangedError);
  });

  it('after /draft INSERTs a draft, /publish-time validation against the still-posted row passes (regression)', async () => {
    // The 'posted' row is at version 3; a new draft at version 4 also exists,
    // but the SELECT WHERE status='posted' filters it out, so the validation
    // sees v3 — matching the snapshot taken when the drawer was opened.
    const { tx, seed } = makeTxMock();
    seed(
      [{ review_content_hash: 'hash-A', review_text: 'Same' }],
      [{ version: 3 }],
    );
    await expect(
      validateOptimisticConcurrency(tx, 'rev-1', { hash: 'hash-A', version: 3 }),
    ).resolves.toBeUndefined();
  });

  it('non-existent review → throws NotFoundError', async () => {
    const { tx, seed } = makeTxMock();
    seed([]);
    await expect(
      validateOptimisticConcurrency(tx, 'rev-MISSING', { hash: 'hash-A', version: 3 }),
    ).rejects.toBeInstanceOf(NotFoundError);
  });
});
