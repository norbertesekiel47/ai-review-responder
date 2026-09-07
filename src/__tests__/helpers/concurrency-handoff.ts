// Bounded, self-describing waits for live-DB concurrency suites (#889).
//
// A concurrency suite orchestrates a deliberate interleaving: an operation is
// started, a mocked call inside it resolves a deferred to signal "I am now
// holding the lock", the test body reacts, and finally the operation is
// awaited. Every one of those waits is a bare `await somePromise` today, so
// when the operation returns early, rejects, or blocks, the test parks and
// vitest reports only the suite timeout — "30015ms", with no reason. #889 is
// exactly that failure, and it survived three architecture passes precisely
// because the red carried no information.
//
// `startStage` is called WHEN THE OPERATION IS CREATED, not when the test first
// awaits it. That matters: the existing suites create a publisher, then sleep
// 200ms and assert, and only then await. A watchdog started at the await would
// already be behind the server-side `statement_timeout` clock, and a cancelled
// statement would reject the wait before the watchdog could collect evidence.
//
// The module is deliberately DB-free so its own failure paths are unit-tested
// without a database (`concurrency-handoff.test.ts`). The caller supplies the
// diagnostic dump through `diagnose`.
//
// Budget arithmetic has NO positive floor. A stage that starts with its reserve
// already spent fails at once rather than waiting a "minimum" it does not have.

/** Default share of the test budget held back for teardown. */
const DEFAULT_RESERVE_MS = 3_000;

/**
 * Default watchdog ceiling. Deliberately BELOW the 10s `statement_timeout` the
 * live suites put on their clients: the watchdog plus its diagnostic budget
 * must both finish before Postgres cancels a blocked statement, or the wait
 * rejects with a bare cancellation and the dump is never collected.
 */
const DEFAULT_MAX_WAIT_MS = 6_000;

/** Default wall clock for one `diagnose()` call. */
const DEFAULT_DIAGNOSE_MS = 2_000;

/** Longest sanitized peer-value snapshot embedded in an error message. */
const MAX_SNAPSHOT_CHARS = 500;

export interface StartStageOptions {
  /** Remaining test budget at the moment the operation starts. */
  budgetMs: number;
  /** Held back for teardown. Default 3_000. */
  reserveMs?: number;
  /** Watchdog ceiling. Default 6_000. */
  maxWaitMs?: number;
  /** Wall clock for one `diagnose()` call. Default 2_000. */
  diagnoseMs?: number;
  /** Collects a diagnostic dump. Its failure never replaces the real error. */
  diagnose?: (label: string) => Promise<string>;
  /**
   * Other in-flight promises whose early settlement means this stage will never
   * be reached. Each is handled at registration so racing it cannot surface as
   * an unhandled rejection.
   */
  peers?: readonly Promise<unknown>[];
  /** Clock seam for tests. Defaults to `Date.now`. */
  now?: () => number;
}

export interface Stage<T> {
  readonly name: string;
  /**
   * Waits for a handoff signal — the deferred a mocked call resolves from
   * inside the operation. Rejects with a named error when the operation (or any
   * registered peer) settles first, which is the lost-wakeup shape.
   */
  awaitHandoff(label: string, target: Promise<void>): Promise<void>;
  /** Waits for the operation itself, returning its value. */
  awaitSettled(): Promise<T>;
}

/**
 * True for a Postgres cancellation — SQLSTATE 57014 `query_canceled`, which
 * covers `statement_timeout` and `pg_cancel_backend`.
 *
 * A cancellation is NOT itself proof of a lock wait. It is the one rejection
 * class worth a dump, because the dump is what says whether a lock wait caused
 * it. Every other rejection is rethrown untouched.
 */
function isQueryCanceled(error: unknown): boolean {
  if (typeof error !== 'object' || error === null) return false;
  const code = (error as { code?: unknown }).code;
  if (code === '57014') return true;
  const message = (error as { message?: unknown }).message;
  return typeof message === 'string' && /canceling statement|statement timeout/i.test(message);
}

/**
 * A short, safe rendering of a peer's resolved value for an error message.
 * Never throws: a cycle, a BigInt, or a getter that blows up degrades to a
 * placeholder rather than masking the failure we are trying to report.
 */
function snapshot(value: unknown): string {
  let text: string;
  try {
    text = JSON.stringify(value, (_key, inner: unknown) =>
      (typeof inner === 'bigint' ? String(inner) : inner));
  } catch {
    return '<unserializable>';
  }
  if (text === undefined) return String(value);
  return text.length > MAX_SNAPSHOT_CHARS ? `${text.slice(0, MAX_SNAPSHOT_CHARS)}…` : text;
}

interface Timer {
  promise: Promise<'timeout'>;
  cancel: () => void;
}

/** A cancellable delay. The losing timer is always cleared by the caller. */
function timer(ms: number): Timer {
  let handle: ReturnType<typeof setTimeout> | undefined;
  const promise = new Promise<'timeout'>((resolve) => {
    handle = setTimeout(() => resolve('timeout'), ms);
  });
  return { promise, cancel: () => { if (handle !== undefined) clearTimeout(handle); } };
}

