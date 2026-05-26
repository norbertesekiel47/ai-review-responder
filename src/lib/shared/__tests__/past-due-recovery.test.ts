import { describe, expect, it } from 'vitest';
import { computePastDueRecoveryState } from '../past-due-recovery';

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
