import { sql } from '@/lib/db/server';

/**
 * Binds a response-status group as a Postgres `text[]` array fragment for use
 * in `status = ANY(${statusArraySql(GROUP)})` READ predicates. Reproduces the
 * codebase's existing `${[...GROUP] as string[]}::text[]` array-binding
 * convention exactly — it never emits an `IN (${...})` list, which Postgres.js
 * v3 would expand into one bind per value and change the generated predicate
 * shape.
 *
 * Lives in this DB-adjacent module (NOT response-status.ts) so the canonical
 * const module stays a zero-dependency pure module: every TS importer of the
 * status groups can pull them in without a transitive `sql` / DB import.
 */
export function statusArraySql(statuses: readonly string[]) {
  return sql`${[...statuses] as string[]}::text[]`;
}
