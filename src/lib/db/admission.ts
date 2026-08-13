// Admission chokepoint for the shared Postgres clients (#773).
//
// THE INVARIANT: in-flight `sql` work per process never exceeds that client's
// connection pool. Excess callers QUEUE; they are never pipelined onto a busy
// connection.
//
// Why this has to exist at all — postgres.js has NO admission control. Its pool
// dispatcher (`node_modules/postgres/src/index.js` `handler()`) reaches for an
// `open` connection, then an unopened `closed` one, and if neither exists it
// takes a BUSY connection and writes the query onto it anyway
// (`go(busy.shift(), query)`). `connection.js` `execute()` writes to the socket
// unconditionally; its return value only decides whether the connection is
// marked `busy` (can take more) or `full`. Only `max_pipeline` (default 100)
// causes queueing, and that dial has no transaction-compatible value: 0 breaks
// every `sql.begin()` (the `sent.length < max_pipeline` short-circuit skips
// `onexecute`, the only hook that binds a transaction to its connection) and 1
// still admits two queries in flight, which wedged 6/6 on staging.
//
// The wedge that motivated this: a backend stuck in `state='active',
// wait_event='ClientRead'` with a growing age, self-clearing only when the
// Fluid Compute isolate is reaped (16.6s and 374.5s observed). Once one pool
// slot is stuck the route fails at concurrency 1 while the database itself is
// healthy (peak 25 of 57 sessions). `statement_timeout` never fires on it —
// ClientRead is a WAIT state, not a running statement.
//
// Bounding per-request fan-out is NOT sufficient and this module is not a
// substitute for it: the pool is per Fluid Compute ISOLATE and an isolate
// serves overlapping requests, so `/api/admin/flagged` wedged with a fan-out of
// TWO against a pool of THREE. Sequencing bounds one request; this bounds the
// isolate.
//
// Evidence: docs/runbooks/evidence/2026-08-13-773-vercel-capacity-decision.md.

import { AsyncLocalStorage } from 'node:async_hooks';
import type postgres from 'postgres';
import { readFlagEnabledByDefault } from '../config/flags';
import { createWorkerLogger } from '../shared/logger';

const logger = createWorkerLogger('db-admission');

/**
 * How long a caller may wait for a slot before failing.
 *
 * Matched to the shared client's 30s `statement_timeout`, on the principle that
 * no caller should wait longer for a slot than the longest legitimate query can
 * hold one. Past that, waiting is not congestion — it is a wedge, and failing
 * fast makes it observable instead of turning it into a hang. postgres.js
 * itself has no queue deadline; this is the whole reason to own the queue.
 */
const DB_SLOT_QUEUE_TIMEOUT_MS = 30_000;

/**
 * Server-only kill switch, default ON — the same default-on shape as
 * `LLM_CIRCUIT_BREAKER_ENABLED`. `DB_ADMISSION_ENABLED=false` reverts to raw
 * postgres.js dispatch on Railway without a redeploy. Never NEXT_PUBLIC
 * (invariant #13).
 */
const ADMISSION_ENABLED_ENV = 'DB_ADMISSION_ENABLED';

function isDbAdmissionEnabled(): boolean {
  return readFlagEnabledByDefault(ADMISSION_ENABLED_ENV);
}

/** A caller waited longer than the queue deadline for a connection slot. */
export class DbSlotTimeoutError extends Error {
  readonly clientName: string;
  readonly waitedMs: number;
  constructor(clientName: string, waitedMs: number) {
    super(
      `db admission: no '${clientName}' connection slot after ${waitedMs}ms — ` +
        'the pool is saturated or wedged (#773)',
    );
    this.name = 'DbSlotTimeoutError';
    this.clientName = clientName;
    this.waitedMs = waitedMs;
  }
}

export interface AdmissionStats {
  /** Slots currently held. Never exceeds `cap`. */
  inFlight: number;
  /** Callers queued for a slot. */
  waiting: number;
  cap: number;
  /** Slot acquisitions that failed the queue deadline. */
  timeouts: number;
  /**
   * Times a call made INSIDE a transaction bypassed the gate (see
   * `transactionSlot`). Expected to be 0; a non-zero value names a real
   * anti-pattern — work inside `sql.begin()` reaching the outer `sql` handle
   * instead of its `tx` handle, which runs OUTSIDE the transaction.
   */
  reentrantBypasses: number;
}