export function startStage<T>(
  name: string,
  operation: Promise<T>,
  options: StartStageOptions,
): Stage<T> {
  const now = options.now ?? Date.now;
  const reserveMs = options.reserveMs ?? DEFAULT_RESERVE_MS;
  const maxWaitMs = options.maxWaitMs ?? DEFAULT_MAX_WAIT_MS;
  const peers = options.peers ?? [];

  // Handled at registration: a peer that loses a race would otherwise reject
  // with no handler attached. `Promise.race` handles its own participants, so
  // this covers only the races a given peer sits out.
  operation.catch(() => {});
  for (const peer of peers) peer.catch(() => {});

  const usableMs = options.budgetMs - reserveMs;
  if (usableMs <= 0) {
    throw new Error(
      `${name}: test budget exhausted before the stage began ` +
      `(budgetMs=${options.budgetMs}, reserveMs=${reserveMs})`,
    );
  }

  const waitMs = Math.min(usableMs, maxWaitMs);
  const diagnoseMs = Math.min(options.diagnoseMs ?? DEFAULT_DIAGNOSE_MS, usableMs - waitMs);
  // The watchdog clock starts HERE — at operation start, not at the first await.
  const deadlineAt = now() + waitMs;

  /**
   * Runs `diagnose` under its own wall clock. Returns a note instead of the
   * dump when there was no budget, when it failed, or when it overran: the
   * point of the dump is to replace a silent hang, never to add one.
   */
  async function collect(label: string): Promise<string> {
    if (options.diagnose === undefined) return 'no diagnostic collector configured';
    if (diagnoseMs <= 0) return 'diagnostics unavailable: no budget left for collection';
    const clock = timer(diagnoseMs);
    try {
      const outcome = await Promise.race([
        options.diagnose(label).then((dump) => ({ kind: 'dump' as const, dump })),
        clock.promise.then(() => ({ kind: 'overran' as const })),
      ]);
      return outcome.kind === 'dump'
        ? outcome.dump
        : `diagnostics unavailable: collection overran its ${diagnoseMs}ms budget`;
    } catch (error) {
      return `diagnostics unavailable: collector failed (${String(error)})`;
    } finally {
      clock.cancel();
    }
  }

  async function race<R>(
    label: string,
    target: Promise<R>,
    racedPeers: readonly Promise<unknown>[],
  ): Promise<R> {
    const remainingMs = Math.max(0, deadlineAt - now());
    const clock = timer(remainingMs);
    try {
      const outcome = await Promise.race<
        | { kind: 'target'; value: R }
        | { kind: 'target-rejected'; error: unknown }
        | { kind: 'peer'; index: number; settled: 'fulfilled'; value: unknown }
        | { kind: 'peer'; index: number; settled: 'rejected'; error: unknown }
        | { kind: 'timeout' }
      >([
        target.then(
          (value) => ({ kind: 'target' as const, value }),
          (error: unknown) => ({ kind: 'target-rejected' as const, error }),
        ),
        ...racedPeers.map((peer, index) => peer.then(
          (value: unknown) => ({ kind: 'peer' as const, index, settled: 'fulfilled' as const, value }),
          (error: unknown) => ({ kind: 'peer' as const, index, settled: 'rejected' as const, error }),
        )),
        clock.promise.then(() => ({ kind: 'timeout' as const })),
      ]);

      if (outcome.kind === 'target') return outcome.value;

      if (outcome.kind === 'target-rejected') {
        if (!isQueryCanceled(outcome.error)) throw outcome.error;
        // A cancellation is the one rejection worth a dump. Throw a NEW error
        // carrying it, with the original as `cause` — never an error whose
        // cause is itself.
        const dump = await collect(label);
        throw new Error(
          `${label}: the statement was cancelled (SQLSTATE 57014) before the wait ` +
          `completed. This is not by itself proof of a lock wait — read the dump.\n${dump}`,
          { cause: outcome.error },
        );
      }

      if (outcome.kind === 'peer') {
        const detail = outcome.settled === 'rejected'
          ? 'it rejected'
          : `it resolved with ${snapshot(outcome.value)}`;
        throw new Error(
          `${label}: in-flight operation "${name}" settled before this stage was ` +
          `reached — ${detail}. The stage can never be signalled now.`,
          outcome.settled === 'rejected' ? { cause: outcome.error } : undefined,
        );
      }

      const dump = await collect(label);
      throw new Error(
        `${label}: no signal within ${waitMs}ms of "${name}" starting ` +
        `(watchdog, not the suite timeout).\n${dump}`,
      );
    } finally {
      clock.cancel();
    }
  }

  return {
    name,
    awaitHandoff: (label, target) => race(label, target, [operation, ...peers]),
    awaitSettled: () => race(`${name} completion`, operation, peers),
  };
}
