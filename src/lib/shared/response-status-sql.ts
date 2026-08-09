import type postgres from 'postgres';

/**
 * Binds a response-status group as a Postgres `text[]` array fragment for use
 * in `status = ANY(${statusArraySql(db, GROUP)})` READ predicates. Reproduces
 * the codebase's existing `${[...GROUP] as string[]}::text[]` array-binding
 * convention exactly — it never emits an `IN (${...})` list, which Postgres.js
 * v3 would expand into one bind per value and change the generated predicate
 * shape.
 *
 * Takes the caller's `sql`/`tx` client explicitly (injection convention): the
 * fragment is client-agnostic to compose (it is never executed on its own), so
 * passing the surrounding query's client is byte-identical. Keeping the client
 * a parameter lets the canonical const module (response-status.ts) stay a
 * zero-dependency pure module — importers of the status groups pull them in
 * without a transitive `sql` / DB import.
 */
export function statusArraySql(db: postgres.Sql | postgres.TransactionSql, statuses: readonly string[]) {
  return db`${[...statuses] as string[]}::text[]`;
}
