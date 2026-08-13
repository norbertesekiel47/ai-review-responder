// #773 admission chokepoint: in-flight work per client never exceeds the pool.
//
// The discriminator is the same one used by
// `src/lib/admin/__tests__/admin-read-single-inflight.test.ts`: hold queries
// PENDING and count how many reached the pool dispatcher. Without the gate
// every query dispatches on creation, so each cap assertion here fails.
//
// The fake client below mirrors the parts of postgres.js the gate actually
// touches — a LAZY `Query` that stores its `handler` and dispatches only from
// `handle()` (via then/catch/finally/execute). Fidelity of that contract is
// what `admission.integration.test.ts` proves against a real database; a mock
// alone cannot (the `max_pipeline: 0` regression was invisible to mocks).

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type postgres from 'postgres';
import {
  DbSlotTimeoutError,
  admissionStats,
  withAdmissionControl,
} from '../admission';

// --- fake postgres.js client ------------------------------------------------

interface Dispatched {
  sql: string;
  resolve(rows: unknown): void;
  reject(error: unknown): void;
}

class FakeQuery extends Promise<unknown> {
  handler!: ((query: FakeQuery) => void) & { debug?: unknown };
  declare resolve: (rows: unknown) => void;
  declare reject: (error: unknown) => void;
  text = '';
  private executed = false;

  static get [Symbol.species](): PromiseConstructor {
    return Promise;
  }

  // Mirrors postgres.js query.js: dispatch happens once, on a microtask.
  async handle(): Promise<void> {
    if (this.executed) return;
    this.executed = true;
    await 1;
    this.handler(this);
  }

  execute(): this {
    void this.handle();
    return this;
  }

  override then<A, B>(
    onFulfilled?: ((value: unknown) => A | PromiseLike<A>) | null,
    onRejected?: ((reason: unknown) => B | PromiseLike<B>) | null,
  ): Promise<A | B> {
    void this.handle();
    return super.then(onFulfilled, onRejected);
  }

  override catch<B>(onRejected?: ((reason: unknown) => B | PromiseLike<B>) | null): Promise<unknown> {
    void this.handle();
    return super.catch(onRejected);
  }

  override finally(onFinally?: (() => void) | null): Promise<unknown> {
    void this.handle();
    return super.finally(onFinally);
  }

  cursor(): unknown {
    return {};
  }
}

interface FakeClient {
  client: postgres.Sql;
  /** Queries that reached the POOL dispatcher, in order. */
  dispatched: Dispatched[];
  /** Queries issued on a transaction's own handle — never pool-dispatched. */
  txQueries: string[];
  /** Resolve the transaction body currently awaiting `txLatch`. */
  releaseTx(): void;
}

function createFakeClient(): FakeClient {
  const dispatched: Dispatched[] = [];
  const txQueries: string[] = [];
  let releaseTxLatch: (() => void) | undefined;

  function poolHandler(query: FakeQuery): void {
    dispatched.push({
      sql: query.text,
      resolve: (rows) => query.resolve(rows),
      reject: (error) => query.reject(error),
    });
  }

  function makeQuery(text: string): FakeQuery {
    let resolve!: (rows: unknown) => void;
    let reject!: (error: unknown) => void;
    const query = new FakeQuery((res, rej) => {
      resolve = res;
      reject = rej;
    });
    query.text = text;
    query.resolve = resolve;
    query.reject = reject;
    query.handler = poolHandler;
    return query;
  }

  function tag(strings: TemplateStringsArray | string, ...args: unknown[]): unknown {
    if (typeof strings === 'string' && args.length === 0) {
      // postgres.js returns an Identifier here, not a Query.
      return { identifier: strings };
    }
    return makeQuery(Array.isArray(strings) ? strings.join('?') : String(strings));
  }

  const client = Object.assign(tag, {
    unsafe: (text: string) => makeQuery(text),
    file: (path: string) => makeQuery(path),
    // Slot accounting is what is under test, so the fake skips the real
    // BEGIN/COMMIT round trips: both run on postgres.js's own internal handle
    // and are ungated in production too. What matters is that the callback gets
    // a SEPARATE handle whose queries never reach the pool dispatcher.
    begin: async (fn: (tx: unknown) => Promise<unknown>) => {
      const tx = (strings: TemplateStringsArray) => {
        txQueries.push(strings.join('?'));
        return Promise.resolve([]);
      };
      const gate = new Promise<void>((resolve) => {
        releaseTxLatch = resolve;
      });
      const result = await fn(tx);
      await gate;
      return result;
    },
    reserve: async () => ({ release: () => {} }),
    options: { max: 3 },
    json: (value: unknown) => value,
    end: async () => {},
  }) as unknown as postgres.Sql;

  return {
    client,
    dispatched,
    txQueries,
    releaseTx: () => releaseTxLatch?.(),
  };
}

