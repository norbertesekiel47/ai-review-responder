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
  checkStrandedAccountOffboardings,
  STRANDED_OFFBOARDING_FINDING_PREFIX,
  checkZeroDeliveryNotifications,
  checkOwnerUnreachable,
  checkBacklogDepth,
  checkFailedInboundEvents,
  checkStaleIgnoredInboundEvents,
  checkStalledSendBatches,
  checkWedgedClientRead,
  runHealthChecks,
  WEDGED_CLIENT_READ_AGE_DEFAULT_S,
  type HealthAlertConfig,
} from '../checks';
import { resetWorkerConfigForTests } from '../../../../../src/lib/config/worker';
import { QUEUE_NAMES } from '../../../../../src/lib/shared/queue-names';
import { stalledThresholdMsForKind } from '../../../../../src/lib/agents/read';

const CFG: HealthAlertConfig = {
  wedgedClientReadAgeS: WEDGED_CLIENT_READ_AGE_DEFAULT_S,
  wedgedClientReadThreshold: 0,
  pendingAgeThresholdS: 900,
  failedWindowS: 3600,
  failedThreshold: 0,
  staleDispatchingThresholdS: 600,
  flaggedOpenThreshold: 5,
  zeroDeliveryWindowS: 3600,
  backlogDepthThreshold: 1500,
  ownerUnreachableAgeS: 14400,
  ownerUnreachableThreshold: 0,
  staleIgnoredWindowS: 3600,
  staleIgnoredThreshold: 5,
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

  // #1413 path 3: a watchdog-terminalized offboarding outbox row runs no
  // handler, so nothing marks the offboarding and no handler alert fires.
  describe('checkStrandedAccountOffboardings', () => {
    const OFFBOARDING_ID = '00000000-0000-7000-8000-0000000000e1';
    const OTHER_OFFBOARDING_ID = '00000000-0000-7000-8000-0000000000e2';

    it('emits one error finding PER OFFBOARDING, keyed and titled by its id, with ids and the scrubbed error only', async () => {
      sqlReturnQueue.push([
        {
          outbox_id: 'ob-1',
          topic: QUEUE_NAMES.ACCOUNT_OFFBOARDING_PURGE,
          last_error: 'Stale dispatched entry exceeded max_attempts',
          account_offboarding_id: OFFBOARDING_ID,
          account_id: 'acct-1',
          offboarding_status: 'purge_scheduled',
        },
        {
          outbox_id: 'ob-2',
          topic: QUEUE_NAMES.ACCOUNT_OFFBOARDING_TEARDOWN,
          last_error: null,
          account_offboarding_id: OTHER_OFFBOARDING_ID,
          account_id: 'acct-2',
          offboarding_status: 'tearing_down',
        },
      ]);

      const findings = await checkStrandedAccountOffboardings(mockSql);

      expect(findings).toEqual([
        {
          key: `${STRANDED_OFFBOARDING_FINDING_PREFIX}:${OFFBOARDING_ID}`,
          level: 'error',
          title: expect.stringContaining(OFFBOARDING_ID),
          detail: {
            account_offboarding_id: OFFBOARDING_ID,
            account_id: 'acct-1',
            topic: QUEUE_NAMES.ACCOUNT_OFFBOARDING_PURGE,
            outbox_id: 'ob-1',
            offboarding_status: 'purge_scheduled',
            last_error: 'Stale dispatched entry exceeded max_attempts',
          },
        },
        expect.objectContaining({
          key: `${STRANDED_OFFBOARDING_FINDING_PREFIX}:${OTHER_OFFBOARDING_ID}`,
          level: 'error',
        }),
      ]);
      // The title is the Sentry grouping (health findings set no fingerprint):
      // the id in it is what makes one issue per stranded offboarding, and the
      // topic names the obligation.
      expect(findings[0]?.title).toContain(QUEUE_NAMES.ACCOUNT_OFFBOARDING_PURGE);
      expect(findings[0]?.key).not.toBe(findings[1]?.key);
    });

    it('returns an empty array when no offboarding is stranded', async () => {
      sqlReturnQueue.push([]);
      expect(await checkStrandedAccountOffboardings(mockSql)).toEqual([]);
    });

    it('queries the newest failed row per topic and offboarding, excluding failed and terminal offboardings', async () => {
      sqlReturnQueue.push([]);
      await checkStrandedAccountOffboardings(mockSql);
      const text = String((mockSql.mock.calls[0]?.[0] as string[])?.join('?'));
      // The handler's own terminal paths land `failed` and already alerted
      // under rules 16-18; a re-drive enqueues a NEWER row for the same topic
      // and offboarding, and the old failed row is then history.
      expect(text).toMatch(/a\.terminal_at IS NULL/);
      expect(text).toMatch(/a\.status <> 'failed'/);
      expect(text).toMatch(/NOT EXISTS[\s\S]*n\.created_at > o\.created_at/);
      expect(text).toMatch(/o\.status = 'failed'/);
      // Exactly the three lifecycle stages, bound as one array: `email` and
      // `reactivation` cannot strand an offboarding (OFFBOARDING_STAGE_TOPICS).
      expect(text).toMatch(/o\.topic = ANY\(\?::text\[\]\)/);
      expect(mockSql.mock.calls[0]?.slice(1)).toEqual(
        expect.arrayContaining([
          'account_offboarding',
          [
            QUEUE_NAMES.ACCOUNT_OFFBOARDING_BILLING_SCHEDULE,
            QUEUE_NAMES.ACCOUNT_OFFBOARDING_TEARDOWN,
            QUEUE_NAMES.ACCOUNT_OFFBOARDING_PURGE,
          ],
        ]),
      );
    });
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
      // Allowlist-membership assertion removed at #1378: the list is gone.
      // `covers every topic` below pins the stronger property it replaced.
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
      // Allowlist-membership assertion removed at #1378: the list is gone.
      // `covers every topic` below pins the stronger property it replaced.
    });

    // #628 round 5: the ask-generation lane's dead-letter concedes a stranded
    // batch to operator recovery, which is only honest if the failed row is
    // actually watched. It was not — the topic was missing from the allowlist.
    it('health alerts include terminal generate_solicitation_asks outbox failures', async () => {
      sqlReturnQueue.push([{ topic: QUEUE_NAMES.GENERATE_SOLICITATION_ASKS, count: 1 }]);

      const findings = await checkFailedOutboxByTopic(mockSql, CFG);

      expect(findings).toEqual([
        expect.objectContaining({
          key: `outbox_failed:${QUEUE_NAMES.GENERATE_SOLICITATION_ASKS}`,
          level: 'error',
          detail: {
            topic: QUEUE_NAMES.GENERATE_SOLICITATION_ASKS,
            count: 1,
            window_s: CFG.failedWindowS,
          },
        }),
      ]);
      // Allowlist-membership assertion removed at #1378: the list is gone.
      // `covers every topic` below pins the stronger property it replaced.
    });

    // Owner Operator Run A (red-team P1-2): a failed agent_turn row means the
    // owner's message never receives a reply; the spec leans on the row being
    // seen.
    it('health alerts include terminal agent_turn outbox failures', async () => {
      sqlReturnQueue.push([{ topic: QUEUE_NAMES.AGENT_TURN, count: 1 }]);

      const findings = await checkFailedOutboxByTopic(mockSql, CFG);

      expect(findings).toEqual([
        expect.objectContaining({
          key: `outbox_failed:${QUEUE_NAMES.AGENT_TURN}`,
          level: 'error',
          detail: {
            topic: QUEUE_NAMES.AGENT_TURN,
            count: 1,
            window_s: CFG.failedWindowS,
          },
        }),
      ]);
      // Allowlist-membership assertion removed at #1378: the list is gone.
      // `covers every topic` below pins the stronger property it replaced.
    });

    // #1378: the seven-topic allowlist is OPEN. The four cases above still pin
    // that each named lane raises its finding; this pins the property that
    // replaced their membership assertions — no topic filter exists at all, so
    // a lane that nobody remembers to register is covered by construction.
    // That is strictly stronger than "these seven are present".
    it('covers every topic — the query binds no topic allowlist', async () => {
      sqlReturnQueue.push([]);

      await checkFailedOutboxByTopic(mockSql, CFG);

      const [template, ...values] = mockSql.mock.calls[0] as [TemplateStringsArray, ...unknown[]];
      const sqlText = template.join(' ');
      expect(sqlText).toContain('FROM job_outbox');
      expect(sqlText).not.toContain('topic IN');
      // Every QUEUE_NAMES value absent from the bind list proves no allowlist
      // was reintroduced under a different SQL spelling (ANY(), OR-chain, …).
      for (const topic of Object.values(QUEUE_NAMES)) {
        expect(values).not.toContain(topic);
      }
    });

    // The capability the widening actually buys: a topic that was NEVER in the
    // old allowlist now pages. `csv_ingest` is deliberately one of those.
    it('raises a finding for a topic that the old allowlist never covered', async () => {
      sqlReturnQueue.push([{ topic: QUEUE_NAMES.CSV_INGEST, count: 3 }]);

      const findings = await checkFailedOutboxByTopic(mockSql, CFG);

      expect(findings).toHaveLength(1);
      expect(findings[0]?.key).toBe(`outbox_failed:${QUEUE_NAMES.CSV_INGEST}`);
      expect(findings[0]?.level).toBe('error');
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

    it('checkFailedInboundEvents does not count stale_ignored rows', async () => {
      // The alert class this branch exists to kill. An age-stale no-account
      // subscription event is acked, not failed, so it must fall outside this
      // query entirely. The predicate is failed-only today; pin it rather than
      // assume it, because widening it later would silently restore the storm.
      sqlReturnQueue.push([]);

      await checkFailedInboundEvents(mockSql, CFG);

      const [template] = mockSql.mock.calls[0] as [TemplateStringsArray, ...unknown[]];
      const queryText = template.join(' ');
      expect(queryText).toContain("status = 'failed'");
      expect(queryText).not.toContain('stale_ignored');

      // BEHAVIOURAL, not a token-absence proxy. The earlier version asserted
      // not.toContain('IN (') and not.toContain('!='), which are satisfied by
      // any rewrite that happens to avoid those characters and broken by
      // innocuous ones — a predicate could widen via OR and still pass. What
      // actually matters is that acked-for-age rows never reach this finding
      // set, so feed the probe a stale_ignored-shaped row and prove the
      // production predicate is the thing that excludes it.
      sqlReturnQueue.push([
        { source: 'stripe', event_type: 'customer.subscription.updated', count: 40 },
      ]);
      const findings = await checkFailedInboundEvents(mockSql, CFG);
      expect(findings.map((f) => f.key)).toEqual([
        'inbound_events_failed:stripe:customer.subscription.updated',
      ]);
      const [secondTemplate] = mockSql.mock.calls[1] as [TemplateStringsArray, ...unknown[]];
      expect(secondTemplate.join(' ')).not.toContain('stale_ignored');
    });
  });

  describe('checkStaleIgnoredInboundEvents', () => {
    it('pages when a stream of events is acked for age', async () => {
      // The detector the 15-minute ack would otherwise have REMOVED. Today one
      // orphaned customer pages continuously via checkFailedInboundEvents for
      // Stripe's ~3-day retry schedule; after the ack that signal decays to
      // zero about 15 minutes in. Without this probe a systemic
      // checkout.session.completed break pages briefly, goes green, and keeps
      // dropping every new paying customer in silence.
      sqlReturnQueue.push([
        { source: 'stripe', event_type: 'customer.subscription.updated', count: 40 },
      ]);

      const findings = await checkStaleIgnoredInboundEvents(mockSql, CFG);

      expect(findings).toHaveLength(1);
      expect(findings[0]).toMatchObject({
        key: 'inbound_events_stale_ignored:stripe:customer.subscription.updated',
        level: 'error',
      });
      const [template] = mockSql.mock.calls[0] as [TemplateStringsArray, ...unknown[]];
      const queryText = template.join(' ');
      expect(queryText).toContain("status = 'stale_ignored'");
      expect(queryText).toContain('GROUP BY source, event_type');
    });

    it('stays quiet for an ordinary out-of-order delivery', async () => {
      // Threshold 5, not 0: a handful of acks in an hour is the normal case the
      // bound exists to produce, and paging on it would retire the alert by
      // fatigue instead of by design.
      sqlReturnQueue.push([
        { source: 'stripe', event_type: 'customer.subscription.deleted', count: 3 },
      ]);

      expect(await checkStaleIgnoredInboundEvents(mockSql, CFG)).toEqual([]);
    });

    // ---- R11: the two choices the tests above could not tell apart ---------

    it('windows on processed_at, NOT the received_at its sibling probe uses', async () => {
      // Substituting received_at passed both tests above, and the choice is not
      // arbitrary: markInboundEventStaleIgnored stamps `processed_at = NOW()`
      // at the moment of the ack, and reclaim does not NULL it, so a redelivered
      // orphan re-stamps and stays in window. `received_at` is what RECLAIM
      // resets, so windowing on it would make a reclaimed row look new. The
      // sibling checkFailedInboundEvents legitimately uses received_at because
      // a failed row's arrival IS its event; keep the two spellings apart.
      sqlReturnQueue.push([]);

      await checkStaleIgnoredInboundEvents(mockSql, CFG);

      const [template] = mockSql.mock.calls[0] as [TemplateStringsArray, ...unknown[]];
      const queryText = template.join(' ');
      expect(queryText).toContain('processed_at >');
      expect(queryText).not.toContain('received_at');
    });

    it('is strictly ABOVE the threshold — exactly 5 does not page', async () => {
      // `count > threshold` reads as 6-and-up. Flipping it to `>=` also passed
      // both tests above while silently moving the effective threshold to 5,
      // which is one full step of alert fatigue on a probe whose whole design
      // is "a handful is normal, a stream is not".
      sqlReturnQueue.push([
        { source: 'stripe', event_type: 'customer.subscription.updated', count: 5 },
      ]);
      expect(await checkStaleIgnoredInboundEvents(mockSql, CFG)).toEqual([]);

      sqlReturnQueue.push([
        { source: 'stripe', event_type: 'customer.subscription.updated', count: 6 },
      ]);
      expect(await checkStaleIgnoredInboundEvents(mockSql, CFG)).toHaveLength(1);
    });

    it('reports each (source, event_type) pair independently', async () => {
      // The key is per-pair, so one broken event type must not be masked by a
      // quiet one, nor page under the other's name.
      sqlReturnQueue.push([
        { source: 'stripe', event_type: 'customer.subscription.updated', count: 40 },
        { source: 'stripe', event_type: 'customer.subscription.deleted', count: 2 },
      ]);

      const findings = await checkStaleIgnoredInboundEvents(mockSql, CFG);

      expect(findings.map((f) => f.key)).toEqual([
        'inbound_events_stale_ignored:stripe:customer.subscription.updated',
      ]);
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

  describe('checkStalledSendBatches', () => {
    const RUN_ID = '00000000-0000-7000-8000-0000000000aa';

    it('checkStalledSendBatches reports a solicitation_send_batch still running past 11 days', async () => {
      sqlReturnQueue.push([{ count: 2, oldest_run_id: RUN_ID, oldest_age_s: 1_040_000 }]);

      const finding = await checkStalledSendBatches(mockSql);

      expect(finding?.key).toBe('solicitation_send_batch_stalled');
      expect(finding?.level).toBe('error');
      // Detail is run id + age only — never contact/review content (no PII).
      expect(finding?.detail).toEqual({
        count: 2,
        oldest_run_id: RUN_ID,
        oldest_age_s: 1_040_000,
        threshold_s: 11 * 24 * 60 * 60,
      });
    });

    it('returns null when every send batch is still inside the 11-day threshold', async () => {
      sqlReturnQueue.push([{ count: 0, oldest_run_id: null, oldest_age_s: null }]);
      expect(await checkStalledSendBatches(mockSql)).toBeNull();
    });

    it('returns null when the aggregate row is missing entirely', async () => {
      sqlReturnQueue.push([]);
      expect(await checkStalledSendBatches(mockSql)).toBeNull();
    });

    it('sources its threshold from stalledThresholdMsForKind, not a re-spelled literal', async () => {
      sqlReturnQueue.push([{ count: 0, oldest_run_id: null, oldest_age_s: null }]);

      await checkStalledSendBatches(mockSql);

      const [template, ...values] = mockSql.mock.calls[0] as [TemplateStringsArray, ...unknown[]];
      const queryText = template.join(' ');
      expect(queryText).toContain('FROM agent_runs');
      expect(queryText).toContain("status = 'running'");
      expect(values).toContain('solicitation_send_batch');
      // The interpolated interval is the shared constant, expressed in seconds.
      expect(values).toContain(stalledThresholdMsForKind('solicitation_send_batch') / 1000);
    });

    it('bounds the probe to a single aggregate row — no unbounded row set', async () => {
      sqlReturnQueue.push([{ count: 0, oldest_run_id: null, oldest_age_s: null }]);

      await checkStalledSendBatches(mockSql);

      const [template] = mockSql.mock.calls[0] as [TemplateStringsArray, ...unknown[]];
      const queryText = template.join(' ');
      expect(queryText).toContain('COUNT(*)::int AS count');
      expect(queryText).not.toContain('GROUP BY');
    });
  });

  // Drives the full runHealthChecks path so resolveHealthAlertConfig() reads env.
  // Sequential dispatch order: wedgedClientRead, failedByTopic, oldestPending, staleDispatching,
  // openFlagged, zeroDelivery, ownerUnreachable, failedInboundEvents,
  // stalledSendBatches, solicitationSendBreaker, backlogDepth, strandedAccountOffboardings —
  // push a queue entry per QUERY in that order. POSITIONAL: a new check inserted anywhere
  // shifts every later response by one, so appending a check means appending its entry
  // here too (#898). Note solicitationSendBreaker is the one check that issues TWO
  // queries. strandedAccountOffboardings is LAST (#1413) and the stub yields `[]` on an
  // exhausted queue, which is why the cases below need no entry for it.
  function pushQuietChecksBeforeBacklog(): void {
    sqlReturnQueue.push([{ count: 0, oldest_age_s: null }]); // wedgedClientRead → null
    sqlReturnQueue.push([]);              // failedByTopic → []
    sqlReturnQueue.push([{ age: null }]); // oldestPending → null
    sqlReturnQueue.push([{ count: 0 }]);  // staleDispatching → null
    sqlReturnQueue.push([{ count: 0 }]);  // openFlagged → null
    sqlReturnQueue.push([{ count: 0 }]);  // zeroDelivery → null
    sqlReturnQueue.push([{ count: 0 }]);  // ownerUnreachable → null
    sqlReturnQueue.push([]);              // failedInboundEvents → []
    sqlReturnQueue.push([{ count: 0 }]);  // stalledSendBatches → null
    // solicitationSendBreaker issues TWO queries: the open-trip probe, then the
    // window aggregate (level-triggered — the probe short-circuits when a trip is
    // already open, so a healthy tick drains both entries).
    sqlReturnQueue.push([]);                                            // breaker open-trip probe → no open trip
    sqlReturnQueue.push([{ sends: 0, hard_bounces: 0, complaints: 0 }]); // breaker window → null (under BREAKER_MIN_SENDS)
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

  // #773 wedge signal. The property under test is AGE, NOT PRESENCE: transient
  // sub-100ms ClientRead is ordinary protocol behaviour and was constant through
  // every clean staging run, so a presence check would page continuously.
  describe('checkWedgedClientRead', () => {
    it('stays quiet when no session is over the age threshold', async () => {
      sqlReturnQueue.push([{ count: 0, oldest_age_s: null }]);
      expect(await checkWedgedClientRead(mockSql, CFG)).toBeNull();
    });

    it('raises an error finding naming the count and the oldest age', async () => {
      sqlReturnQueue.push([{ count: 2, oldest_age_s: 374 }]);
      const finding = await checkWedgedClientRead(mockSql, CFG);
      expect(finding?.key).toBe('db_connection_wedged');
      expect(finding?.level).toBe('error');
      expect(finding?.detail).toMatchObject({ count: 2, oldest_age_s: 374, age_threshold_s: 10 });
    });

    it('filters on age, state and wait_event — never on ClientRead presence alone', async () => {
      sqlReturnQueue.push([{ count: 0, oldest_age_s: null }]);
      await checkWedgedClientRead(mockSql, CFG);
      const [template, ...values] = mockSql.mock.calls[0] as [TemplateStringsArray, ...unknown[]];
      const queryText = template.join(' ');
      expect(queryText).toContain("state = 'active'");
      expect(queryText).toContain("wait_event = 'ClientRead'");
      expect(queryText).toContain('pid <> pg_backend_pid()');
      // The age predicate must be present and bound to the configured threshold;
      // without it this check would fire on every healthy poll.
      expect(queryText).toContain('clock_timestamp() - query_start >');
      expect(values).toContain(WEDGED_CLIENT_READ_AGE_DEFAULT_S);
    });

    it('honors a tightened age threshold from config', async () => {
      sqlReturnQueue.push([{ count: 0, oldest_age_s: null }]);
      await checkWedgedClientRead(mockSql, { ...CFG, wedgedClientReadAgeS: 45 });
      const [, ...values] = mockSql.mock.calls[0] as [TemplateStringsArray, ...unknown[]];
      expect(values).toContain(45);
    });

    it('defaults to a 10s age — above protocol noise, below the shortest observed wedge', () => {
      expect(WEDGED_CLIENT_READ_AGE_DEFAULT_S).toBe(10);
      expect(WEDGED_CLIENT_READ_AGE_DEFAULT_S).toBeGreaterThan(1);
      expect(WEDGED_CLIENT_READ_AGE_DEFAULT_S).toBeLessThan(16.6);
    });
  });

  describe('runHealthChecks', () => {
    it('aggregates findings across all checks (env defaults)', async () => {
      // Order matches sequential dispatch order in runHealthChecks:
      // wedgedClientRead, failedByTopic, oldestPending, staleDispatching, openFlagged,
      // zeroDelivery, ownerUnreachable, failedInboundEvents,
      // stalledSendBatches, backlogDepth, strandedAccountOffboardings
      sqlReturnQueue.push([{ count: 0, oldest_age_s: null }]);          // wedgedClientRead → null
      sqlReturnQueue.push([{ topic: 'publish_response', count: 1 }]); // failed → finding
      sqlReturnQueue.push([{ age: 50 }]);                              // pending → null
      sqlReturnQueue.push([{ count: 0 }]);                             // stale → null
      sqlReturnQueue.push([{ count: 10 }]);                            // flagged → finding (>5 default)
      sqlReturnQueue.push([{ count: 0 }]);                             // zero-delivery → null
      sqlReturnQueue.push([{ count: 0 }]);                             // owner-unreachable → null
      sqlReturnQueue.push([{ source: 'stripe', event_type: 'invoice.paid', count: 2 }]); // inbound → finding
      sqlReturnQueue.push([]);                                         // stale_ignored → null (no acked-for-age stream)
      sqlReturnQueue.push([{ count: 1, oldest_run_id: '00000000-0000-7000-8000-0000000000bb', oldest_age_s: 1_000_000 }]); // stalled send batch → finding
      // solicitationSendBreaker issues TWO queries: the open-trip probe, then the
      // window aggregate (level-triggered — the probe short-circuits when a trip
      // is already open, so a healthy tick drains both entries).
      sqlReturnQueue.push([]);                                            // breaker open-trip probe → no open trip
      sqlReturnQueue.push([{ sends: 0, hard_bounces: 0, complaints: 0 }]); // breaker window → null
      sqlReturnQueue.push([{ job_outbox: 3000, analytics_events: 0 }]); // backlog → finding (>1500 default)
      sqlReturnQueue.push([{                                            // stranded offboarding → finding (#1413)
        outbox_id: 'ob-1',
        topic: QUEUE_NAMES.ACCOUNT_OFFBOARDING_PURGE,
        last_error: null,
        account_offboarding_id: '00000000-0000-7000-8000-0000000000e1',
        account_id: 'acct-1',
        offboarding_status: 'purge_scheduled',
      }]);

      const findings = await runHealthChecks(mockSql);
      const keys = findings.map((f) => f.key).sort();
      expect(keys).toEqual([
        'account_offboarding_stranded:00000000-0000-7000-8000-0000000000e1',
        'backlog_depth:job_outbox',
        'flagged_open_backlog',
        'inbound_events_failed:stripe:invoice.paid',
        'outbox_failed:publish_response',
        'solicitation_send_batch_stalled',
      ]);
    });

    // F-medium regression: a backlog-count failure (checkBacklogDepth uses
    // sql.begin) must NOT reject Promise.all and swallow the critical findings.
    it('isolates a backlog-check failure: other findings survive, failure becomes a warning', async () => {
      // The core checks (dispatch order) drain the queue synchronously; the
      // backlog check's sql.begin rejects (as it would under the DB pressure it
      // detects) and consumes no queue entry.
      sqlReturnQueue.push([{ count: 0, oldest_age_s: null }]); // wedgedClientRead → null
      sqlReturnQueue.push([]);              // failedByTopic → []
      sqlReturnQueue.push([{ age: null }]); // oldestPending → null
      sqlReturnQueue.push([{ count: 0 }]);  // staleDispatching → null
      sqlReturnQueue.push([{ count: 10 }]); // openFlagged → finding (>5 default)
      sqlReturnQueue.push([{ count: 0 }]);  // zeroDelivery → null
      sqlReturnQueue.push([{ count: 0 }]);  // ownerUnreachable → null
      sqlReturnQueue.push([]);              // failedInboundEvents → []
      sqlReturnQueue.push([{ count: 0 }]);  // stalledSendBatches → null
      // solicitationSendBreaker issues TWO queries: the open-trip probe, then the
      // window aggregate (level-triggered — the probe short-circuits when a trip
      // is already open, so a healthy tick drains both entries).
      sqlReturnQueue.push([]);                                            // breaker open-trip probe → no open trip
      sqlReturnQueue.push([{ sends: 0, hard_bounces: 0, complaints: 0 }]); // breaker window → null
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

    // Round-1 adversarial-5 / B1.3. The send breaker is the ONLY writer in this
    // file, so it has failure modes no reader here has — and un-isolated, every
    // one of them discarded the findings already collected above it. A local sql
    // stub is used rather than the shared mockSql because the failure has to land
    // on ONE specific call, not the next one.
    //
    // ROUND-2 R2-7: this case's title names a WRITE failure, so the rejection now
    // lands on the trip INSERT — the probe and the window aggregate both resolve
    // first, so the breaker genuinely reaches its write and fails there. That is
    // the class B1.3 was written for (a 23505, a lock wait on
    // `solicitation_send_breaker_one_open`, an ON CONFLICT inference error); the
    // earlier version injected on the read probe, which short-circuits before any
    // write is dispatched. The read-probe arm is covered by the case below it.
    const localSqlStub = (rows: unknown[]) => {
      const sql: any = vi.fn(() => {
        const r = rows.shift() ?? [];
        if (r instanceof Error) return Promise.reject(r);
        return Promise.resolve(Array.isArray(r) ? r : [r]);
      });
      sql.begin = vi.fn(async (cb: (tx: typeof sql) => unknown) => cb(sql));
      sql.unsafe = vi.fn(() => Promise.resolve([]));
      // `evaluateSendBreaker` interpolates the window snapshot with `sql.json`
      // (OID 3802) on the INSERT — the read-only stubs above never reach it.
      sql.json = vi.fn((value: unknown) => value);
      return sql;
    };

    /** The nine reads dispatched before the breaker, in order. `openFlagged`
     *  yields the finding whose survival is the isolation assertion. */
    const ROWS_BEFORE_BREAKER: unknown[] = [
      [{ count: 0, oldest_age_s: null }],       // wedgedClientRead → null
      [],                                       // failedByTopic → []
      [{ age: null }],                          // oldestPending → null
      [{ count: 0 }],                           // staleDispatching → null
      [{ count: 10 }],                          // openFlagged → finding (>5 default)
      [{ count: 0 }],                           // zeroDelivery → null
      [{ count: 0 }],                           // ownerUnreachable → null
      [],                                       // failedInboundEvents → []
      [],                                       // staleIgnoredInboundEvents → []
      [{ count: 0 }],                           // stalledSendBatches → null
    ];

    it('isolates a send-breaker-write failure: earlier findings survive and the failure becomes a warning', async () => {
      // Positional, in dispatch order; an Error entry rejects instead of resolving.
      const sql = localSqlStub([
        ...ROWS_BEFORE_BREAKER,
        [],                                       // breaker open-trip probe → none open
        // window aggregate → 10/200 = 5% hard bounces, over the 2% bar and over
        // the 100-send floor, so classifyBreach returns 'hard_bounce_rate' and
        // the breaker MUST attempt its INSERT.
        [{ sends: 200, hard_bounces: 10, complaints: 0 }],
        new Error('deadlock detected'),           // the trip INSERT → REJECTS
        [{ job_outbox: 0, analytics_events: 0 }], // backlogDepth inner SELECT
      ]);

      const findings = await runHealthChecks(sql);
      const keys = findings.map((f) => f.key);

      // The finding collected BEFORE the breaker is not discarded…
      expect(keys).toContain('flagged_open_backlog');
      // …and the breaker pages nothing, because the trip write never landed —
      // a breach it could not record is not a breach it may claim to have
      // recorded.
      expect(keys).not.toContain('solicitation_send_breaker_tripped');
      const errFinding = findings.find(
        (f) => f.key === 'health_check_error:solicitation_send_breaker',
      );
      expect(errFinding?.level).toBe('warning');
      expect(errFinding?.title).toContain('deadlock detected');
      expect(errFinding?.detail).toEqual({ check: 'solicitation_send_breaker' });

      // The write was genuinely reached: probe, aggregate, INSERT, then the
      // backlog read that follows. Without this the case would pass on a stub
      // that short-circuited early and the title would overstate again (R2-7).
      const statements = sql.mock.calls
        .map((call: unknown[]) => String((call[0] as string[])?.join?.('?') ?? ''))
        .filter(Boolean);
      expect(statements.some((s: string) => /INSERT INTO solicitation_send_breaker/.test(s))).toBe(
        true,
      );
      expect(sql.json).toHaveBeenCalledTimes(1);
    });

    it('isolates a stranded-offboarding failure in the LAST position: every earlier finding survives', async () => {
      // The check runs last, so an un-isolated rejection there would discard
      // the whole cycle's findings — the one position where isolation is
      // required rather than merely kind (#1413).
      const sql = localSqlStub([
        ...ROWS_BEFORE_BREAKER,
        [],                                            // breaker open-trip probe → none open
        [{ sends: 0, hard_bounces: 0, complaints: 0 }], // breaker window → null
        [{ job_outbox: 0, analytics_events: 0 }],      // backlogDepth inner SELECT
        new Error('canceling statement due to statement timeout'), // stranded offboardings → REJECTS
      ]);

      const findings = await runHealthChecks(sql);
      const keys = findings.map((f) => f.key);

      expect(keys).toContain('flagged_open_backlog');
      const errFinding = findings.find(
        (f) => f.key === 'health_check_error:account_offboarding_stranded',
      );
      expect(errFinding?.level).toBe('warning');
      expect(errFinding?.title).toContain('statement timeout');
      expect(errFinding?.detail).toEqual({ check: 'account_offboarding_stranded' });
    });

    it('isolates a send-breaker READ failure the same way: the probe rejects before any write', async () => {
      // The other half of B1.3's isolation, kept from the original form of the
      // case above: the open-trip probe short-circuits, so the aggregate and the
      // INSERT are never dispatched and nothing partial is written.
      const sql = localSqlStub([
        ...ROWS_BEFORE_BREAKER,
        new Error('connection terminated'),       // breaker open-trip probe → REJECTS
        [{ job_outbox: 0, analytics_events: 0 }], // backlogDepth inner SELECT
      ]);

      const findings = await runHealthChecks(sql);
      const keys = findings.map((f) => f.key);

      expect(keys).toContain('flagged_open_backlog');
      expect(keys).not.toContain('solicitation_send_breaker_tripped');
      const errFinding = findings.find(
        (f) => f.key === 'health_check_error:solicitation_send_breaker',
      );
      expect(errFinding?.level).toBe('warning');
      expect(errFinding?.title).toContain('connection terminated');
      expect(errFinding?.detail).toEqual({ check: 'solicitation_send_breaker' });
      // Nothing was written, and nothing was even measured.
      expect(sql.json).not.toHaveBeenCalled();
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
  // in flight at a time so nothing pipelines. See .claude/reference/lab-notes/postgres.md.
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
    // ownerUnreachable, failedInboundEvents, stalledSendBatches, then
    // backlogDepth's inner SELECT (its SET LOCAL via .unsafe consumes none).
    function quietRows(): unknown[] {
      return [
        [], // failedByTopic → []
        [{ age: null }], // oldestPending → null
        [{ count: 0 }], // staleDispatching → null
        [{ count: 0 }], // openFlagged → null
        [{ count: 0 }], // zeroDelivery → null
        [{ count: 0 }], // ownerUnreachable → null
        [], // failedInboundEvents → []
        [{ count: 0 }], // stalledSendBatches → null
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
