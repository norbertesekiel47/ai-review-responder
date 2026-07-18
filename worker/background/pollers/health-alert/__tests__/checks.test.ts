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
  checkBacklogDepth,
  runHealthChecks,
  type HealthAlertConfig,
} from '../checks';
import { resetWorkerConfigForTests } from '../../../../../src/lib/config/worker';

const CFG: HealthAlertConfig = {
  pendingAgeThresholdS: 900,
  failedWindowS: 3600,
  failedThreshold: 0,
  staleDispatchingThresholdS: 600,
  flaggedOpenThreshold: 5,
  zeroDeliveryWindowS: 3600,
  backlogDepthThreshold: 1500,
};

const HEALTH_ENV = [
  'HEALTH_ALERT_PENDING_AGE_S',
  'HEALTH_ALERT_FAILED_WINDOW_S',
  'HEALTH_ALERT_FAILED_THRESHOLD',
  'HEALTH_ALERT_STALE_DISPATCHING_S',
  'HEALTH_ALERT_FLAGGED_OPEN_THRESHOLD',
  'HEALTH_ALERT_ZERO_DELIVERY_WINDOW_S',
  'HEALTH_ALERT_BACKLOG_DEPTH_THRESHOLD',
];

describe('health-alert checks', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    sqlReturnQueue.length = 0;
    for (const k of HEALTH_ENV) delete process.env[k];
    resetWorkerConfigForTests();
  });

  describe('checkOldestPendingOutbox', () => {
    it('returns a finding when the oldest pending row exceeds the threshold', async () => {
      sqlReturnQueue.push([{ age: 1200 }]);
      const finding = await checkOldestPendingOutbox(mockSql, CFG);
      expect(finding?.key).toBe('outbox_pending_age');
      expect(finding?.detail.oldest_age_s).toBe(1200);
    });
    it('returns null when within threshold', async () => {
      sqlReturnQueue.push([{ age: 100 }]);
      expect(await checkOldestPendingOutbox(mockSql, CFG)).toBeNull();
    });
    it('returns null when there are no pending rows (age null)', async () => {
      sqlReturnQueue.push([{ age: null }]);
      expect(await checkOldestPendingOutbox(mockSql, CFG)).toBeNull();
    });
  });

  describe('checkStaleDispatching', () => {
    it('returns an error finding when stale dispatching rows exist', async () => {
      sqlReturnQueue.push([{ count: 3 }]);
      const finding = await checkStaleDispatching(mockSql, CFG);
      expect(finding?.key).toBe('outbox_stale_dispatching');
      expect(finding?.level).toBe('error');
    });
    it('returns null when none are stale', async () => {
      sqlReturnQueue.push([{ count: 0 }]);
      expect(await checkStaleDispatching(mockSql, CFG)).toBeNull();
    });
  });

  describe('checkOpenFlaggedResponses', () => {
    it('returns a finding when the open backlog exceeds the threshold', async () => {
      sqlReturnQueue.push([{ count: 9 }]);
      const finding = await checkOpenFlaggedResponses(mockSql, CFG);
      expect(finding?.key).toBe('flagged_open_backlog');
    });
    it('returns null at or below the threshold', async () => {
      sqlReturnQueue.push([{ count: 5 }]);
      expect(await checkOpenFlaggedResponses(mockSql, CFG)).toBeNull();
    });
  });

  describe('checkFailedOutboxByTopic', () => {
    it('emits one finding per public-path topic over threshold, skipping zero counts', async () => {
      sqlReturnQueue.push([
        { topic: 'publish_response', count: 2 },
        { topic: 'send_notification', count: 0 },
      ]);
      const findings = await checkFailedOutboxByTopic(mockSql, CFG);
      expect(findings).toHaveLength(1);
      expect(findings[0]?.key).toBe('outbox_failed:publish_response');
      expect(findings[0]?.level).toBe('error');
    });
    it('returns an empty array when nothing failed', async () => {
      sqlReturnQueue.push([]);
      expect(await checkFailedOutboxByTopic(mockSql, CFG)).toEqual([]);
    });
  });

  describe('checkZeroDeliveryNotifications', () => {
    it('returns an error finding when completed notifications produced zero deliveries', async () => {
      sqlReturnQueue.push([{ count: 1 }]);
      const finding = await checkZeroDeliveryNotifications(mockSql, CFG);
      expect(finding?.key).toBe('zero_delivery_notifications');
      expect(finding?.level).toBe('error');
    });
    it('returns null when every completed notification delivered', async () => {
      sqlReturnQueue.push([{ count: 0 }]);
      expect(await checkZeroDeliveryNotifications(mockSql, CFG)).toBeNull();
    });
  });

  describe('checkBacklogDepth', () => {
    it('emits one warning finding per table over the threshold', async () => {
      sqlReturnQueue.push([{ job_outbox: 1600, analytics_events: 2000 }]);
      const findings = await checkBacklogDepth(mockSql, CFG);
      expect(findings).toHaveLength(2);
      const byKey = Object.fromEntries(findings.map((f) => [f.key, f]));
      expect(byKey['backlog_depth:job_outbox']?.level).toBe('warning');
      expect(byKey['backlog_depth:job_outbox']?.detail).toEqual({
        table: 'job_outbox',
        count: 1600,
        threshold: 1500,
      });
      expect(byKey['backlog_depth:analytics_events']?.detail).toEqual({
        table: 'analytics_events',
        count: 2000,
        threshold: 1500,
      });
    });
    it('returns no finding at the threshold (strict >)', async () => {
      sqlReturnQueue.push([{ job_outbox: 1500, analytics_events: 1500 }]);
      expect(await checkBacklogDepth(mockSql, CFG)).toEqual([]);
    });
    it('returns no finding under the threshold', async () => {
      sqlReturnQueue.push([{ job_outbox: 10, analytics_events: 0 }]);
      expect(await checkBacklogDepth(mockSql, CFG)).toEqual([]);
    });
    it('reports each table independently — one over, one under → exactly one finding', async () => {
      sqlReturnQueue.push([{ job_outbox: 1600, analytics_events: 100 }]);
      const findings = await checkBacklogDepth(mockSql, CFG);
      expect(findings).toHaveLength(1);
      expect(findings[0]?.key).toBe('backlog_depth:job_outbox');
    });
  });

  // Drives the full runHealthChecks path so resolveHealthAlertConfig() reads env.
  // Promise.all order: failedByTopic, oldestPending, staleDispatching, openFlagged,
  // zeroDelivery, backlogDepth — push a queue entry per check in that order.
  function pushQuietChecksBeforeBacklog(): void {
    sqlReturnQueue.push([]);              // failedByTopic → []
    sqlReturnQueue.push([{ age: null }]); // oldestPending → null
    sqlReturnQueue.push([{ count: 0 }]);  // staleDispatching → null
    sqlReturnQueue.push([{ count: 0 }]);  // openFlagged → null
    sqlReturnQueue.push([{ count: 0 }]);  // zeroDelivery → null
  }

  describe('backlog-depth threshold config', () => {
    it('uses the 1500 default when HEALTH_ALERT_BACKLOG_DEPTH_THRESHOLD is unset', async () => {
      pushQuietChecksBeforeBacklog();
      sqlReturnQueue.push([{ job_outbox: 1600, analytics_events: 0 }]); // 1600 > 1500 default
      const findings = await runHealthChecks(mockSql);
      expect(findings.map((f) => f.key)).toContain('backlog_depth:job_outbox');
    });
    it('honors a HEALTH_ALERT_BACKLOG_DEPTH_THRESHOLD env override', async () => {
      process.env.HEALTH_ALERT_BACKLOG_DEPTH_THRESHOLD = '5000';
      resetWorkerConfigForTests();
      pushQuietChecksBeforeBacklog();
      sqlReturnQueue.push([{ job_outbox: 1600, analytics_events: 0 }]); // 1600 < 5000 override
      const findings = await runHealthChecks(mockSql);
      expect(findings.map((f) => f.key)).not.toContain('backlog_depth:job_outbox');
    });
  });

  describe('runHealthChecks', () => {
    it('aggregates findings across all checks (env defaults)', async () => {
      // Order matches Promise.all dispatch order in runHealthChecks:
      // failedByTopic, oldestPending, staleDispatching, openFlagged, zeroDelivery, backlogDepth
      sqlReturnQueue.push([{ topic: 'publish_response', count: 1 }]); // failed → finding
      sqlReturnQueue.push([{ age: 50 }]);                              // pending → null
      sqlReturnQueue.push([{ count: 0 }]);                             // stale → null
      sqlReturnQueue.push([{ count: 10 }]);                            // flagged → finding (>5 default)
      sqlReturnQueue.push([{ count: 0 }]);                             // zero-delivery → null
      sqlReturnQueue.push([{ job_outbox: 3000, analytics_events: 0 }]); // backlog → finding (>1500 default)

      const findings = await runHealthChecks(mockSql);
      const keys = findings.map((f) => f.key).sort();
      expect(keys).toEqual([
        'backlog_depth:job_outbox',
        'flagged_open_backlog',
        'outbox_failed:publish_response',
      ]);
    });
  });
});