/** Let every pending microtask and one macrotask turn run. */
async function settleTurn(): Promise<void> {
  await new Promise((resolve) => {
    setTimeout(resolve, 0);
  });
}

// --- tests ------------------------------------------------------------------

// Restored rather than deleted after each case, so a red check run with
// DB_ADMISSION_ENABLED=false in the environment stays ungated for the WHOLE
// file instead of only its first test.
const ADMISSION_ENV_AT_LOAD = process.env.DB_ADMISSION_ENABLED;

describe('db admission chokepoint (#773)', () => {
  beforeEach(() => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
    if (ADMISSION_ENV_AT_LOAD === undefined) delete process.env.DB_ADMISSION_ENABLED;
    else process.env.DB_ADMISSION_ENABLED = ADMISSION_ENV_AT_LOAD;
  });

  it('never dispatches more queries than the cap, however many callers there are', async () => {
    const fake = createFakeClient();
    const sql = withAdmissionControl(fake.client, { cap: 3, clientName: 'test' });

    const pending = Array.from({ length: 9 }, () => sql`SELECT 1`.catch(() => {}));
    await settleTurn();

    expect(fake.dispatched).toHaveLength(3);
    expect(admissionStats(sql)).toMatchObject({ inFlight: 3, waiting: 6, cap: 3 });

    // Drain in order. Each release admits exactly one more, so dispatched minus
    // settled — the true in-flight count — never crosses the cap.
    let settled = 0;
    for (let i = 0; i < 9; i += 1) {
      while (fake.dispatched.length <= i) await settleTurn();
      expect(fake.dispatched.length - settled).toBeLessThanOrEqual(3);
      fake.dispatched[i]!.resolve([]);
      settled += 1;
      await settleTurn();
    }

    await Promise.all(pending);
    expect(fake.dispatched).toHaveLength(9);
    expect(admissionStats(sql)).toMatchObject({ inFlight: 0, waiting: 0 });
  });

  it('a rejected query releases its slot', async () => {
    const fake = createFakeClient();
    const sql = withAdmissionControl(fake.client, { cap: 1, clientName: 'test' });

    const first = sql`SELECT 1`.catch(() => 'rejected');
    const second = sql`SELECT 2`.catch(() => {});
    await settleTurn();
    expect(fake.dispatched).toHaveLength(1);

    fake.dispatched[0]!.reject(new Error('boom'));
    await expect(first).resolves.toBe('rejected');
    await settleTurn();

    expect(fake.dispatched).toHaveLength(2);
    fake.dispatched[1]!.resolve([]);
    await second;
  });

  it('a transaction holds ONE slot for its whole duration, not one per query', async () => {
    const fake = createFakeClient();
    const sql = withAdmissionControl(fake.client, { cap: 2, clientName: 'test' });

    const tx = sql.begin(async (t: postgres.TransactionSql) => {
      await t`INSERT INTO a VALUES (1)`;
      await t`INSERT INTO b VALUES (2)`;
      await t`INSERT INTO c VALUES (3)`;
      return 'committed';
    });

    const queries = [sql`SELECT 1`.catch(() => {}), sql`SELECT 2`.catch(() => {})];
    await settleTurn();

    // Cap 2, one slot held by the transaction → exactly one query admitted.
    expect(fake.dispatched).toHaveLength(1);
    // Three statements ran inside the transaction and consumed NO pool slots.
    expect(fake.txQueries).toHaveLength(3);
    expect(admissionStats(sql)).toMatchObject({ inFlight: 2, waiting: 1 });

    fake.releaseTx();
    await expect(tx).resolves.toBe('committed');
    await settleTurn();

    expect(fake.dispatched).toHaveLength(2);
    for (const query of fake.dispatched) query.resolve([]);
    await Promise.all(queries);
  });

  it('work inside a transaction that reaches the outer handle bypasses instead of deadlocking', async () => {
    const fake = createFakeClient();
    // Cap 1 is the deadlock shape in miniature: the only slot is held by the
    // transaction, and the transaction then wants another one.
    const sql = withAdmissionControl(fake.client, { cap: 1, clientName: 'test' });

    let escaped: unknown;
    const tx = sql.begin(async () => {
      escaped = await sql`SELECT outer_handle`;
      return 'committed';
    });

    await settleTurn();
    expect(fake.dispatched).toHaveLength(1);
    expect(fake.dispatched[0]!.sql).toContain('outer_handle');
    expect(admissionStats(sql)?.reentrantBypasses).toBe(1);

    fake.dispatched[0]!.resolve(['row']);
    await settleTurn();
    fake.releaseTx();

    await expect(tx).resolves.toBe('committed');
    expect(escaped).toEqual(['row']);
  });

  it('fails a caller that waits past the queue deadline instead of hanging', async () => {
    const fake = createFakeClient();
    const sql = withAdmissionControl(fake.client, {
      cap: 1,
      clientName: 'test',
      queueTimeoutMs: 25,
    });

    const first = sql`SELECT 1`.catch(() => {});
    const starved = sql`SELECT 2`;

    await expect(starved).rejects.toBeInstanceOf(DbSlotTimeoutError);
    expect(admissionStats(sql)).toMatchObject({ timeouts: 1, waiting: 0 });
    // The timed-out caller never reached the pool.
    expect(fake.dispatched).toHaveLength(1);

    fake.dispatched[0]!.resolve([]);
    await first;
  });

  it('passes identifiers and builders through untouched', () => {
    const fake = createFakeClient();
    const sql = withAdmissionControl(fake.client, { cap: 3, clientName: 'test' });

    expect(sql('reviews')).toEqual({ identifier: 'reviews' });
  });

  it('gates sql.unsafe the same as a tagged query', async () => {
    const fake = createFakeClient();
    const sql = withAdmissionControl(fake.client, { cap: 1, clientName: 'test' });

    const first = sql.unsafe('SELECT 1').catch(() => {});
    const second = sql.unsafe('SELECT 2').catch(() => {});
    await settleTurn();

    expect(fake.dispatched).toHaveLength(1);
    fake.dispatched[0]!.resolve([]);
    await settleTurn();
    expect(fake.dispatched).toHaveLength(2);
    fake.dispatched[1]!.resolve([]);
    await Promise.all([first, second]);
  });

  it('rejects .cursor() rather than leaking the slot it could never release', () => {
    const fake = createFakeClient();
    const sql = withAdmissionControl(fake.client, { cap: 3, clientName: 'test' });

    expect(() => (sql`SELECT 1` as unknown as { cursor(): unknown }).cursor()).toThrow(
      /cursor\(\) is not supported/,
    );
  });

  it('returns the client untouched when the kill switch is off', () => {
    process.env.DB_ADMISSION_ENABLED = 'false';
    const fake = createFakeClient();
    const sql = withAdmissionControl(fake.client, { cap: 3, clientName: 'test' });

    expect(sql).toBe(fake.client);
    expect(admissionStats(sql)).toBeUndefined();
  });
});