/**
 * Marks the async context of a transaction that already HOLDS a slot.
 *
 * This is what resolves the transaction-vs-query slot-counting subtlety. A
 * transaction takes ONE slot for its whole duration, because it holds one
 * connection for its whole duration. Queries issued on the `tx` handle inside
 * it are ungated by construction — postgres.js hands the callback a separate
 * scoped `Sql` with its own handler, which never reaches this module.
 *
 * The residual hazard is code inside a transaction reaching the OUTER `sql`
 * handle. Counted strictly, that would be a caller waiting for a slot while
 * holding one — a hard deadlock as soon as every slot is held by such a
 * transaction. So it bypasses the gate instead: it can never deadlock, it
 * over-subscribes by at most one per in-flight transaction (hard ceiling
 * 2 x cap), and it is counted and logged so the anti-pattern is visible rather
 * than silent.
 *
 * The store carries WHICH clients' slots are held, not a bare flag: `sql` and
 * `sqlRead` are separate pools, so a transaction on one must not exempt the
 * other from its own gate. Only the self-referential case — the deadlocking
 * one — bypasses.
 */
const transactionSlot = new AsyncLocalStorage<ReadonlySet<string>>();

interface Waiter {
  resolve(release: () => void): void;
  reject(error: Error): void;
  timer: NodeJS.Timeout;
  queuedAtMs: number;
}

class AdmissionGate {
  private inFlight = 0;
  private timeouts = 0;
  private reentrantBypasses = 0;
  private warnedReentrant = false;
  private readonly waiters: Waiter[] = [];

  constructor(
    readonly clientName: string,
    readonly cap: number,
    private readonly queueTimeoutMs: number,
  ) {}

  get stats(): AdmissionStats {
    return {
      inFlight: this.inFlight,
      waiting: this.waiters.length,
      cap: this.cap,
      timeouts: this.timeouts,
      reentrantBypasses: this.reentrantBypasses,
    };
  }

  /** True when the caller already holds a slot on THIS client. */
  holdsSlot(): boolean {
    return transactionSlot.getStore()?.has(this.clientName) === true;
  }

  /** The store to run a transaction body under: held clients plus this one. */
  heldWithSelf(): ReadonlySet<string> {
    const current = transactionSlot.getStore();
    return current ? new Set([...current, this.clientName]) : new Set([this.clientName]);
  }

  countBypass(): void {
    this.reentrantBypasses += 1;
    if (!this.warnedReentrant) {
      this.warnedReentrant = true;
      // Warn ONCE per process: a hot path doing this would otherwise flood the
      // log. The running total stays available in `stats`.
      logger.warn('db admission: query issued on the outer sql handle inside a transaction', {
        client: this.clientName,
        detail: 'runs OUTSIDE the transaction and bypasses admission control — use the tx handle',
      });
    }
  }

  acquire(): Promise<() => void> {
    if (this.inFlight < this.cap) {
      this.inFlight += 1;
      return Promise.resolve(this.makeRelease());
    }
    return new Promise<() => void>((resolve, reject) => {
      const queuedAtMs = Date.now();
      const timer = setTimeout(() => {
        const index = this.waiters.indexOf(waiter);
        if (index !== -1) this.waiters.splice(index, 1);
        this.timeouts += 1;
        logger.error('db admission: slot wait timed out', {
          client: this.clientName,
          waitedMs: Date.now() - queuedAtMs,
          cap: this.cap,
          waiting: this.waiters.length,
        });
        reject(new DbSlotTimeoutError(this.clientName, Date.now() - queuedAtMs));
      }, this.queueTimeoutMs);
      // An idle queue must never hold the process open (worker shutdown, and
      // vitest teardown).
      timer.unref?.();
      const waiter: Waiter = { resolve, reject, timer, queuedAtMs };
      this.waiters.push(waiter);
    });
  }

