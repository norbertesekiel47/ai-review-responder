// worker/background/pollers/__tests__/stripe-overage.test.ts
import { describe, it, expect } from 'vitest';
import {
  isMissingStripeSubscriptionError,
  activeStripeSubscriptions,
  extractStripeCustomerId,
  findOverageItem,
  isOverageItem,
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

  describe('isOverageItem', () => {
    const overageIds = new Set(['price_overage_std']);
    it('matches by a known overage price id', () => {
      expect(isOverageItem(
        { price: { id: 'price_overage_std', unit_amount: 2500 } } as any,
        overageIds, 2500, 2,
      )).toBe(true);
    });
    it('matches by a descriptor keyword', () => {
      expect(isOverageItem(
        { price: { id: 'price_x', nickname: 'Extra location', unit_amount: 2500 } } as any,
        overageIds, 0, 2,
      )).toBe(true);
    });
    it('matches a legacy price by stored unit amount when more than one item', () => {
      expect(isOverageItem(
        { price: { id: 'price_legacy', unit_amount: 3000 } } as any,
        overageIds, 3000, 2,
      )).toBe(true);
    });
    it('does not match the sole item by unit amount', () => {
      expect(isOverageItem(
        { price: { id: 'price_base', unit_amount: 3000 } } as any,
        overageIds, 3000, 1,
      )).toBe(false);
    });
    it('returns false when the item has no price', () => {
      expect(isOverageItem({} as any, overageIds, 2500, 2)).toBe(false);
    });
  });

  describe('findOverageItem', () => {
    const overageIds = new Set(['price_overage_std']);
    it('finds the overage item among subscription items', () => {
      const sub = {
        items: { data: [
          { id: 'si_base', price: { id: 'price_base', unit_amount: 7900 } },
          { id: 'si_over', price: { id: 'price_overage_std', unit_amount: 2500 } },
        ] },
      };
      expect(findOverageItem(sub as any, overageIds, 2500)?.id).toBe('si_over');
    });
    it('returns undefined when no overage item exists', () => {
      const sub = { items: { data: [
        { id: 'si_base', price: { id: 'price_base', unit_amount: 7900 } },
      ] } };
      expect(findOverageItem(sub as any, overageIds, 2500)).toBeUndefined();
    });
  });
});
