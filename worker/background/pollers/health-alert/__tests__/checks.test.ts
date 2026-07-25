import { describe, it, expect, vi, beforeEach } from 'vitest';

// ── Hoisted sql mock (mirrors OutboxPoller.test.ts) ──────────────────
// queryBacklogDepth (via checkBacklogDepth) now runs its count inside
// sql.begin(): `.begin(cb)` runs the callback against the same tagged-template
// stub as tx, and `.unsafe(...)` (the SET LOCAL statement_timeout call) resolves
// WITHOUT draining sqlReturnQueue — so the transaction body's single SELECT
// still consumes exactly one queued row, keeping every existing push count valid.
const { sqlReturnQueue, mockSql } = vi.hoisted(() => {
  const sqlReturnQueue: unknown[] = [];
  const shiftFrom = (q: unknown[]) => {
    const r = q.shift() ?? [];
    return Promise.resolve(Array.isArray(r) ? r : [r]);
  };
  const mockSql: any = vi.fn((_s: TemplateStringsArray, ..._v: unknown[]) => shiftFrom(sqlReturnQueue));
  mockSql.begin = vi.fn(async (cb: (tx: typeof mockSql) => unknown) => cb(mockSql));
  mockSql.unsafe = vi.fn(() => Promise.resolve([]));
  return { sqlReturnQueue, mockSql };
});

vi.mock('../../../../../src/lib/db/server', () => ({ sql: mockSql }));

import {
  checkOldestPendingOutbox,
  checkStaleDispatching,
  checkOpenFlaggedResponses,
  checkFailedOutboxByTopic,
  checkZeroDeliveryNotifications,
  checkOwnerUnreachable,
  checkBacklogDepth,
  checkFailedInboundEvents,
  runHealthChecks,
  type HealthAlertConfig,
} from '../checks';
import { resetWorkerConfigForTests } from '../../../../../src/lib/config/worker';
import { QUEUE_NAMES } from '../../../../../src/lib/shared/queue-names';

const CFG: HealthAlertConfig = {
  pendingAgeThresholdS: 900,
  failedWindowS: 3600,
  failedThreshold: 0,
  staleDispatchingThresholdS: 600,
  flaggedOpenThreshold: 5,
  zeroDeliveryWindowS: 3600,
  backlogDepthThreshold: 1500,
  ownerUnreachableAgeS: 14400,
  ownerUnreachableThreshold: 0,
};