  /**
   * Idempotent release. Hands the slot DIRECTLY to the next waiter rather than
   * decrementing and re-incrementing, so `inFlight` can never dip below the cap
   * while callers are queued (and no third party can steal the slot in the gap).
   */
  private makeRelease(): () => void {
    let released = false;
    return () => {
      if (released) return;
      released = true;
      const next = this.waiters.shift();
      if (next) {
        clearTimeout(next.timer);
        next.resolve(this.makeRelease());
        return;
      }
      this.inFlight -= 1;
    };
  }
}

const gates = new WeakMap<object, AdmissionGate>();

/** Admission stats for a gated client. `undefined` when the client is ungated. */
export function admissionStats(client: object): AdmissionStats | undefined {
  return gates.get(client)?.stats;
}

/**
 * The parts of a postgres.js `Query` this module touches.
 *
 * `Query` is LAZY: the constructor stores `handler` and dispatch happens only
 * in `handle()`, which `then`/`catch`/`finally`/`forEach`/`cursor`/`execute`
 * call. That is the seam — replacing `handler` on the instance delays dispatch
 * without changing anything else about the object, so chaining (`.raw()`,
 * `.values()`, `.simple()`, `.describe()`) keeps working on the SAME instance.
 */
interface QueryLike {
  handler: ((query: QueryLike) => void) & { debug?: unknown };
  reject(error: unknown): void;
  handle(): unknown;
  execute(): unknown;
  cursor?: unknown;
}

function isQueryLike(value: unknown): value is QueryLike {
  if (typeof value !== 'object' || value === null) return false;
  const candidate = value as Partial<QueryLike>;
  return (
    typeof candidate.handle === 'function' &&
    typeof candidate.execute === 'function' &&
    typeof candidate.handler === 'function'
  );
}

/**
 * Gate one lazy query. Returns the SAME object — `sql('table')` /
 * `sql(obj, 'a', 'b')` return an Identifier/Builder instead of a Query and are
 * passed through untouched by the caller's `isQueryLike` check.
 */
function gateQuery(query: QueryLike, gate: AdmissionGate): QueryLike {
  const dispatch = query.handler;

  const gated = ((pending: QueryLike) => {
    if (gate.holdsSlot()) {
      gate.countBypass();
      dispatch(pending);
      return;
    }
    gate.acquire().then(
      (release) => {
        // Observe settlement WITHOUT re-entering Query.then (which would call
        // handle() again — guarded, but this is the honest way to do it):
        // handle() has already run, we are inside it. Passing `release` as both
        // handlers means the derived promise always fulfils, so a rejected
        // query cannot produce an unhandled rejection here.
        Promise.prototype.then.call(pending as unknown as Promise<unknown>, release, release);
        dispatch(pending);
      },
      (error: Error) => {
        pending.reject(error);
      },
    );
  }) as QueryLike['handler'];
  // `Query.origin` reads `handler.debug`; keep it.
  gated.debug = dispatch.debug;
  query.handler = gated;

  // `cursor()` re-assigns `resolve`/`reject` on EVERY iterator step and never
  // settles the Query promise, so there is no settlement to release on — a
  // cursor through this gate would leak its slot permanently. There are zero
  // cursor call sites in this codebase; fail loudly rather than leak silently.
  query.cursor = () => {
    throw new Error(
      'db admission: .cursor() is not supported through the admission gate ' +
        '(no settlement to release the slot on) — see src/lib/db/admission.ts',
    );
  };

  return query;
}

export interface AdmissionOptions {
  /**
   * Slot ceiling. Pass the client's own pool `max`: cap == pool is EXACTLY the
   * no-pipelining condition, because with N <= max in flight postgres.js always
   * finds an `open` or `closed` connection and never falls through to
   * `go(busy.shift(), query)`.
   */
  cap: number;
  /** Name used in errors, logs and stats. */
  clientName: string;
  queueTimeoutMs?: number;
}

