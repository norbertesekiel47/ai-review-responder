import { describe, it, expect, vi, beforeEach } from 'vitest';

// ── Hoisted sql mock (mirrors OutboxPoller.test.ts) ──────────────────
const { sqlReturnQueue, mockSql } = vi.hoisted(() => {
  const sqlReturnQueue: unknown[] = [];
  const shiftFrom = (q: unknown[]) => {
    const r = q.shift() ?? [];
    return Promise.resolve(Array.isArray(r) ? r : [r]);
  };
  const mockSql: any = vi.fn((_s: TemplateStringsArray, ..._v: unknown[]) => shiftFrom(sqlReturnQueue));
  return { sqlReturnQueue, mockSql };
});

vi.mock('../../../../../src/lib/db/server', () => ({ sql: mockSql }));

import {
  checkOldestPendingOutbox,
  checkStaleDispatching,
  checkOpenFlaggedResponses,
  checkFailedOutboxByTopic,
  checkZeroDeliveryNotifications,
  runHealthChecks,
  type HealthAlertConfig,
} from '../checks';

const CFG: HealthAlertConfig = {
  pendingAgeThresholdS: 900,
  failedWindowS: 3600,
  failedThreshold: 0,
  staleDispatchingThresholdS: 600,
  flaggedOpenThreshold: 5,
  zeroDeliveryWindowS: 3600,
};

const HEALTH_ENV = [
  'HEALTH_ALERT_PENDING_AGE_S',
  'HEALTH_ALERT_FAILED_WINDOW_S',
  'HEALTH_ALERT_FAILED_THRESHOLD',
  'HEALTH_ALERT_STALE_DISPATCHING_S',
  'HEALTH_ALERT_FLAGGED_OPEN_THRESHOLD',
  'HEALTH_ALERT_ZERO_DELIVERY_WINDOW_S',
];

describe('health-alert checks', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    sqlReturnQueue.length = 0;
    for (const k of HEALTH_ENV) delete process.env[k];
  });

  describe('checkOldestPendingOutbox', () => {
    it('returns a finding when the oldest pending row exceeds the threshold', async () => {
      sqlReturnQueue.push([{ age: 1200 }]);
      const finding = await checkOldestPendingOutbox(CFG);
      expect(finding?.key).toBe('outbox_pending_age');
      expect(finding?.detail.oldest_age_s).toBe(1200);
    });
    it('returns null when within threshold', async () => {
      sqlReturnQueue.push([{ age: 100 }]);
      expect(await checkOldestPendingOutbox(CFG)).toBeNull();
    });
    it('returns null when there are no pending rows (age null)', async () => {
      sqlReturnQueue.push([{ age: null }]);
      expect(await checkOldestPendingOutbox(CFG)).toBeNull();
    });
  });

  describe('checkStaleDispatching', () => {
    it('returns an error finding when stale dispatching rows exist', async () => {
      sqlReturnQueue.push([{ count: 3 }]);
      const finding = await checkStaleDispatching(CFG);
      expect(finding?.key).toBe('outbox_stale_dispatching');
      expect(finding?.level).toBe('error');
    });
    it('returns null when none are stale', async () => {
      sqlReturnQueue.push([{ count: 0 }]);
      expect(await checkStaleDispatching(CFG)).toBeNull();
    });
  });

  describe('checkOpenFlaggedResponses', () => {
    it('returns a finding when the open backlog exceeds the threshold', async () => {
      sqlReturnQueue.push([{ count: 9 }]);
      const finding = await checkOpenFlaggedResponses(CFG);
      expect(finding?.key).toBe('flagged_open_backlog');
    });
    it('returns null at or below the threshold', async () => {
      sqlReturnQueue.push([{ count: 5 }]);
      expect(await checkOpenFlaggedResponses(CFG)).toBeNull();
    });
  });

  describe('checkFailedOutboxByTopic', () => {
    it('emits one finding per public-path topic over threshold, skipping zero counts', async () => {
      sqlReturnQueue.push([
        { topic: 'publish_response', count: 2 },
        { topic: 'send_notification', count: 0 },
      ]);
      const findings = await checkFailedOutboxByTopic(CFG);
      expect(findings).toHaveLength(1);
      expect(findings[0]?.key).toBe('outbox_failed:publish_response');
      expect(findings[0]?.level).toBe('error');
    });
    it('returns an empty array when nothing failed', async () => {
      sqlReturnQueue.push([]);
      expect(await checkFailedOutboxByTopic(CFG)).toEqual([]);
    });
  });

  describe('checkZeroDeliveryNotifications', () => {
    it('returns an error finding when completed notifications produced zero deliveries', async () => {
      sqlReturnQueue.push([{ count: 1 }]);
      const finding = await checkZeroDeliveryNotifications(CFG);
      expect(finding?.key).toBe('zero_delivery_notifications');
      expect(finding?.level).toBe('error');
    });
    it('returns null when every completed notification delivered', async () => {
      sqlReturnQueue.push([{ count: 0 }]);
      expect(await checkZeroDeliveryNotifications(CFG)).toBeNull();
    });
  });

  describe('runHealthChecks', () => {
    it('aggregates findings across all checks (env defaults)', async () => {
      // Order matches Promise.all dispatch order in runHealthChecks:
      // failedByTopic, oldestPending, staleDispatching, openFlagged, zeroDelivery
      sqlReturnQueue.push([{ topic: 'publish_response', count: 1 }]); // failed → finding
      sqlReturnQueue.push([{ age: 50 }]);                              // pending → null
      sqlReturnQueue.push([{ count: 0 }]);                             // stale → null
      sqlReturnQueue.push([{ count: 10 }]);                            // flagged → finding (>5 default)
      sqlReturnQueue.push([{ count: 0 }]);                             // zero-delivery → null

      const findings = await runHealthChecks();
      const keys = findings.map((f) => f.key).sort();
      expect(keys).toEqual(['flagged_open_backlog', 'outbox_failed:publish_response']);
    });
  });
});
