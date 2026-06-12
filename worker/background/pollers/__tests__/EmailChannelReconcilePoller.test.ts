// worker/background/pollers/__tests__/EmailChannelReconcilePoller.test.ts
//
// Reconciliation poller for the durable channel_enrollments retry path.
// Critical invariants tested:
//   - Active business missing an email channel → SELECT then INSERT (happy path)
//   - Active business with an existing verified email channel → SELECT finds row, no INSERT
//   - Active business with an ARCHIVED email channel → no INSERT
//     (B16 finding #4 — the previous query treated archived rows as missing,
//      which would silently resubscribe an intentionally unsubscribed owner)
//   - Concurrent INSERT race → 23505 caught as benign, counted as non-insert
//   - sql.begin() used for select-then-insert transaction (no ON CONFLICT)

import { describe, it, expect, vi, beforeEach } from 'vitest';

// Marker type to signal that a queued consume call should throw instead of return
interface ThrowMarker {
  __throw: Error;
}

function throwMarker(err: Error): ThrowMarker {
  return { __throw: err };
}

function isThrowMarker(val: unknown): val is ThrowMarker {
  return val !== null && typeof val === 'object' && '__throw' in val;
}

function mkArrayWithCount(items: unknown[], count?: number): unknown[] & { count: number } {
  const arr = [...items] as unknown[] & { count: number };
  Object.defineProperty(arr, 'count', { value: count ?? items.length, enumerable: false });
  return arr;
}

// All mock state must be created inside vi.hoisted so it's available when
// the vi.mock factory runs (factories are hoisted above imports).
const {
  returnQueue,
  sqlCalls,
  consume,
  mockBegin,
  mockLog,
  mockError,
} = vi.hoisted(() => {
  const returnQueue: unknown[] = [];
  const sqlCalls: Array<{ template: string; values: unknown[] }> = [];

  const consume = vi.fn((strings: TemplateStringsArray, ...values: unknown[]) => {
    sqlCalls.push({ template: strings.join('?'), values });
    const next = returnQueue.shift();
    if (next === undefined) {
      return Promise.resolve(mkArrayWithCount([], 0));
    }
    if (isThrowMarker(next)) {
      return Promise.reject(next.__throw);
    }
    if (Array.isArray(next)) {
      const arr = [...next] as unknown[] & { count?: number };
      const srcCount = (next as { count?: number }).count;
      if (!('count' in arr) || arr.count === undefined) {
        Object.defineProperty(arr, 'count', { value: srcCount ?? arr.length, enumerable: false });
      }
      return Promise.resolve(arr);
    }
    return Promise.resolve(next);
  });

  const mockBegin = vi.fn(async (cb: (tx: typeof consume) => Promise<unknown>) => {
    return cb(consume);
  });

  const mockLog = vi.fn();
  const mockError = vi.fn();

  return {
    returnQueue,
    sqlCalls,
    consume,
    mockBegin,
    mockLog,
    mockError,
  };
});

vi.mock('@/lib/db/server', () => ({
  sql: Object.assign(consume, { begin: mockBegin }),
}));

vi.mock('@/lib/shared/logger', () => ({
  toError: (value: unknown) => (value instanceof Error ? value : new Error(String(value))),
  logUnhandledPollError: () => () => {},
  createWorkerLogger: () => ({
    log: mockLog,
    warn: vi.fn(),
    error: mockError,
  }),
}));

import { runOnce } from '../EmailChannelReconcilePoller';

beforeEach(() => {
  returnQueue.length = 0;
  sqlCalls.length = 0;
  consume.mockClear();
  mockLog.mockClear();
  mockError.mockClear();
  mockBegin.mockClear();
  delete process.env.EMAIL_CHANNEL_RECONCILE_BATCH_SIZE;
});

