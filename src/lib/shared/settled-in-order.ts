// Sequential analog of `Promise.allSettled`, for query waves that must not
// exceed their postgres.js pool.
//
// WHY THIS EXISTS (#505): `Promise.all`/`Promise.allSettled` are CONCURRENT
// drivers. When a wave of queries on ONE postgres.js client is wider than that
// client's pool, postgres.js pipelines the excess onto connections that are
// already open. Over the Supabase Supavisor TRANSACTION pooler, a pipelined
// query's response then parks server-side in `state=active,
// wait_event=ClientRead` and is never read — a PERMANENT connection wedge. No
// server-side timeout heals it: in `ClientRead` the statement is not executing,
// so `statement_timeout` never fires. Each wedge leaks a pool slot until the
// pool starves and the surface goes down (the admin portal, staging 2026-08-10).
//
// The pool that matters on Vercel is `DB_POOL_MAX` = 3 per serverless instance
// (`src/lib/db/server.ts`), so any wave wider than 3 on the shared `sql` client
// is a candidate. Full mechanism, proof, and the sequential cure:
// `docs/adr/0008-boot-readiness-cure.md`, `docs/adr/0009-split-postgres-pools.md`
// and the #505 lab notes.
//
// Use this instead of `Promise.allSettled` when the wave's members must each
// keep their own success/failure outcome (a degradation contract where one slice
// may fail without collapsing the whole payload). When members share fate,
// plain sequential `await`s are simpler and preferable.

export type SettledTuple<T extends readonly unknown[]> = {
  -readonly [K in keyof T]: PromiseSettledResult<T[K]>;
};

/**
 * Runs each thunk to completion before starting the next, returning the same
 * per-member settled results, in the same tuple shape, as
 * `Promise.allSettled` would.
 *
 * Members are THUNKS, not promises: a promise argument would already be
 * in flight before this function saw it, which is the very concurrency being
 * avoided.
 */
export async function settledInOrder<T extends readonly unknown[]>(
  // Mapped-tuple parameter (the shape lib.es2020 uses to type
  // Promise.allSettled): infers T positionally from each thunk's resolved type,
  // so a destructure at the call site keeps per-slot types instead of
  // collapsing to a union.
  thunks: readonly [...{ [K in keyof T]: () => PromiseLike<T[K]> }],
): Promise<SettledTuple<T>> {
  const results: PromiseSettledResult<unknown>[] = [];
  for (const run of thunks) {
    try {
      results.push({ status: 'fulfilled', value: await run() });
    } catch (reason) {
      results.push({ status: 'rejected', reason });
    }
  }
  return results as SettledTuple<T>;
}
