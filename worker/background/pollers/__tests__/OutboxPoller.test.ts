import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// ── Hoisted mock state ──────────────────────────────────────────────
const {
  sqlReturnQueue,
  txReturnQueue,
  mockSql,
  mockTx,
  mockQueueAdd,
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
    mockQueueAdd: vi.fn(),
    mockCaptureMessage: vi.fn(),
    mockAddBreadcrumb: vi.fn(),
  };
});

vi.mock('../../../../src/lib/db/server', () => ({ sql: mockSql, jsonb: (v: unknown) => v }));
vi.mock('../../../queues', () => ({
  topicToQueue: { send_notification: { add: mockQueueAdd } },
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
    expect(sqlText(mockTx.mock.calls[0])).toContain("INTERVAL '1 hour'");
    expect(sqlText(mockTx.mock.calls[0])).toContain('attempts < max_attempts');
    expect(sqlText(mockTx.mock.calls[1])).toContain("status = 'failed'");
    expect(sqlText(mockTx.mock.calls[1])).toContain('attempts >= max_attempts');
    expect(sqlText(mockTx.mock.calls[2])).toContain("status = 'dispatching'");
    expect(sqlText(mockTx.mock.calls[2])).toContain("INTERVAL '2 minutes'");
  });

  it('logs recovered/failed/stale counts when the watchdog acted', async () => {
    txReturnQueue.push([{ count: '2' }]); // recovered
    txReturnQueue.push([{ count: '1' }]); // terminated
    txReturnQueue.push([{ count: '3' }]); // stale dispatching
    sqlReturnQueue.push([]); // no pending rows
    await pollOutbox();

    const watchdogLog = logSpy.mock.calls.find(
      (c: unknown[]) => typeof c[0] === 'string' && (c[0] as string).includes('Watchdog'),
    );
    expect(watchdogLog).toBeDefined();
    expect(watchdogLog![0]).toContain('recovered=2');
    expect(watchdogLog![0]).toContain('failed=1');
    expect(watchdogLog![0]).toContain('stale_dispatching=3');
  });

  it('continues to dispatch even if the watchdog transaction throws', async () => {
    mockSql.begin.mockRejectedValueOnce(new Error('watchdog tx failed'));
    sqlReturnQueue.push([outboxEntry()]); // claim returns one entry
    await pollOutbox();

    expect(errorSpy).toHaveBeenCalled();
    expect(mockQueueAdd).toHaveBeenCalledOnce(); // dispatch still happened
  });

  // ── Phase 2 + 3: dispatch ──
  it('dispatches a claimed pending row to its queue and marks it dispatched', async () => {
    sqlReturnQueue.push([outboxEntry()]); // claim
    await pollOutbox();

    expect(mockQueueAdd).toHaveBeenCalledOnce();
    const [topicArg, payloadArg, optsArg] = mockQueueAdd.mock.calls[0] as [
      string,
      Record<string, unknown>,
      { jobId: string },
    ];
    expect(topicArg).toBe('send_notification');
    expect(payloadArg).toEqual({ response_id: 'resp-1', outbox_id: 'out-1', outbox_attempt: 1 });
    expect(optsArg).toEqual({ jobId: 'out-1_1' });

    const dispatchedUpdate = findSql(mockSql.mock.calls, "status = 'dispatched'");
    expect(dispatchedUpdate).toBeDefined();
  });

  it('returns without dispatching when no pending rows are claimed', async () => {
    sqlReturnQueue.push([]); // empty claim
    await pollOutbox();
    expect(mockQueueAdd).not.toHaveBeenCalled();
  });

  it('parses a JSON-string payload into an object before enqueueing', async () => {
    sqlReturnQueue.push([outboxEntry({ payload: JSON.stringify({ response_id: 'resp-1' }) })]);
    await pollOutbox();

    const payloadArg = (mockQueueAdd.mock.calls[0] as unknown[])[1];
    expect(payloadArg).toEqual({ response_id: 'resp-1', outbox_id: 'out-1', outbox_attempt: 1 });
    expect(typeof payloadArg).toBe('object');
  });

  // ── Unknown topic ──
  it('marks an unknown-topic row failed and reports to Sentry without enqueueing', async () => {
    sqlReturnQueue.push([outboxEntry({ topic: 'bogus_topic' })]);
    await pollOutbox();

    expect(mockQueueAdd).not.toHaveBeenCalled();
    expect(mockCaptureMessage).toHaveBeenCalledOnce();
    expect(String((mockCaptureMessage.mock.calls[0] as unknown[])[0])).toContain('Unknown topic');

    const failedUpdate = findSql(mockSql.mock.calls, "status = 'failed'", 'last_error');
    expect(failedUpdate).toBeDefined();
    expect(String((failedUpdate as unknown[])[1])).toContain('Unknown topic');
  });

  // ── Attempt-guard / dead-letter on dispatch failure ──
  it('resets the row to pending when enqueue fails and attempts remain', async () => {
    mockQueueAdd.mockRejectedValueOnce(new Error('redis down'));
    sqlReturnQueue.push([outboxEntry({ attempts: 1, max_attempts: 5 })]);
    await pollOutbox();

    const pendingReset = findSql(mockSql.mock.calls, "status = 'pending'", 'last_error');
    expect(pendingReset).toBeDefined();
  });

  it('dead-letters the row to failed when enqueue fails and attempts are exhausted', async () => {
    mockQueueAdd.mockRejectedValueOnce(new Error('redis down'));
    sqlReturnQueue.push([outboxEntry({ attempts: 5, max_attempts: 5 })]);
    await pollOutbox();

    const failedUpdate = findSql(mockSql.mock.calls, "status = 'failed'", 'last_error');
    expect(failedUpdate).toBeDefined();
  });
});
