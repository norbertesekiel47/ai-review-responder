import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// ── Hoisted mock state ──────────────────────────────────────────────
const {
  sqlReturnQueue,
  txReturnQueue,
  mockSql,
  mockTx,
  mockQueueAddBulk,
  mockQueueAddBulkPublish,
  mockCaptureMessage,
  mockAddBreadcrumb,
} = vi.hoisted(() => {
  const sqlReturnQueue: unknown[] = [];
  const txReturnQueue: unknown[] = [];
  const shiftFrom = (q: unknown[]) => {
    const r = q.shift() ?? [];
    return Promise.resolve(Array.isArray(r) ? r : [r]);
  };
  const mockTx: any = vi.fn((_s: TemplateStringsArray, ..._v: unknown[]) => shiftFrom(txReturnQueue));
  const mockSql: any = vi.fn((_s: TemplateStringsArray, ..._v: unknown[]) => shiftFrom(sqlReturnQueue));
  mockSql.begin = vi.fn(async (cb: (tx: unknown) => Promise<unknown>) => cb(mockTx));
  return {
    sqlReturnQueue,
    txReturnQueue,
    mockSql,
    mockTx,
    mockQueueAddBulk: vi.fn(),
    mockQueueAddBulkPublish: vi.fn(),
    mockCaptureMessage: vi.fn(),
    mockAddBreadcrumb: vi.fn(),
  };
});

vi.mock('../../../../src/lib/db/server', () => ({ sql: mockSql, jsonb: (v: unknown) => v }));
vi.mock('../../../queues', () => ({
  topicToQueue: {
    send_notification: { addBulk: mockQueueAddBulk },
    publish_response: { addBulk: mockQueueAddBulkPublish },
  },
}));
vi.mock('@sentry/node', () => ({
  captureMessage: mockCaptureMessage,
  addBreadcrumb: mockAddBreadcrumb,
  captureException: vi.fn(),
}));

// Import AFTER mocks are wired.
import { pollOutbox } from '../OutboxPoller';

// ── Helpers ─────────────────────────────────────────────────────────
function sqlText(call: unknown[]): string {
  return (call[0] as TemplateStringsArray).join(' ');
}
/** Find the sql() call whose flattened text contains ALL needles. */
function findSql(calls: unknown[][], ...needles: string[]): unknown[] | undefined {
  return calls.find((c) => needles.every((n) => sqlText(c).includes(n)));
}
type BulkJob = { name: string; data: Record<string, unknown>; opts: { jobId: string } };

function outboxEntry(overrides: Record<string, unknown> = {}) {
  return {
    id: 'out-1',
    topic: 'send_notification',
    payload: { response_id: 'resp-1' },
    attempts: 1,
    max_attempts: 5,
    ...overrides,
  };
}

