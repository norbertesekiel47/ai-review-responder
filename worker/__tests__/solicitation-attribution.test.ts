// Registration and logging contract for `SolicitationAttributionWorker`
// (#632 Task 5).
//
// The topic must map to a queue AND a registered handler — an unregistered
// topic leaves its outbox rows dispatching forever. The log line carries
// `resolution` from the closed set attributed | no_candidates | no_match |
// ambiguous, plus `reviewId`, `businessId` and `candidateCount`, and never the
// reviewer name or the review text.
//
// Task 0 authors both promised titles parked; Task 5 lands the bodies.
//
// The `subscription guard` block below carries NO promised title. Invariant #11
// requires the guard and CLAUDE.md's working rules require it be tested, but the
// feature's promised corpus never named a case for it — so the guard shipped with
// only the indirect coverage of one `active` fixture flowing through the real
// `checkSubscription`. These are ordinary tests, deliberately not added to the
// intake, and they are the guard's only direct coverage.
//
// The outbox module is deliberately NOT mocked: the real
// `markOutboxCompletedIfOwned` reads `result.count`, so the queue is fed
// `mkTaggedResult` (deviation D19 — a bare array carries no `count` and the
// helper would silently report "not owned"). Keeping it real is also what lets
// the log case assert the completion UPDATE ran INSIDE the transaction.

import type { Job } from 'bullmq';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const {
  mockSql,
  sqlReturnQueue,
  sqlCalls,
  resetMockSql,
  mkTaggedResult,
  mockLogger,
  mockAttributeReview,
} = await vi.hoisted(async () => {
  const helpers = await import('./helpers/mock-sql');
  return {
    ...helpers.createMockSql(),
    mkTaggedResult: helpers.mkTaggedResult,
    mockLogger: helpers.mockWorkerLogger(),
    mockAttributeReview: vi.fn(),
  };
});

// Boot queues.ts without a real BullMQ/Redis connection — same technique as
// worker/__tests__/queue-routing.test.ts. The handler's own `import type`
// of Job is erased, so the Queue stub cannot affect it.
vi.mock('../redis-connection', () => ({ getRedisOptions: () => ({}) }));
vi.mock('bullmq', () => ({
  Queue: class {
    name: string;
    constructor(name: string) {
      this.name = name;
    }
    // queues.ts attaches a non-fatal 'error' listener at module scope (P5).
    on(): void {}
  },
}));

vi.mock('@/lib/solicitation/attribution', () => ({ attributeReview: mockAttributeReview }));
vi.mock('@/lib/shared/logger', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/shared/logger')>()),
  createWorkerLogger: () => mockLogger,
}));

import type { Sql } from 'postgres';
import { QUEUE_NAMES, ALL_QUEUE_NAMES } from '../../src/lib/shared/queue-names';
import { checkSubscription } from '../../src/lib/shared/subscription-guard';
import { SubscriptionStatus } from '../../src/lib/shared/subscription-status';
import type { SolicitationAttributionPayload } from '../../src/lib/shared/worker-types';
import { queues, topicToQueue } from '../queues';
import { handleSolicitationAttribution } from '../jobs/solicitation-attribution/SolicitationAttributionWorker';

const REVIEW_ID = 'review-632';
const BUSINESS_ID = 'business-632';
const OUTBOX_ID = 'outbox-632';
const OUTBOX_ATTEMPT = 2;

/** The two strings the log line must never carry, on either side of the match. */
const REVIEWER_NAME = 'Dana Rodriguez';
const REVIEW_TEXT = 'Best haircut in the county, ask for Dana.';

function job(): Job<SolicitationAttributionPayload> {
  return {
    id: 'bull-job-1',
    data: {
      review_id: REVIEW_ID,
      business_id: BUSINESS_ID,
      outbox_id: OUTBOX_ID,
      outbox_attempt: OUTBOX_ATTEMPT,
      correlation_id: 'corr-632',
    },
  } as Job<SolicitationAttributionPayload>;
}

/** The subscription-guard row the handler reads first (invariant #11), then
 *  the one affected row the attempt-guarded completion CAS must see. The same
 *  two-row shape serves a DENIED run: the guard's own `markOutboxCompleted` is
 *  the second query on that path too. */
function queueAccount(status: string): void {
  sqlReturnQueue.push(
    mkTaggedResult([
      { subscription_status: status, account_past_due_at: null, account_flags: {} },
    ]),
  );
  sqlReturnQueue.push(mkTaggedResult([{ id: OUTBOX_ID }]));
}

function queueActiveAccount(): void {
  queueAccount(SubscriptionStatus.ACTIVE);
}

function loggedPayloads(): unknown[] {
  return [
    ...mockLogger.log.mock.calls,
    ...mockLogger.warn.mock.calls,
    ...mockLogger.error.mock.calls,
  ].flat();
}

beforeEach(() => {
  vi.clearAllMocks();
  resetMockSql();
});