describe('EmailChannelReconcilePoller — runOnce', () => {
  it('candidate query EXCLUDES archived rows (NOT EXISTS without archived_at filter)', async () => {
    returnQueue.push([]); // empty candidate set
    await runOnce();

    const candidatesCall = sqlCalls[0];
    expect(candidatesCall).toBeDefined();
    // Strip SQL line comments (-- ...) before regex matching — the human-
    // readable comment inside the NOT EXISTS block contains the word
    // "archived_at" intentionally, but it's not executed SQL.
    const text = candidatesCall!.template.replace(/--[^\n]*/g, '');

    // Critical regression guard from B16 finding #4 (refined as B17 #4):
    // The NOT EXISTS subquery must NOT filter on archived_at IS NULL —
    // otherwise an archived row would still appear "missing" and we'd
    // recreate it, silently resubscribing an unsubscribed owner.
    const notExistsBlock = text.match(/NOT EXISTS\s*\([\s\S]*?\)/);
    expect(notExistsBlock).not.toBeNull();
    expect(notExistsBlock![0]).not.toMatch(/archived_at/);

    // Defense-in-depth: confirm we DO join accounts and filter on subscription_status='active'.
    expect(text).toMatch(/subscription_status\s*=\s*'active'/);
    expect(text).toMatch(/role\s*=\s*'owner'/);
    expect(text).toMatch(/auth_id\s+IS\s+NOT\s+NULL/);
    // After migration 034: candidate query joins via users.account_id and accounts
    expect(text).toMatch(/u\.account_id/);
  });

  it('active business with NO email enrollment → SELECT then INSERT verified row with account_id', async () => {
    // Call order:
    // 1. candidate query → 1 candidate
    // 2. sql.begin → tx SELECT (existing check) → empty
    // 3. sql.begin → tx INSERT → succeeds (count=1)
    returnQueue.push([
      { business_id: 'biz-1', account_id: 'acct-1', owner_email: 'owner@example.com' },
    ]);
    returnQueue.push([]); // tx SELECT: no existing enrollment
    returnQueue.push(mkArrayWithCount([], 1)); // tx INSERT: 1 row inserted

    const result = await runOnce();

    expect(result.candidates).toBe(1);
    expect(result.inserted).toBe(1);
    expect(result.failed).toBe(0);

    // Verify sql.begin was called (transaction pattern)
    expect(mockBegin).toHaveBeenCalledTimes(1);

    // Find the INSERT call inside the transaction
    const insertCall = sqlCalls.find((c) =>
      c.template.includes('INSERT INTO channel_enrollments'),
    );
    expect(insertCall).toBeDefined();
    expect(insertCall!.template).toContain("'email'");
    expect(insertCall!.template).toContain("'verified'");
    // account_id included in INSERT (NOT NULL constraint added by migration 034)
    expect(insertCall!.values).toContain('acct-1');
    // NO ON CONFLICT — replaced with select-then-insert transaction
    expect(insertCall!.template).not.toContain('ON CONFLICT');
    expect(insertCall!.values).toContain('biz-1');
    expect(insertCall!.values).toContain('owner@example.com');

    // Find the SELECT call inside the transaction (existing check)
    const selectCall = sqlCalls.find((c) =>
      c.template.includes('SELECT id FROM channel_enrollments')
      && c.template.includes("channel = 'email'")
      && c.template.includes('archived_at IS NULL'),
    );
    expect(selectCall).toBeDefined();
    expect(selectCall!.values).toContain('biz-1');
  });

  it('active business with EXISTING active email enrollment → query yields 0 candidates, no INSERT', async () => {
    // The candidate query's NOT EXISTS rules out businesses with any email
    // enrollment row. Empty result simulates the production happy state.
    returnQueue.push([]);

    const result = await runOnce();

    expect(result.candidates).toBe(0);
    expect(result.inserted).toBe(0);

    const insertCall = sqlCalls.find((c) =>
      c.template.includes('INSERT INTO channel_enrollments'),
    );
    expect(insertCall).toBeUndefined();
    // sql.begin not called since no candidates to process
    expect(mockBegin).not.toHaveBeenCalled();
  });

  it('active business with ARCHIVED email enrollment → still excluded (no resubscribe)', async () => {
    // The candidate query's NOT EXISTS does NOT scope to archived_at IS NULL,
    // so archived rows still satisfy the EXISTS check and the business is
    // EXCLUDED from the candidates list. This is the regression guard for
    // B16 finding #4. Empty result here simulates that exclusion working.
    returnQueue.push([]);

    const result = await runOnce();

    expect(result.candidates).toBe(0);
    expect(result.inserted).toBe(0);

    // Anti-regression: the SQL template must NOT scope its EXISTS to
    // archived_at IS NULL.
    const candidatesCall = sqlCalls[0];
    expect(candidatesCall).toBeDefined();
    const stripped = candidatesCall!.template.replace(/--[^\n]*/g, '');
    const notExistsBlock = stripped.match(/NOT EXISTS\s*\([\s\S]*?\)/);
    expect(notExistsBlock).not.toBeNull();
    expect(notExistsBlock![0]).not.toMatch(/archived_at/);
  });

  it('SELECT finds existing enrollment → INSERT skipped (transaction select-then-insert)', async () => {
    returnQueue.push([
      { business_id: 'biz-2', account_id: 'acct-2', owner_email: 'owner2@example.com' },
    ]);
    // sql.begin → tx SELECT finds an existing row → skip INSERT
    returnQueue.push([{ id: 'existing-row-id' }]);

    const result = await runOnce();

    expect(result.candidates).toBe(1);
    expect(result.inserted).toBe(0); // not counted as inserted
    expect(result.failed).toBe(0); // not an error either

    // Verify sql.begin was called
    expect(mockBegin).toHaveBeenCalledTimes(1);

    // Verify SELECT was called inside the transaction
    const selectCall = sqlCalls.find((c) =>
      c.template.includes('SELECT id FROM channel_enrollments'),
    );
    expect(selectCall).toBeDefined();

    // Verify NO INSERT was issued
    const insertCall = sqlCalls.find((c) =>
      c.template.includes('INSERT INTO channel_enrollments'),
    );
    expect(insertCall).toBeUndefined();
  });

  it('concurrent INSERT race: 23505 caught as benign, counted as non-insert', async () => {
    returnQueue.push([
      { business_id: 'biz-3', account_id: 'acct-3', owner_email: 'owner3@example.com' },
    ]);
    // sql.begin → tx SELECT: empty (no existing enrollment found)
    returnQueue.push([]);
    // sql.begin → tx INSERT: throws 23505 unique violation
    // (concurrent writer won the race between our SELECT and INSERT)
    const uniqueViolation = new Error('unique violation') as Error & { code: string; constraint_name: string };
    uniqueViolation.code = '23505';
    uniqueViolation.constraint_name = 'channel_enrollments_account_channel_scope_uniq';
    returnQueue.push(throwMarker(uniqueViolation));

    const result = await runOnce();

    expect(result.candidates).toBe(1);
    expect(result.inserted).toBe(0); // not counted as inserted
    expect(result.failed).toBe(0); // 23505 is benign, not a failure
    // No error logged for 23505 races
    expect(mockError).not.toHaveBeenCalled();
  });

  it('INSERT throws non-23505 error → counted as failed, loop continues to next candidate', async () => {
    returnQueue.push([
      { business_id: 'biz-4', account_id: 'acct-4', owner_email: 'owner4@example.com' },
      { business_id: 'biz-5', account_id: 'acct-5', owner_email: 'owner5@example.com' },
    ]);
    // First candidate: sql.begin → tx SELECT empty → tx INSERT throws transient error
    returnQueue.push([]); // tx SELECT: no existing enrollment
    returnQueue.push(throwMarker(new Error('transient'))); // tx INSERT: throws
    // Second candidate: sql.begin → tx SELECT empty → tx INSERT succeeds
    returnQueue.push([]); // tx SELECT: no existing enrollment
    returnQueue.push(mkArrayWithCount([], 1)); // tx INSERT: 1 row inserted

    const result = await runOnce();

    expect(result.candidates).toBe(2);
    expect(result.failed).toBe(1);
    expect(result.inserted).toBe(1); // second candidate succeeded
    expect(mockError).toHaveBeenCalled();
  });

  it('uses sql.begin for transaction (not bare INSERT with ON CONFLICT)', async () => {
    returnQueue.push([
      { business_id: 'biz-6', account_id: 'acct-6', owner_email: 'owner6@example.com' },
    ]);
    returnQueue.push([]); // tx SELECT: no existing enrollment
    returnQueue.push(mkArrayWithCount([], 1)); // tx INSERT: 1 row inserted

    await runOnce();

    // The poller must use sql.begin() for the select-then-insert pattern
    expect(mockBegin).toHaveBeenCalledTimes(1);

    // Verify no ON CONFLICT in any SQL template (replaced with tx pattern)
    const allTemplates = sqlCalls.map((c) => c.template).join(' ');
    expect(allTemplates).not.toContain('ON CONFLICT');
  });
});
