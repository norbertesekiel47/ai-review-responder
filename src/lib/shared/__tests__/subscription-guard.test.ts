import { describe, it, expect } from 'vitest';
import { checkSubscription, type WorkerType } from '../subscription-guard';

const WORKER_TYPES: WorkerType[] = ['generator', 'notification', 'publisher', 'summary'];
const NOW = new Date('2026-05-25T12:00:00.000Z');
const ONE_DAY_AGO = new Date(NOW.getTime() - 86_400_000);

describe('checkSubscription', () => {
  describe('active', () => {
    it.each(WORKER_TYPES)('allows %s worker', (workerType) => {
      expect(checkSubscription({ status: 'active', workerType, now: NOW })).toEqual({ allowed: true });
    });
  });

  describe('cancelled', () => {
    it.each(WORKER_TYPES)('denies %s worker', (workerType) => {
      const result = checkSubscription({ status: 'cancelled', workerType, now: NOW });
      expect(result).toEqual({ allowed: false, reason: 'cancelled' });
    });
  });

  describe('pending_payment', () => {
    it('allows generator worker (admin-visible demo drafts)', () => {
      expect(checkSubscription({ status: 'pending_payment', workerType: 'generator', now: NOW })).toEqual({
        allowed: true,
      });
    });

    it.each<WorkerType>(['notification', 'publisher', 'summary'])(
      'denies %s worker',
      (workerType) => {
        const result = checkSubscription({ status: 'pending_payment', workerType, now: NOW });
        expect(result).toEqual({ allowed: false, reason: 'pending_payment' });
      },
    );
  });

  describe('past_due', () => {
    it.each(WORKER_TYPES)('allows %s worker within 7-day grace period', (workerType) => {
      const result = checkSubscription({
        status: 'past_due',
        pastDueAt: ONE_DAY_AGO,
        accountFlags: {},
        workerType,
        now: NOW,
      });
      expect(result).toEqual({ allowed: true });
    });

    it.each(WORKER_TYPES)('denies %s worker after 7-day grace period', (workerType) => {
      const eightDaysAgo = new Date(NOW.getTime() - 8 * 86_400_000);
      const result = checkSubscription({
        status: 'past_due',
        pastDueAt: eightDaysAgo,
        accountFlags: {},
        workerType,
        now: NOW,
      });
      expect(result).toEqual({ allowed: false, reason: 'past_due_expired' });
    });

    it('allows at exactly 6 days 23 hours 59 minutes (inside grace)', () => {
      const justInside = new Date(NOW.getTime() - (7 * 86_400_000 - 60_000));
      expect(checkSubscription({
        status: 'past_due',
        pastDueAt: justInside,
        accountFlags: {},
        workerType: 'generator',
        now: NOW,
      })).toEqual({
        allowed: true,
      });
    });

    it('denies at 7 days and 1 second (outside grace)', () => {
      const justOutside = new Date(NOW.getTime() - (7 * 86_400_000 + 1_000));
      expect(checkSubscription({
        status: 'past_due',
        pastDueAt: justOutside,
        accountFlags: {},
        workerType: 'generator',
        now: NOW,
      })).toEqual({
        allowed: false,
        reason: 'past_due_expired',
      });
    });

    it('honors active past_due_extension flags', () => {
      const eightDaysAgo = new Date(NOW.getTime() - 8 * 86_400_000);
      expect(checkSubscription({
        status: 'past_due',
        pastDueAt: eightDaysAgo,
        accountFlags: {
          past_due_extension: { days: 7, expires_at: '2026-06-01T00:00:00.000Z' },
        },
        workerType: 'publisher',
        now: NOW,
      })).toEqual({ allowed: true });
    });

    it('does not use unrelated business updated_at as the past-due clock', () => {
      const result = checkSubscription({
        status: 'past_due',
        pastDueAt: new Date(NOW.getTime() - 8 * 86_400_000),
        businessUpdatedAt: NOW,
        accountFlags: {},
        workerType: 'publisher',
        now: NOW,
      });
      expect(result).toEqual({ allowed: false, reason: 'past_due_expired' });
    });
  });

  describe('unknown status', () => {
    it('denies with descriptive reason', () => {
      const result = checkSubscription({ status: 'bogus', workerType: 'generator', now: NOW });
      expect(result).toEqual({ allowed: false, reason: 'unknown_status:bogus' });
    });
  });
});
