// Unit tests for the transactional-outbox writers.
//
// These gate exactly-once semantics but previously had no DIRECT test — worker
// suites mock them. After consolidating the attempt-guard into `dispatchedRow`
// (a composed Postgres.js fragment), this suite verifies the composed SQL via
// the fragment-aware `createMockSql` harness (which mirrors real Postgres.js
// nested-fragment flattening), so the guarded-vs-legacy WHERE can't silently
// regress.

import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { Sql } from 'postgres';

const { mockSql, sqlReturnQueue, sqlCalls, resetMockSql } = await vi.hoisted(async () => {
  const { createMockSql } = await import('../../../../worker/__tests__/helpers/mock-sql');
  return { ...createMockSql() };
});

vi.mock('@/lib/db/server', () => ({ sql: mockSql }));

import { markOutboxCompleted, markOutboxFailed, recordOutboxTransientError } from '../outbox';
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
  it('markOutboxCompleted attempt-guards the WHERE when the attempt is known', async () => {
    sqlReturnQueue.push(mkTaggedResult([{ id: 'x' }]));
    await markOutboxCompleted(execMock, 'outbox-1', 3);
    const q = sqlCalls.at(-1)!;
    expect(q.text).toContain("SET status = 'completed'");
    expect(q.text).toContain("status = 'dispatched'");
    expect(q.text).toContain('attempts =');
    expect(q.values).toEqual(['outbox-1', 3]);
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

  it('markOutboxFailed writes last_error + status=failed, attempt-guarded', async () => {
    sqlReturnQueue.push(mkTaggedResult([{ id: 'x' }]));
    await markOutboxFailed(execMock, 'outbox-2', 'boom', 2);
    const q = sqlCalls.at(-1)!;
    expect(q.text).toContain("SET status = 'failed'");
    expect(q.text).toContain('attempts =');
    // SET's ${error} is bound before the WHERE fragment's ${outboxId}, ${attempt}.
    expect(q.values).toEqual(['boom', 'outbox-2', 2]);
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
