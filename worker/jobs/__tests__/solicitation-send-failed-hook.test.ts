// The `'failed'` exhaustion hook for the Solicitation send worker
// (#899 Task 0 — the eval task, Task 7 converts these).
//
// The hook is the ONLY writer that terminalizes an Outreach row on BullMQ
// exhaustion, and its whole correctness rests on one predicate: has the FINAL
// attempt failed? Fire early and a row that still has retries left is written
// `failed` / `send_exhausted` while a later attempt is still allowed to run —
// which, with a stable provider idempotency key, means a "failed" row whose
// message may yet be delivered.
//
// THE TERMINAL PREDICATE HERE IS THE `'failed'`-EVENT FORM — `attemptsMade >=
// max` — and it is deliberately NOT `isTerminalAttempt` from
// `src/lib/shared/outbox.ts`, which is the CATCH-BLOCK form and fires one
// attempt early in this position. `worker/jobs/judge/failed-hook.ts` keeps its
// own copy for exactly this reason and says "do not unify them". Test 34 is
// what stops a future edit from unifying them anyway.
//
// The hook writes the terminal facts itself; it does NOT delegate to the
// terminal job-failure sink (`worker/job-failure-sink.ts`), which raises the
// Sentry issue and writes nothing to `job_outbox` — failed-hooks own that
// surface.
//
// UNIT, not live-DB: the claims below are about WHICH collaborators run, in
// which order, and under which predicate — none of which needs real Postgres.
// The stored-row behaviour this hook depends on (the CAS, the join) is pinned
// by `src/lib/solicitation/__tests__/dispatch.integration.test.ts`.

import type { Job } from 'bullmq';
import type { Sql, TransactionSql } from 'postgres';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { SolicitationSendPayload } from '@/lib/shared/worker-types';

// The four collaborators the hook composes. `extractOutboxHandle` is kept REAL
// — it is the thing that decides whether the CAS is attempt-guarded at all, and
// a mocked one would hide a payload shape the hook cannot terminalize under.
const outboxMocks = vi.hoisted(() => ({
  markOutboxFailed: vi.fn<() => Promise<boolean>>(),
}));
vi.mock('@/lib/shared/outbox', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/shared/outbox')>()),
  markOutboxFailed: outboxMocks.markOutboxFailed,
}));

const spineMocks = vi.hoisted(() => ({ completeRun: vi.fn<() => Promise<void>>() }));
vi.mock('@/lib/agents/run-spine', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/agents/run-spine')>()),
  completeRun: spineMocks.completeRun,
}));

const outreachMocks = vi.hoisted(() => ({ closeBatchIfSettled: vi.fn<() => Promise<unknown>>() }));
vi.mock('@/lib/solicitation/outreach', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/solicitation/outreach')>()),
  closeBatchIfSettled: outreachMocks.closeBatchIfSettled,
}));

const lockMocks = vi.hoisted(() => ({
  acquireSolicitationBatchLock: vi.fn<() => Promise<void>>(),
}));
vi.mock('@/lib/solicitation/batch-builder', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/solicitation/batch-builder')>()),
  acquireSolicitationBatchLock: lockMocks.acquireSolicitationBatchLock,
}));

import { handleSolicitationSendFailed } from '../solicitation-send/failed-hook';

const BATCH_ID = '11111111-1111-7111-8111-111111111111';
const BUSINESS_ID = '22222222-2222-7222-8222-222222222222';
const OUTREACH_ID = '33333333-3333-7333-8333-333333333333';
const ACCOUNT_ID = '44444444-4444-7444-8444-444444444444';
const OUTBOX_ID = '55555555-5555-7555-8555-555555555555';
const CHILD_RUN_ID = '66666666-6666-7666-8666-666666666666';

interface RecordedCall {
  text: string;
  values: unknown[];
}

/**
 * Tagged-template stub with a FIFO result queue, shaped after
 * `src/lib/escalations/__tests__/transitions.test.ts`'s `makeSqlStub`. Only the
 * transaction handle is ever used here — the hook opens exactly one
 * `sql.begin`, and a query on the outer handle would be a bug this stub makes
 * visible by starving the queue.
 */
function makeSqlStub(results: unknown[][]) {
  const queue = [...results];
  const calls: RecordedCall[] = [];
  const txCalls: RecordedCall[] = [];
  const recorder = (target: RecordedCall[]) =>
    (strings: TemplateStringsArray, ...values: unknown[]) => {
      target.push({ text: strings.join('?'), values });
      const rows = queue.shift() ?? [];
      return Promise.resolve(Object.assign(rows, { count: rows.length }));
    };
  const tx = recorder(txCalls) as never as TransactionSql;
  const beginMock = vi.fn(
    async (callback: (transaction: TransactionSql) => unknown) => callback(tx),
  );
  const sql = Object.assign(recorder(calls), { begin: beginMock }) as never as Sql;
  return { sql, calls, txCalls, beginMock };
}

/** One BullMQ `'failed'` event's job, with the attempt arithmetic the whole
 *  hook turns on left as the caller's choice. */
function sendJob(attemptsMade: number, maxAttempts: number): Job<SolicitationSendPayload> {
  return {
    id: 'solicitation-send_job',
    attemptsMade,
    opts: { attempts: maxAttempts },
    data: {
      batch_id: BATCH_ID,
      business_id: BUSINESS_ID,
      outreach_id: OUTREACH_ID,
      outbox_id: OUTBOX_ID,
      outbox_attempt: 2,
    },
  } as never as Job<SolicitationSendPayload>;
}

