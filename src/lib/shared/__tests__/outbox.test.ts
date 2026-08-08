// Unit tests for the transactional-outbox writers.
//
// These gate exactly-once semantics but previously had no DIRECT test — worker
// suites mock them. After consolidating the attempt-guard into `dispatchedRow`
// (a composed Postgres.js fragment), this suite verifies the composed SQL via
// the fragment-aware `createMockSql` harness (which mirrors real Postgres.js
// nested-fragment flattening), so the guarded-vs-legacy WHERE can't silently
// regress.

import { describe, it, expect, beforeEach, vi } from 'vitest';
import fc from 'fast-check';
import type { Sql } from 'postgres';
import { OUTBOX_COMPLETION_REASON } from '../outbox-completion-reason';

const { mockSql, sqlReturnQueue, sqlCalls, resetMockSql } = await vi.hoisted(async () => {
  const { createMockSql } = await import('../../../../worker/__tests__/helpers/mock-sql');
  return { ...createMockSql() };
});

vi.mock('@/lib/db/server', () => ({ sql: mockSql }));

import {
  extractOutboxHandle,
  lockDispatchedOutboxAttemptIfOwned,
  markOutboxCompleted,
  markOutboxCompletedIfOwned,
  markOutboxCompletedWithReason,
  markOutboxFailed,
  recordOutboxTransientError,
} from '../outbox';
import { mkTaggedResult } from '../../../../worker/__tests__/helpers/mock-sql';

// The writers now take the executor as their leading arg; mockSql (the
// tagged-template harness mock) doesn't structurally match postgres.Sql, so
// pass a cast view — the query still runs on mockSql, so sqlCalls records it.
const execMock = mockSql as unknown as Sql;

beforeEach(() => {
  resetMockSql();
  vi.restoreAllMocks();
});

