// worker/background/pollers/__tests__/stripe-overage.test.ts
import { describe, it, expect } from 'vitest';
import {
  isMissingStripeSubscriptionError,
  activeStripeSubscriptions,
  extractStripeCustomerId,
} from '../billing-reconciliation/stripe-overage';

describe('stripe-overage helpers', () => {
  describe('extractStripeCustomerId', () => {
    it('returns the string customer id directly', () => {
      expect(extractStripeCustomerId('cus_123')).toBe('cus_123');
    });
    it('returns the id from a customer object', () => {
      expect(extractStripeCustomerId({ id: 'cus_obj' } as any)).toBe('cus_obj');
    });
    it('returns null for a null customer', () => {
      expect(extractStripeCustomerId(null)).toBeNull();
    });
  });

  describe('isMissingStripeSubscriptionError', () => {
    it('detects the resource_missing code', () => {
      expect(isMissingStripeSubscriptionError({ code: 'resource_missing' })).toBe(true);
    });
    it('detects a 404 statusCode', () => {
      expect(isMissingStripeSubscriptionError({ statusCode: 404 })).toBe(true);
    });
    it('detects an invalid-request "no such subscription" message', () => {
      expect(isMissingStripeSubscriptionError({
        type: 'StripeInvalidRequestError',
        message: 'No such subscription: sub_x',
      })).toBe(true);
    });
    it('is false for unrelated errors', () => {
      expect(isMissingStripeSubscriptionError(new Error('timeout'))).toBe(false);
    });
    it('is false for null', () => {
      expect(isMissingStripeSubscriptionError(null)).toBe(false);
    });
  });

  describe('activeStripeSubscriptions', () => {
    it('keeps active/trialing/past_due/unpaid and drops canceled', () => {
      const result = activeStripeSubscriptions({
        data: [
          { id: 'a', status: 'active' },
          { id: 't', status: 'trialing' },
          { id: 'p', status: 'past_due' },
          { id: 'u', status: 'unpaid' },
          { id: 'c', status: 'canceled' },
        ] as any,
      });
      expect(result.map((s) => s.id)).toEqual(['a', 't', 'p', 'u']);
    });
    it('handles a missing data array', () => {
      expect(activeStripeSubscriptions({} as any)).toEqual([]);
    });
  });
});
