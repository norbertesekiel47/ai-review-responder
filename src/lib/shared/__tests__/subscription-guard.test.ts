import { describe, it, expect } from 'vitest';
import { checkSubscription, type WorkerType } from '../subscription-guard';

const WORKER_TYPES: WorkerType[] = ['generator', 'notification', 'publisher', 'summary'];
const NOW = new Date();
const ONE_DAY_AGO = new Date(Date.now() - 86_400_000);

describe('checkSubscription', () => {
  describe('active', () => {
    it.each(WORKER_TYPES)('allows %s worker', (workerType) => {
      expect(checkSubscription('active', NOW, workerType)).toEqual({ allowed: true });
    });
  });

  describe('cancelled', () => {
    it.each(WORKER_TYPES)('denies %s worker', (workerType) => {
      const result = checkSubscription('cancelled', NOW, workerType);
      expect(result).toEqual({ allowed: false, reason: 'cancelled' });
    });
  });

  describe('pending_payment', () => {
    it('allows generator worker (admin-visible demo drafts)', () => {
      expect(checkSubscription('pending_payment', NOW, 'generator')).toEqual({
        allowed: true,
      });
    });

    it.each<WorkerType>(['notification', 'publisher', 'summary'])(
      'denies %s worker',
      (workerType) => {
        const result = checkSubscription('pending_payment', NOW, workerType);
        expect(result).toEqual({ allowed: false, reason: 'pending_payment' });
      },
    );
  });

  describe('past_due', () => {
    it.each(WORKER_TYPES)('allows %s worker within 7-day grace period', (workerType) => {
      const result = checkSubscription('past_due', ONE_DAY_AGO, workerType);
      expect(result).toEqual({ allowed: true });
    });

    it.each(WORKER_TYPES)('denies %s worker after 7-day grace period', (workerType) => {
      const eightDaysAgo = new Date(Date.now() - 8 * 86_400_000);
      const result = checkSubscription('past_due', eightDaysAgo, workerType);
      expect(result).toEqual({ allowed: false, reason: 'past_due_expired' });
    });

    it('allows at exactly 6 days 23 hours 59 minutes (inside grace)', () => {
      const justInside = new Date(Date.now() - (7 * 86_400_000 - 60_000));
      expect(checkSubscription('past_due', justInside, 'generator')).toEqual({
        allowed: true,
      });
    });

    it('denies at 7 days and 1 second (outside grace)', () => {
      const justOutside = new Date(Date.now() - (7 * 86_400_000 + 1_000));
      expect(checkSubscription('past_due', justOutside, 'generator')).toEqual({
        allowed: false,
        reason: 'past_due_expired',
      });
    });
  });

  describe('unknown status', () => {
    it('denies with descriptive reason', () => {
      const result = checkSubscription('bogus', NOW, 'generator');
      expect(result).toEqual({ allowed: false, reason: 'unknown_status:bogus' });
    });
  });
});