describe('outbox writers — dispatchedRow attempt-guard composition', () => {
  it('lockDispatchedOutboxAttemptIfOwned prevents a stale build attempt from creating a parent', async () => {
    sqlReturnQueue.push(
      mkTaggedResult([{ id: 'outbox-1' }]),
      mkTaggedResult([]),
      mkTaggedResult([]),
    );

    await expect(
      lockDispatchedOutboxAttemptIfOwned(execMock, 'outbox-1', 3),
    ).resolves.toBe(true);
    await expect(
      lockDispatchedOutboxAttemptIfOwned(execMock, 'outbox-1', 2),
    ).resolves.toBe(false);
    await expect(
      lockDispatchedOutboxAttemptIfOwned(execMock, 'outbox-1', 4),
    ).resolves.toBe(false);
    await expect(
      lockDispatchedOutboxAttemptIfOwned(execMock, 'outbox-1', Number.NaN),
    ).resolves.toBe(false);

    expect(sqlCalls).toHaveLength(3);
    for (const query of sqlCalls) {
      expect(query.text).toContain('SELECT id FROM job_outbox');
      expect(query.text).toContain("status = 'dispatched'");
      expect(query.text).toContain('attempts =');
      expect(query.text).toContain('FOR UPDATE');
    }
    expect(sqlCalls[0]!.values).toEqual(['outbox-1', 3]);
    expect(sqlCalls[1]!.values).toEqual(['outbox-1', 2]);
    expect(sqlCalls[2]!.values).toEqual(['outbox-1', 4]);
  });

  it('markOutboxCompleted attempt-guards the WHERE when the attempt is known', async () => {
    sqlReturnQueue.push(mkTaggedResult([{ id: 'x' }]));
    await markOutboxCompleted(execMock, 'outbox-1', 3);
    const q = sqlCalls.at(-1)!;
    expect(q.text).toContain("SET status = 'completed'");
    expect(q.text).toContain("status = 'dispatched'");
    expect(q.text).toContain('attempts =');
    expect(q.values).toEqual(['outbox-1', 3]);
    // A generic completion must stay reasonless: if `markOutboxCompleted` ever
    // grew a reason, every ordinary completed row would look like a policy event.
    expect(sqlCalls.at(-1)!.text).not.toContain('completion_reason');
  });

  it('markOutboxCompleted drops the attempts guard on the legacy (no-attempt) path', async () => {
    sqlReturnQueue.push(mkTaggedResult([{ id: 'x' }]));
    await markOutboxCompleted(execMock, 'outbox-1');
    const q = sqlCalls.at(-1)!;
    expect(q.text).toContain("status = 'dispatched'");
    expect(q.text).not.toContain('attempts =');
    expect(q.values).toEqual(['outbox-1']);
  });

  it('markOutboxCompleted warns when an attempt-guarded UPDATE matches 0 rows (superseded)', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    sqlReturnQueue.push(mkTaggedResult([]));
    await markOutboxCompleted(execMock, 'outbox-1', 5);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('markOutboxCompleted no-op'));
  });

  it('markOutboxCompleted does NOT warn on the legacy path even at 0 rows', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    sqlReturnQueue.push(mkTaggedResult([]));
    await markOutboxCompleted(execMock, 'outbox-1');
    expect(warn).not.toHaveBeenCalled();
  });

  it('markOutboxCompletedIfOwned exposes whether the dispatched attempt won its CAS', async () => {
    sqlReturnQueue.push(mkTaggedResult([{ id: 'x' }]), mkTaggedResult([]));

    await expect(markOutboxCompletedIfOwned(execMock, 'outbox-1', 2)).resolves.toBe(true);
    await expect(markOutboxCompletedIfOwned(execMock, 'outbox-1', 1)).resolves.toBe(false);
  });

  it('markOutboxFailed writes last_error + status=failed, attempt-guarded', async () => {
    sqlReturnQueue.push(mkTaggedResult([{ id: 'x' }]));
    const transitioned = await markOutboxFailed(execMock, 'outbox-2', 'boom', 2);
    const q = sqlCalls.at(-1)!;
    expect(q.text).toContain("SET status = 'failed'");
    expect(q.text).toContain('attempts =');
    // SET's ${error} is bound before the WHERE fragment's ${outboxId}, ${attempt}.
    expect(q.values).toEqual(['boom', 'outbox-2', 2]);
    expect(transitioned).toBe(true);
  });

  it('markOutboxFailed returns false when a guarded stale attempt loses the transition', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    sqlReturnQueue.push(mkTaggedResult([]));

    const transitioned = await markOutboxFailed(execMock, 'outbox-2', 'boom', 1);

    expect(transitioned).toBe(false);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('markOutboxFailed no-op'));
  });

  it('markOutboxFailed reports the unguarded legacy UPDATE row-count result', async () => {
    sqlReturnQueue.push(mkTaggedResult([{ id: 'x' }]), mkTaggedResult([]));

    await expect(markOutboxFailed(execMock, 'legacy-updated', 'boom')).resolves.toBe(true);
    await expect(markOutboxFailed(execMock, 'legacy-missing', 'boom')).resolves.toBe(false);
  });

  it('recordOutboxTransientError sets last_error WITHOUT touching status, attempt-guarded', async () => {
    sqlReturnQueue.push(mkTaggedResult([{ id: 'x' }]));
    await recordOutboxTransientError(execMock, 'outbox-3', 'transient', 4);
    const q = sqlCalls.at(-1)!;
    expect(q.text).toContain('SET last_error =');
    expect(q.text).not.toContain("status = 'failed'");
    expect(q.text).not.toContain("status = 'completed'");
    expect(q.text).toContain("status = 'dispatched'"); // still guards on dispatched
    expect(q.text).toContain('attempts =');
    expect(q.values).toEqual(['transient', 'outbox-3', 4]);
  });

  it('recordOutboxTransientError swallows DB errors (observability must not poison the retry path)', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const rejected = Promise.reject(new Error('db down'));
    rejected.catch(() => {}); // pre-handle so the rejection isn't flagged before the mock consumes it
    sqlReturnQueue.push(rejected);
    await expect(recordOutboxTransientError(execMock, 'outbox-3', 'transient', 1)).resolves.toBeUndefined();
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('recordOutboxTransientError failed'));
  });
});