const HEALTH_ENV = [
  'HEALTH_ALERT_PENDING_AGE_S',
  'HEALTH_ALERT_FAILED_WINDOW_S',
  'HEALTH_ALERT_FAILED_THRESHOLD',
  'HEALTH_ALERT_STALE_DISPATCHING_S',
  'HEALTH_ALERT_FLAGGED_OPEN_THRESHOLD',
  'HEALTH_ALERT_ZERO_DELIVERY_WINDOW_S',
  'HEALTH_ALERT_BACKLOG_DEPTH_THRESHOLD',
  'HEALTH_ALERT_OWNER_UNREACHABLE_AGE_S',
  'HEALTH_ALERT_OWNER_UNREACHABLE_THRESHOLD',
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

    it('raises a finding for terminal generate_response failures', async () => {
      sqlReturnQueue.push([{ topic: 'generate_response', count: 2 }]);
      const findings = await checkFailedOutboxByTopic(mockSql, CFG);
      expect(findings).toHaveLength(1);
      expect(findings[0]?.key).toBe('outbox_failed:generate_response');
      // SQL-text assertion: the row-queued mock returns whatever is queued
      // regardless of the query, so also prove the production topic filter
      // actually includes generate_response (passed as an interpolated value).
      const [template, ...values] = mockSql.mock.calls[0] as [TemplateStringsArray, ...unknown[]];
      expect(template.join(' ')).toContain('FROM job_outbox');
      expect(values).toContain(QUEUE_NAMES.GENERATE_RESPONSE);
    });

    it('health alerts include terminal build_solicitation_batch outbox failures', async () => {
      sqlReturnQueue.push([{ topic: QUEUE_NAMES.BUILD_SOLICITATION_BATCH, count: 1 }]);

      const findings = await checkFailedOutboxByTopic(mockSql, CFG);

      expect(findings).toEqual([
        expect.objectContaining({
          key: `outbox_failed:${QUEUE_NAMES.BUILD_SOLICITATION_BATCH}`,
          level: 'error',
          detail: {
            topic: QUEUE_NAMES.BUILD_SOLICITATION_BATCH,
            count: 1,
            window_s: CFG.failedWindowS,
          },
        }),
      ]);
      const [template, ...values] = mockSql.mock.calls[0] as [TemplateStringsArray, ...unknown[]];
      expect(template.join(' ')).toContain('FROM job_outbox');
      expect(values).toContain(QUEUE_NAMES.BUILD_SOLICITATION_BATCH);
    });
  });

  describe('checkFailedInboundEvents', () => {
    it('raises one finding per failing (source, event_type)', async () => {
      sqlReturnQueue.push([
        { source: 'stripe', event_type: 'invoice.paid', count: 3 },
        { source: 'zernio', event_type: 'review.updated', count: 1 },
      ]);
      const findings = await checkFailedInboundEvents(mockSql, CFG);
      expect(findings).toHaveLength(2);
      expect(findings[0]).toMatchObject({
        key: 'inbound_events_failed:stripe:invoice.paid',
        level: 'error',
      });
      expect(findings[1]).toMatchObject({
        key: 'inbound_events_failed:zernio:review.updated',
      });
      // SQL-text assertion: prove the query targets inbound_events failures
      // grouped by (source, event_type) — a row-only test would pass even if
      // the production query were wrong.
      const [template] = mockSql.mock.calls[0] as [TemplateStringsArray, ...unknown[]];
      const queryText = template.join(' ');
      expect(queryText).toContain('FROM inbound_events');
      expect(queryText).toContain("status = 'failed'");
      expect(queryText).toContain('GROUP BY source, event_type');
    });

    it('returns nothing when counts are within threshold', async () => {
      sqlReturnQueue.push([]);
      expect(await checkFailedInboundEvents(mockSql, CFG)).toEqual([]);
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

    it('de-conflates owner-unreachable rows — excludes them from the zero-delivery count', async () => {
      sqlReturnQueue.push([{ count: 0 }]);
      await checkZeroDeliveryNotifications(mockSql, CFG);
      const [template] = mockSql.mock.calls[0] as [TemplateStringsArray, ...unknown[]];
      const queryText = template.join(' ');
      expect(queryText).toContain('completion_reason');
      expect(queryText).toContain('IS DISTINCT FROM');
    });
  });

  describe('checkOwnerUnreachable', () => {
    it('returns a warning finding when the queued count exceeds the threshold', async () => {
      sqlReturnQueue.push([{ count: 2 }]);
      const finding = await checkOwnerUnreachable(mockSql, CFG);
      expect(finding?.key).toBe('owner_unreachable');
      expect(finding?.level).toBe('warning');
      expect(finding?.detail).toEqual({ count: 2, age_floor_s: 14400 });
    });
    it('returns null at or below the threshold', async () => {
      sqlReturnQueue.push([{ count: 0 }]);
      expect(await checkOwnerUnreachable(mockSql, CFG)).toBeNull();
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
  // Sequential dispatch order: failedByTopic, oldestPending, staleDispatching,
  // openFlagged, zeroDelivery, ownerUnreachable, failedInboundEvents, backlogDepth
  // — push a queue entry per check in that order.
  function pushQuietChecksBeforeBacklog(): void {
    sqlReturnQueue.push([]);              // failedByTopic → []
    sqlReturnQueue.push([{ age: null }]); // oldestPending → null
    sqlReturnQueue.push([{ count: 0 }]);  // staleDispatching → null
    sqlReturnQueue.push([{ count: 0 }]);  // openFlagged → null
    sqlReturnQueue.push([{ count: 0 }]);  // zeroDelivery → null
    sqlReturnQueue.push([{ count: 0 }]);  // ownerUnreachable → null
    sqlReturnQueue.push([]);              // failedInboundEvents → []
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
      // Order matches sequential dispatch order in runHealthChecks:
      // failedByTopic, oldestPending, staleDispatching, openFlagged,
      // zeroDelivery, ownerUnreachable, failedInboundEvents, backlogDepth
      sqlReturnQueue.push([{ topic: 'publish_response', count: 1 }]); // failed → finding
      sqlReturnQueue.push([{ age: 50 }]);                              // pending → null
      sqlReturnQueue.push([{ count: 0 }]);                             // stale → null
      sqlReturnQueue.push([{ count: 10 }]);                            // flagged → finding (>5 default)
      sqlReturnQueue.push([{ count: 0 }]);                             // zero-delivery → null
      sqlReturnQueue.push([{ count: 0 }]);                             // owner-unreachable → null
      sqlReturnQueue.push([{ source: 'stripe', event_type: 'invoice.paid', count: 2 }]); // inbound → finding
      sqlReturnQueue.push([{ job_outbox: 3000, analytics_events: 0 }]); // backlog → finding (>1500 default)

      const findings = await runHealthChecks(mockSql);
      const keys = findings.map((f) => f.key).sort();
      expect(keys).toEqual([
        'backlog_depth:job_outbox',
        'flagged_open_backlog',
        'inbound_events_failed:stripe:invoice.paid',
        'outbox_failed:publish_response',
      ]);
    });

    // F-medium regression: a backlog-count failure (checkBacklogDepth uses
    // sql.begin) must NOT reject Promise.all and swallow the critical findings.
    it('isolates a backlog-check failure: other findings survive, failure becomes a warning', async () => {
      // First six checks (dispatch order) drain the queue synchronously; the
      // backlog check's sql.begin rejects (as it would under the DB pressure it
      // detects) and consumes no queue entry.
      sqlReturnQueue.push([]);              // failedByTopic → []
      sqlReturnQueue.push([{ age: null }]); // oldestPending → null
      sqlReturnQueue.push([{ count: 0 }]);  // staleDispatching → null
      sqlReturnQueue.push([{ count: 10 }]); // openFlagged → finding (>5 default)
      sqlReturnQueue.push([{ count: 0 }]);  // zeroDelivery → null
      sqlReturnQueue.push([{ count: 0 }]);  // ownerUnreachable → null
      sqlReturnQueue.push([]);              // failedInboundEvents → []
      mockSql.begin.mockRejectedValueOnce(new Error('canceling statement due to statement timeout'));

      const findings = await runHealthChecks(mockSql);
      const keys = findings.map((f) => f.key);

      // The unrelated check's finding is NOT suppressed.
      expect(keys).toContain('flagged_open_backlog');
      // The backlog failure degrades to a diagnostic warning, not a thrown batch.
      const errFinding = findings.find((f) => f.key === 'health_check_error:backlog_depth');
      expect(errFinding?.level).toBe('warning');
      expect(errFinding?.detail).toEqual({ check: 'backlog_depth' });
    });
  });

  // ── #505 regression: the health-check bundle MUST run SEQUENTIALLY ─────────
  // WHY: concurrent queries fired on ONE postgres.js client over the Supabase
  // Supavisor TRANSACTION pooler get pipelined onto a shared connection, and a
  // pipelined query's response parks server-side in state=active /
  // wait_event=ClientRead and never returns — a PERMANENT connection wedge every
  // poller cycle on the max:2 health client. Proven by the #505 staging
  // differential repro: the exact Promise.all bundle on max:2 wedged 6/6
  // iterations; the same 6 queries run sequentially wedged 0/6. Fix = one query
  // in flight at a time so nothing pipelines. See .claude/reference/lab-notes.md.
  //
  // SEAM HONESTY: this is a live-pooler pipelining effect a unit test CANNOT
  // reproduce (no faithful seam without the real Supavisor pooler). The
  // max-observed-concurrency === 1 assertion below is the closest unit-level
  // PROXY for "sequential → no pipelining"; the TRUE validation is the staging
  // differential repro (already done) + steady-state observation. Do not mistake
  // this green test for full proof of the cure.
  describe('#505 sequential execution (no query pipelining on the health client)', () => {
    // A fake `sql` that (a) resolves every query ASYNCHRONOUSLY (after a
    // macrotask) so any overlap is observable, and (b) records the peak number
    // of simultaneously in-flight queries. Sequential execution keeps that peak
    // at 1; the old Promise.all fires all six before any resolves → peak >> 1.
    function makeConcurrencyTrackingSql(rows: unknown[]) {
      let inFlight = 0;
      let maxInFlight = 0;
      const queue = [...rows];
      const settleAsync = <T>(value: T): Promise<T> => {
        inFlight += 1;
        maxInFlight = Math.max(maxInFlight, inFlight);
        return new Promise<T>((resolve) => {
          setTimeout(() => {
            inFlight -= 1;
            resolve(value);
          }, 0);
        });
      };
      const nextRows = (): unknown[] => {
        const r = queue.shift() ?? [];
        return Array.isArray(r) ? r : [r];
      };
      const sql: any = vi.fn(() => settleAsync(nextRows()));
      // queryBacklogDepth runs its count inside sql.begin(); the SET LOCAL via
      // .unsafe() and the inner SELECT both go through settleAsync so they, too,
      // count toward observed concurrency.
      sql.begin = vi.fn((cb: (tx: any) => unknown) => Promise.resolve(cb(sql)));
      sql.unsafe = vi.fn(() => settleAsync([]));
      return { sql, getMaxConcurrency: () => maxInFlight };
    }

    // One queue entry per tagged-template QUERY, in sequential dispatch order:
    // failedByTopic, oldestPending, staleDispatching, openFlagged, zeroDelivery,
    // ownerUnreachable, failedInboundEvents, then backlogDepth's inner SELECT (its
    // SET LOCAL via .unsafe consumes none).
    function quietRows(): unknown[] {
      return [
        [], // failedByTopic → []
        [{ age: null }], // oldestPending → null
        [{ count: 0 }], // staleDispatching → null
        [{ count: 0 }], // openFlagged → null
        [{ count: 0 }], // zeroDelivery → null
        [{ count: 0 }], // ownerUnreachable → null
        [], // failedInboundEvents → []
        [{ job_outbox: 0, analytics_events: 0 }], // backlogDepth inner SELECT
      ];
    }

    it('runs the checks one-at-a-time — max observed query concurrency is 1', async () => {
      const { sql, getMaxConcurrency } = makeConcurrencyTrackingSql(quietRows());
      await runHealthChecks(sql);
      expect(getMaxConcurrency()).toBe(1);
    });

    it('propagates a core-check rejection (fails the cycle → the poller recycles the client)', async () => {
      const { sql } = makeConcurrencyTrackingSql(quietRows());
      // The first core check (checkFailedOutboxByTopic) rejects with a transient
      // DB error; sequential await must let it propagate — NOT swallow it.
      sql.mockImplementationOnce(() => Promise.reject(new Error('connection terminated unexpectedly')));
      await expect(runHealthChecks(sql)).rejects.toThrow('connection terminated unexpectedly');
    });

    it('isolates a backlog-depth failure — degrades to a warning, does not reject the cycle', async () => {
      const { sql } = makeConcurrencyTrackingSql(quietRows());
      sql.begin.mockRejectedValueOnce(new Error('canceling statement due to statement timeout'));
      const findings = await runHealthChecks(sql);
      const errFinding = findings.find((f) => f.key === 'health_check_error:backlog_depth');
      expect(errFinding?.level).toBe('warning');
      expect(errFinding?.detail).toEqual({ check: 'backlog_depth' });
    });
  });
});
