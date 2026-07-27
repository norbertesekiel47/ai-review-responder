// Shared Postgres.js mock + worker-logger mock for worker unit suites.
//
// NOT a test file: the vitest include glob only matches `**/__tests__/**/*.test.{ts,tsx}`,
// so this helper is invisible to the runner and only ever loaded by suites
// that import it.
//
// Because `vi.hoisted` executes before static imports are initialized, consumers
// must construct the harness via a dynamic import inside an async hoisted block:
//
//   const { mockSql, sqlReturnQueue, sqlCalls, resetMockSql } = await vi.hoisted(async () => {
//     const { createMockSql } = await import('../../../__tests__/helpers/mock-sql');
//     return { ...createMockSql() };
//   });
//   vi.mock('../../../../src/lib/db/server', () => ({ sql: mockSql }));

import { vi, type Mock } from 'vitest';

/** One awaited query, with nested fragments flattened into the parent text. */
export interface RecordedSqlCall {
  /** Query text with every bound value replaced by `?`. */
  text: string;
  /** Bound values in placeholder order (nested-fragment values inlined). */
  values: unknown[];
  /** True when the query was awaited inside a `sql.begin(...)` callback. */
  inTransaction: boolean;
}

interface MockQueryFragment {
  __mockSqlFragment: true;
  text: string;
  values: unknown[];
  then: (
    resolve: (value: unknown) => unknown,
    reject?: (reason: unknown) => unknown,
  ) => Promise<unknown>;
}

export type MockSql = Mock<(strings: TemplateStringsArray, ...values: unknown[]) => MockQueryFragment> & {
  begin: Mock<(
    optionsOrCallback: string | ((tx: unknown) => Promise<unknown>),
    callback?: (tx: unknown) => Promise<unknown>,
  ) => Promise<unknown>>;
  /**
   * Stand-in for Postgres.js's `sql.json(value)` (real behavior: tags the
   * value as a JSONB-typed bind parameter, serialized exactly once).
   * Identity pass-through here — tests assert on the plain object the
   * production code builds, not on any wire encoding.
   */
  json: Mock<(value: unknown) => unknown>;
};

export interface MockSqlHarness {
  /**
   * Tagged-template mock standing in for the Postgres.js `sql` client.
   * `mockSql.mock.calls` records every invocation as `[strings, ...values]`
   * (including unawaited nested fragments); use `sqlCalls` for the awaited,
   * fragment-flattened view.
   */
  mockSql: MockSql;
  /**
   * FIFO of results for awaited queries. Push tagged count arrays
   * (`mkTaggedResult`), plain row arrays, or a (pre-handled) rejected Promise
   * to simulate a query failure. An empty queue yields `[] & { count: 0 }`.
   */
  sqlReturnQueue: unknown[];
  /** Awaited queries in execution order, as `{ text, values, inTransaction }`. */
  sqlCalls: RecordedSqlCall[];
  /**
   * True while a `sql.begin(...)` callback is in flight. `sqlCalls` already
   * carries this per query; call it from a mocked collaborator (a run-spine
   * writer, an audit-log writer) to assert that collaborator ran inside the
   * SAME transaction as the state change — invariant #2's actual claim.
   */
  isInTransaction: () => boolean;
  /** Clears `sqlReturnQueue` + `sqlCalls` (call in `beforeEach`). */
  resetMockSql: () => void;
}

/**
 * Postgres.js result arrays carry a `count` property (rows affected).
 * Mutates and returns `rows` so identity-based assertions keep working.
 */
export function mkTaggedResult<T>(rows: T[]): T[] & { count: number } {
  return Object.assign(rows, { count: rows.length });
}

/**
 * Fragment-aware Postgres.js mock.
 *
 * Mirrors real Postgres.js semantics: sql`` returns a LAZY thenable, so a
 * nested fragment (e.g. a conditional `sql\`AND …\`` / `sql\`\`` filter)
 * composes into the parent query's text without executing or consuming the
 * return queue. Only awaited queries record into `sqlCalls` and shift
 * `sqlReturnQueue`.
 *
 * Caveat (unlike real Postgres.js): fragments are await-once — awaiting the
 * same fragment twice re-executes it (records again and shifts the queue again).
 *
 * `sql.begin(cb)` and `sql.begin(options, cb)` invoke `cb` with the same mock,
 * so transactional code paths share the one queue and call log. The options
 * argument remains visible in `mockSql.begin.mock.calls` for isolation-mode
 * assertions, and every call awaited while `cb` is in flight records
 * `inTransaction: true` — which is what distinguishes "written in the same
 * transaction as the state change" from "written next to it".
 */
export function createMockSql(): MockSqlHarness {
  const sqlReturnQueue: unknown[] = [];
  const sqlCalls: RecordedSqlCall[] = [];
  let openTransactions = 0;
  const isInTransaction = () => openTransactions > 0;

  const isFragment = (value: unknown): value is MockQueryFragment =>
    Boolean(value && typeof value === 'object' && (value as MockQueryFragment).__mockSqlFragment);

  const taggedTemplate = vi.fn((strings: TemplateStringsArray, ...values: unknown[]): MockQueryFragment => {
    let text = strings[0] ?? '';
    const flatValues: unknown[] = [];
    for (let i = 0; i < values.length; i++) {
      const value = values[i];
      if (isFragment(value)) {
        text += value.text;
        flatValues.push(...value.values);
      } else {
        text += '?';
        flatValues.push(value);
      }
      text += strings[i + 1] ?? '';
    }
    return {
      __mockSqlFragment: true,
      text,
      values: flatValues,
      then(resolve, reject) {
        sqlCalls.push({ text, values: flatValues, inTransaction: isInTransaction() });
        const queued = sqlReturnQueue.shift();
        const result = queued !== undefined ? queued : mkTaggedResult([]);
        return Promise.resolve(result).then(resolve, reject);
      },
    };
  });

  const mockSql = taggedTemplate as MockSql;
  mockSql.begin = vi.fn(async (
    optionsOrCallback: string | ((tx: unknown) => Promise<unknown>),
    callback?: (tx: unknown) => Promise<unknown>,
  ) => {
    const transactionCallback = typeof optionsOrCallback === 'function'
      ? optionsOrCallback
      : callback;
    if (!transactionCallback) throw new Error('mock sql.begin requires a callback');
    openTransactions++;
    try {
      return await transactionCallback(mockSql);
    } finally {
      openTransactions--;
    }
  });
  mockSql.json = vi.fn((value: unknown) => value);

  return {
    mockSql,
    sqlReturnQueue,
    sqlCalls,
    isInTransaction,
    resetMockSql: () => {
      sqlReturnQueue.length = 0;
      sqlCalls.length = 0;
    },
  };
}

export interface MockWorkerLogger {
  log: Mock;
  warn: Mock;
  error: Mock;
}

/**
 * Stand-in for a `createWorkerLogger` logger. Wire it up in a module mock:
 *
 *   vi.mock('../../../../src/lib/shared/logger', () => ({
 *     createWorkerLogger: () => mockLogger,
 *   }));
 */
export function mockWorkerLogger(): MockWorkerLogger {
  return { log: vi.fn(), warn: vi.fn(), error: vi.fn() };
}