describe('worker registration', () => {
  it('worker registration: solicitation_attribution maps to a queue and a registered handler', () => {
    // Half one: the topic constant exists, is enumerated, and routes to a queue
    // of its own name. A topic with no queue entry makes OutboxPoller drop the
    // dispatch and the row sits dispatched until the watchdog exhausts it.
    expect(QUEUE_NAMES.SOLICITATION_ATTRIBUTION).toBe('solicitation_attribution');
    expect(ALL_QUEUE_NAMES).toContain('solicitation_attribution');
    const queue = topicToQueue[QUEUE_NAMES.SOLICITATION_ATTRIBUTION];
    expect(queue).toBeDefined();
    expect(queue).toBe(queues.solicitationAttribution);
    expect((queue as unknown as { name: string }).name).toBe('solicitation_attribution');

    // Half two: a queue with no registered Worker is the same outage from the
    // other end, so the entry point is read for the handler wiring AND for the
    // map entry that puts this worker through the registration loop.
    const source = readFileSync(resolve(process.cwd(), 'worker/index.ts'), 'utf8');
    expect(source).toContain(
      "from './jobs/solicitation-attribution/SolicitationAttributionWorker'",
    );
    expect(source).toContain('handleSolicitationAttribution(sql, job)');
    expect(source).toContain(
      '[QUEUE_NAMES.SOLICITATION_ATTRIBUTION]: solicitationAttributionWorker',
    );

    // The registration loop is the ONLY place both error hooks are attached —
    // an unlistened emitter error is a fatal uncaughtException, and without the
    // failure sink a handler that throws on every attempt raises no Sentry
    // issue (#719). Membership in workersByQueue is what buys both, so the map
    // entry above is asserted together with the loop still doing the work.
    const loopStart = source.indexOf(
      'for (const [queueName, worker] of Object.entries(workersByQueue))',
    );
    expect(loopStart, 'the per-queue worker registration loop moved').toBeGreaterThan(-1);
    const loopEnd = source.indexOf('\n}', loopStart);
    const loopBody = source.slice(loopStart, loopEnd);
    expect(loopBody).toContain('attachEmitterErrorLogger(worker, `worker:${queueName}`)');
    expect(loopBody).toContain('attachJobFailureSink(worker, queueName)');
  });
});

describe('SolicitationAttributionWorker', () => {
  it('SolicitationAttributionWorker: logs every resolution without reviewer name or review text', async () => {
    // attributeReview is the only place either personal string is in scope, so
    // the matcher is driven through ALL FOUR arms of the closed set and the
    // whole logged corpus is re-scanned after each one.
    const resolutions = [
      {
        // candidateCount 4, deliberately NOT 1 (branch-review M3). The attributed
        // arm used to report a hardcoded 1, so a fixture using 1 could not tell
        // the constant from the real value. Four asks were in the window and one
        // matched; the log must say four.
        match: {
          resolution: 'attributed',
          rule: 'full_name',
          candidateCount: 4,
          candidate: {
            outreachId: 'outreach-1',
            contactName: REVIEWER_NAME,
            sentAt: '2026-08-10T15:03:00.000Z',
            agentRunId: 'run-1',
          },
        },
        expected: { resolution: 'attributed', candidateCount: 4, rule: 'full_name' },
      },
      {
        match: { resolution: 'no_candidates' },
        expected: { resolution: 'no_candidates', candidateCount: 0, rule: null },
      },
      {
        match: { resolution: 'no_match', candidateCount: 3 },
        expected: { resolution: 'no_match', candidateCount: 3, rule: null },
      },
      {
        match: { resolution: 'ambiguous', candidateCount: 2 },
        expected: { resolution: 'ambiguous', candidateCount: 2, rule: null },
      },
    ];

    for (const { match, expected } of resolutions) {
      vi.clearAllMocks();
      resetMockSql();
      queueActiveAccount();
      mockAttributeReview.mockResolvedValueOnce(match);

      await handleSolicitationAttribution(mockSql as unknown as Sql, job());

      expect(mockLogger.log).toHaveBeenCalledWith('attribution_resolved', {
        reviewId: REVIEW_ID,
        businessId: BUSINESS_ID,
        ...expected,
      });

      // Neither personal string, nor the matched outreach id, reaches ANY log
      // level on ANY arm.
      const serialized = JSON.stringify(loggedPayloads());
      expect(serialized).not.toContain(REVIEWER_NAME);
      expect(serialized).not.toContain(REVIEW_TEXT);
      expect(serialized).not.toContain('outreach-1');

      // The completion CAS and the domain call share ONE transaction, and the
      // CAS is attempt-guarded — the shape invariant #2 actually claims.
      const completion = sqlCalls.find((call) => call.text.includes('UPDATE job_outbox'));
      expect(completion, 'the handler never completed its own outbox row').toBeDefined();
      expect(completion?.inTransaction).toBe(true);
      expect(completion?.values).toContain(OUTBOX_ID);
      expect(completion?.values).toContain(OUTBOX_ATTEMPT);
      expect(mockAttributeReview).toHaveBeenCalledWith(mockSql, {
        reviewId: REVIEW_ID,
        businessId: BUSINESS_ID,
      });
    }
  });
});

