// src/lib/shared/__tests__/subscription-status.test.ts
//
// TDD assertions for central SubscriptionStatus type/const.
// Validation contract: SubscriptionStatus const contains all 4 statuses.

import { describe, it, expect } from 'vitest';
import {
  FULL_ACCESS_SUBSCRIPTION_STATUSES,
  SubscriptionStatus,
  type SubscriptionStatusValue,
  isSubscriptionStatus,
  subscriptionAllowsDashboardRead,
  subscriptionAllowsQrRedirect,
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

describe('FULL_ACCESS_SUBSCRIPTION_STATUSES', () => {
  // #1329: the Release cycle's candidate scan binds this array into SQL to
  // exclude an unentitled account from the 50-row candidate window. A status
  // admitted by one of the two and refused by the other either starves an
  // account that may send or holds slots for one that may not.
  //
  // THE MEMBERSHIP IS ASSERTED AGAINST LITERALS, NOT AGAINST THE PREDICATE, and
  // that is the whole point of the case: `subscriptionGrantsFullAccess` is now
  // IMPLEMENTED over this array, so deriving the expectation from the predicate
  // made both sides move together — red-team round 1 dropped `TRIALING` from the
  // array and the earlier version of this test still passed. The literals are
  // the independent oracle; the loop below then proves the predicate agrees.
  it('FULL_ACCESS_SUBSCRIPTION_STATUSES holds exactly the statuses subscriptionGrantsFullAccess admits', () => {
    expect([...FULL_ACCESS_SUBSCRIPTION_STATUSES].sort()).toStrictEqual([
      'active',
      'trialing',
    ]);
    // Set equality, order-independent: the constant's docstring says the order
    // is not meaningful, so a reorder must not red this test.
    for (const status of Object.values(SubscriptionStatus)) {
      expect(FULL_ACCESS_SUBSCRIPTION_STATUSES.includes(status)).toBe(
        subscriptionGrantsFullAccess(status),
      );
    }
    // And the predicate still refuses the three non-members by name, so the
    // agreement above cannot be satisfied by an empty array.
    expect(subscriptionGrantsFullAccess(SubscriptionStatus.PAST_DUE)).toBe(false);
    expect(subscriptionGrantsFullAccess(SubscriptionStatus.PENDING_PAYMENT)).toBe(false);
    expect(subscriptionGrantsFullAccess(SubscriptionStatus.CANCELLED)).toBe(false);
    expect(subscriptionGrantsFullAccess(SubscriptionStatus.ACTIVE)).toBe(true);
    expect(subscriptionGrantsFullAccess(SubscriptionStatus.TRIALING)).toBe(true);
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

describe('subscriptionAllowsQrRedirect', () => {
  it('subscriptionAllowsQrRedirect admits active, trialing and past_due only', () => {
    expect(subscriptionAllowsQrRedirect(SubscriptionStatus.ACTIVE)).toBe(true);
    expect(subscriptionAllowsQrRedirect(SubscriptionStatus.TRIALING)).toBe(true);
    expect(subscriptionAllowsQrRedirect(SubscriptionStatus.PAST_DUE)).toBe(true);
    expect(subscriptionAllowsQrRedirect(SubscriptionStatus.PENDING_PAYMENT)).toBe(false);
    expect(subscriptionAllowsQrRedirect(SubscriptionStatus.CANCELLED)).toBe(false);
    expect(subscriptionAllowsQrRedirect('nonsense')).toBe(false);
  });
});