const outreachRow = {
  account_id: ACCOUNT_ID,
  agent_run_id: CHILD_RUN_ID,
  delivery_status: 'sending',
};

beforeEach(() => {
  outboxMocks.markOutboxFailed.mockReset();
  outboxMocks.markOutboxFailed.mockResolvedValue(true);
  spineMocks.completeRun.mockReset();
  spineMocks.completeRun.mockResolvedValue(undefined);
  outreachMocks.closeBatchIfSettled.mockReset();
  outreachMocks.closeBatchIfSettled.mockResolvedValue({ status: 'closed' });
  lockMocks.acquireSolicitationBatchLock.mockReset();
  lockMocks.acquireSolicitationBatchLock.mockResolvedValue(undefined);
});

describe('handleSolicitationSendFailed', () => {
  // On the terminal attempt: `delivery_status='failed'` with
  // `disposition_reason='send_exhausted'`, the Lazy child terminalized
  // `failed`, the outbox row marked failed, and `closeBatchIfSettled` called in
  // the SAME transaction — a Settled batch has no Outreach row left in
  // `rendered`, `queued` or `sending`, and an exhausted row that never joins
  // leaves the batch open forever and permanently consumes the account's one
  // active-batch slot.
  it('writes failed with send_exhausted on the terminal attempt and calls closeBatchIfSettled', async () => {
    const { sql, calls, txCalls, beginMock } = makeSqlStub([
      [outreachRow],
      [{ id: OUTREACH_ID }],
    ]);

    await handleSolicitationSendFailed(sql, sendJob(3, 3), new TypeError('provider exploded'));

    // ONE transaction, and nothing outside it: the five facts are coupled or
    // they are nothing.
    expect(beginMock).toHaveBeenCalledTimes(1);
    expect(calls).toEqual([]);

    // The advisory lock is the transaction's FIRST act — the global lock order
    // is advisory-then-row-locks, and holding the Outreach row while waiting
    // for the batch row is an ABBA deadlock against the offboarding purge.
    expect(lockMocks.acquireSolicitationBatchLock).toHaveBeenCalledWith(
      expect.anything(),
      BUSINESS_ID,
    );
    expect(lockMocks.acquireSolicitationBatchLock.mock.invocationCallOrder[0])
      .toBeLessThan(outboxMocks.markOutboxFailed.mock.invocationCallOrder[0]!);

    // The ownership CAS precedes every domain write, so a stale hook — one the
    // watchdog already superseded — can never terminalize a row a newer
    // attempt is still dispatching.
    expect(outboxMocks.markOutboxFailed).toHaveBeenCalledWith(
      expect.anything(),
      OUTBOX_ID,
      'solicitation_send_exhausted:TypeError',
      2,
    );

    // The terminal row write itself, with 091's `failed` ↔ `send_exhausted`
    // pairing and the CAS that keeps another writer's verdict standing.
    const update = txCalls.find((call) => call.text.includes('UPDATE solicitation_outreach'));
    expect(update).toBeDefined();
    expect(update!.text).toContain("delivery_status = 'failed'");
    expect(update!.text).toContain("delivery_status IN ('queued', 'sending')");
    expect(update!.values).toContain('send_exhausted');

    // Decision 8's failure arm: a dispatch that never got a provider answer is
    // a failure to send, so the Lazy child terminalizes `failed`.
    expect(spineMocks.completeRun).toHaveBeenCalledWith(
      expect.anything(),
      CHILD_RUN_ID,
      'failed',
      expect.objectContaining({ failure_class: 'send_exhausted', error_class: 'TypeError' }),
    );

    // And the join, with the account id resolved from the ROW rather than
    // taken from a payload this hook does not own.
    expect(outreachMocks.closeBatchIfSettled).toHaveBeenCalledWith(
      expect.anything(),
      { batchId: BATCH_ID, accountId: ACCOUNT_ID, businessId: BUSINESS_ID },
    );
  });

  // The negative half, and the one that catches the `isTerminalAttempt`
  // confusion above: with `attemptsMade` one short of `max`, the hook writes
  // NOTHING — no Outreach terminal, no child terminal, no outbox completion.
  // BullMQ still owns the job.
  it('does not terminalize, fail the child, or complete the outbox before the final BullMQ attempt', async () => {
    const { sql, calls, txCalls, beginMock } = makeSqlStub([
      [outreachRow],
      [{ id: OUTREACH_ID }],
    ]);

    // 2/3 under the `'failed'`-EVENT form: `attemptsMade` already counts the
    // attempt that just failed, so one retry remains. The CATCH-BLOCK form
    // (`attemptsMade + 1 >= max`) would call this terminal and fire here.
    await handleSolicitationSendFailed(sql, sendJob(2, 3), new Error('transient'));

    expect(beginMock).not.toHaveBeenCalled();
    expect(calls).toEqual([]);
    expect(txCalls).toEqual([]);
    expect(lockMocks.acquireSolicitationBatchLock).not.toHaveBeenCalled();
    expect(outboxMocks.markOutboxFailed).not.toHaveBeenCalled();
    expect(spineMocks.completeRun).not.toHaveBeenCalled();
    expect(outreachMocks.closeBatchIfSettled).not.toHaveBeenCalled();
  });
});