/**
 * Wrap a postgres.js client so every top-level query, transaction and
 * reservation takes one slot for its duration.
 *
 * Applied to the shared singletons in `src/lib/db/server.ts` rather than at
 * call sites: `src/app/**` alone has 153 files importing `sql` directly, so a
 * per-call-site helper has no enforceable coverage. The wrapper is transparent
 * — same type, same laziness, same chaining — so no caller changes.
 *
 * NOT gated (deliberate, none has a production call site): `listen`/`subscribe`
 * take their own dedicated connection outside the pool, and `notify` runs on
 * the raw client's internal handle.
 */
export function withAdmissionControl<T extends postgres.Sql>(client: T, options: AdmissionOptions): T {
  if (!isDbAdmissionEnabled()) {
    logger.warn('db admission DISABLED by env — pool over-subscription is unbounded', {
      client: options.clientName,
      env: ADMISSION_ENABLED_ENV,
    });
    return client;
  }

  const gate = new AdmissionGate(
    options.clientName,
    options.cap,
    options.queueTimeoutMs ?? DB_SLOT_QUEUE_TIMEOUT_MS,
  );

  type QueryFactory = (...args: unknown[]) => unknown;

  // Resolved on FIRST ACCESS, not at wrap time, and memoized so
  // `sql.unsafe === sql.unsafe` still holds and vi.spyOn keeps working. Lazy
  // because a test that mocks the `postgres` module hands us a client without
  // these methods, and merely constructing the wrapper must not throw.
  const wrappedFactories = new Map<string, unknown>();
  const queryFactory = (prop: string): unknown => {
    const memoized = wrappedFactories.get(prop);
    if (memoized) return memoized;
    const original = Reflect.get(client, prop) as unknown;
    if (typeof original !== 'function') return original;
    const wrapper = (...args: unknown[]): unknown => {
      const result = (original as QueryFactory).apply(client, args);
      return isQueryLike(result) ? gateQuery(result, gate) : result;
    };
    wrappedFactories.set(prop, wrapper);
    return wrapper;
  };

  const gatedBegin = (...args: unknown[]): unknown => {
    const rawBegin = client.begin.bind(client) as (...a: unknown[]) => Promise<unknown>;
    // A nested `sql.begin()` inside a transaction is a savepoint in postgres.js
    // only when taken on the `tx` handle; on the outer handle it is a SECOND
    // connection. Either way the caller already holds a slot — bypass, never
    // wait on ourselves.
    if (gate.holdsSlot()) {
      gate.countBypass();
      return rawBegin(...args);
    }
    return (async () => {
      const release = await gate.acquire();
      try {
        // The store must be established BEFORE `begin` starts, so every async
        // continuation inside the transaction callback inherits it.
        return await transactionSlot.run(gate.heldWithSelf(), () => rawBegin(...args));
      } finally {
        release();
      }
    })();
  };

  const gatedReserve = async (): Promise<unknown> => {
    const rawReserve = client.reserve.bind(client);
    if (gate.holdsSlot()) {
      gate.countBypass();
      return rawReserve();
    }
    const release = await gate.acquire();
    let reserved: Awaited<ReturnType<postgres.Sql['reserve']>>;
    try {
      reserved = await rawReserve();
    } catch (error) {
      release();
      throw error;
    }
    const rawRelease = reserved.release.bind(reserved);
    let done = false;
    reserved.release = () => {
      if (done) return;
      done = true;
      try {
        rawRelease();
      } finally {
        release();
      }
    };
    return reserved;
  };

  const proxy = new Proxy(client, {
    apply(target, thisArg, argArray) {
      const result = Reflect.apply(
        target as unknown as (...a: unknown[]) => unknown,
        thisArg,
        argArray,
      );
      return isQueryLike(result) ? gateQuery(result, gate) : result;
    },
    get(target, prop) {
      if (prop === 'begin') return gatedBegin;
      if (prop === 'reserve') return gatedReserve;
      if (prop === 'unsafe' || prop === 'file') return queryFactory(prop);
      // Read from the TARGET, not the proxy — a getter must not re-enter this
      // trap.
      return Reflect.get(target, prop);
    },
  }) as T;

  gates.set(proxy, gate);
  return proxy;
}
