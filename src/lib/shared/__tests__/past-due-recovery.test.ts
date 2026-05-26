import { describe, expect, it } from 'vitest';
import { computePastDueRecoveryState } from '../past-due-recovery';
import {
  assertWritableSubscription,
  assertWritableSubscriptionForAccount,
  assertWritableSubscriptionStatus,
  SubscriptionReadOnlyError,
  throwIfReadOnly,
} from '../writable-subscription';

const NOW = new Date('2026-05-25T12:00:00.000Z');

describe('computePastDueRecoveryState', () => {
  it('uses past_due_at as the grace clock', () => {
    const state = computePastDueRecoveryState({
      subscriptionStatus: 'past_due',
      pastDueAt: new Date('2026-05-24T12:00:00.000Z'),
      accountFlags: {},
      now: NOW,
    });
    expect(state.isPastDue).toBe(true);
    expect(state.isReadOnly).toBe(false);
    expect(state.daysRemaining).toBe(6);
  });

  it('marks read-only after seven days without extension', () => {
    const state = computePastDueRecoveryState({
      subscriptionStatus: 'past_due',
      pastDueAt: new Date('2026-05-17T12:00:00.000Z'),
      accountFlags: {},
      now: NOW,
    });
    expect(state.isReadOnly).toBe(true);
  });

  it('marks past_due read-only when past_due_at is missing', () => {
    const state = computePastDueRecoveryState({
      subscriptionStatus: 'past_due',
      pastDueAt: null,
      accountFlags: {},
      now: NOW,
    });

    expect(state.isPastDue).toBe(true);
    expect(state.isReadOnly).toBe(true);
    expect(state.daysRemaining).toBe(0);
  });

  it('marks past_due read-only when past_due_at is invalid', () => {
    const state = computePastDueRecoveryState({
      subscriptionStatus: 'past_due',
      pastDueAt: 'not-a-date',
      accountFlags: {},
      now: NOW,
    });

    expect(state.isReadOnly).toBe(true);
    expect(state.daysRemaining).toBe(0);
  });

  it('marks past_due read-only when past_due_at is in the future', () => {
    const state = computePastDueRecoveryState({
      subscriptionStatus: 'past_due',
      pastDueAt: '2026-05-26T12:00:00.000Z',
      accountFlags: {},
      now: NOW,
    });

    expect(state.isReadOnly).toBe(true);
    expect(state.daysRemaining).toBe(0);
  });

  it('extends the cutoff with active past_due_extension flag', () => {
    const state = computePastDueRecoveryState({
      subscriptionStatus: 'past_due',
      pastDueAt: new Date('2026-05-17T12:00:00.000Z'),
      accountFlags: {
        past_due_extension: {
          days: 7,
          expires_at: '2026-06-01T12:00:00.000Z',
          reason: 'card replacement',
        },
      },
      now: NOW,
    });
    expect(state.isReadOnly).toBe(false);
    expect(state.extension?.days).toBe(7);
  });

  it('uses extension expires_at as the deadline for already read-only accounts', () => {
    const state = computePastDueRecoveryState({
      subscriptionStatus: 'past_due',
      pastDueAt: new Date('2026-05-16T12:00:00.000Z'),
      accountFlags: {
        past_due_extension: {
          days: 3,
          expires_at: '2026-05-28T12:00:00.000Z',
        },
      },
      now: NOW,
    });

    expect(state.isReadOnly).toBe(false);
    expect(state.deadline?.toISOString()).toBe('2026-05-28T12:00:00.000Z');
  });

  it('parses account flags returned as a JSONB string', () => {
    const state = computePastDueRecoveryState({
      subscriptionStatus: 'past_due',
      pastDueAt: new Date('2026-05-17T12:00:00.000Z'),
      accountFlags: JSON.stringify({
        past_due_extension: {
          days: 7,
          expires_at: '2026-06-01T12:00:00.000Z',
        },
      }),
      now: NOW,
    });

    expect(state.isReadOnly).toBe(false);
    expect(state.extension?.days).toBe(7);
  });
});

describe('assertWritableSubscription', () => {
  it('returns a 402 read-only error when the recovery state is read-only', () => {
    expect(assertWritableSubscription({
      isPastDue: true,
      pastDueAt: new Date('2026-05-17T12:00:00.000Z'),
      deadline: new Date('2026-05-24T12:00:00.000Z'),
      daysRemaining: 0,
      isReadOnly: true,
      extension: null,
    })).toEqual({ ok: false, status: 402, error: 'past_due_read_only' });
  });

  it('allows writes while the past-due recovery window is still open', () => {
    expect(assertWritableSubscription({
      isPastDue: true,
      pastDueAt: new Date('2026-05-20T12:00:00.000Z'),
      deadline: new Date('2026-05-27T12:00:00.000Z'),
      daysRemaining: 2,
      isReadOnly: false,
      extension: null,
    })).toEqual({ ok: true });
  });
});

describe('assertWritableSubscriptionStatus', () => {
  it('allows active subscriptions', () => {
    expect(assertWritableSubscriptionStatus({
      subscriptionStatus: 'active',
      pastDueAt: null,
      accountFlags: {},
    })).toEqual({ ok: true });
  });

  it('allows past_due subscriptions while the recovery window is open', () => {
    expect(assertWritableSubscriptionStatus({
      subscriptionStatus: 'past_due',
      pastDueAt: new Date(Date.now() - 1 * 86_400_000),
      accountFlags: {},
    })).toEqual({ ok: true });
  });

  it('blocks past_due subscriptions after the recovery window', () => {
    expect(assertWritableSubscriptionStatus({
      subscriptionStatus: 'past_due',
      pastDueAt: new Date(Date.now() - 8 * 86_400_000),
      accountFlags: {},
    })).toEqual({ ok: false, status: 402, error: 'past_due_read_only' });
  });

  it('blocks non-active non-past_due subscriptions', () => {
    expect(assertWritableSubscriptionStatus({
      subscriptionStatus: 'pending_payment',
      pastDueAt: null,
      accountFlags: {},
    })).toEqual({ ok: false, status: 403, error: 'subscription_inactive' });
  });
});

describe('assertWritableSubscriptionForAccount', () => {
  it('fails closed when the account row is missing', async () => {
    const db = async () => [];

    await expect(assertWritableSubscriptionForAccount('acct-1', db as never))
      .resolves.toEqual({ ok: false, status: 403, error: 'no_business' });
  });

  it('blocks cancelled accounts from write routes', async () => {
    const db = async () => [{
      subscription_status: 'cancelled',
      past_due_at: null,
      flags: {},
    }];

    await expect(assertWritableSubscriptionForAccount('acct-1', db as never))
      .resolves.toEqual({ ok: false, status: 403, error: 'subscription_inactive' });
  });
});

describe('throwIfReadOnly', () => {
  it('preserves non-402 blocked-write status codes', () => {
    expect(() => throwIfReadOnly({
      ok: false,
      status: 403,
      error: 'subscription_inactive',
    })).toThrow(SubscriptionReadOnlyError);

    try {
      throwIfReadOnly({ ok: false, status: 403, error: 'subscription_inactive' });
    } catch (err) {
      expect(err).toMatchObject({
        name: 'SubscriptionReadOnlyError',
        message: 'subscription_inactive',
        status: 403,
        error: 'subscription_inactive',
      });
    }
  });
});
