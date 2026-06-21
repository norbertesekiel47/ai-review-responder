// src/lib/shared/__tests__/writable-subscription-status.test.ts
//
// Unit tests for the pure status gate `assertWritableSubscriptionStatus`.
// trialing must be writable exactly like active.

import { describe, it, expect } from 'vitest';
import { assertWritableSubscriptionStatus } from '../writable-subscription';

describe('assertWritableSubscriptionStatus', () => {
  it('allows active', () => {
    expect(
      assertWritableSubscriptionStatus({ subscriptionStatus: 'active', pastDueAt: null }),
    ).toEqual({ ok: true });
  });

  it('allows trialing (treated like active)', () => {
    expect(
      assertWritableSubscriptionStatus({ subscriptionStatus: 'trialing', pastDueAt: null }),
    ).toEqual({ ok: true });
  });

  it('rejects pending_payment', () => {
    expect(
      assertWritableSubscriptionStatus({ subscriptionStatus: 'pending_payment', pastDueAt: null }),
    ).toEqual({ ok: false, status: 403, error: 'subscription_inactive' });
  });

  it('rejects cancelled', () => {
    expect(
      assertWritableSubscriptionStatus({ subscriptionStatus: 'cancelled', pastDueAt: null }),
    ).toEqual({ ok: false, status: 403, error: 'subscription_inactive' });
  });

  it('past_due inside grace is writable', () => {
    const oneDayAgo = new Date(Date.now() - 86_400_000);
    expect(
      assertWritableSubscriptionStatus({
        subscriptionStatus: 'past_due',
        pastDueAt: oneDayAgo,
        accountFlags: {},
      }),
    ).toEqual({ ok: true });
  });
});