describe('markOutboxCompletedWithReason (invariants)', () => {
  it('markOutboxCompletedWithReason completes the dispatched row and stamps the supplied completion_reason', async () => {
    // The new capability: the reason is a PARAMETER, not baked into the method
    // name. Swept over every vocabulary member so adding one can't skip a site.
    for (const reason of Object.values(OUTBOX_COMPLETION_REASON)) {
      resetMockSql();
      sqlReturnQueue.push(mkTaggedResult([{ id: 'x' }]));

      await markOutboxCompletedWithReason(execMock, 'outbox-1', reason, 3);

      const q = sqlCalls.at(-1)!;
      expect(q.text).toContain("SET status = 'completed'");
      // `completed_at` is what makes a completed row auditable — it is the only
      // record of WHEN the marker landed, and every other outbox writer sets it.
      // A generalization that dropped it would leave reasoned completions as the
      // one class of completed row with no completion timestamp.
      expect(q.text).toContain('completed_at = NOW()');
      expect(q.text).toContain('completion_reason');
      expect(q.values).toContain(reason);
      // Row scoping lives in the shared `dispatchedRow` fragment, but the bind
      // has to arrive from THIS caller — assert the id reached the values.
      expect(q.values).toContain('outbox-1');
    }
  });

  it('OUTBOX_COMPLETION_REASON preserves the persisted owner_unreachable wire value', () => {
    // The vocabulary is self-referential: the writer, both pollers, and every
    // fixture resolve the SAME constant, so renaming its VALUE (not its key)
    // would strand every historical row while leaving all of them green. This is
    // the one place a bare literal is correct — comparing the constant to the
    // durable wire value is the whole assertion.
    expect(OUTBOX_COMPLETION_REASON.OWNER_UNREACHABLE).toBe('owner_unreachable');
    expect(OUTBOX_COMPLETION_REASON.IMPORT_CONSENT_BLOCKED).toBe('import_consent_blocked');
  });

  it('markOutboxCompletedWithReason guards on the dispatched attempt so a superseded attempt stamps no reason', async () => {
    await fc.assert(fc.asyncProperty(
      fc.option(fc.integer({ min: 0, max: 50 }), { nil: undefined }), // dispatched-attempt param
      fc.integer({ min: 0, max: 50 }),                                // the row's ACTUAL attempts
      fc.boolean(),                                                    // row is currently 'dispatched'?
      fc.constantFrom(...Object.values(OUTBOX_COMPLETION_REASON)),     // every vocabulary member
      async (attempt, actualAttempts, isDispatched, reason) => {
        resetMockSql();
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
        const rowMatches = typeof attempt === 'number'
          ? (isDispatched && attempt === actualAttempts)
          : isDispatched;
        sqlReturnQueue.push(mkTaggedResult(rowMatches ? [{ id: 'x' }] : []));
        await markOutboxCompletedWithReason(execMock, 'outbox-1', reason, attempt);
        const q = sqlCalls.at(-1)!;
        expect(q.text).toContain("SET status = 'completed'");
        expect(q.text).toContain('completion_reason');
        expect(q.values).toContain(reason);
        // HOISTED out of the attempt branch (round-1 finding): the legacy
        // no-attempt path still must not overwrite a terminal row, and the old
        // assertion only covered the guarded path.
        expect(q.text).toContain("status = 'dispatched'");
        if (typeof attempt === 'number') {
          expect(q.text).toContain('attempts =');
          expect(q.values).toContain(attempt);
        } else {
          expect(q.text).not.toContain('attempts =');
        }
        expect(warn).toHaveBeenCalledTimes(typeof attempt === 'number' && !rowMatches ? 1 : 0);
        warn.mockRestore();
      },
    ), { numRuns: 200 });
  });

  it('markOutboxCompletedWithReason warns and swallows a 0-row update rather than throwing', async () => {
    // The warn label must name the REASON, not just the method — an operator
    // reading the line needs to know which marker was lost to the race.
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    sqlReturnQueue.push(mkTaggedResult([]));

    await expect(
      markOutboxCompletedWithReason(
        execMock, 'outbox-9', OUTBOX_COMPLETION_REASON.IMPORT_CONSENT_BLOCKED, 4,
      ),
    ).resolves.toBeUndefined();

    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0]![0]).toContain(
      OUTBOX_COMPLETION_REASON.IMPORT_CONSENT_BLOCKED,
    );
    warn.mockRestore();
  });
});

describe('extractOutboxHandle — payload/legacy handle extraction', () => {
  it('extracts outbox_id and a finite outbox_attempt from a poller-shaped payload', () => {
    expect(extractOutboxHandle({ outbox_id: 'ob_1', outbox_attempt: 3 }, 'job_9')).toEqual({
      outboxId: 'ob_1',
      attempt: 3,
    });
  });

  it('falls back to the BullMQ job id when outbox_id is missing or not a string', () => {
    expect(extractOutboxHandle({}, 'job_9').outboxId).toBe('job_9');
    expect(extractOutboxHandle({ outbox_id: 42 }, 'job_9').outboxId).toBe('job_9');
  });

  it('degrades attempt to undefined for legacy payloads without a usable outbox_attempt', () => {
    expect(extractOutboxHandle({ outbox_id: 'ob_1' }, 'job_9').attempt).toBeUndefined();
    expect(extractOutboxHandle({ outbox_id: 'ob_1', outbox_attempt: '3' }, 'job_9').attempt).toBeUndefined();
    expect(extractOutboxHandle({ outbox_id: 'ob_1', outbox_attempt: Number.NaN }, 'job_9').attempt).toBeUndefined();
    expect(
      extractOutboxHandle({ outbox_id: 'ob_1', outbox_attempt: Number.POSITIVE_INFINITY }, 'job_9').attempt,
    ).toBeUndefined();
  });

  it('treats null/undefined job data as a legacy job (fallback id, no attempt)', () => {
    expect(extractOutboxHandle(null, 'job_9')).toEqual({ outboxId: 'job_9', attempt: undefined });
    expect(extractOutboxHandle(undefined, 'job_9')).toEqual({ outboxId: 'job_9', attempt: undefined });
  });
});