describe('subscription guard', () => {
  // The guard runs BEFORE anything reads tenant content, so "denied" has to mean
  // three things at once: no domain call, no transaction, and a settled outbox
  // row. Each case below asserts all three rather than only the first, because
  // an early `return` that forgets the completion is the failure mode that hides
  // — the review is silently uncounted AND the row churns until it exhausts.

  /** Everything a denied run must be able to prove it did not do. */
  function expectNoAttribution(): void {
    expect(mockAttributeReview).not.toHaveBeenCalled();
    expect(mockSql.begin).not.toHaveBeenCalled();
    expect(mockLogger.log).not.toHaveBeenCalledWith('attribution_resolved', expect.anything());
  }

  it('SolicitationAttributionWorker: a cancelled account never attributes', async () => {
    queueAccount(SubscriptionStatus.CANCELLED);

    await handleSolicitationAttribution(mockSql as unknown as Sql, job());

    expectNoAttribution();
    // On this arm and the next, the guard's reason vocabulary reuses the status
    // name, so the status constant is the literal-free spelling of the reason.
    expect(mockLogger.log).toHaveBeenCalledWith('attribution_skipped', {
      reviewId: REVIEW_ID,
      businessId: BUSINESS_ID,
      reason: SubscriptionStatus.CANCELLED,
    });
  });

  it('SolicitationAttributionWorker: a pending_payment account never attributes', async () => {
    queueAccount(SubscriptionStatus.PENDING_PAYMENT);

    await handleSolicitationAttribution(mockSql as unknown as Sql, job());

    expectNoAttribution();
    expect(mockLogger.log).toHaveBeenCalledWith('attribution_skipped', {
      reviewId: REVIEW_ID,
      businessId: BUSINESS_ID,
      reason: SubscriptionStatus.PENDING_PAYMENT,
    });

    // This is the case that pins the handler's `workerType: 'summary'`.
    // `pending_payment` is the ONE status the worker-type choice moves — the
    // guard exempts it for `generator` alone, for admin demo drafts. The pair
    // below shows the exemption is real, so flipping the handler's argument to
    // `generator` would let the run through, open the transaction and call
    // attributeReview — which is what the assertions above turn red on.
    const account = {
      status: SubscriptionStatus.PENDING_PAYMENT,
      pastDueAt: null,
      accountFlags: {},
    };
    expect(checkSubscription({ ...account, workerType: 'summary' })).toEqual({
      allowed: false,
      reason: SubscriptionStatus.PENDING_PAYMENT,
    });
    expect(checkSubscription({ ...account, workerType: 'generator' })).toEqual({ allowed: true });
  });

  it('SolicitationAttributionWorker: a guard denial completes its outbox row instead of leaving it dispatched', async () => {
    // A denial is a SETTLED outcome, not a failure. A row left `dispatched` is
    // the watchdog's to reclaim, and it will re-dispatch it until the entry
    // exhausts — every attempt re-denying, none of them ever doing work.
    for (const status of [SubscriptionStatus.CANCELLED, SubscriptionStatus.PENDING_PAYMENT]) {
      vi.clearAllMocks();
      resetMockSql();
      queueAccount(status);

      await handleSolicitationAttribution(mockSql as unknown as Sql, job());

      const completion = sqlCalls.find((call) => call.text.includes('UPDATE job_outbox'));
      expect(completion, `${status} denial left its outbox row dispatched`).toBeDefined();
      expect(completion?.text).toContain("status = 'completed'");
      expect(completion?.values).toContain(OUTBOX_ID);
      // Attempt-guarded, same as the success path: a stale attempt resolving
      // after the watchdog re-dispatched must not stomp the newer attempt's row.
      expect(completion?.values).toContain(OUTBOX_ATTEMPT);
      // OUTSIDE a transaction, unlike the success path — there is no domain
      // write for the completion to be atomic with, and `sql.begin` never opens.
      expect(completion?.inTransaction).toBe(false);
      expect(mockAttributeReview).not.toHaveBeenCalled();
    }
  });

  it('SolicitationAttributionWorker: a trialing account attributes exactly like active', async () => {
    // Invariant #11: `trialing` is full access everywhere except recurring paid
    // ranking. This is the control that makes the denials above mean something —
    // without it they would all still pass if the guard denied EVERY status.
    queueAccount(SubscriptionStatus.TRIALING);
    mockAttributeReview.mockResolvedValueOnce({ resolution: 'no_match', candidateCount: 2 });

    await handleSolicitationAttribution(mockSql as unknown as Sql, job());

    expect(mockAttributeReview).toHaveBeenCalledWith(mockSql, {
      reviewId: REVIEW_ID,
      businessId: BUSINESS_ID,
    });
    expect(mockLogger.log).toHaveBeenCalledWith('attribution_resolved', {
      reviewId: REVIEW_ID,
      businessId: BUSINESS_ID,
      resolution: 'no_match',
      candidateCount: 2,
      rule: null,
    });
    expect(mockLogger.log).not.toHaveBeenCalledWith('attribution_skipped', expect.anything());
  });
});
