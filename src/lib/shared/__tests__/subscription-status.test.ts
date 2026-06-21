// src/lib/shared/__tests__/subscription-status.test.ts
//
// TDD assertions for central SubscriptionStatus type/const.
// Validation contract: SubscriptionStatus const contains all 4 statuses.

import { describe, it, expect } from 'vitest';
import {
  SubscriptionStatus,
  type SubscriptionStatusValue,
  isSubscriptionStatus,
  subscriptionAllowsDashboardRead,
  subscriptionGrantsFullAccess,
} from '../subscription-status';

describe('SubscriptionStatus', () => {
  it('contains pending_payment', () => {
    expect(SubscriptionStatus.PENDING_PAYMENT).toBe('pending_payment');
  });

  it('contains active', () => {
    expect(SubscriptionStatus.ACTIVE).toBe('active');
  });

  it('contains trialing', () => {
    expect(SubscriptionStatus.TRIALING).toBe('trialing');
  });

  it('contains past_due', () => {
    expect(SubscriptionStatus.PAST_DUE).toBe('past_due');
  });

  it('contains cancelled', () => {
    expect(SubscriptionStatus.CANCELLED).toBe('cancelled');
  });

  it('has exactly 5 status values', () => {
    const values = Object.values(SubscriptionStatus);
    expect(values).toHaveLength(5);
  });

  it('all values are strings', () => {
    const values = Object.values(SubscriptionStatus);
    for (const v of values) {
      expect(typeof v).toBe('string');
    }
  });

  it('SubscriptionStatusValue type is derived from const (compile-time check)', () => {
    // This test verifies the type derivation works at the type level.
    // At runtime we just confirm the values are present.
    const s: SubscriptionStatusValue = 'active';
    expect(typeof s).toBe('string');
  });
});

describe('subscriptionGrantsFullAccess', () => {
  it('grants full access to active and trialing', () => {
    expect(subscriptionGrantsFullAccess('active')).toBe(true);
    expect(subscriptionGrantsFullAccess('trialing')).toBe(true);
  });

  it('denies pending_payment, past_due, and cancelled', () => {
    expect(subscriptionGrantsFullAccess('pending_payment')).toBe(false);
    expect(subscriptionGrantsFullAccess('past_due')).toBe(false);
    expect(subscriptionGrantsFullAccess('cancelled')).toBe(false);
  });
});

describe('subscriptionAllowsDashboardRead', () => {
  it('allows active and past_due and trialing', () => {
    expect(subscriptionAllowsDashboardRead('active')).toBe(true);
    expect(subscriptionAllowsDashboardRead('past_due')).toBe(true);
    expect(subscriptionAllowsDashboardRead('trialing')).toBe(true);
  });

  it('denies pending_payment and cancelled', () => {
    expect(subscriptionAllowsDashboardRead('pending_payment')).toBe(false);
    expect(subscriptionAllowsDashboardRead('cancelled')).toBe(false);
  });
});

describe('isSubscriptionStatus', () => {
  it('returns true for all five canonical statuses', () => {
    expect(isSubscriptionStatus('pending_payment')).toBe(true);
    expect(isSubscriptionStatus('active')).toBe(true);
    expect(isSubscriptionStatus('trialing')).toBe(true);
    expect(isSubscriptionStatus('past_due')).toBe(true);
    expect(isSubscriptionStatus('cancelled')).toBe(true);
  });

  it('returns false for unknown strings', () => {
    expect(isSubscriptionStatus('unknown')).toBe(false);
    expect(isSubscriptionStatus('expired')).toBe(false);
    expect(isSubscriptionStatus('')).toBe(false);
  });

  it('returns false for case-variants', () => {
    expect(isSubscriptionStatus('Active')).toBe(false);
    expect(isSubscriptionStatus('PENDING_PAYMENT')).toBe(false);
  });

  it('narrows the type when true', () => {
    const value: string = 'active';
    if (isSubscriptionStatus(value)) {
      // TypeScript should now know value is SubscriptionStatusValue
      const _typed: SubscriptionStatusValue = value;
      expect(_typed).toBe('active');
    }
  });
});