describe('OutboxPoller.pollOutbox', () => {
  let logSpy: ReturnType<typeof vi.spyOn>;
  let errorSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.clearAllMocks();
    sqlReturnQueue.length = 0;
    txReturnQueue.length = 0;
    logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    logSpy.mockRestore();
    errorSpy.mockRestore();
  });

  // ── Phase 1: watchdog ──
  it('runs the three watchdog recovery queries inside a transaction', async () => {
    sqlReturnQueue.push([]); // claim returns no pending rows
    await pollOutbox();

    expect(mockSql.begin).toHaveBeenCalledOnce();
    expect(mockTx).toHaveBeenCalledTimes(3);
    expect(sqlText(mockTx.mock.calls[0])).toContain("status = 'pending'");
    // Stale window is env-tunable (OUTBOX_WATCHDOG_STALE_MS, 15min default)
    // and reaches SQL as a bound make_interval parameter, not a literal.
    expect(sqlText(mockTx.mock.calls[0])).toContain('make_interval(secs =>');
    expect(sqlText(mockTx.mock.calls[0])).toContain('attempts < max_attempts');
    expect(sqlText(mockTx.mock.calls[1])).toContain("status = 'failed'");
    expect(sqlText(mockTx.mock.calls[1])).toContain('attempts >= max_attempts');
    // #736: the terminalizer must PRESERVE a per-job last_error when one is
    // already present (failed-hooks write bounded error classes onto
    // still-dispatched rows) and fall back to the generic reclaim text only
    // for rows that recorded nothing. An unconditional overwrite is what hid
    // #719 for three months. Live-DB proof of the value-level behavior is in
    // OutboxPoller.watchdog.integration.test.ts; this pins the SQL shape.
    expect(sqlText(mockTx.mock.calls[1])).toContain(
      "COALESCE(NULLIF(last_error, ''), CASE WHEN status = 'dispatching'",
    );
    expect(sqlText(mockTx.mock.calls[2])).toContain("status = 'dispatching'");
    expect(sqlText(mockTx.mock.calls[2])).toContain("INTERVAL '2 minutes'");
  });

  it('logs recovered/failed/stale counts when the watchdog acted', async () => {
    txReturnQueue.push([{ count: '2' }]); // recovered
    txReturnQueue.push([{ count: '1' }]); // terminated
    txReturnQueue.push([{ count: '3' }]); // stale dispatching
    sqlReturnQueue.push([]); // no pending rows
    await pollOutbox();

    // createWorkerLogger emits one JSON line per call via console.log.
    const watchdogLog = logSpy.mock.calls.find(
      (c: unknown[]) => typeof c[0] === 'string' && (c[0] as string).includes('Watchdog'),
    );
    expect(watchdogLog).toBeDefined();
    expect(watchdogLog![0]).toContain('"logger":"OutboxPoller"');
    expect(watchdogLog![0]).toContain('"recovered":2');
    expect(watchdogLog![0]).toContain('"failed":1');
    expect(watchdogLog![0]).toContain('"stale_dispatching":3');
  });

  it('continues to dispatch even if the watchdog transaction throws', async () => {
    mockSql.begin.mockRejectedValueOnce(new Error('watchdog tx failed'));
    sqlReturnQueue.push([outboxEntry()]); // claim returns one entry
    await pollOutbox();

    expect(errorSpy).toHaveBeenCalled();
    expect(mockQueueAddBulk).toHaveBeenCalledOnce(); // dispatch still happened
  });

  // ── Phase 2 + 3: dispatch ──
  it('dispatches a claimed pending row to its queue and marks it dispatched', async () => {
    sqlReturnQueue.push([outboxEntry()]); // claim
    await pollOutbox();

    expect(mockQueueAddBulk).toHaveBeenCalledOnce();
    const [jobs] = mockQueueAddBulk.mock.calls[0] as [BulkJob[]];
    expect(jobs).toHaveLength(1);
    expect(jobs[0]?.name).toBe('send_notification');
    expect(jobs[0]?.data).toEqual({ response_id: 'resp-1', outbox_id: 'out-1', outbox_attempt: 1 });
    // jobId shape is unchanged by bulk dispatch: `${outbox_id}_${attempt}`.
    expect(jobs[0]?.opts).toEqual({ jobId: 'out-1_1' });

    // Pin the optimistic-lock guard: the dispatched update must scope to the
    // claimed row's dispatching state + attempt, not blindly set 'dispatched'.
    const dispatchedUpdate = findSql(
      mockSql.mock.calls,
      "status = 'dispatched'",
      "status = 'dispatching'",
      'attempts =',
    );
    expect(dispatchedUpdate).toBeDefined();
  });

  it('returns without dispatching when no pending rows are claimed', async () => {
    sqlReturnQueue.push([]); // empty claim
    await pollOutbox();
    expect(mockQueueAddBulk).not.toHaveBeenCalled();
  });

  it('parses a JSON-string payload into an object before enqueueing', async () => {
    sqlReturnQueue.push([outboxEntry({ payload: JSON.stringify({ response_id: 'resp-1' }) })]);
    await pollOutbox();

    const [jobs] = mockQueueAddBulk.mock.calls[0] as [BulkJob[]];
    expect(jobs[0]?.data).toEqual({ response_id: 'resp-1', outbox_id: 'out-1', outbox_attempt: 1 });
    expect(typeof jobs[0]?.data).toBe('object');
  });

  // ── Unknown topic ──
  it('marks an unknown-topic row failed and reports to Sentry without enqueueing', async () => {
    sqlReturnQueue.push([outboxEntry({ topic: 'bogus_topic' })]);
    await pollOutbox();

    expect(mockQueueAddBulk).not.toHaveBeenCalled();
    expect(mockCaptureMessage).toHaveBeenCalledOnce();
    expect(String((mockCaptureMessage.mock.calls[0] as unknown[])[0])).toContain('Unknown topic');

    const failedUpdate = findSql(mockSql.mock.calls, "status = 'failed'", 'last_error');
    expect(failedUpdate).toBeDefined();
    expect(String((failedUpdate as unknown[])[1])).toContain('Unknown topic');
    // Every terminal write sets completed_at (#1395).
    expect(((failedUpdate as unknown[])[0] as string[]).join('?')).toContain('completed_at = NOW()');
  });

  // ── Attempt-guard / dead-letter on dispatch failure ──
  it('resets the row to pending when enqueue fails and attempts remain', async () => {
    mockQueueAddBulk.mockRejectedValueOnce(new Error('redis down'));
    sqlReturnQueue.push([outboxEntry({ attempts: 1, max_attempts: 5 })]);
    await pollOutbox();

    const pendingReset = findSql(mockSql.mock.calls, "status = 'pending'", 'last_error');
    expect(pendingReset).toBeDefined();
    // …and must NOT also dead-letter the row.
    expect(findSql(mockSql.mock.calls, "status = 'failed'", 'last_error')).toBeUndefined();
  });

  it('dead-letters the row to failed when enqueue fails and attempts are exhausted', async () => {
    mockQueueAddBulk.mockRejectedValueOnce(new Error('redis down'));
    sqlReturnQueue.push([outboxEntry({ attempts: 5, max_attempts: 5 })]);
    await pollOutbox();

    const failedUpdate = findSql(mockTx.mock.calls, "status = 'failed'", 'unnest');
    expect(failedUpdate).toBeDefined();
    expect(failedUpdate!.slice(1)).toEqual(['redis down', ['out-1'], [5]]);
    expect(mockSql.begin).toHaveBeenCalledTimes(2); // watchdog + coupled exhaustion
    // …and must NOT also reset the row to pending.
    expect(findSql(mockSql.mock.calls, "status = 'pending'", 'last_error')).toBeUndefined();
  });

  // ── Dispatch timeout (a hung BullMQ enqueue must not wedge the cycle) ──
  it('re-pends a row when the BullMQ enqueue exceeds the dispatch timeout', async () => {
    vi.useFakeTimers();
    try {
      // queue.add never settles — without the dispatch timeout this would hang
      // the whole cycle forever (ioredis offline queue, maxRetriesPerRequest:null).
      mockQueueAddBulk.mockReturnValueOnce(new Promise(() => {}));
      sqlReturnQueue.push([outboxEntry({ attempts: 1, max_attempts: 5 })]); // claim

      const p = pollOutbox();
      await vi.advanceTimersByTimeAsync(10_000 + 50); // default OUTBOX_DISPATCH_TIMEOUT_MS
      await p;

      const pendingReset = findSql(mockSql.mock.calls, "status = 'pending'", 'last_error');
      expect(pendingReset).toBeDefined();
      expect(String((pendingReset as unknown[])[1])).toContain('timed out');
      // attempts remain → must NOT dead-letter.
      expect(findSql(mockSql.mock.calls, "status = 'failed'", 'last_error')).toBeUndefined();
    } finally {
      vi.useRealTimers();
    }
  });

  // ── Cycle self-recovery (a stalled cycle must not silence the poller) ──
  it('supersedes a cycle stalled past the max duration and starts a fresh one', async () => {
    vi.useFakeTimers();
    try {
      // First cycle wedges: the watchdog transaction never settles.
      mockSql.begin.mockReturnValueOnce(new Promise(() => {}));
      void pollOutbox(); // enters, hangs in Phase 1, never resolves

      // Before the deadline, a fresh tick is a no-op (overlap guard holds).
      await pollOutbox();
      expect(mockQueueAddBulk).not.toHaveBeenCalled();

      // Past the deadline (default max cycle = 4× 30s interval = 120s), a new
      // cycle supersedes the wedged one and dispatches normally.
      await vi.advanceTimersByTimeAsync(120_000 + 1_000);
      sqlReturnQueue.push([outboxEntry()]); // fresh cycle's claim
      await pollOutbox();

      expect(mockQueueAddBulk).toHaveBeenCalledOnce();
      const stallLog = errorSpy.mock.calls.find(
        (c: unknown[]) => typeof c[0] === 'string' && (c[0] as string).includes('exceeded max duration'),
      );
      expect(stallLog).toBeDefined();
    } finally {
      vi.useRealTimers();
    }
  });

  // ── Bulk dispatch (one Redis round trip per topic group, one UPDATE per group) ──
  describe('bulk dispatch', () => {
    it('calls addBulk once per topic group with every id of that group, then one dispatched UPDATE per group', async () => {
      sqlReturnQueue.push([
        outboxEntry({ id: 'n-1' }),
        outboxEntry({ id: 'p-1', topic: 'publish_response', payload: { response_id: 'r-9' } }),
        outboxEntry({ id: 'n-2', attempts: 2 }),
      ]);
      await pollOutbox();

      expect(mockQueueAddBulk).toHaveBeenCalledOnce();
      expect(mockQueueAddBulkPublish).toHaveBeenCalledOnce();
      const [notifJobs] = mockQueueAddBulk.mock.calls[0] as [BulkJob[]];
      const [publishJobs] = mockQueueAddBulkPublish.mock.calls[0] as [BulkJob[]];
      expect(notifJobs.map((j) => j.opts.jobId)).toEqual(['n-1_1', 'n-2_2']);
      expect(publishJobs.map((j) => j.opts.jobId)).toEqual(['p-1_1']);
      expect(publishJobs[0]?.data).toEqual({ response_id: 'r-9', outbox_id: 'p-1', outbox_attempt: 1 });

      // One attempt-scoped bulk UPDATE per group (2 groups → 2), paired via
      // unnest(ids, attempts) so a stale cycle cannot overwrite a re-claimed row.
      const dispatchedUpdates = mockSql.mock.calls.filter(
        (c: unknown[]) => sqlText(c).includes("status = 'dispatched'") && sqlText(c).includes('unnest('),
      );
      expect(dispatchedUpdates).toHaveLength(2);
      const notifUpdate = dispatchedUpdates.find((c: unknown[]) =>
        (c[1] as string[]).includes('n-1'),
      ) as unknown[];
      expect(notifUpdate[1]).toEqual(['n-1', 'n-2']);
      expect(notifUpdate[2]).toEqual([1, 2]);
      expect(sqlText(notifUpdate)).toContain("status = 'dispatching'");
      expect(sqlText(notifUpdate)).toContain('attempts = claimed.attempts');
    });

    it('on a bulk failure re-pends the whole group (all-or-nothing) with the error, attempt-scoped', async () => {
      mockQueueAddBulk.mockRejectedValueOnce(new Error('redis down'));
      sqlReturnQueue.push([
        outboxEntry({ id: 'n-1', attempts: 1 }),
        outboxEntry({ id: 'n-2', attempts: 3 }),
      ]);
      await pollOutbox();

      const pendingReset = findSql(mockSql.mock.calls, "status = 'pending'", 'last_error', 'unnest(');
      expect(pendingReset).toBeDefined();
      expect(String((pendingReset as unknown[])[1])).toBe('redis down');
      expect((pendingReset as unknown[])[2]).toEqual(['n-1', 'n-2']);
      expect((pendingReset as unknown[])[3]).toEqual([1, 3]);
      // Pin the optimistic-lock guard on the re-pend: a stale cycle must not
      // reset a row a newer cycle has since re-claimed (attempts bumped).
      expect(sqlText(pendingReset as unknown[])).toContain("o.status = 'dispatching'");
      expect(sqlText(pendingReset as unknown[])).toContain('attempts = claimed.attempts');
      expect(findSql(mockSql.mock.calls, "status = 'failed'", 'last_error')).toBeUndefined();
    });

    it('splits a failed group by attempt budget: exhausted rows dead-letter, the rest re-pend', async () => {
      mockQueueAddBulk.mockRejectedValueOnce(new Error('redis down'));
      sqlReturnQueue.push([
        outboxEntry({ id: 'n-1', attempts: 5, max_attempts: 5 }),
        outboxEntry({ id: 'n-2', attempts: 2, max_attempts: 5 }),
      ]);
      await pollOutbox();

      const failed = findSql(mockTx.mock.calls, "status = 'failed'", 'unnest') as unknown[];
      const pending = findSql(mockSql.mock.calls, "status = 'pending'", 'last_error') as unknown[];
      expect(failed[2]).toEqual(['n-1']);
      expect(pending[2]).toEqual(['n-2']);
      // Both failure-path UPDATEs carry the same attempt-scoped guard as the
      // dispatched UPDATE; the dead-letter one especially, since 'failed' is terminal.
      for (const update of [failed, pending]) {
        expect(sqlText(update)).toContain("o.status = 'dispatching'");
        expect(sqlText(update)).toContain('attempts = claimed.attempts');
      }
    });

    it('a bulk failure in one topic group does not stop the next group from dispatching', async () => {
      mockQueueAddBulk.mockRejectedValueOnce(new Error('redis down'));
      sqlReturnQueue.push([
        outboxEntry({ id: 'n-1' }),
        outboxEntry({ id: 'p-1', topic: 'publish_response' }),
      ]);
      await pollOutbox();

      expect(mockQueueAddBulkPublish).toHaveBeenCalledOnce();
      const dispatched = findSql(mockSql.mock.calls, "status = 'dispatched'", 'unnest(') as unknown[];
      expect(dispatched[1]).toEqual(['p-1']);
    });

    it('an unknown-topic row is failed individually and excluded from the bulk group', async () => {
      sqlReturnQueue.push([
        outboxEntry({ id: 'n-1' }),
        outboxEntry({ id: 'x-1', topic: 'bogus_topic' }),
      ]);
      await pollOutbox();

      const [jobs] = mockQueueAddBulk.mock.calls[0] as [BulkJob[]];
      expect(jobs.map((j) => j.opts.jobId)).toEqual(['n-1_1']);
      expect(mockCaptureMessage).toHaveBeenCalledOnce();
    });
  });

  // ── Drain loop (re-claim inside the tick while batches come back full) ──
  describe('drain loop', () => {
    const batch = (prefix: string, n: number) =>
      Array.from({ length: n }, (_, i) => outboxEntry({ id: `${prefix}-${i}` }));
    // The sql mock shifts one queued result per sql() call, and each claimed
    // batch (one topic group here) is followed by exactly one bulk
    // `dispatched` UPDATE — so every claim result is followed by its UPDATE result.
    const queueBatch = (prefix: string, n: number) => {
      sqlReturnQueue.push(batch(prefix, n));
      sqlReturnQueue.push([]); // the group's dispatched UPDATE
    };

    it('re-claims after a FULL batch and stops on the first short batch', async () => {
      queueBatch('a', 50); // full (default OUTBOX_BATCH_SIZE = 50)
      queueBatch('b', 50); // full
      queueBatch('c', 7); // short → stop
      queueBatch('d', 50); // must never be claimed this tick
      await pollOutbox();

      const claims = mockSql.mock.calls.filter((c: unknown[]) => sqlText(c).includes('FOR UPDATE SKIP LOCKED'));
      expect(claims).toHaveLength(3);
      expect(mockQueueAddBulk).toHaveBeenCalledTimes(3);
      const sizes = mockQueueAddBulk.mock.calls.map((c: unknown[]) => (c[0] as BulkJob[]).length);
      expect(sizes).toEqual([50, 50, 7]);
      expect(sqlReturnQueue).toHaveLength(2); // the 'd' batch (+ its UPDATE) was left for the next tick
    });

    it('stops after ONE claim when a full batch has a failed group, leaving the rows re-pended at their first attempt', async () => {
      // Fast-failing Redis (-OOM / -READONLY reply errors): addBulk rejects
      // synchronously on every call. The re-pend leaves available_at untouched,
      // so without the failure stop the next claim in the same loop would pick
      // the same rows straight back up and burn max_attempts inside one tick.
      mockQueueAddBulk.mockRejectedValue(new Error('OOM command not allowed'));
      try {
        sqlReturnQueue.push(batch('a', 50)); // full batch, attempts = 1
        sqlReturnQueue.push([]); // the group's re-pend UPDATE
        sqlReturnQueue.push(batch('a', 50)); // what a second claim WOULD return (attempts bumped in prod)
        sqlReturnQueue.push([]);
        await pollOutbox();

        const claims = mockSql.mock.calls.filter((c: unknown[]) => sqlText(c).includes('FOR UPDATE SKIP LOCKED'));
        expect(claims).toHaveLength(1);
        expect(mockQueueAddBulk).toHaveBeenCalledOnce();

        // The 50 rows were re-pended at attempts 1 — not dead-lettered.
        const pendingResets = mockSql.mock.calls.filter(
          (c: unknown[]) => sqlText(c).includes("status = 'pending'") && sqlText(c).includes('last_error'),
        );
        expect(pendingResets).toHaveLength(1);
        expect((pendingResets[0] as unknown[])[2]).toHaveLength(50);
        expect(new Set((pendingResets[0] as unknown[])[3] as number[])).toEqual(new Set([1]));
        expect(findSql(mockSql.mock.calls, "status = 'failed'", 'last_error')).toBeUndefined();
        expect(sqlReturnQueue).toHaveLength(2); // second batch untouched this tick
      } finally {
        mockQueueAddBulk.mockReset();
      }
    });

    it('does not re-claim when the first batch is already short', async () => {
      queueBatch('a', 3);
      queueBatch('b', 50);
      await pollOutbox();

      const claims = mockSql.mock.calls.filter((c: unknown[]) => sqlText(c).includes('FOR UPDATE SKIP LOCKED'));
      expect(claims).toHaveLength(1);
      expect(sqlReturnQueue).toHaveLength(2);
    });

    it('stops re-claiming once the drain budget is spent even though the batch was full', async () => {
      vi.useFakeTimers();
      try {
        queueBatch('a', 50);
        queueBatch('b', 50);
        queueBatch('c', 50); // must not be claimed: budget spent after 'b'
        // Each addBulk consumes 2.5s of fake time, so after two full batches the
        // 4s default OUTBOX_DRAIN_BUDGET_MS is exceeded.
        mockQueueAddBulk.mockImplementation(async () => {
          await vi.advanceTimersByTimeAsync(2_500);
          return [];
        });

        await pollOutbox();

        const claims = mockSql.mock.calls.filter((c: unknown[]) => sqlText(c).includes('FOR UPDATE SKIP LOCKED'));
        expect(claims).toHaveLength(2);
        expect(sqlReturnQueue).toHaveLength(2);
        const budgetLog = logSpy.mock.calls.find(
          (c: unknown[]) => typeof c[0] === 'string' && (c[0] as string).includes('Drain budget spent'),
        );
        expect(budgetLog).toBeDefined();
      } finally {
        mockQueueAddBulk.mockReset();
        vi.useRealTimers();
      }
    });
  });
});
